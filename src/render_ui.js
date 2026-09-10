import { normalizeName, spriteUrl, typeEffectiveness } from "./protocol.js";
import { teamMatchesFormat, unpackTeamPreview } from "./team_store.js";

export const FORMATS = [
  ["gen9randombattle", "Gen 9 Random Battle"],
  ["gen9championsrandombattle", "Gen 9 Champions Random Battle"],
  ["gen9doublerandombattle", "Gen 9 Random Doubles Battle"],
  ["gen9championsdoublerandombattle", "Gen 9 Champions Random Doubles Battle"],
  ["gen9ou", "Gen 9 OU"],
];

export const RANDOM_FORMATS = FORMATS.filter(([id]) => id !== "gen9ou");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function page(title, body, refresh = 0) {
  const refreshTag = refresh ? `<meta http-equiv="refresh" content="${refresh}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refreshTag}<title>${esc(title)}</title><style>
body{font-family:sans-serif;font-size:14px;margin:8px;background:#111;color:#eee}a{color:#7ec3ff}h1{font-size:18px;margin:4px 0}h2{font-size:15px;margin:12px 0 4px}.muted{color:#999;font-size:12px}.chip{display:inline-block;border:1px solid #555;border-radius:4px;padding:0 4px;margin:0 4px 2px 0;font-size:12px}.hp{font-weight:bold}a.row{display:block;border:1px solid #444;border-radius:6px;padding:6px;margin:6px 0;text-decoration:none;background:#1c1c22;color:#eee}.row img{display:block;margin:0 auto 4px}.log{font-size:13px;border:1px solid #333;border-radius:6px;padding:6px}.banner{background:#2a2510;border:1px solid #775500;padding:6px;border-radius:4px;margin:6px 0;font-size:12px}input[type=text],input[type=password],select{font-size:16px;width:92%}input[type=submit]{font-size:16px}form{margin:6px 0}hr{border:0;border-top:1px solid #333;margin:10px 0}</style></head><body>${body}</body></html>`;
}

function sideFor(state, which) {
  const mine = state.mySide || "p1";
  return which === "my" ? mine : mine === "p1" ? "p2" : "p1";
}

function activeFor(state, which) {
  const side = sideFor(state, which);
  return Object.entries(state.active || {})
    .filter(([slot]) => slot.startsWith(side))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, mon]) => mon);
}

function hpText(condition) {
  if (!condition) return "?";
  if (condition === "0 fnt") return "fainted";
  const m = String(condition).match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(?:\s+(.*))?$/);
  if (!m) return condition;
  const pct = Math.round((Number(m[1]) / Math.max(1, Number(m[2]))) * 100);
  return `${pct}%${m[3] ? ` [${m[3]}]` : ""}`;
}

function statsText(stats) {
  if (!stats) return "";
  return `${stats.atk}/${stats.def}/${stats.spa}/${stats.spd}/${stats.spe}`;
}

function statFactor(stage) {
  const n = Math.max(-6, Math.min(6, Number(stage) || 0));
  return n >= 0 ? (2 + n) / 2 : 2 / (2 - n);
}

function adjustedSpeed(speed, stage) {
  return Number.isFinite(speed) ? Math.floor(speed * statFactor(stage)) : null;
}

