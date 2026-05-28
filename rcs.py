#!/usr/bin/env python3
"""ripcurl-to-strava: pull surfs from Rip Curl Search GPS, push to Strava."""
from __future__ import annotations

import argparse
import io
import json
import mimetypes
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import uuid
import webbrowser
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

RIPCURL_API = "https://api.ripcurl.com/v1"
STRAVA_API = "https://www.strava.com/api/v3"
STRAVA_OAUTH = "https://www.strava.com/oauth"
SURF_URL_RE = re.compile(r"/my-surfs/([0-9a-f]{32})")
ENV_PATH = Path(__file__).parent / ".env"
STATE_PATH = Path(__file__).parent / ".uploaded.json"


# ---------- env ----------

def load_dotenv() -> None:
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def save_env(updates: dict[str, str]) -> None:
    lines = ENV_PATH.read_text().splitlines() if ENV_PATH.exists() else []
    seen = set()
    out = []
    for line in lines:
        m = re.match(r"\s*([A-Z_][A-Z0-9_]*)\s*=", line)
        if m and m.group(1) in updates:
            out.append(f"{m.group(1)}={updates[m.group(1)]}")
            seen.add(m.group(1))
        else:
            out.append(line)
    for k, v in updates.items():
        if k not in seen:
            out.append(f"{k}={v}")
    ENV_PATH.write_text("\n".join(out) + "\n")
    for k, v in updates.items():
        os.environ[k] = v


def require_env(*names: str) -> list[str]:
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        sys.exit(f"Missing env vars: {', '.join(missing)}. See .env.example.")
    return [os.environ[n] for n in names]


# ---------- http ----------

def http_json(method: str, url: str, *, headers: dict | None = None,
              data: bytes | None = None) -> dict:
    req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
        return json.loads(body) if body else {}


# ---------- rip curl ----------

_RIPCURL_HEADERS_BASE = {
    "accept": "application/json, text/javascript, */*; q=0.01",
    "auth-token": "---",
    "content-type": "application/json",
    "origin": "https://searchgps.ripcurl.com",
    "referer": "https://searchgps.ripcurl.com/",
    "user-agent": "Mozilla/5.0 ripcurl-to-strava",
}

_session_checked = False


