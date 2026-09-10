import { BattleSession as BaseBattleSession } from "./battle_session.js";
import { FORMATS, renderBattle as renderModeBattle, renderTeams } from "./render_ui.js";
import { renderEnhancedBattle } from "./battle_intel.js";
import { fetchRemoteTeams, teamMatchesFormat } from "./team_store.js";

const FORMAT_IDS = new Set(FORMATS.map(([id]) => id));
const TEAM_FORMAT = "gen9ou";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function htmlPage(title, body, refresh = 0) {
  const tag = refresh ? `<meta http-equiv="refresh" content="${refresh}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${tag}<style>body{font-family:sans-serif;font-size:14px;margin:8px;background:#111;color:#eee}a{color:#7ec3ff}h1{font-size:18px;margin:4px 0}h2{font-size:15px;margin:12px 0 4px}.muted{color:#999;font-size:12px}.chip{display:inline-block;border:1px solid #555;border-radius:4px;padding:0 4px;margin:0 4px 2px 0;font-size:12px}.banner{background:#2a2510;border:1px solid #775500;padding:6px;border-radius:4px;margin:6px 0;font-size:12px}input[type=text],input[type=password],select{font-size:16px;width:92%}input[type=submit]{font-size:16px}form{margin:6px 0}hr{border:0;border-top:1px solid #333;margin:10px 0}.row{display:block;border:1px solid #444;border-radius:6px;padding:6px;margin:6px 0;text-decoration:none;background:#1c1c22;color:#eee}</style></head><body>${body}</body></html>`;
}

function extractSection(html, heading) {
  const marker = `<h2>${heading}</h2>`;
  const start = html.indexOf(marker);
  if (start === -1) return "";
  const rest = html.slice(start + marker.length);
  const next = rest.indexOf("<h2>");
  return next === -1 ? html.slice(start) : html.slice(start, start + marker.length + next);
}

function removeSection(html, heading) {
  const marker = `<h2>${heading}</h2>`;
  const start = html.indexOf(marker);
  if (start === -1) return html;
  const rest = html.slice(start + marker.length);
  const next = rest.indexOf("<h2>");
  const end = next === -1 ? html.length : start + marker.length + next;
  return html.slice(0, start) + html.slice(end);
}

function allowedFormat(format) {
  return FORMAT_IDS.has(String(format || ""));
}

function ownerMatches(state) {
  const owner = String(state.selectedTeamOwner || "").toLowerCase();
  const current = String(state.username || state.loginName || "").toLowerCase();
  return !!(state.selectedTeam?.packed && owner && current && owner === current);
}

function teamError(message) {
  return htmlPage(
    "Team error",
    `<h1>Team error</h1><p>${esc(message)}</p><p><a href="/teams?format=gen9ou">Back to teams</a> | <a href="/">Home</a></p>`
  );
}

export class BattleSession extends BaseBattleSession {
  constructor(ctx, env) {
    super(ctx, env);
    this.teamCache = null;
    this.pendingChoices = [];
  }

  resetBattle() {
    super.resetBattle();
    this.pendingChoices = [];
    if (this.state_) this.state_.pendingChoices = [];
  }