function renderIntel(state) {
  const ownReq = state.request?.side?.pokemon?.find((p) => p.active);
  const own = activeFor(state, "my")[0];
  const opp = activeFor(state, "opp")[0];
  if (!ownReq || !own || !opp) return "";

  let body = "";
  if (Number.isFinite(ownReq.stats?.spe) && Number.isFinite(opp.predictedSpeed)) {
    const ownSpeed = adjustedSpeed(ownReq.stats.spe, own.boosts?.spe || 0);
    const oppSpeed = adjustedSpeed(opp.predictedSpeed, opp.boosts?.spe || 0);
    const verdict = ownSpeed > oppSpeed ? "You are faster" : ownSpeed < oppSpeed ? "Opponent is faster" : "Speed tie";
    body += `<h2>Speed comparison</h2><div>You: ${ownSpeed} Spe${own.boosts?.spe ? ` (${ownReq.stats.spe}, ${own.boosts.spe > 0 ? "+" : ""}${own.boosts.spe})` : ""}</div><div>Opponent: ~${oppSpeed} Spe${opp.boosts?.spe ? ` (~${opp.predictedSpeed}, ${opp.boosts.spe > 0 ? "+" : ""}${opp.boosts.spe})` : " (base-stat estimate)"}</div><div><strong>${esc(verdict)}</strong></div>`;
    body += `<div class="muted">Opponent Speed is estimated because EVs, nature, item and some abilities are hidden.</div>`;
  }

  const ownTypes = own.types || ownReq.types || [];
  const oppTypes = opp.types || [];
  const moves = (state.request?.active || [])[0]?.moves || [];
  if (ownReq.stats && ownTypes.length && oppTypes.length) {
    const meaningful = moves.filter((m) => !m.disabled && m.category !== "Status" && Number(m.basePower) > 0);
    const rows = meaningful.map((m) => ({
      name: m.move,
      power: Number(m.basePower),
      type: m.type,
      mult: m.type ? typeEffectiveness(m.type, oppTypes) : 1,
      category: m.category,
    })).filter((m) => m.type);
    if (rows.length) {
      body += `<h2>Damage / KO estimate</h2><div class="muted">Approximate; hidden opponent stats are inferred from base stats.</div>`;
      const oppEntry = state.active && Object.values(state.active).find((m) => normalizeName(m.species) === normalizeName(opp.species)) || opp;
      for (const m of rows) {
        const attacker = m.category === "Physical" ? ownReq.stats.atk : ownReq.stats.spa;
        const baseDef = Number(oppEntry?.predictedDefense?.[m.category === "Physical" ? "def" : "spd"]);
        const fallback = Number.isFinite(baseDef) ? baseDef : null;
        if (!Number.isFinite(attacker) || !fallback || !own.level) continue;
        const stab = ownTypes.includes(m.type) ? 1.5 : 1;
        const base = Math.floor(Math.floor(Math.floor((2 * own.level) / 5 + 2) * m.power * attacker / fallback) / 50) + 2;
        const max = Math.max(1, Math.floor(base * stab * m.mult));
        const hpMatch = String(opp.condition || "").match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/);
        const current = hpMatch ? Number(hpMatch[1]) : null;
        const hits = current ? Math.max(1, Math.ceil(current / max)) : null;
        body += `<div>${esc(m.name)}: ~${max} dmg (${m.mult}x)${hits ? ` — ${hits} hit KO at max roll` : ""}</div>`;
      }
    }
  }
  return body;
}

function renderDossier(state) {
  const entries = Object.values(state.revealed?.[sideFor(state, "opp")] || {});
  if (!entries.length) return "";
  entries.sort((a, b) => (b.lastSeenTurn || 0) - (a.lastSeenTurn || 0));
  const active = activeFor(state, "opp");
  let body = `<h2>Opponent dossier (${entries.length})</h2>`;
  for (const e of entries) {
    const isActive = active.some((m) => normalizeName(m.species) === normalizeName(e.species) && m.condition !== "0 fnt");
    body += `<div><strong>${esc(e.species)}</strong>${isActive ? " (active)" : ""}`;
    if (e.types?.length) body += ` [${esc(e.types.join("/"))}${e.teraType ? ` Tera ${esc(e.teraType)}` : ""}]`;
    body += `<br>HP: ${esc(hpText(e.condition))} | Ability: ${esc(e.ability || "?")} | Item: ${esc(e.item || "?")}`;
    body += `<br>Seen moves: ${esc(e.usedMoves?.length ? e.usedMoves.join(", ") : "none")}`;
    body += `<br><span class="muted">Last seen turn ${esc(e.lastSeenTurn ?? 0)}</span></div><hr>`;
  }
  return body;
}

function renderField(state) {
  const f = state.field || {};
  const mine = f.sides?.[sideFor(state, "my")] || [];
  const opp = f.sides?.[sideFor(state, "opp")] || [];
  if (!f.weather && !f.fields?.length && !mine.length && !opp.length) return "";
  const bits = [];
  if (f.weather) bits.push(`Weather: ${f.weather}`);
  bits.push(...(f.fields || []));
  let body = `<h2>Field</h2><div>${bits.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</div>`;
  if (mine.length) body += `<div>Your side: ${mine.map((x) => esc(x.name) + (x.count > 1 ? ` x${x.count}` : "")).join(", ")}</div>`;
  if (opp.length) body += `<div>Opponent's side: ${opp.map((x) => esc(x.name) + (x.count > 1 ? ` x${x.count}` : "")).join(", ")}</div>`;
  return body;
}

function renderRevealedTeam(state) {
  const entries = Object.values(state.revealed?.[sideFor(state, "opp")] || {});
  if (!entries.length) return "";
  return `<h2>Opponent team seen</h2><div>${entries.map((e) => `- ${esc(e.species)}${e.types?.length ? ` [${esc(e.types.join("/"))}]` : ""}${e.condition ? ` — ${esc(hpText(e.condition))}` : ""}`).join("<br>")}</div>`;
}