def ripcurl_login() -> str:
    """POST /auth/login, capture session cookies, persist them, return cookie string."""
    email, password = require_env("RIPCURL_EMAIL", "RIPCURL_PASSWORD")
    body = json.dumps({"email": email, "password": password, "version": 1}).encode()
    req = urllib.request.Request(
        f"{RIPCURL_API}/auth/login",
        data=body, method="POST", headers=_RIPCURL_HEADERS_BASE,
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        set_cookies = r.headers.get_all("Set-Cookie") or []
    # Only keep the auth-related cookies that subsequent calls need.
    keep = ("ripcurl_user_session", "session", "session.sig", "AWSALB", "AWSALBCORS")
    pairs = []
    for sc in set_cookies:
        nv = sc.split(";", 1)[0].strip()
        name = nv.split("=", 1)[0]
        if name in keep:
            pairs.append(nv)
    if not pairs:
        sys.exit("ripcurl login returned no cookies")
    cookie = "; ".join(pairs)
    save_env({"RIPCURL_COOKIE": cookie})
    return cookie


def ensure_session() -> None:
    """Cheap probe; re-login if the session is stale and credentials are available."""
    global _session_checked
    if _session_checked:
        return
    if not os.environ.get("RIPCURL_EMAIL"):
        _session_checked = True
        return
    needs_login = not os.environ.get("RIPCURL_COOKIE")
    if not needs_login:
        try:
            _ripcurl_raw_get("/users/me")
        except urllib.error.HTTPError as e:
            if e.code in (401, 404):
                needs_login = True
            else:
                raise
    if needs_login:
        ripcurl_login()
    _session_checked = True


def _ripcurl_raw_get(path: str, params: dict | None = None) -> dict | list:
    (cookie,) = require_env("RIPCURL_COOKIE")
    url = f"{RIPCURL_API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    return http_json("GET", url, headers={**_RIPCURL_HEADERS_BASE, "cookie": cookie})


def ripcurl_get(path: str, params: dict | None = None) -> dict | list:
    ensure_session()
    return _ripcurl_raw_get(path, params)


def parse_surf_id(s: str) -> str:
    m = SURF_URL_RE.search(s)
    if m:
        return m.group(1)
    if re.fullmatch(r"[0-9a-f]{32}", s):
        return s
    sys.exit(f"Couldn't parse a surf id from {s!r}.")


# ---------- urbnsurf schedule ----------

URBNSURF_AVAILABILITY = (
    "https://hm42z09myi.execute-api.ap-southeast-2.amazonaws.com"
    "/prod/sessions/v1/availability"
)
_URBNSURF_CACHE: dict[tuple[str, str], list[dict]] = {}
_URBNSURF_TEMP_CACHE: dict[str, int] = {}


def urbnsurf_pool_temp(park: str) -> int | None:
    """Scrape current Sydney/Melbourne pool water temp from urbnsurf.com/surf/."""
    if not _URBNSURF_TEMP_CACHE:
        try:
            req = urllib.request.Request(
                "https://urbnsurf.com/surf/",
                headers={"user-agent": "Mozilla/5.0 ripcurl-to-strava"},
            )
            with urllib.request.urlopen(req, timeout=15) as r:
                html = r.read().decode("utf-8", "replace")
        except Exception:
            return None
        for city in ("Sydney", "Melbourne"):
            m = re.search(rf"{city} Water Temp\s*(\d+)", html)
            if m:
                _URBNSURF_TEMP_CACHE[city.lower()] = int(m.group(1))
    return _URBNSURF_TEMP_CACHE.get(park.lower())


def _urbnsurf_sessions(location: str, date_str: str) -> list[dict]:
    key = (location, date_str)
    if key in _URBNSURF_CACHE:
        return _URBNSURF_CACHE[key]
    url = (f"{URBNSURF_AVAILABILITY}?location={location}"
           f"&from_date={date_str}&to_date={date_str}&page=1&limit=300")
    try:
        data = http_json("GET", url, headers={"user-agent": "Mozilla/5.0 ripcurl-to-strava"})
    except Exception:
        data = {}
    sessions = data.get("data", []) if isinstance(data, dict) else []
    _URBNSURF_CACHE[key] = sessions
    return sessions


def urbnsurf_session_name(surf: dict) -> str | None:
    """Find the program (e.g. 'Intermediate Barrels') whose time window best overlaps this surf."""
    loc = (surf.get("location") or "").upper()
    if "URBNSURF" not in loc:
        return None
    park = "sydney" if "SYDNEY" in loc else "melbourne" if "MELBOURNE" in loc else None
    if not park:
        return None

    offset = timedelta(hours=int(surf.get("utc_offset", 0)))
    started = datetime.strptime(surf["start_datetime"][:19], "%Y-%m-%d %H:%M:%S") + offset
    surf_dur = surf.get("duration_total") or 60 * 60
    ended = started + timedelta(seconds=surf_dur)
    surf_start_min = started.hour * 60 + started.minute
    surf_end_min = surf_start_min + surf_dur // 60

    sessions = _urbnsurf_sessions(park, started.strftime("%Y-%m-%d"))
    skip_types = {"spectator-pass", "surf-buddy"}
    skip_words = ("Beginner", "Surf in the Bays", "Spectator")

    best_title, best_overlap = None, 0
    for s in sessions:
        if s.get("session_type") in skip_types: continue
        if any(w in (s.get("title") or "") for w in skip_words): continue
        dur = s.get("duration") or 0
        if not (30 <= dur <= 80): continue
        t = s.get("time") or ""
        try:
            h, m = map(int, t.split(":"))
        except ValueError:
            continue
        sess_start = h * 60 + m
        sess_end = sess_start + dur
        overlap = max(0, min(sess_end, surf_end_min) - max(sess_start, surf_start_min))
        if overlap > best_overlap:
            best_overlap = overlap
            best_title = s.get("title")
    # Need at least 10 min of overlap to be confident
    return best_title if best_overlap >= 10 else None


# ---------- copy ----------

def _time_of_day(hour: int) -> str:
    if hour < 4: return "Late-night"
    if hour < 7: return "Dawn"
    if hour < 11: return "Morning"
    if hour < 14: return "Lunch"
    if hour < 17: return "Arvo"
    if hour < 20: return "Evening"
    return "Night"


def surf_title(surf: dict) -> str:
    spot = (surf.get("location") or "Surf").split(",")[0].strip() or "Surf"
    program = urbnsurf_session_name(surf)
    if program:
        return f"{spot} - {program}"
    return spot


_WIND_WORDS = ["calm", "light", "moderate", "strong", "very strong", "gale"]


def conditions_line(surf: dict) -> str | None:
    """Format ocean conditions from the Rip Curl API into a single line, or None if sparse."""
    bits = []
    swell = surf.get("swell_size") or surf.get("swell_max")
    period = surf.get("swell_period")
    swell_dir = surf.get("swell_direction")
    human = (surf.get("human_relation") or "").strip()
    if human:
        bits.append(human)
    elif swell:
        s = f"{swell:.1f}m"
        if swell_dir: s += f" {swell_dir}"
        if period: s += f" @ {period}s"
        bits.append(s + " swell")

    ws = surf.get("wind_strength")
    wd = surf.get("wind_direction")
    if ws and wd:
        word = _WIND_WORDS[min(int(ws), len(_WIND_WORDS) - 1)]
        bits.append(f"{word} {wd} wind")

    tide_level = (surf.get("tide_level") or "").lower()
    tide_dir = (surf.get("tide_direction") or "").lower()
    if tide_level and tide_dir:
        bits.append(f"{tide_level} tide {tide_dir}")

    wt = surf.get("water_temp")
    if wt:
        bits.append(f"{wt}°C water")

    if len(bits) < 2:
        return None
    return " · ".join(b[0].upper() + b[1:] if b and b[0].isalpha() else b for b in bits)


def surf_description(surf: dict) -> str:
    waves = surf.get("wave_count", 0)
    wave_word = "Wave" if waves == 1 else "Waves"
    dur_min = round((surf.get("duration_total") or 0) / 60)

    program = urbnsurf_session_name(surf)
    lead_bits = [f"{dur_min} minutes", f"{waves} {wave_word}"]
    if program:
        loc = (surf.get("location") or "").upper()
        park = "sydney" if "SYDNEY" in loc else "melbourne" if "MELBOURNE" in loc else None
        temp = urbnsurf_pool_temp(park) if park else None
        if temp:
            lead_bits.append(f"{temp}°C water")
        context = None
    else:
        context = conditions_line(surf)
    lead = " · ".join(lead_bits) + "."

    bits = []
    longest = int(surf.get("longest_wave_by_distance") or 0)
    if longest:
        bits.append(f"Longest wave {longest}m")
    speed = surf.get("speed_max")
    if speed:
        bits.append(f"Top speed {speed:.1f} km/h")
    dw = (surf.get("distance_waves") or 0) / 1000
    if dw:
        bits.append(f"{dw:.2f}km Riding")
    dp = (surf.get("distance_paddles") or 0) / 1000
    if dp:
        bits.append(f"{dp:.2f}km Paddling")
    stats = " · ".join(bits) + "." if bits else ""

    return "\n".join(x for x in (lead, context, stats) if x)


# ---------- gpx ----------

def surf_to_gpx(surf: dict) -> tuple[str, dict]:
    """Return (gpx_xml, meta). Meta has name/description for Strava upload."""
    raw = json.loads(surf["raw_data"])
    offset = timedelta(hours=int(surf.get("utc_offset", 0)))

    ET.register_namespace("", "http://www.topografix.com/GPX/1/1")
    gpx = ET.Element("gpx", {
        "version": "1.1",
        "creator": "ripcurl-to-strava",
        "xmlns": "http://www.topografix.com/GPX/1/1",
    })
    meta = ET.SubElement(gpx, "metadata")
    started_utc = datetime.strptime(raw[0]["time"], "%Y-%m-%d %H:%M:%S") - offset
    ET.SubElement(meta, "time").text = started_utc.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    trk = ET.SubElement(gpx, "trk")
    name = surf_title(surf)
    description = surf_description(surf)
    ET.SubElement(trk, "name").text = name
    seg = ET.SubElement(trk, "trkseg")

    for p in raw:
        t = datetime.strptime(p["time"], "%Y-%m-%d %H:%M:%S") - offset
        pt = ET.SubElement(seg, "trkpt", {
            "lat": str(p["latitude"]),
            "lon": str(p["longitude"]),
        })
        ET.SubElement(pt, "time").text = t.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(gpx, encoding="unicode")
    return xml, {"name": name, "description": description}


# ---------- strava oauth ----------

def strava_authorize(client_id: str | None = None, client_secret: str | None = None) -> None:
    if not client_id:
        client_id = os.environ.get("STRAVA_CLIENT_ID") or input("Client ID: ").strip()
    if not client_secret:
        client_secret = os.environ.get("STRAVA_CLIENT_SECRET") or input("Client Secret: ").strip()

    port = 53682
    redirect = f"http://localhost:{port}/callback"
    auth_url = (
        f"{STRAVA_OAUTH}/authorize?"
        + urllib.parse.urlencode({
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": redirect,
            "approval_prompt": "force",
            "scope": "activity:write,activity:read",
        })
    )
    print(f"\nOpening browser to authorize: {auth_url}")
    webbrowser.open(auth_url)

    code_holder: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.urlparse(self.path).query
            params = dict(urllib.parse.parse_qsl(q))
            code_holder.update(params)
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h2>Authorized. You can close this tab.</h2>")

        def log_message(self, *a): pass

    server = HTTPServer(("localhost", port), Handler)
    while "code" not in code_holder and "error" not in code_holder:
        server.handle_request()
    if "error" in code_holder:
        sys.exit(f"Strava auth error: {code_holder['error']}")

    body = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code_holder["code"],
        "grant_type": "authorization_code",
    }).encode()
    tok = http_json("POST", f"{STRAVA_OAUTH}/token",
                    headers={"content-type": "application/x-www-form-urlencoded"},
                    data=body)

    save_env({
        "STRAVA_CLIENT_ID": client_id,
        "STRAVA_CLIENT_SECRET": client_secret,
        "STRAVA_REFRESH_TOKEN": tok["refresh_token"],
    })
    print(f"\n✓ Saved Strava credentials to {ENV_PATH}")
    print(f"  Athlete: {tok['athlete']['firstname']} {tok['athlete']['lastname']}")