  async startSearch(format, packedTeam = null) {
    await this.ensureConnected();
    if (this.state_.loginName) await this.autoRelogin();

    if (this.state_.roomId) {
      try { this.sendToRoom(this.state_.roomId, "/leave"); } catch {}
      this.resetBattle();
    }

    if (this.state_.searching?.length) {
      try { this.send("|/cancelsearch"); } catch {}
      this.state_.searching = [];
    }

    this.send(`|/utm ${packedTeam || "null"}`);
    this.send(`|/search ${format}`);

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (this.state_.roomId && !this.state_.ended) return true;
      if ((this.state_.searching || []).includes(format)) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  renderHome() {
    const s = this.state_;
    let body = `<h1>PS CloudPhone</h1>`;
    body += `<div>${s.connected ? `Connected as ${esc(s.username || "guest")}` : "Not connected yet."}${s.loggedIn ? " (logged in)" : ""}</div>`;
    if (s.serverMsg && !s.ipLocked) body += `<div class="banner">${esc(s.serverMsg)} <a href="/dismiss?from=/">[OK]</a></div>`;
    if (s.ipLocked) body += `<div class="banner"><strong>Showdown proxy warning:</strong> ${esc(s.ipLockedMsg || "connection flagged")}</div>`;
    if (s.notice) body += `<p>${esc(s.notice)}</p>`;
    if (s.roomId && !s.ended) body += `<p><strong><a href="/battle">&gt; Resume battle</a></strong></p>`;

    body += `<h2>Random battles</h2>`;
    for (const [id, label] of FORMATS) {
      if (id === TEAM_FORMAT) continue;
      body += `<div><a href="/search?format=${encodeURIComponent(id)}">${esc(label)}</a></div>`;
    }

    body += `<h2>Gen 9 OU</h2>`;
    body += `<div><a href="/teams?format=${TEAM_FORMAT}">Choose uploaded OU team</a></div>`;
    if (s.selectedTeam && ownerMatches(s)) body += `<div class="muted">Selected team: ${esc(s.selectedTeam.name)}</div>`;

    const incoming = Object.entries(s.challengesFrom || {});
    if (incoming.length) {
      body += `<h2>Challenges</h2>`;
      for (const [user, format] of incoming) {
        body += `<div>${esc(user)} challenged you to ${esc(format)}</div>`;
        body += `<div><a href="/accept?user=${encodeURIComponent(user)}">Accept</a> | <a href="/reject?user=${encodeURIComponent(user)}">Reject</a></div>`;
      }
    }

    body += `<h2>Battle a friend</h2>`;
    body += `<form method="post" action="/challenge"><div><label>Username<br><input type="text" name="username"></label></div><div><label>Format<br><select name="format">${FORMATS.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join("")}</select></label></div><div><input type="submit" value="Challenge"></div></form>`;

    body += `<p><a href="/login">Login</a> | <a href="/logout">Logout</a> | <a href="/reconnect">Reconnect</a> | <a href="/dex">Pokédex</a> | <a href="/typechart">Type Chart</a> | <a href="/commands">Commands</a></p>`;
    if (s.searching?.length) body += `<p>Searching: ${esc(s.searching.join(", "))} — <a href="/">Refresh</a> | <a href="/cancelsearch">Cancel</a></p>`;
    return htmlPage("PS CloudPhone", body, s.searching?.length ? 6 : 0);
  }

  async renderBattlePage() {
    this.state_.pendingChoices = Array.isArray(this.pendingChoices) ? [...this.pendingChoices] : [];
    let html = renderModeBattle(this.state_);
    try {
      html = removeSection(html, "Damage / KO estimate");
      const enhanced = await renderEnhancedBattle(this.state_);
      const damage = extractSection(enhanced, "Damage / KO estimator");
      const switches = extractSection(enhanced, "Smart switch recommendations");
      const marker = "<h2>Log</h2>";
      if (damage || switches) html = html.replace(marker, `${damage}${switches}${marker}`);
    } catch {}
    return html;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/" && request.method === "GET") {
        await this.ensureConnected();
        return this.htmlResponse(this.renderHome());
      }

      if (path === "/battle" && request.method === "GET") {
        if (!this.state_.roomId) return Response.redirect(new URL("/", url), 302);
        await this.ensureConnected();
        return this.htmlResponse(await this.renderBattlePage());
      }

      if (path === "/teams" && request.method === "GET") {
        const format = String(url.searchParams.get("format") || TEAM_FORMAT);
        if (format !== TEAM_FORMAT) return new Response(teamError("Only Gen 9 OU uses uploaded teams."), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
        await this.ensureConnected();
        if (this.state_.loginName) await this.autoRelogin();
        if (!this.state_.loginName || !this.state_.upstreamCookie) {
          this.state_.notice = "Log in first to load your uploaded teams.";
          await this.save();
          return Response.redirect(new URL("/login", url), 302);
        }
        this.teamCache = await fetchRemoteTeams(this.state_.upstreamCookie);
        return this.htmlResponse(renderTeams(this.teamCache, this.state_, format));
      }

      if (path === "/select-team" && request.method === "GET") {
        const format = String(url.searchParams.get("format") || TEAM_FORMAT);
        const id = String(url.searchParams.get("id") || "");
        if (format !== TEAM_FORMAT || !id) return new Response(teamError("Invalid team selection."), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
        await this.ensureConnected();
        if (this.state_.loginName) await this.autoRelogin();
        if (!this.state_.loginName || !this.state_.upstreamCookie) return Response.redirect(new URL("/login", url), 302);

        if (!Array.isArray(this.teamCache)) this.teamCache = await fetchRemoteTeams(this.state_.upstreamCookie);
        const selected = this.teamCache.find((team) => team.id === id && teamMatchesFormat(team, format));
        if (!selected) return new Response(teamError("That team is no longer available on your account."), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });

        this.state_.selectedTeam = {
          id: selected.id,
          name: selected.name,
          format: selected.format,
          packed: selected.packed,
        };
        this.state_.selectedTeamOwner = String(this.state_.username || this.state_.loginName || "").toLowerCase();
        this.state_.notice = `Selected team: ${selected.name}`;
        await this.save();
        return Response.redirect(new URL(`/search?format=${TEAM_FORMAT}`, url), 302);
      }

      if (path === "/search" && request.method === "GET") {
        const format = String(url.searchParams.get("format") || "gen9randombattle");
        if (!allowedFormat(format)) {
          this.state_.notice = `Unsupported format: ${format}`;
          await this.save();
          return Response.redirect(new URL("/", url), 302);
        }

        if (format === TEAM_FORMAT) {
          if (!ownerMatches(this.state_)) return Response.redirect(new URL(`/teams?format=${TEAM_FORMAT}`, url), 302);
          const teamName = this.state_.selectedTeam.name;
          const ok = await this.startSearch(format, this.state_.selectedTeam.packed);
          this.state_.notice = ok ? `Searching for ${format} with ${teamName}...` : `Searching for ${format}...`;
          await this.save();
          if (this.state_.roomId) return Response.redirect(new URL("/battle", url), 302);
          return Response.redirect(new URL("/", url), 302);
        }

        return super.fetch(request);
      }

      if (path === "/challenge" && request.method === "POST") {
        const params = await this.readForm(request);
        const target = (params.get("username") || "").trim();
        const format = String(params.get("format") || "gen9randombattle");
        if (!target || !allowedFormat(format)) return Response.redirect(new URL("/", url), 302);
        await this.ensureConnected();
        if (this.state_.loginName) await this.autoRelogin();

        if (format === TEAM_FORMAT) {
          if (!ownerMatches(this.state_)) return Response.redirect(new URL(`/teams?format=${TEAM_FORMAT}`, url), 302);
          this.send(`|/utm ${this.state_.selectedTeam.packed}`);
        } else {
          this.send("|/utm null");
        }
        this.send(`|/challenge ${target}, ${format}`);
        this.state_.notice = `Challenge sent to ${target}.`;
        await this.save();
        return Response.redirect(new URL("/", url), 302);
      }

      if (path === "/accept" && request.method === "GET") {
        const user = String(url.searchParams.get("user") || "");
        const format = String(this.state_.challengesFrom?.[user] || "");
        if (user && format === TEAM_FORMAT) {
          if (!ownerMatches(this.state_)) return Response.redirect(new URL(`/teams?format=${TEAM_FORMAT}`, url), 302);
          await this.ensureConnected();
          if (this.state_.loginName) await this.autoRelogin();
          this.send(`|/utm ${this.state_.selectedTeam.packed}`);
          this.send(`|/accept ${user}`);
          await this.save();
          return Response.redirect(new URL("/", url), 302);
        }
        if (user && allowedFormat(format)) return super.fetch(request);
        return Response.redirect(new URL("/", url), 302);
      }

      if (path === "/doublechoose" && request.method === "GET") {
        const reqData = this.state_.request;
        if (!reqData?.active || reqData.active.length < 2 || !this.state_.roomId) return Response.redirect(new URL("/battle", url), 302);
        if (!Array.isArray(this.pendingChoices) || this.pendingChoices.length !== reqData.active.length) {
          this.pendingChoices = Array(reqData.active.length).fill(null);
        }
        this.state_.pendingChoices = [...this.pendingChoices];

        const slotRaw = String(url.searchParams.get("slot") || "");
        let choice = String(url.searchParams.get("choice") || "");
        choice = choice.replace(/^(move\s+\d+)\s+mega\s+([+-]\d+)$/i, "$1 $2 mega");

        if (slotRaw === "all" && choice === "default") {
          const force = Array.isArray(reqData.forceSwitch) ? reqData.forceSwitch : [];
          for (let i = 0; i < reqData.active.length; i++) {
            if (!force[i] && !this.pendingChoices[i]) this.pendingChoices[i] = "default";
          }
        } else {
          const slot = Number(slotRaw);
          if (!Number.isInteger(slot) || slot < 0 || slot >= reqData.active.length) return Response.redirect(new URL("/battle", url), 302);
          if (choice === "undo") this.pendingChoices[slot] = null;
          else if (choice) this.pendingChoices[slot] = choice;
        }
        this.state_.pendingChoices = [...this.pendingChoices];

        const complete = this.pendingChoices.length === reqData.active.length && this.pendingChoices.every(Boolean);
        if (complete) {
          const combined = this.pendingChoices.join(",");
          this.sendToRoom(this.state_.roomId, `/choose ${combined}${reqData.rqid !== undefined ? `|${reqData.rqid}` : ""}`);
          this.pendingChoices = [];
          this.state_.pendingChoices = [];
          this.state_.request = null;
          await this.save();
        }
        return Response.redirect(new URL("/battle", url), 302);
      }

      if (path === "/team-order" && request.method === "GET") {
        const reqData = this.state_.request;
        const order = String(url.searchParams.get("order") || "").replace(/[^1-9]/g, "");
        const size = reqData?.side?.pokemon?.length || 0;
        if (!reqData?.teamPreview || !this.state_.roomId || !size || order.length !== size || new Set(order.split("")).size !== size) {
          return Response.redirect(new URL("/battle", url), 302);
        }
        this.sendToRoom(this.state_.roomId, `/choose team ${order}|${reqData.rqid || ""}`);
        this.pendingChoices = [];
        this.state_.pendingChoices = [];
        this.state_.request = null;
        await this.save();
        return Response.redirect(new URL("/battle", url), 302);
      }

      return super.fetch(request);
    } catch (err) {
      return new Response(htmlPage("Error", `<h1>Error</h1><p>${esc(err?.message || String(err))}</p><p><a href="/">Home</a></p>`), { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
    }
  }
}