function moveTargetLinks(slot, moveIndex, move, mega) {
  const base = `move ${moveIndex}`;
  const action = (suffix, label) => {
    const choice = `${base}${mega ? " mega" : ""}${suffix ? ` ${suffix}` : ""}`;
    return `<a href="/doublechoose?slot=${slot}&choice=${encodeURIComponent(choice)}">${label}</a>`;
  };
  const target = String(move.target || "normal");
  if (target === "normal" || target === "adjacentFoe") {
    return `${action("+1", "target 1")} | ${action("+2", "target 2")}`;
  }
  return action("", mega ? "Mega" : "Use");
}

function renderDoubleRequests(state) {
  const req = state.request;
  const activeReqs = req?.active || [];
  const force = Array.isArray(req?.forceSwitch) ? req.forceSwitch : [];
  let body = `<h2>Doubles actions</h2>`;
  if (state.pendingChoices?.length) body += `<div class="banner">Selected: ${state.pendingChoices.map((x, i) => x ? `Slot ${i + 1}: ${x}` : `Slot ${i + 1}: not selected`).join(" | ")}</div>`;

  for (let slot = 0; slot < activeReqs.length; slot++) {
    const a = activeReqs[slot] || {};
    body += `<h2>Slot ${slot + 1}</h2>`;
    if (state.pendingChoices?.[slot]) {
      body += `<div><strong>Selected:</strong> ${esc(state.pendingChoices[slot])} <a href="/doublechoose?slot=${slot}&choice=undo">[undo]</a></div>`;
    }
    const mustSwitch = !!force[slot];
    if (mustSwitch) {
      body += `<div class="muted">This slot must switch.</div>`;
      (req.side?.pokemon || []).forEach((p, i) => {
        if (p.active || p.condition === "0 fnt") return;
        const species = (p.details || "").split(",")[0];
        body += `<p><a href="/doublechoose?slot=${slot}&choice=${encodeURIComponent(`switch ${i + 1}`)}">${i + 1}. ${esc(species)}</a></p>`;
      });
      continue;
    }

    const moves = a.moves || [];
    moves.forEach((m, i) => {
      if (m.disabled) {
        body += `<div>${i + 1}. ${esc(m.move)} (disabled)</div>`;
        return;
      }
      const mega = !!a.canMegaEvolve;
      body += `<p>${i + 1}. <strong>${esc(m.move)}</strong> [${esc(m.type || "?")}] ${moveTargetLinks(slot, i + 1, m, false)}${mega ? ` | ${moveTargetLinks(slot, i + 1, m, true)}` : ""}</p>`;
    });

    body += `<div>Switch:</div>`;
    (req.side?.pokemon || []).forEach((p, i) => {
      if (p.active || p.condition === "0 fnt") return;
      const species = (p.details || "").split(",")[0];
      body += `<p><a href="/doublechoose?slot=${slot}&choice=${encodeURIComponent(`switch ${i + 1}`)}">${i + 1}. ${esc(species)}</a></p>`;
    });
  }
  body += `<p><a href="/doublechoose?slot=all&choice=default">Use default for all unselected slots</a></p>`;
  return body;
}

function renderTeamPreview(state) {
  const pokemon = state.request?.side?.pokemon || [];
  const doubles = (state.request?.active || []).length > 1 || String(state.roomTitle || "").toLowerCase().includes("doubles");
  if (!pokemon.length) return "";
  let body = `<h2>Team preview</h2>`;
  if (doubles) {
    body += `<div class="muted">Choose the first two Pokémon; the remaining order stays unchanged.</div>`;
    for (let i = 0; i < pokemon.length; i++) {
      if (pokemon[i].condition === "0 fnt") continue;
      for (let j = i + 1; j < pokemon.length; j++) {
        if (pokemon[j].condition === "0 fnt") continue;
        const order = [i + 1, j + 1, ...pokemon.map((_, k) => k + 1).filter((n) => n !== i + 1 && n !== j + 1)].join("");
        const a = (pokemon[i].details || "").split(",")[0];
        const b = (pokemon[j].details || "").split(",")[0];
        body += `<p><a href="/team-order?order=${encodeURIComponent(order)}">${i + 1}/${j + 1}: ${esc(a)} + ${esc(b)}</a></p>`;
      }
    }
  } else {
    pokemon.forEach((p, i) => {
      if (p.condition === "0 fnt") return;
      const species = (p.details || "").split(",")[0];
      body += `<p><a href="/lead?i=${i + 1}">${i + 1}. ${esc(species)}</a></p>`;
    });
  }
  return body;
}