def strava_access_token() -> str:
    cid, secret, refresh = require_env("STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "STRAVA_REFRESH_TOKEN")
    body = urllib.parse.urlencode({
        "client_id": cid,
        "client_secret": secret,
        "refresh_token": refresh,
        "grant_type": "refresh_token",
    }).encode()
    tok = http_json("POST", f"{STRAVA_OAUTH}/token",
                    headers={"content-type": "application/x-www-form-urlencoded"},
                    data=body)
    if tok.get("refresh_token") and tok["refresh_token"] != refresh:
        save_env({"STRAVA_REFRESH_TOKEN": tok["refresh_token"]})
    return tok["access_token"]


def _multipart(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    boundary = "----rcs" + uuid.uuid4().hex
    buf = io.BytesIO()
    for k, v in fields.items():
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
        buf.write(v.encode())
        buf.write(b"\r\n")
    for k, (fname, data, ctype) in files.items():
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(f'Content-Disposition: form-data; name="{k}"; filename="{fname}"\r\n'.encode())
        buf.write(f"Content-Type: {ctype}\r\n\r\n".encode())
        buf.write(data)
        buf.write(b"\r\n")
    buf.write(f"--{boundary}--\r\n".encode())
    return buf.getvalue(), f"multipart/form-data; boundary={boundary}"


def strava_update_activity(activity_id: int, name: str, description: str | None = None) -> None:
    token = strava_access_token()
    fields = {"name": name}
    if description is not None:
        fields["description"] = description
    body = urllib.parse.urlencode(fields).encode()
    http_json("PUT", f"{STRAVA_API}/activities/{activity_id}",
              headers={"Authorization": f"Bearer {token}",
                       "Content-Type": "application/x-www-form-urlencoded"},
              data=body)


def strava_upload(gpx: str, name: str, description: str, external_id: str) -> dict:
    token = strava_access_token()
    body, ctype = _multipart(
        fields={
            "name": name,
            "description": description,
            "data_type": "gpx",
            "sport_type": "Surfing",
            "external_id": external_id,
        },
        files={"file": (f"{external_id}.gpx", gpx.encode(), "application/gpx+xml")},
    )
    upload = http_json("POST", f"{STRAVA_API}/uploads",
                       headers={"Authorization": f"Bearer {token}", "Content-Type": ctype},
                       data=body)
    upload_id = upload["id"]
    print(f"  upload id {upload_id} queued — polling…")
    for _ in range(30):
        time.sleep(2)
        status = http_json("GET", f"{STRAVA_API}/uploads/{upload_id}",
                           headers={"Authorization": f"Bearer {token}"})
        if status.get("activity_id"):
            return status
        if status.get("error"):
            sys.exit(f"Strava upload failed: {status['error']}")
    sys.exit("Timed out waiting for Strava to process upload.")


# ---------- commands ----------

def cmd_list(args: argparse.Namespace) -> None:
    data = ripcurl_get("/feeds/", {
        "limit": args.limit, "user": "true", "sort": "date", "filter": "my-surfs",
    })
    if args.raw:
        print(json.dumps(data, indent=2))
        return
    for s in data:
        when = s["start_datetime"]
        loc = s.get("location") or "?"
        print(f"{s['id']}  {when}  {s['wave_count']:>3} waves  {loc}")


def cmd_show(args: argparse.Namespace) -> None:
    surf = ripcurl_get(f"/surfs/{parse_surf_id(args.surf)}")
    print(json.dumps(surf, indent=2))


def cmd_gpx(args: argparse.Namespace) -> None:
    surf = ripcurl_get(f"/surfs/{parse_surf_id(args.surf)}")
    gpx, _ = surf_to_gpx(surf)
    if args.out:
        Path(args.out).write_text(gpx)
        print(f"wrote {args.out}")
    else:
        sys.stdout.write(gpx)


def cmd_upload(args: argparse.Namespace) -> None:
    if args.from_gpx:
        gpx = Path(args.from_gpx).read_text()
        name = args.name or Path(args.from_gpx).stem
        description = args.description or "Imported from Rip Curl Search GPS."
        external_id = f"ripcurl-gpx-{Path(args.from_gpx).stem}"
    else:
        surf_id = parse_surf_id(args.surf)
        surf = ripcurl_get(f"/surfs/{surf_id}")
        gpx, meta = surf_to_gpx(surf)
        name = args.name or meta["name"]
        description = args.description or meta["description"]
        external_id = f"ripcurl-{surf_id}"
        print(f"→ {name}  ({surf.get('wave_count', 0)} waves)")
    result = strava_upload(gpx, name, description, external_id=external_id)
    print(f"✓ Strava activity: https://www.strava.com/activities/{result['activity_id']}")


def cmd_strava_auth(args: argparse.Namespace) -> None:
    strava_authorize(args.client_id, args.client_secret)


def cmd_login(args: argparse.Namespace) -> None:
    cookie = ripcurl_login()
    print(f"✓ logged in; cookie ({len(cookie)} chars) saved to {ENV_PATH}")


def load_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    return {}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2))


