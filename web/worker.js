// Cloudflare Worker for ripcurl-to-strava web app.
// - Handles Strava OAuth code/refresh exchanges (needs client_secret server-side)
// - CORS-proxies api.ripcurl.com (their API only allows the searchgps origin)
// - CORS-proxies UrbnSurf schedule + water-temp scrape
// - Falls through to static assets (index.html)
// Stateless. No persistence. Each user's tokens live only in their browser localStorage.

const RIPCURL_BASE = "https://api.ripcurl.com";
const URBNSURF_AVAIL = "https://hm42z09myi.execute-api.ap-southeast-2.amazonaws.com/prod/sessions/v1/availability";
const URBNSURF_HOME = "https://urbnsurf.com/surf/";

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-RC-Cookie",
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

async function handleStravaToken(request, env, origin) {
  const body = await request.json();
  if (!env.STRAVA_CLIENT_SECRET) {
    return jsonResp({ error: "STRAVA_CLIENT_SECRET not configured on the Worker" }, 500, origin);
  }
  const form = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
  });
  if (body.code) {
    form.set("grant_type", "authorization_code");
    form.set("code", body.code);
  } else if (body.refresh_token) {
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", body.refresh_token);
  } else {
    return jsonResp({ error: "must supply code or refresh_token" }, 400, origin);
  }
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

async function handleRipcurl(url, request, origin) {
  const subPath = url.pathname.replace("/api/ripcurl", "");
  const target = `${RIPCURL_BASE}${subPath}${url.search}`;
  const outHeaders = {
    "accept": "application/json, text/javascript, */*; q=0.01",
    "auth-token": "---",
    "content-type": "application/json",
    "origin": "https://searchgps.ripcurl.com",
    "referer": "https://searchgps.ripcurl.com/",
    "user-agent": "Mozilla/5.0 ripcurl-to-strava-web",
  };
  const cookie = request.headers.get("x-rc-cookie");
  if (cookie) outHeaders["cookie"] = cookie;

  const init = { method: request.method, headers: outHeaders };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }
  const r = await fetch(target, init);

  // Extract Set-Cookie headers and expose them to the browser via X-RC-Cookie
  let cookies = [];
  if (typeof r.headers.getSetCookie === "function") {
    cookies = r.headers.getSetCookie();
  } else {
    const raw = r.headers.get("set-cookie");
    if (raw) cookies = raw.split(/,\s*(?=[A-Za-z0-9_.-]+=)/);
  }
  const cookieHeader = cookies.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");

  const respHeaders = {
    ...cors(origin),
    "Content-Type": r.headers.get("content-type") || "application/json",
  };
  if (cookieHeader) respHeaders["X-RC-Cookie"] = cookieHeader;

  return new Response(await r.text(), { status: r.status, headers: respHeaders });
}

async function handleUrbnsurfTemp(origin) {
  const r = await fetch(URBNSURF_HOME, { headers: { "user-agent": "Mozilla/5.0 ripcurl-to-strava-web" } });
  const html = await r.text();
  const sydney = html.match(/Sydney Water Temp\s*(\d+)/);
  const melbourne = html.match(/Melbourne Water Temp\s*(\d+)/);
  return jsonResp({
    sydney: sydney ? +sydney[1] : null,
    melbourne: melbourne ? +melbourne[1] : null,
  }, 200, origin);
}

async function handleUrbnsurfAvail(url, origin) {
  const r = await fetch(URBNSURF_AVAIL + url.search);
  return new Response(await r.text(), {
    status: r.status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

async function handleConfig(env, origin) {
  return jsonResp({ strava_client_id: env.STRAVA_CLIENT_ID || null }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(origin) });
    }

    try {
      if (url.pathname === "/api/config") return handleConfig(env, origin);
      if (url.pathname === "/api/strava/token" && request.method === "POST") {
        return handleStravaToken(request, env, origin);
      }
      if (url.pathname.startsWith("/api/ripcurl/")) {
        return handleRipcurl(url, request, origin);
      }
      if (url.pathname === "/api/urbnsurf/availability") {
        return handleUrbnsurfAvail(url, origin);
      }
      if (url.pathname === "/api/urbnsurf/temp") {
        return handleUrbnsurfTemp(origin);
      }
    } catch (e) {
      return jsonResp({ error: e.message }, 500, origin);
    }

    // Static asset fallthrough
    return env.ASSETS.fetch(request);
  },
};