export function renderHome(state) {
  let body = `<h1>PS CloudPhone</h1><div>${state.connected ? `Connected as ${esc(state.username || "guest")}` : "Not connected yet."}${state.loggedIn ? " (logged in)" : ""}</div>`;
  if (state.ipLocked) body += `<div class="banner"><strong>Showdown proxy warning:</strong> ${esc(state.ipLockedMsg || "connection flagged")}</div>`;
  if (state.serverMsg && !state.ipLocked) body += `<div class="banner">${esc(state.serverMsg)} <a href="/dismiss?from=/">[OK]</a></div>`;
  if (state.notice) body += `<p>${esc(state.notice)}</p>`;

  if (state.roomId && !state.ended) body += `<p><strong><a href="/battle">&gt; Resume battle</a></strong></p>`;

  body += `<h2>Random battles</h2>`;
  for (const [id, label] of RANDOM_FORMATS) body += `<div><a href="/search?format=${encodeURIComponent(id)}">${esc(label)}</a></div>`;
  body += `<h2>Gen 9 OU</h2><div><a href="/teams?format=gen9ou">Choose uploaded OU team</a></div>`;
  if (state.selectedTeam) body += `<p class="muted">Selected team: ${esc(state.selectedTeam.name)}</p>`;

  const incoming = Object.entries(state.challengesFrom || {});
  if (incoming.length) {
    body += `<h2>Challenges</h2>`;
    for (const [user, format] of incoming) {
      body += `<div>${esc(user)} challenged you to ${esc(format)}</div><div><a href="/accept?user=${encodeURIComponent(user)}">Accept</a> | <a href="/reject?user=${encodeURIComponent(user)}">Reject</a></div>`;
    }
  }

  body += `<p><a href="/login">Login</a> | <a href="/logout">Logout</a> | <a href="/reconnect">Reconnect</a> | <a href="/dex">Pokédex</a> | <a href="/typechart">Type Chart</a> | <a href="/commands">Commands</a></p>`;
  const refresh = state.searching?.length ? 6 : 0;
  if (state.searching?.length) body += `<p>Searching: ${esc(state.searching.join(", "))} — <a href="/">Refresh</a> | <a href="/cancelsearch">Cancel</a></p>`;
  return page("PS CloudPhone", body, refresh);
}

function renderActiveMon(info, own, ownReq) {
  if (!info) return `<div class="muted">?</div>`;
  const imgUrl = own ? (info.spriteBack || info.spriteFront) : info.spriteFront;
  let body = imgUrl ? `<img src="${esc(imgUrl)}" alt="" width="80">` : "";
  body += `<div><strong>${esc(info.species || info.nickname || "?")}</strong>`;
  if (info.nickname && info.nickname !== info.species) body += ` (${esc(info.nickname)})`;
  if (info.level && info.level !== 100) body += ` L${esc(info.level)}`;
  if (info.types?.length) body += ` <span class="chip">${esc(info.types.join("/"))}${info.teraType ? ` Tera ${esc(info.teraType)}` : ""}</span>`;
  body += `</div><div class="hp">${esc(hpText(info.condition))}</div>`;
  if (own && ownReq?.stats) body += `<div class="muted">Atk/Def/SpA/SpD/Spe: ${esc(statsText(ownReq.stats))}</div>`;
  if (!own) {
    if (info.ability) body += `<div>Ability: ${esc(info.ability)} (revealed)</div>`;
    else if (info.possibleAbilities?.length) body += `<div class="muted">Possible abilities: ${esc(info.possibleAbilities.join(" / "))}</div>`;
    if (info.item) body += `<div>Item: ${esc(info.item)} (revealed)</div>`;
    if (info.predictedSpeed != null) body += `<div>Predicted Spe: ~${esc(info.predictedSpeed)}</div>`;
    if (info.usedMoves?.length) body += `<div class="muted">Seen moves: ${esc(info.usedMoves.join(", "))}</div>`;
  }
  return body;
}