def cmd_sync(args: argparse.Namespace) -> None:
    state = load_state()
    try:
        feed = ripcurl_get("/feeds/", {
            "limit": args.limit, "user": "true", "sort": "date", "filter": "my-surfs",
        })
    except Exception as e:
        # Don't crash launchd retries on transient/auth errors — log and exit clean.
        print(f"[sync] feeds fetch failed: {e}")
        return
    if not isinstance(feed, list):
        print(f"[sync] unexpected feed payload: {type(feed).__name__}")
        return

    new_ids = [s["id"] for s in feed if s["id"] not in state]
    if not new_ids:
        print(f"[sync] up to date ({len(feed)} surfs in feed, {len(state)} already uploaded)")
        return

    for surf_id in new_ids:
        try:
            surf = ripcurl_get(f"/surfs/{surf_id}")
            gpx, meta = surf_to_gpx(surf)
            print(f"[sync] uploading {surf_id}: {meta['name']} ({surf.get('wave_count', 0)} waves)")
            result = strava_upload(gpx, meta["name"], meta["description"],
                                   external_id=f"ripcurl-{surf_id}")
            activity_id = result["activity_id"]
            state[surf_id] = {
                "activity_id": activity_id,
                "uploaded_at": datetime.now(timezone.utc).isoformat(),
                "name": meta["name"],
            }
            save_state(state)
            print(f"[sync] ✓ https://www.strava.com/activities/{activity_id}")
        except Exception as e:
            print(f"[sync] failed for {surf_id}: {e}")



