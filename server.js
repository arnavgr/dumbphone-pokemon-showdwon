import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import { BattleSession } from "./src/battle_session.js";
import { FORMATS, renderHome, renderBattle, renderTeams, renderTeamError } from "./src/render_ui.js";
import { renderEnhancedBattle } from "./src/battle_intel.js";
import { fetchRemoteTeams, teamMatchesFormat } from "./src/team_store.js";

const app = express();
app.set("trust proxy", 1);
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sessions = new Map();

function getSession(sid) {
  if (!sessions.has(sid)) sessions.set(sid, new BattleSession(sid));
  return sessions.get(sid);
}

const FORMAT_IDS = new Set(FORMATS.map(([id]) => id));
const TEAM_FORMAT = "gen9ou";

function teamOwnerMatches(session) {
  return !!(
    session.state_?.selectedTeam &&
    session.state_?.selectedTeamOwner &&
    session.state_?.username &&
    session.state_.selectedTeamOwner === String(session.state_.username).toLowerCase()
  );
}

async function startSearch(session, format, packedTeam = null) {
  await session.ensureConnected();
  if (session.state_.loginName) await session.autoRelogin();

  if (session.state_.roomId) {
    try { session.sendToRoom(session.state_.roomId, "/leave"); } catch {}
    session.resetBattle();
  }
  if (session.state_.searching?.length) {
    try { session.send("|/cancelsearch"); } catch {}
    session.state_.searching = [];
  }

  session.send(`|/utm ${packedTeam || "null"}`);
  session.send(`|/search ${format}`);

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (session.state_.roomId && !session.state_.ended) return true;
    if ((session.state_.searching || []).includes(format)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function renderPageError(res, message, status = 503) {
  return res.status(status).send(renderTeamError(message));
}

function extractEnhancedSection(html, heading) {
  const startMarker = `<h2>${heading}</h2>`;
  const start = html.indexOf(startMarker);
  if (start === -1) return "";
  const after = html.slice(start + startMarker.length);
  const end = after.indexOf("<h2>");
  return end === -1 ? html.slice(start) : html.slice(start, startMarker.length + end);
}

// ---------------------------------------------------------------------------
// Same-Origin Sprite Proxy
// ---------------------------------------------------------------------------
const FOLDER_EXT = { gen5: ".png", "gen5-back": ".png", gen5ani: ".gif", "gen5ani-back": ".gif" };
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
  if (!path || /[?#]/.test(path) || !/^[a-z0-9-_/]+\.(png|gif)$/i.test(path)) return res.status(404).send("Not found");
  const sources = [
    "https://play.pokemonshowdown.com/sprites/",
    "https://raw.githubusercontent.com/smogon/pokemon-showdown-sprites/master/",
  ];
  for (const candidate of spriteCandidates(path)) {
    for (const base of sources) {
      try {
        const upstream = await fetch(base + candidate, { headers: { "User-Agent": "ps-cloudphone-sprite-proxy" } });
        if (!upstream.ok) continue;
        res.setHeader("Content-Type", upstream.headers.get("content-type") || (candidate.endsWith(".gif") ? "image/gif" : "image/png"));
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.status(200).send(Buffer.from(await upstream.arrayBuffer()));
      } catch {}
    }
  }
  return res.status(404).send("Sprite not found");
});

// ---------------------------------------------------------------------------
// HTTP gateway
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

  try {
    if (req.path === "/" && req.method === "GET") {
      await session.ensureConnected();
      return res.send(renderHome(session.state_));
    }

    if (req.path === "/battle" && req.method === "GET") {
      await session.ensureConnected();
      let html = await renderBattle(session.state_);
      try {
        const enhanced = await renderEnhancedBattle(session.state_);
        // The enhanced renderer is retained as a calculation engine for the
        // damage estimator and smart switch scoring while render_ui owns the
        // singles/doubles page layout.
        const damage = extractEnhancedSection(enhanced, "Damage / KO estimator");
        const switches = extractEnhancedSection(enhanced, "Smart switch recommendations");
        const marker = "<h2>Log</h2>";
        const intel = `${damage}${switches}`;
        if (intel && html.includes(marker)) html = html.replace(marker, `${intel}${marker}`);
      } catch {}
      return res.send(html);
    }

    if (req.path === "/teams" && req.method === "GET") {
      const format = String(req.query.format || TEAM_FORMAT);
      if (format !== TEAM_FORMAT) return renderPageError(res, "Only Gen 9 OU uses uploaded teams.", 400);
      await session.ensureConnected();
      if (!session.state_.loginName) {
        session.state_.notice = "Log in first to load your uploaded teams.";
        return res.redirect("/login");
      }
      await session.autoRelogin();
      const teams = await fetchRemoteTeams(session.state_.upstreamCookie);
      session.teamCache = teams;
      return res.send(renderTeams(teams, session.state_, format));
    }

    if (req.path === "/select-team" && req.method === "GET") {
      const format = String(req.query.format || TEAM_FORMAT);
      const id = String(req.query.id || "");
      if (format !== TEAM_FORMAT || !id) return renderPageError(res, "Invalid team selection.", 400);
      if (!session.state_.loginName) return res.redirect("/login");
      await session.ensureConnected();
      await session.autoRelogin();
      if (!Array.isArray(session.teamCache)) session.teamCache = await fetchRemoteTeams(session.state_.upstreamCookie);

      const selected = session.teamCache.find((t) => t.id === id && teamMatchesFormat(t, format));
      if (!selected) return renderPageError(res, "That team is not available on your account anymore.", 404);
      session.state_.selectedTeam = { id: selected.id, name: selected.name, format: selected.format, packed: selected.packed };
      session.state_.selectedTeamOwner = String(session.state_.username || session.state_.loginName || "").toLowerCase();
      session.state_.notice = `Selected team: ${selected.name}`;
      return res.redirect(`/search?format=${encodeURIComponent(format)}`);
    }

    if (req.path === "/search" && req.method === "GET") {
      const format = String(req.query.format || "gen9randombattle");
      if (!FORMAT_IDS.has(format)) return renderPageError(res, `Unsupported format: ${format}`, 400);

      if (format === TEAM_FORMAT) {
        if (!teamOwnerMatches(session)) return res.redirect(`/teams?format=${encodeURIComponent(TEAM_FORMAT)}`);
        const teamName = session.state_.selectedTeam.name;
        const ok = await startSearch(session, format, session.state_.selectedTeam.packed);
        session.state_.notice = ok ? `Searching for ${format} with ${teamName}...` : `Searching for ${format}...`;
      } else {
        const ok = await startSearch(session, format, null);
        session.state_.notice = ok ? `Searching for ${format}...` : `Searching for ${format}... (check back shortly)`;
      }
      if (session.state_.roomId) return res.redirect("/battle");
      return res.redirect("/");
    }

    if (req.path === "/doublechoose" && req.method === "GET") {
      const reqData = session.state_.request;
      if (!reqData?.active || reqData.active.length < 2 || !session.state_.roomId) return res.redirect("/battle");
      if (!Array.isArray(session.pendingChoices) || session.pendingChoices.length !== reqData.active.length) {
        session.pendingChoices = Array(reqData.active.length).fill(null);
      }

      const slotRaw = String(req.query.slot ?? "");
      let choice = String(req.query.choice || "");
      // Showdown expects the target before the Mega modifier in doubles:
      // move 1 +1 mega, not move 1 mega +1.
      choice = choice.replace(/^(move\s+\S+)\s+mega\s+([+-]\d+)$/i, "$1 $2 mega");

      if (slotRaw === "all" && choice === "default") {
        for (let i = 0; i < reqData.active.length; i++) {
          if (!session.pendingChoices[i] && !(Array.isArray(reqData.forceSwitch) && reqData.forceSwitch[i])) session.pendingChoices[i] = "default";
        }
      } else {
        const slot = Number(slotRaw);
        if (!Number.isInteger(slot) || slot < 0 || slot >= reqData.active.length) return res.redirect("/battle");
        if (choice === "undo") session.pendingChoices[slot] = null;
        else if (choice) session.pendingChoices[slot] = choice;
      }

      const complete = session.pendingChoices.every((value, i) => value || (Array.isArray(reqData.forceSwitch) && reqData.forceSwitch[i] === false && reqData.active[i] == null));
      if (complete) {
        const combined = session.pendingChoices.map((value) => value || "pass").join(",");
        const rqid = reqData.rqid;
        session.sendToRoom(session.state_.roomId, `/choose ${combined}${rqid !== undefined ? `|${rqid}` : ""}`);
        session.pendingChoices = [];
        session.state_.request = null;
      }
      return res.redirect("/battle");
    }

    if (req.path === "/team-order" && req.method === "GET") {
      const reqData = session.state_.request;
      const order = String(req.query.order || "").replace(/[^1-9]/g, "");
      const size = reqData?.side?.pokemon?.length || 0;
      if (!reqData?.teamPreview || !session.state_.roomId || !size || !order) return res.redirect("/battle");
      if (order.length !== size || new Set(order.split("")).size !== size) return res.redirect("/battle");
      session.sendToRoom(session.state_.roomId, `/choose team ${order}|${reqData.rqid || ""}`);
      session.pendingChoices = [];
      session.state_.request = null;
      return res.redirect("/battle");
    }

    // Incoming OU challenges need the selected account team before /accept.
    if (req.path === "/accept" && req.method === "GET" && req.query.user) {
      const user = String(req.query.user);
      const format = session.state_.challengesFrom?.[user];
      if (format === TEAM_FORMAT) {
        if (!teamOwnerMatches(session)) return res.redirect(`/teams?format=${encodeURIComponent(TEAM_FORMAT)}`);
        await session.ensureConnected();
        await session.autoRelogin();
        session.send("|/utm " + session.state_.selectedTeam.packed);
        session.send(`|/accept ${user}`);
        return res.redirect("/");
      }
    }

    await session.handleRequest(req, res);
  } catch (err) {
    return renderPageError(res, err?.message || "Unexpected server error.", 503);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PS CloudPhone running on port ${PORT}`));