export function renderBattle(state) {
  const req = state.request;
  const doubles = (req?.active || []).length > 1;
  const mine = activeFor(state, "my");
  const opp = activeFor(state, "opp");
  const ownReq = req?.side?.pokemon?.find((p) => p.active) || req?.side?.pokemon?.[0];

  let body = `<h1>${esc(state.roomTitle || "Battle")}</h1><div>Turn ${esc(state.turn || 0)}${state.ended ? " - battle over" : ""}</div>`;
  if (state.serverMsg && !state.ipLocked) body += `<div class="banner">${esc(state.serverMsg)}</div>`;
  body += `<p><a href="/battle">Refresh</a> | <a href="/">Home</a>${state.ended ? "" : ` | <a href="/timer">${state.timerOn ? "Timer off" : "Timer on"}</a>`}</p>`;

  body += `<h2>You</h2>`;
  mine.forEach((m, i) => { body += `<div><strong>Slot ${i + 1}</strong></div>${renderActiveMon(m, true, i === 0 ? ownReq : null)}`; });
  body += `<h2>Opponent</h2>`;
  opp.forEach((m, i) => { body += `<div><strong>Slot ${i + 1}</strong></div>${renderActiveMon(m, false, null)}`; });

  body += renderDossier(state);
  body += renderRevealedTeam(state);
  body += renderField(state);
  body += renderIntel(state);

  if (state.ended) {
    body += `<h2>Result</h2><div>${esc(state.resultMsg || "Battle ended.")}</div><p><a href="/newgame">Start another battle</a></p>`;
  } else if (req?.teamPreview) {
    body += renderTeamPreview(state);
  } else if (doubles && req?.active) {
    body += renderDoubleRequests(state);
  } else if (req?.forceSwitch) {
    body += `<h2>Choose a Pokémon to send out</h2>`;
    (req.side?.pokemon || []).forEach((p, i) => {
      if (p.active || p.condition === "0 fnt") return;
      const species = (p.details || "").split(",")[0];
      body += `<p><a href="/choose?value=${encodeURIComponent(`switch ${i + 1}`)}">${i + 1}. ${esc(species)}</a></p>`;
    });
  } else if (req?.active) {
    const active = req.active[0] || {};
    body += `<h2>Choose a move</h2>`;
    (active.moves || []).forEach((m, i) => {
      if (m.disabled) body += `<div>${i + 1}. ${esc(m.move)} [${esc(m.type || "?")}] (disabled)</div>`;
      else body += `<p><a href="/choose?value=${encodeURIComponent(`move ${i + 1}`)}">${i + 1}. ${esc(m.move)} [${esc(m.type || "?")}]</a>${m.oppMult !== undefined ? ` <span class="chip">x${esc(m.oppMult)}</span>` : ""}</p>`;
      if (m.shortDesc) body += `<div class="muted">${esc(m.shortDesc.slice(0, 120))}</div>`;
      if (m.disabled) return;
      if (active.canMegaEvolve) body += `<p><a href="/choose?value=${encodeURIComponent(`move ${i + 1} mega`)}">${i + 1}. ${esc(m.move)} + MEGA</a></p>`;
    });
    body += `<h2>Switch</h2>`;
    (req.side?.pokemon || []).forEach((p, i) => {
      if (p.active || p.condition === "0 fnt") return;
      const species = (p.details || "").split(",")[0];
      body += `<p><a href="/choose?value=${encodeURIComponent(`switch ${i + 1}`)}">${i + 1}. ${esc(species)}</a></p>`;
    });
  } else {
    body += `<p>Waiting for the other player...</p>`;
  }

  body += `<h2>Log</h2><div class="log">${(state.log || []).slice(-30).map((l) => `<div>${esc(l)}</div>`).join("") || '<div class="muted">(no messages yet)</div>'}</div>`;
  body += `<h2>Chat</h2><div class="log">${(state.chat || []).slice(-15).map((l) => `<div>${esc(l)}</div>`).join("") || '<div class="muted">(no chat yet)</div>'}</div>`;
  if (!state.ended && state.roomId) body += `<form method="post" action="/chat"><input type="text" name="msg" maxlength="200"><input type="submit" value="Send chat"></form>`;
  return page(state.roomTitle || "Battle", body, req ? 0 : 7);
}

export function renderTeams(teams, state, format = "gen9ou") {
  const eligible = (teams || []).filter((t) => teamMatchesFormat(t, format));
  let body = `<h1>Choose OU team</h1><div class="muted">Teams are read from your logged-in Pokémon Showdown account.</div>`;
  if (!eligible.length) body += `<p>No uploaded Gen 9 OU teams were found.</p>`;
  for (const team of eligible) {
    const mons = unpackTeamPreview(team.packed);
    body += `<a class="row" href="/select-team?id=${encodeURIComponent(team.id)}&format=${encodeURIComponent(format)}"><strong>${esc(team.name)}</strong><br><span class="muted">${esc(mons.join(", "))}</span></a>`;
  }
  body += `<p><a href="/teams?format=${encodeURIComponent(format)}">Refresh teams</a> | <a href="/">Home</a></p>`;
  return page("Choose team", body, 0);
}

export function renderTeamError(message) {
  return page("Team error", `<h1>Team error</h1><p>${esc(message)}</p><p><a href="/teams?format=gen9ou">Back to teams</a> | <a href="/">Home</a></p>`);
}