def main() -> None:
    load_dotenv()
    p = argparse.ArgumentParser(prog="rcs")
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list", help="list recent surfs")
    pl.add_argument("--limit", type=int, default=10)
    pl.add_argument("--raw", action="store_true", help="dump raw JSON")
    pl.set_defaults(func=cmd_list)

    ps = sub.add_parser("show", help="dump one surf as JSON")
    ps.add_argument("surf", help="surf id or URL")
    ps.set_defaults(func=cmd_show)

    pg = sub.add_parser("gpx", help="convert a surf to GPX")
    pg.add_argument("surf")
    pg.add_argument("--out", help="write to file (default: stdout)")
    pg.set_defaults(func=cmd_gpx)

    pu = sub.add_parser("upload", help="upload a surf to Strava as a Surfing activity")
    pu.add_argument("surf", nargs="?", help="surf id or URL (omit when using --from-gpx)")
    pu.add_argument("--from-gpx", help="upload an existing GPX file instead of fetching")
    pu.add_argument("--name", help="override activity name")
    pu.add_argument("--description", help="override activity description")
    pu.set_defaults(func=cmd_upload)

    sa = sub.add_parser("strava-auth", help="one-time Strava OAuth setup")
    sa.add_argument("--client-id")
    sa.add_argument("--client-secret")
    sa.set_defaults(func=cmd_strava_auth)

    li = sub.add_parser("login", help="re-authenticate with Rip Curl (uses RIPCURL_EMAIL/PASSWORD)")
    li.set_defaults(func=cmd_login)

    sy = sub.add_parser("sync", help="upload any surfs not yet in .uploaded.json")
    sy.add_argument("--limit", type=int, default=20, help="how many feed entries to scan")
    sy.set_defaults(func=cmd_sync)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
