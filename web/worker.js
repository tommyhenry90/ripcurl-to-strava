// Cloudflare Worker for ripcurl-to-strava web app.
// - Serves the static UI.
// - CORS-proxies api.ripcurl.com + UrbnSurf endpoints.
// - Handles Strava OAuth token exchange (needs client_secret).
// - Optional opt-in background sync: stores encrypted creds in KV, scheduled trigger
//   runs every 30 min to fetch new surfs and upload them.

const RIPCURL_BASE = "https://api.ripcurl.com";
const URBNSURF_AVAIL = "https://hm42z09myi.execute-api.ap-southeast-2.amazonaws.com/prod/sessions/v1/availability";
const URBNSURF_HOME = "https://urbnsurf.com/surf/";
const STRAVA_API = "https://www.strava.com/api/v3";
const STRAVA_OAUTH = "https://www.strava.com/oauth";

// ---------- CORS ----------
function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-RC-Cookie, X-Strava-Token",
    "Access-Control-Expose-Headers": "X-RC-Cookie",
    "Access-Control-Max-Age": "86400",
  };
}
function jsonResp(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json", ...extra },
  });
}

// ---------- crypto ----------
async function masterKey(env) {
  if (!env.SYNC_MASTER_KEY) throw new Error("SYNC_MASTER_KEY not configured");
  const raw = Uint8Array.from(atob(env.SYNC_MASTER_KEY), c => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encrypt(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  let bin = ""; for (const b of combined) bin += String.fromCharCode(b);
  return btoa(bin);
}
async function decrypt(b64, key) {
  const combined = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(data);
}

// ---------- strava ----------
async function stravaTokenExchange(env, params) {
  const form = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    ...params,
  });
  const r = await fetch(`${STRAVA_OAUTH}/token`, {
    method: "POST", body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  if (!r.ok) throw new Error(`Strava token failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function stravaVerifyAthlete(accessToken) {
  const r = await fetch(`${STRAVA_API}/athlete`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Strava athlete check failed: ${r.status}`);
  return r.json();
}

// ---------- rip curl ----------
const RC_HEADERS = {
  "accept": "application/json, text/javascript, */*; q=0.01",
  "auth-token": "---",
  "content-type": "application/json",
  "origin": "https://searchgps.ripcurl.com",
  "referer": "https://searchgps.ripcurl.com/",
  "user-agent": "Mozilla/5.0 ripcurl-to-strava-web",
};

function extractSetCookies(r) {
  if (typeof r.headers.getSetCookie === "function") return r.headers.getSetCookie();
  const raw = r.headers.get("set-cookie");
  return raw ? raw.split(/,\s*(?=[A-Za-z0-9_.-]+=)/) : [];
}

async function ripcurlLogin(email, password) {
  const r = await fetch(`${RIPCURL_BASE}/v1/auth/login`, {
    method: "POST", headers: RC_HEADERS,
    body: JSON.stringify({ email, password, version: 1 }),
  });
  if (!r.ok) throw new Error(`Rip Curl login failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const cookies = extractSetCookies(r);
  const cookie = cookies.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
  if (!cookie) throw new Error("Rip Curl login returned no cookies");
  return { user: data, cookie };
}

async function ripcurlGet(path, cookie) {
  const r = await fetch(`${RIPCURL_BASE}${path}`, {
    headers: { ...RC_HEADERS, cookie },
  });
  if (!r.ok) throw new Error(`Rip Curl ${path} -> ${r.status}`);
  return r.json();
}

// ---------- urbnsurf ----------
async function urbnsurfSessions(park, dateStr) {
  try {
    const r = await fetch(`${URBNSURF_AVAIL}?location=${park}&from_date=${dateStr}&to_date=${dateStr}&page=1&limit=300`);
    if (!r.ok) return [];
    const data = await r.json();
    return data?.data || [];
  } catch { return []; }
}

async function urbnsurfPoolTemps() {
  try {
    const r = await fetch(URBNSURF_HOME, { headers: { "user-agent": "Mozilla/5.0 ripcurl-to-strava-web" } });
    const html = await r.text();
    const sydney = html.match(/Sydney Water Temp\s*(\d+)/);
    const melbourne = html.match(/Melbourne Water Temp\s*(\d+)/);
    return { sydney: sydney ? +sydney[1] : null, melbourne: melbourne ? +melbourne[1] : null };
  } catch { return { sydney: null, melbourne: null }; }
}

async function urbnsurfSessionName(surf) {
  const loc = (surf.location || "").toUpperCase();
  if (!loc.includes("URBNSURF")) return null;
  const park = loc.includes("SYDNEY") ? "sydney" : loc.includes("MELBOURNE") ? "melbourne" : null;
  if (!park) return null;
  const offset = +(surf.utc_offset || 0);
  const startUtc = new Date(surf.start_datetime.replace(" ", "T").replace(" +", "+"));
  const local = new Date(startUtc.getTime() + offset * 3600_000);
  const dateStr = local.toISOString().slice(0, 10);
  const surfDurSec = surf.duration_total || 3600;
  const startMin = local.getUTCHours() * 60 + local.getUTCMinutes();
  const endMin = startMin + Math.floor(surfDurSec / 60);
  const sessions = await urbnsurfSessions(park, dateStr);
  const skipTypes = new Set(["spectator-pass", "surf-buddy"]);
  const skipWords = ["Beginner", "Surf in the Bays", "Spectator"];
  let bestTitle = null, bestOverlap = 0;
  for (const s of sessions) {
    if (skipTypes.has(s.session_type)) continue;
    if (skipWords.some(w => (s.title || "").includes(w))) continue;
    const dur = s.duration || 0;
    if (dur < 30 || dur > 80) continue;
    const [h, m] = (s.time || "").split(":").map(Number);
    if (Number.isNaN(h)) continue;
    const sStart = h * 60 + m;
    const sEnd = sStart + dur;
    const overlap = Math.max(0, Math.min(sEnd, endMin) - Math.max(sStart, startMin));
    if (overlap > bestOverlap) { bestOverlap = overlap; bestTitle = s.title; }
  }
  return bestOverlap >= 10 ? bestTitle : null;
}

// ---------- copy ----------
const WIND_WORDS = ["calm", "light", "moderate", "strong", "very strong", "gale"];

function surfTitle(surf, session) {
  const spot = (surf.location || "Surf").split(",")[0].trim() || "Surf";
  return session ? `${spot} - ${session}` : spot;
}

function conditionsLine(surf) {
  const bits = [];
  const swell = surf.swell_size || surf.swell_max;
  const period = surf.swell_period;
  const swellDir = surf.swell_direction;
  const human = (surf.human_relation || "").trim();
  if (human) bits.push(human);
  else if (swell) {
    let s = swell.toFixed(1) + "m";
    if (swellDir) s += " " + swellDir;
    if (period) s += " @ " + period + "s";
    bits.push(s + " swell");
  }
  if (surf.wind_strength && surf.wind_direction) {
    const w = WIND_WORDS[Math.min(+surf.wind_strength, WIND_WORDS.length - 1)];
    bits.push(`${w} ${surf.wind_direction} wind`);
  }
  if (surf.tide_level && surf.tide_direction) {
    bits.push(`${surf.tide_level.toLowerCase()} tide ${surf.tide_direction.toLowerCase()}`);
  }
  if (surf.water_temp) bits.push(`${surf.water_temp}°C water`);
  if (bits.length < 2) return null;
  return bits.map(b => (b[0] || "").toUpperCase() + b.slice(1)).join(" · ");
}

function surfDescription(surf, session, poolTemp) {
  const waves = surf.wave_count || 0;
  const waveWord = waves === 1 ? "Wave" : "Waves";
  const durMin = Math.round((surf.duration_total || 0) / 60);
  const leadBits = [`${durMin} minutes`, `${waves} ${waveWord}`];
  let context = null;
  if (session) {
    if (poolTemp) leadBits.push(`${poolTemp}°C water`);
  } else {
    context = conditionsLine(surf);
  }
  const lead = leadBits.join(" · ") + ".";
  const stats = [];
  const longest = Math.round(surf.longest_wave_by_distance || 0);
  if (longest) stats.push(`Longest wave ${longest}m`);
  if (surf.speed_max) stats.push(`Top speed ${surf.speed_max.toFixed(1)} km/h`);
  const dw = (surf.distance_waves || 0) / 1000;
  if (dw) stats.push(`${dw.toFixed(2)}km Riding`);
  const dp = (surf.distance_paddles || 0) / 1000;
  if (dp) stats.push(`${dp.toFixed(2)}km Paddling`);
  return [lead, context, stats.length ? stats.join(" · ") + "." : null].filter(Boolean).join("\n");
}

// ---------- gpx ----------
function pad2(n) { return String(n).padStart(2, "0"); }
function toIso(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`;
}
function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&apos;"}[c]));
}
function gpxFromSurf(surf, name) {
  const raw = JSON.parse(surf.raw_data);
  const offsetMs = +(surf.utc_offset || 0) * 3600_000;
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<gpx version="1.1" creator="ripcurl-to-strava-web" xmlns="http://www.topografix.com/GPX/1/1">');
  const firstUtc = new Date(raw[0].time.replace(" ", "T") + "Z").getTime() - offsetMs;
  out.push(`<metadata><time>${toIso(firstUtc)}</time></metadata>`);
  out.push(`<trk><name>${escapeXml(name)}</name><trkseg>`);
  for (const p of raw) {
    const utcMs = new Date(p.time.replace(" ", "T") + "Z").getTime() - offsetMs;
    out.push(`<trkpt lat="${p.latitude}" lon="${p.longitude}"><time>${toIso(utcMs)}</time></trkpt>`);
  }
  out.push("</trkseg></trk></gpx>");
  return out.join("");
}

// ---------- upload to strava ----------
function parseDuplicate(msg) {
  if (!msg) return null;
  const m = msg.match(/\/activities\/(\d+)/);
  return m && /duplicate/i.test(msg) ? +m[1] : null;
}

async function uploadSurfToStrava(surf, accessToken) {
  const session = await urbnsurfSessionName(surf);
  let poolTemp = null;
  if (session) {
    const temps = await urbnsurfPoolTemps();
    poolTemp = (surf.location || "").toUpperCase().includes("SYDNEY") ? temps.sydney : temps.melbourne;
  }
  const title = surfTitle(surf, session);
  const description = surfDescription(surf, session, poolTemp);
  const gpx = gpxFromSurf(surf, title);

  const form = new FormData();
  form.append("name", title);
  form.append("description", description);
  form.append("data_type", "gpx");
  form.append("sport_type", "Surfing");
  form.append("external_id", `ripcurl-${surf.id}`);
  form.append("file", new Blob([gpx], { type: "application/gpx+xml" }), `${surf.id}.gpx`);

  const upRes = await fetch(`${STRAVA_API}/uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const upData = await upRes.json();
  const upDup = parseDuplicate(upData.error);
  if (upDup) return { activity_id: upDup, name: title, was_duplicate: true };
  if (upData.error) throw new Error(String(upData.error).replace(/<[^>]+>/g, "").trim());
  const uploadId = upData.id;

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const sRes = await fetch(`${STRAVA_API}/uploads/${uploadId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const sData = await sRes.json();
    if (sData.activity_id) return { activity_id: sData.activity_id, name: title };
    const sDup = parseDuplicate(sData.error);
    if (sDup) return { activity_id: sDup, name: title, was_duplicate: true };
    if (sData.error) throw new Error(String(sData.error).replace(/<[^>]+>/g, "").trim());
  }
  throw new Error("Timed out waiting for Strava");
}

// ---------- sync persistence ----------
function userKey(athleteId) { return `user:${athleteId}`; }

async function storeUserState(env, athleteId, state) {
  await env.RCS_SYNC.put(userKey(athleteId), JSON.stringify(state));
}
async function loadUserState(env, athleteId) {
  const raw = await env.RCS_SYNC.get(userKey(athleteId));
  return raw ? JSON.parse(raw) : null;
}
async function deleteUserState(env, athleteId) {
  await env.RCS_SYNC.delete(userKey(athleteId));
}

// ---------- sync endpoints ----------
async function handleSyncEnable(request, env, origin) {
  const body = await request.json();
  const { strava_access_token, strava_refresh_token, ripcurl_email, ripcurl_password } = body;
  if (!strava_access_token || !strava_refresh_token || !ripcurl_email || !ripcurl_password) {
    return jsonResp({ error: "missing fields" }, 400, origin);
  }
  const athlete = await stravaVerifyAthlete(strava_access_token);
  // Validate Rip Curl creds by attempting login
  await ripcurlLogin(ripcurl_email, ripcurl_password);

  const key = await masterKey(env);
  const state = {
    email: ripcurl_email,
    password_enc: await encrypt(ripcurl_password, key),
    refresh_enc: await encrypt(strava_refresh_token, key),
    athlete: { id: athlete.id, firstname: athlete.firstname, lastname: athlete.lastname },
    uploaded_surfs: {},
    last_sync: null,
    last_error: null,
    created_at: new Date().toISOString(),
  };
  await storeUserState(env, athlete.id, state);
  return jsonResp({ ok: true, athlete: state.athlete }, 200, origin);
}

async function handleSyncDisable(request, env, origin) {
  const body = await request.json();
  const { strava_access_token } = body;
  if (!strava_access_token) return jsonResp({ error: "missing strava_access_token" }, 400, origin);
  const athlete = await stravaVerifyAthlete(strava_access_token);
  await deleteUserState(env, athlete.id);
  return jsonResp({ ok: true }, 200, origin);
}

async function handleSyncStatus(request, env, origin) {
  const token = request.headers.get("x-strava-token");
  if (!token) return jsonResp({ enabled: false }, 200, origin);
  let athlete;
  try { athlete = await stravaVerifyAthlete(token); }
  catch { return jsonResp({ enabled: false }, 200, origin); }
  const state = await loadUserState(env, athlete.id);
  if (!state) return jsonResp({ enabled: false }, 200, origin);
  return jsonResp({
    enabled: true,
    last_sync: state.last_sync,
    last_error: state.last_error,
    uploaded_count: Object.keys(state.uploaded_surfs || {}).length,
    athlete: state.athlete,
  }, 200, origin);
}

// ---------- scheduled handler ----------
async function syncOneUser(env, key, state) {
  const masterK = await masterKey(env);
  const password = await decrypt(state.password_enc, masterK);
  const refreshToken = await decrypt(state.refresh_enc, masterK);

  // Fresh Strava access token
  const stravaTok = await stravaTokenExchange(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const accessToken = stravaTok.access_token;
  // If refresh_token rotated, re-encrypt
  if (stravaTok.refresh_token && stravaTok.refresh_token !== refreshToken) {
    state.refresh_enc = await encrypt(stravaTok.refresh_token, masterK);
  }

  // Rip Curl login → cookie → feed
  const { cookie } = await ripcurlLogin(state.email, password);
  const feed = await ripcurlGet(`/v1/feeds/?limit=20&user=true&sort=date&filter=my-surfs`, cookie);

  const newIds = (Array.isArray(feed) ? feed : []).map(s => s.id).filter(id => !state.uploaded_surfs[id]);
  for (const surfId of newIds) {
    try {
      const surf = await ripcurlGet(`/v1/surfs/${surfId}`, cookie);
      const result = await uploadSurfToStrava(surf, accessToken);
      state.uploaded_surfs[surfId] = { activity_id: result.activity_id, name: result.name };
    } catch (e) {
      state.last_error = `surf ${surfId}: ${e.message}`;
      // Continue with other surfs
    }
  }

  state.last_sync = new Date().toISOString();
  if (newIds.length === 0) state.last_error = null;
  await env.RCS_SYNC.put(key, JSON.stringify(state));
  return { uploaded: newIds.length };
}

async function runScheduledSync(env) {
  const list = await env.RCS_SYNC.list({ prefix: "user:" });
  const results = [];
  for (const item of list.keys) {
    try {
      const raw = await env.RCS_SYNC.get(item.name);
      if (!raw) continue;
      const state = JSON.parse(raw);
      const r = await syncOneUser(env, item.name, state);
      results.push({ key: item.name, ...r });
    } catch (e) {
      console.log(`[sync] ${item.name} failed: ${e.message}`);
      results.push({ key: item.name, error: e.message });
    }
  }
  console.log(`[sync] processed ${results.length} users`);
  return results;
}

// ---------- existing endpoints (token exchange, proxies) ----------
async function handleStravaToken(request, env, origin) {
  const body = await request.json();
  if (!env.STRAVA_CLIENT_SECRET) {
    return jsonResp({ error: "STRAVA_CLIENT_SECRET not configured on the Worker" }, 500, origin);
  }
  const params = {};
  if (body.code) { params.grant_type = "authorization_code"; params.code = body.code; }
  else if (body.refresh_token) { params.grant_type = "refresh_token"; params.refresh_token = body.refresh_token; }
  else return jsonResp({ error: "must supply code or refresh_token" }, 400, origin);
  try {
    const data = await stravaTokenExchange(env, params);
    return jsonResp(data, 200, origin);
  } catch (e) {
    return jsonResp({ error: e.message }, 400, origin);
  }
}

async function handleRipcurlProxy(url, request, origin) {
  const subPath = url.pathname.replace("/api/ripcurl", "");
  const target = `${RIPCURL_BASE}${subPath}${url.search}`;
  const outHeaders = { ...RC_HEADERS };
  const cookie = request.headers.get("x-rc-cookie");
  if (cookie) outHeaders["cookie"] = cookie;
  const init = { method: request.method, headers: outHeaders };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.text();
  const r = await fetch(target, init);
  const cookies = extractSetCookies(r);
  const cookieHeader = cookies.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
  const respHeaders = {
    ...cors(origin),
    "Content-Type": r.headers.get("content-type") || "application/json",
  };
  if (cookieHeader) respHeaders["X-RC-Cookie"] = cookieHeader;
  return new Response(await r.text(), { status: r.status, headers: respHeaders });
}

// ---------- main ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "*";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });

    try {
      if (url.pathname === "/api/config") {
        return jsonResp({ strava_client_id: env.STRAVA_CLIENT_ID || null }, 200, origin);
      }
      if (url.pathname === "/api/strava/token" && request.method === "POST") {
        return handleStravaToken(request, env, origin);
      }
      if (url.pathname.startsWith("/api/ripcurl/")) {
        return handleRipcurlProxy(url, request, origin);
      }
      if (url.pathname === "/api/urbnsurf/availability") {
        const r = await fetch(URBNSURF_AVAIL + url.search);
        return new Response(await r.text(), {
          status: r.status,
          headers: { ...cors(origin), "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/api/urbnsurf/temp") {
        return jsonResp(await urbnsurfPoolTemps(), 200, origin);
      }
      if (url.pathname === "/api/sync/enable" && request.method === "POST") {
        return handleSyncEnable(request, env, origin);
      }
      if (url.pathname === "/api/sync/disable" && request.method === "POST") {
        return handleSyncDisable(request, env, origin);
      }
      if (url.pathname === "/api/sync/status") {
        return handleSyncStatus(request, env, origin);
      }
      // Debug-only: manual trigger of scheduled sync (no auth in v1 — relies on
      // wrangler cron auth via Cloudflare; keep behind a token if you publicly expose this).
      if (url.pathname === "/api/sync/run" && request.method === "POST") {
        if (!env.SYNC_RUN_TOKEN || request.headers.get("x-run-token") !== env.SYNC_RUN_TOKEN) {
          return jsonResp({ error: "forbidden" }, 403, origin);
        }
        const results = await runScheduledSync(env);
        return jsonResp({ ok: true, results }, 200, origin);
      }
    } catch (e) {
      return jsonResp({ error: e.message }, 500, origin);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },
};
