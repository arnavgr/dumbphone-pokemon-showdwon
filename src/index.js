import { BattleSession } from "./battle_session.js";
export { BattleSession };

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Same-origin sprite proxy (/sprite/*)
// ---------------------------------------------------------------------------
const FOLDER_EXT = {
  gen5: ".png",
  "gen5-back": ".png",
  gen5ani: ".gif",
  "gen5ani-back": ".gif",
};

const FOLDER_FALLBACK = {
  "gen5ani-back": ["gen5-back", "gen5ani", "gen5"],
  gen5ani: ["gen5"],
  "gen5-back": ["gen5"],
  gen5: [],
};

function spriteCandidates(path) {
  const slash = path.indexOf("/");
  if (slash === -1) return [path];

  const folder = path.slice(0, slash);
  const file = path.slice(slash + 1);

  const extMatch = file.match(/\.(png|gif)$/i);
  const ext = extMatch ? extMatch[0] : ".png";
  const stem = file.slice(0, file.length - ext.length);
  const baseStem = stem.split("-")[0];

  const folderChain = [folder, ...(FOLDER_FALLBACK[folder] || [])];

  const candidates = [];
  for (const f of folderChain) {
    const e = FOLDER_EXT[f] || ext;
    candidates.push(`${f}/${stem}${e}`);
    if (baseStem !== stem) candidates.push(`${f}/${baseStem}${e}`);
  }

  return [...new Set(candidates)];
}

async function handleSprite(request, url) {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const path = decodeURIComponent(url.pathname.slice("/sprite/".length));

  if (!path || /[?#]/.test(path) || !/^[a-z0-9-_/]+\.(png|gif)$/i.test(path)) {
    return new Response("Not found", { status: 404 });
  }

  const cacheKey = new Request(request.url, { method: "GET" });

  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  } catch {
    // Cache unavailable
  }

  const sources = [
    "https://play.pokemonshowdown.com/sprites/",
    "https://raw.githubusercontent.com/smogon/pokemon-showdown-sprites/master/",
  ];

  for (const candidate of spriteCandidates(path)) {
    for (const base of sources) {
      const upstreamUrl = base + candidate;

      let upstream;
      try {
        upstream = await fetch(upstreamUrl, {
          headers: { "User-Agent": "ps-cloudphone-sprite-proxy" },
        });
      } catch {
        continue;
      }

      if (!upstream.ok) continue;

      const headers = new Headers();
      headers.set(
        "content-type",
        upstream.headers.get("content-type") ||
          (candidate.endsWith(".gif") ? "image/gif" : "image/png")
      );
      headers.set("cache-control", "public, max-age=86400");

      const response = new Response(upstream.body, { status: 200, headers });

      try {
        await caches.default.put(cacheKey, response.clone());
      } catch {
        // Ignore cache put failures
      }

      return response;
    }
  }

  return new Response("Sprite not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// Main Worker entry
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/sprite/")) {
      return handleSprite(request, url);
    }

    let sid = getCookie(request, "sid");
    let setCookie = null;

    if (!sid) {
      sid = crypto.randomUUID();
      setCookie = `sid=${sid}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`;
    }

    const id = env.BATTLE_SESSION.idFromName(sid);
    const stub = env.BATTLE_SESSION.get(id);

    const resp = await stub.fetch(request);

    if (setCookie) {
      const headers = new Headers(resp.headers);
      headers.append("Set-Cookie", setCookie);
      return new Response(resp.body, { status: resp.status, headers });
    }

    return resp;
  },
};
