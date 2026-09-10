import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import { BattleSession } from "./src/battle_session.js";

const app = express();
app.set("trust proxy", 1);
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// In-memory session registry (replaces Durable Objects)
const sessions = new Map();

function getSession(sid) {
  if (!sessions.has(sid)) {
    sessions.set(sid, new BattleSession(sid));
  }
  return sessions.get(sid);
}

// ---------------------------------------------------------------------------
// Same-Origin Sprite Proxy (/sprite/*)
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

app.get("/sprite/*", async (req, res) => {
  const path = decodeURIComponent(req.path.slice("/sprite/".length));
  if (!path || /[?#]/.test(path) || !/^[a-z0-9-_/]+\.(png|gif)$/i.test(path)) {
    return res.status(404).send("Not found");
  }

  const sources = [
    "https://play.pokemonshowdown.com/sprites/",
    "https://raw.githubusercontent.com/smogon/pokemon-showdown-sprites/master/",
  ];

  for (const candidate of spriteCandidates(path)) {
    for (const base of sources) {
      try {
        const upstream = await fetch(base + candidate, {
          headers: { "User-Agent": "ps-cloudphone-sprite-proxy" },
        });

        if (!upstream.ok) continue;

        res.setHeader(
          "Content-Type",
          upstream.headers.get("content-type") ||
            (candidate.endsWith(".gif") ? "image/gif" : "image/png")
        );
        res.setHeader("Cache-Control", "public, max-age=86400");

        const arrayBuffer = await upstream.arrayBuffer();
        return res.status(200).send(Buffer.from(arrayBuffer));
      } catch {
        continue;
      }
    }
  }

  return res.status(404).send("Sprite not found");
});

// ---------------------------------------------------------------------------
// HTTP Session Gateway
// ---------------------------------------------------------------------------
app.all("*", async (req, res) => {
  let sid = req.cookies.sid;
  if (!sid) {
    sid = crypto.randomUUID();
    res.cookie("sid", sid, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      path: "/",
    });
  }

  const session = getSession(sid);
  await session.handleRequest(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PS CloudPhone running on port ${PORT}`);
});
