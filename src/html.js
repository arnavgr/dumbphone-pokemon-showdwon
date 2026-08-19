import { spriteUrl, typeEffectiveness } from "./protocol.js";

const SHOW_BACK_SPRITES_FOR_YOU = true;

const RANDOM_FORMATS = [
  ["gen9randombattle", "Gen 9 Random Battle"],
  ["gen9hackmonscup", "Gen 9 Hackmons Cup"],
  ["gen8randombattle", "Gen 8 Random Battle"],
];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function page(title, body, refresh = 0) {
  const refreshTag =
    refresh > 0 ? `<meta http-equiv="refresh" content="${refresh}">` : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshTag}
<title>${esc(title)}</title>
<style>
body{font-family:sans-serif;font-size:14px;margin:8px;background:#111;color:#eee}
a{color:#7ec3ff}
h1{font-size:18px;margin:4px 0}
h2{font-size:15px;margin:12px 0 4px}
.muted{color:#999;font-size:12px}
.chip{display:inline-block;border:1px solid #555;border-radius:4px;padding:0 4px;margin:0 4px 2px 0;font-size:12px}
.hpbar{font-weight:bold}
a.row{display:block;border:1px solid #444;border-radius:6px;padding:6px;margin:6px 0;text-decoration:none;background:#1c1c22;color:#eee}
a.row img{display:block;margin:0 auto 4px}
.log{font-size:13px;border:1px solid #333;border-radius:6px;padding:6px}
.banner{background:#2a2510;border:1px solid #775500;padding:6px;border-radius:4px;margin:6px 0;font-size:12px}
input[type=text],input[type=password],select{font-size:16px;width:92%}
input[type=submit]{font-size:16px}
form{margin:6px 0}
hr{border:0;border-top:1px solid #333;margin:10px 0}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function hpBar(cond) {
  if (!cond) return "";
  if (cond === "0 fnt") {
    return `<span class="hpbar" style="color:#bb2222">fainted</span>`;
  }
  const m = String(cond).match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(?:\s+(.*))?$/);
  if (!m) return `<span class="hpbar">${esc(cond)}</span>`;
  const cur = Number(m[1]);
  const max = Number(m[2]);
  const pct = max ? Math.max(0, Math.min(100, Math.round((cur / max) * 100))) : 0;
  const status = m[3] ? ` [${esc(m[3])}]` : "";
  const color = pct > 50 ? "#4caf50" : pct > 20 ? "#cc7700" : "#bb2222";
  return `<span class="hpbar" style="color:${color}">${pct}%${status}</span>`;
}

const BOOST_LABELS = {
  atk: "Atk", def: "Def", spa: "SpA", spd: "SpD",
  spe: "Spe", accuracy: "Acc", evasion: "Eva",
};

function boostsLine(boosts) {
  if (!boosts) return "";
  const parts = Object.entries(boosts)
    .filter(([, v]) => v)
    .map(([k, v]) => `${v > 0 ? "+" : ""}${v} ${BOOST_LABELS[k] || k}`);
  if (!parts.length) return "";
  return ` <span class="chip">${esc(parts.join(", "))}</span>`;
}

function volatilesLine(vols) {
  if (!vols || !vols.length) return "";
  const cleaned = vols.map(v => esc(v.replace(/^(move|ability|item):\s*/i, '')));
  return ` <span class="chip" style="border-color:#b88;color:#ecc">${cleaned.join(", ")}</span>`;
}

function activeForSide(state, which) {
  const mySide = state.mySide || "p1";
  const side = which === "my" ? mySide : mySide === "p1" ? "p2" : "p1";
  return Object.entries(state.active || {})
    .filter(([slot]) => slot.startsWith(side))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, info]) => info);
}

function statsLine(stats) {
  if (!stats) return null;
  return `${stats.atk}/${stats.def}/${stats.spa}/${stats.spd}/${stats.spe}`;
}

function describeMultiplier(mult) {
  if (mult === 0) return "no effect";
  if (mult >= 4) return `${mult}x - devastating`;
  if (mult === 2) return "2x - super effective";
  if (mult === 1) return "1x - neutral";
  if (mult === 0.5) return "0.5x - resisted";
  return `${mult}x - barely scratches`;
}

function multShort(mult) {
  return mult === 0 ? "x0" : `x${mult}`;
}

const WEATHER_NAMES = {
  RainDance: "Rain", SunnyDay: "Sun", Sandstorm: "Sandstorm",
  Hail: "Hail", Snow: "Snow", DesolateLand: "Harsh Sun",
  PrimordialSea: "Heavy Rain", DeltaStream: "Strong Winds",
};

function renderActive(state, which) {
  const mons = activeForSide(state, which);
  if (!mons.length) return `<div class="muted">?</div>`;

  const myActiveFull =
    which === "my"
      ? (state.request?.side?.pokemon || []).find((p) => p.active)
      : null;

  return mons
    .map((info) => {
      const url =
        which === "my" && SHOW_BACK_SPRITES_FOR_YOU
          ? info.spriteBack || info.spriteFront
          : info.spriteFront;
      const img = url ? `<img src="${esc(url)}" alt="" width="96">` : "";

      const label = info.species || info.nickname || "?";
      const nick =
        info.nickname && info.nickname !== info.species
          ? ` (${esc(info.nickname)})`
          : "";
      const lvl = info.level && info.level !== 100 ? ` L${info.level}` : "";
      const types =
        info.types && info.types.length
          ? ` <span class="chip">${esc(info.types.join("/"))}${info.teraType ? " Tera" : ""}</span>`
          : "";

      let intel = "";
      if (which === "my") {
        if (myActiveFull?.stats) {
          intel += `<div class="muted">Atk/Def/SpA/SpD/Spe: ${esc(statsLine(myActiveFull.stats))}</div>`;
        }
        const bits = [];
        if (myActiveFull?.ability) bits.push(`Ability: ${myActiveFull.ability}`);
        if (myActiveFull?.item) bits.push(`Item: ${myActiveFull.item}`);
        if (bits.length) intel += `<div class="muted">${esc(bits.join(" | "))}</div>`;
      } else if (which === "opp") {
        if (info.ability) {
          intel += `<div>Ability: ${esc(info.ability)} (revealed)</div>`;
        } else if (info.possibleAbilities && info.possibleAbilities.length) {
          intel += `<div class="muted">Possible abilities: ${esc(info.possibleAbilities.join(" / "))}</div>`;
        }
        if (info.item) intel += `<div>Item: ${esc(info.item)} (revealed)</div>`;
        if (info.predictedSpeed != null) intel += `<div>Predicted Spe: ${info.predictedSpeed}</div>`;
        if (info.usedMoves && info.usedMoves.length) {
          intel += `<div class="muted">Seen moves: ${esc(info.usedMoves.join(", "))}</div>`;
        }
      }

      return `<div>${img}<div><strong>${esc(label)}</strong>${esc(nick)}${lvl}${types}</div>
<div>${hpBar(info.condition)}${boostsLine(info.boosts)}${volatilesLine(info.volatiles)}</div>${intel}</div>`;
    })
    .join("<hr>");
}

function renderRevealed(state) {
  const mySide = state.mySide || "p1";
  const oppSide = mySide === "p1" ? "p2" : "p1";
  const entries = Object.values(state.revealed?.[oppSide] || {});
  if (!entries.length) return "";

  entries.sort((a, b) => (a.lastSeenTurn || 0) - (b.lastSeenTurn || 0));
  const oppActive = activeForSide(state, "opp")[0];

  let body = `<h2>Opponent has shown (${entries.length})</h2>`;
  for (const e of entries) {
    const isActive =
      oppActive && e.species === oppActive.species && oppActive.condition !== "0 fnt";
    const tags = [e.ability, e.item].filter(Boolean).join(" / ");
    body += `<div>- ${esc(e.species)}${e.level && e.level !== 100 ? ` L${e.level}` : ""}${
      isActive ? " <strong>(active)</strong>" : ""
    } - ${hpBar(e.condition) || "-"}${
      tags ? ` <span class="muted">[${esc(tags)}]</span>` : ""
    }</div>`;
  }
  return body;
}

function renderField(state) {
  const f = state.field || {};
  const mySide = state.mySide || "p1";
  const oppSide = mySide === "p1" ? "p2" : "p1";

  const chips = [];
  if (f.weather) chips.push(`Weather: ${WEATHER_NAMES[f.weather] || f.weather}`);
  for (const t of f.fields || []) chips.push(t);

  const sideLine = (side) =>
    (f.sides?.[side] || []).map((s) => (s.count > 1 ? `${s.name} x${s.count}` : s.name));
  const mine = sideLine(mySide);
  const opp = sideLine(oppSide);

  if (!chips.length && !mine.length && !opp.length) return "";

  let html = `<h2>Field</h2>`;
  if (chips.length) {
    html += `<div>${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>`;
  }
  if (mine.length) html += `<div>Your side: ${mine.map(esc).join(", ")}</div>`;
  if (opp.length) html += `<div>Opponent's side: ${opp.map(esc).join(", ")}</div>`;
  return html;
}

function renderTypeMatchup(state) {
  const req = state.request;
  const teamPokemon = req?.side?.pokemon;
  if (!teamPokemon || !teamPokemon.length) return "";

  const oppInfo = activeForSide(state, "opp")[0];
  const oppTypes = oppInfo?.types;
  if (!oppTypes || !oppTypes.length) return "";

  const rows = teamPokemon
    .filter((p) => p.condition !== "0 fnt")
    .map((p) => {
      const species = (p.details || "").split(",")[0];
      
      const moveTypes = p.moveTypes || [];
      const best = moveTypes.length
        ? Math.max(...moveTypes.map((t) => typeEffectiveness(t, oppTypes)))
        : null;

      const myTypes = p.types || [];
      const weakTo = [];
      const strongAgainst = [];
      const immuneTo = [];

      if (myTypes.length) {
        for (const oppType of oppTypes) {
          const defEff = typeEffectiveness(oppType, myTypes);
          if (defEff > 1) weakTo.push(oppType.toLowerCase());
          else if (defEff === 0) immuneTo.push(oppType.toLowerCase());
          else if (defEff < 1) strongAgainst.push(oppType.toLowerCase());
        }
      }

      const defParts = [];
      if (immuneTo.length) defParts.push(`immune to ${immuneTo.join("/")}`);
      if (weakTo.length) defParts.push(`weak against ${weakTo.join("/")}`);
      if (strongAgainst.length) defParts.push(`strong against ${strongAgainst.join("/")}`);

      const defLabel = defParts.length ? `, ${defParts.join(", ")}` : "";

      return {
        species,
        active: !!p.active,
        best,
        hasMoves: Array.isArray(p.moves) && p.moves.length > 0,
        defLabel 
      };
    })
    .sort((a, b) => (b.best ?? -1) - (a.best ?? -1));

  if (!rows.length) return "";

  const oppLabel = oppInfo.species || oppInfo.nickname || "the opponent";

  let body = `<h2>Type matchup vs ${esc(oppLabel)} [${esc(oppTypes.join("/"))}]</h2>`;
  for (const r of rows) {
    let label = "";
    if (r.best === null) {
      label = r.hasMoves ? "no attacking moves known" : "moves unknown";
    } else if (r.best === 1) {
      label = "1x neutral move";
    } else if (r.best >= 2) {
      label = `${r.best}x super effective move`;
    } else if (r.best === 0) {
      label = "0x no effect move";
    } else {
      label = `${r.best}x resisted move`;
    }
    
    body += `<div>${r.active ? "&gt; " : ""}${esc(r.species)}: ${esc(label)}${esc(r.defLabel)}</div>`;
  }
  return body;
}

function renderMoveDesc(m) {
  if (!m.shortDesc) return "";
  const text = m.shortDesc.length > 90 ? `${m.shortDesc.slice(0, 87)}...` : m.shortDesc;
  const moreLink = m.id
    ? ` <a href="/moveinfo?move=${encodeURIComponent(m.id)}">[More]</a>`
    : "";
  return `<div class="muted">${esc(text)}${moreLink}</div>`;
}

function switchCard(p, i, href, showNum) {
  const species = (p.details || "").split(",")[0];
  const imgUrl = spriteUrl(species, { anim: false });
  const typesText = p.types && p.types.length ? ` [${esc(p.types.join("/"))}]` : "";
  const stats = statsLine(p.stats);
  const cond = p.condition ? ` ${hpBar(p.condition)}` : "";
  const bits = [];
  if (p.ability) bits.push(`Ability: ${p.ability}`);
  if (p.item) bits.push(`Item: ${p.item}`);
  const extra = bits.length ? `<br><span class="muted">${esc(bits.join(" | "))}</span>` : "";
  return `<a class="row" href="${esc(href)}">
<img src="${esc(imgUrl)}" alt="" width="96">
<span>${showNum ? `${i + 1}. ` : ""}<strong>${esc(species)}</strong>${cond}${typesText}${
    stats ? `<br><span class="muted">Atk/Def/SpA/SpD/Spe: ${esc(stats)}</span>` : ""
  }${extra}</span>
</a>`;
}

function renderLog(log) {
  const recent = (log || []).slice(-25);
  return `<div class="log">${
    recent.map((l) => `<div>${esc(l)}</div>`).join("") ||
    '<div class="muted">(no messages yet)</div>'
  }</div>`;
}

function renderChat(state) {
  const lines = (state.chat || []).slice(-15);
  let body = `<h2>Chat</h2>`;
  body += `<div class="log">${
    lines.map((l) => `<div>${esc(l)}</div>`).join("") ||
    '<div class="muted">(no chat yet)</div>'
  }</div>`;
  if (!state.ended && state.roomId) {
    body += `<form method="post" action="/chat">
<input type="text" name="msg" maxlength="200">
<input type="submit" value="Send chat">
</form>`;
  }
  return body;
}

function renderChallenges(state) {
  let body = `<h2>Battle a friend</h2>`;

  const incoming = Object.entries(state.challengesFrom || {});
  for (const [userid, format] of incoming) {
    body += `<div>${esc(userid)} challenged you to ${esc(format)}</div>`;
    body += `<div><a href="/accept?user=${encodeURIComponent(userid)}">Accept</a> | <a href="/reject?user=${encodeURIComponent(userid)}">Reject</a></div>`;
  }

  if (state.challengeTo && state.challengeTo.to) {
    body += `<div>Challenging ${esc(state.challengeTo.to)} to ${esc(
      state.challengeTo.format || ""
    )}...</div>`;
    body += `<div><a href="/cancelchallenge">Cancel challenge</a></div>`;
  } else {
    body += `<form method="post" action="/challenge">
<div><label>Friend's username<br><input type="text" name="username"></label></div>
<div><label>Format<br><select name="format">${RANDOM_FORMATS.map(
      ([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`
    ).join("")}</select></label></div>
<div><input type="submit" value="Challenge"></div>
</form>`;
  }

  return body;
}

function renderIpLockBanner(state) {
  if (!state.ipLocked) return "";
  const since = state.ipLockedAt
    ? Math.max(0, Math.round((Date.now() - state.ipLockedAt) / 1000))
    : null;
  return `<div class="banner" style="background:#2a1010;border-color:#772222">
<strong>Connection flagged as a proxy by Showdown</strong>
<div>${esc(state.ipLockedMsg || "Showdown is treating this connection as a proxy and may close it.")}</div>
<div class="muted">This is Cloudflare's shared IP range being flagged, not your account specifically. The app reconnects itself in the background with a growing delay if the connection keeps dropping quickly, and gives up on retrying automatically after a while rather than repeatedly hitting a connection that's been flagged${
    since !== null ? ` (first seen ${since}s ago)` : ""
  }. Loading any page, or the link below, always tries again immediately.</div>
<div><a href="/reconnect">Retry connection now</a></div>
</div>`;
}

export function renderHome(state) {
  let body = `<h1>PS CloudPhone</h1>`;

  body += `<div>${
    state.connected ? `Connected as ${esc(state.username || "guest")}` : "Not connected yet."
  }${state.loggedIn ? " (logged in)" : ""}</div>`;

  body += renderIpLockBanner(state);

  if (state.serverMsg && !state.ipLocked) {
    body += `<div class="banner"><strong>Notice:</strong> ${esc(state.serverMsg)}<br><a href="/dismiss?from=/">[OK / Dismiss]</a></div>`;
  }

  if (state.notice) body += `<p>${esc(state.notice)}</p>`;
  if (state.loginError) body += `<p style="color:#b22">Login error: ${esc(state.loginError)}</p>`;

  body += `<p><a href="/">Refresh</a> | <a href="/dex">Pok&eacute;dex</a> | <a href="/debug">Debug</a> | <a href="/login">Login</a> | <a href="/logout">Logout</a> | <a href="/reconnect">Reconnect</a></p>`;

  if (state.roomId && !state.ended) {
    body += `<p><strong><a href="/battle">&gt; Resume battle in progress</a></strong></p>`;
  }

  body += renderChallenges(state);

  if (state.searching && state.searching.length) {
    body += `<h2>Searching</h2>`;
    body += `<div>${esc(state.searching.join(", "))}</div>`;
    body += `<p><a href="/">Check again</a> | <a href="/cancelsearch">Cancel search</a></p>`;
  } else {
    body += `<h2>Random battles</h2>`;
    for (const [id, label] of RANDOM_FORMATS) {
      const href = `/search?format=${encodeURIComponent(id)}`;
      body += `<div><a href="${esc(href)}">${esc(label)}</a></div>`;
    }
    body += `<p class="muted">Random formats pick a team for you - no team builder needed.</p>`;
  }

  if (state.ended && state.resultMsg) {
    body += `<h2>Result</h2>`;
    body += `<div>${esc(state.resultMsg)}</div>`;
    body += `<p><a href="/newgame">Start another battle</a></p>`;
  }

  const shouldAutoRefresh =
    (state.searching && state.searching.length > 0) ||
    Boolean(state.challengeTo && state.challengeTo.to);

  return page("PS CloudPhone", body, shouldAutoRefresh ? 6 : 0);
}

export function renderLogin(state) {
  let body = `<h1>Login</h1>`;

  if (state.loginError) body += `<p style="color:#b22">${esc(state.loginError)}</p>`;

  body += `<form method="post" action="/login">
<div><label>Username<br><input type="text" name="username" value="${esc(state.loginName || "")}"></label></div>
<div><label>Password<br><input type="password" name="password"></label></div>
<p class="muted">Warning: this worker stores your password so it can silently re-login after reconnects. Use only on your own personal deployment.</p>
<div><input type="submit" value="Login"></div>
</form>
<p><a href="/">Back</a></p>`;

  return page("Login", body, 0);
}

export function renderBattle(state) {
  let body = `<h1>${esc(state.roomTitle || "Battle")}</h1>`;
  body += `<div>Turn ${state.turn || 0}${state.ended ? " - battle over" : ""}</div>`;
  body += `<div>Timer: <strong>${state.timerOn ? "ON" : "OFF"}</strong></div>`;

  body += renderIpLockBanner(state);

  if (state.serverMsg && !state.ipLocked) {
    body += `<div class="banner"><strong>Notice:</strong> ${esc(state.serverMsg)}<br><a href="/dismiss?from=/battle">[OK / Dismiss]</a></div>`;
  }

  if (!state.mySide) body += `<div class="muted">Detecting your side...</div>`;

  body += `<h2>You</h2>`;
  body += renderActive(state, "my");
  body += `<h2>Opponent</h2>`;
  body += renderActive(state, "opp");

  body += renderRevealed(state);
  body += renderField(state);
  body += renderTypeMatchup(state);

  body += `<h2>Log</h2>${renderLog(state.log)}`;
  body += renderChat(state);

  if (state.ended) {
    body += `<h2>Result</h2>`;
    body += `<div>${esc(state.resultMsg || "Battle ended.")}</div>`;
    body += `<p><a href="/newgame">Start another battle</a> | <a href="/">Home</a></p>`;
    return page(state.roomTitle || "Battle", body, 0);
  }

  const req = state.request;

  if (req) {
    if (req.teamPreview) {
      body += `<h2>Choose lead</h2>`;
      body += `<div class="muted">Stats shown as Atk/Def/SpA/SpD/Spe.</div>`;
      (req.side?.pokemon || []).forEach((p, i) => {
        body += switchCard(p, i, `/lead?i=${i + 1}`, true);
      });
      body += `<p><a href="/lead?i=1">Auto lead first</a></p>`;
    } else if (req.forceSwitch) {
      body += `<h2>Choose a Pokemon to send out</h2>`;
      body += `<div class="muted">Stats shown as Atk/Def/SpA/SpD/Spe.</div>`;
      (req.side?.pokemon || []).forEach((p, i) => {
        if (p.active || p.condition === "0 fnt") return;
        body += switchCard(
          p, i,
          `/choose?value=${encodeURIComponent(`switch ${i + 1}`)}`,
          true
        );
      });
    } else if (req.active) {
      if (req.active.length > 1) {
        body += `<div class="muted">Doubles: this UI picks for the first active slot, or use default.</div>`;
      }

      const activeReq = req.active[0] || {};
      const moves = activeReq.moves || [];
      const canTera = activeReq.canTerastallize;

      body += `<h2>Choose a move</h2>`;
      body += `<div class="muted">The xN chip is type effectiveness vs the opponent's current type.</div>`;
      moves.forEach((m, i) => {
        const typeStr = m.type ? ` [${esc(m.type)}]` : "";
        const effChip =
          m.oppMult !== undefined && m.oppMult !== null
            ? ` <span class="chip">${multShort(m.oppMult)}</span>`
            : "";
        if (m.disabled) {
          body += `<div>${i + 1}. ${esc(m.move)}${typeStr} (disabled)</div>`;
        } else {
          const href = `/choose?value=${encodeURIComponent(`move ${i + 1}`)}`;
          body += `<p><a href="${esc(href)}">${i + 1}. ${esc(m.move)}${typeStr}${effChip} <span class="muted">(${m.pp ?? "?"}/${m.maxpp ?? "?"} pp)</span></a></p>`;
        }
        body += renderMoveDesc(m);
      });
      body += `<p><a href="/choose?value=${encodeURIComponent("default")}">Use default move</a></p>`;

      if (canTera) {
        body += `<h2>Terastallize (${esc(String(canTera))})</h2>`;
        body += `<div class="muted">Use a move AND Terastallize this turn.</div>`;
        moves.forEach((m, i) => {
          if (m.disabled) return;
          const href = `/choose?value=${encodeURIComponent(`move ${i + 1} terastallize`)}`;
          body += `<p><a href="${esc(href)}">${i + 1}. ${esc(m.move)} + Tera</a></p>`;
        });
      }

      body += `<h2>Switch out</h2>`;
      body += `<div class="muted">Stats shown as Atk/Def/SpA/SpD/Spe.</div>`;
      (req.side?.pokemon || []).forEach((p, i) => {
        if (p.active || p.condition === "0 fnt") return;
        body += switchCard(
          p, i,
          `/choose?value=${encodeURIComponent(`switch ${i + 1}`)}`,
          false
        );
      });
    } else {
      body += `<p>Waiting on the other player...</p>`;
    }
  } else {
    body += `<p>Waiting for the next request from the server...</p>`;
  }

  body += `<p><a href="/battle">Refresh</a> | <a href="/timer">${
    state.timerOn ? "Turn timer off" : "Turn timer on"
  }</a> | <a href="/dex">Pok&eacute;dex</a> | <a href="/debug">Debug</a> | <a href="/forfeit">Forfeit</a> | <a href="/">Home</a></p>`;

  const refresh = state.request ? 0 : 7;

  return page(state.roomTitle || "Battle", body, refresh);
}

export function renderMoveInfo(move, moveId, state) {
  if (!move) {
    return page(
      "Move info",
      `<h1>Move info</h1>
<p>Unknown move (${esc(moveId || "")}).</p>
<p><a href="/battle">Back to battle</a></p>`,
      0
    );
  }

  const accuracy = move.accuracy === true ? "always hits" : `${move.accuracy}%`;
  const power = move.basePower ? move.basePower : "-";

  let body = `<h1>${esc(move.name || moveId)}</h1>`;
  body += `<div>${esc(move.type || "")}${move.category ? ` / ${esc(move.category)}` : ""}</div>`;
  body += `<div>Power: ${esc(String(power))} | Accuracy: ${esc(String(accuracy))} | PP: ${esc(
    String(move.pp ?? "?")
  )}</div>`;

  const oppInfo = state ? activeForSide(state, "opp")[0] : null;
  const oppTypes = oppInfo?.types;
  if (oppTypes && oppTypes.length) {
    const oppLabel = oppInfo.species || oppInfo.nickname || "the opponent";
    if (move.category === "Status") {
      body += `<p>vs ${esc(oppLabel)} [${esc(oppTypes.join("/"))}] status move - type effectiveness doesn't apply.</p>`;
    } else {
      const mult = typeEffectiveness(move.type, oppTypes);
      body += `<p>vs ${esc(oppLabel)} [${esc(oppTypes.join("/"))}]: <strong>${esc(
        describeMultiplier(mult)
      )}</strong></p>`;
    }
  }

  body += `<p>${esc(move.desc || move.shortDesc || "No description available.")}</p>`;
  body += `<p><a href="/battle">Back to battle</a></p>`;

  return page(move.name || "Move info", body, 0);
}

export function renderDex(entry, q) {
  let body = `<h1>Pok&eacute;dex</h1>`;
  
  body += `<form action="/dex" method="get">
<div><input type="text" name="q" value="${esc(q || "")}" placeholder="Search Pok&eacute;mon"></div>
<div><input type="submit" value="Search"></div>
</form><hr>`;

  if (q) {
    if (!entry) {
      body += `<p>No entry found for "${esc(q)}".</p>`;
    } else {
      const imgUrl = spriteUrl(entry.name, { anim: false });
      if (imgUrl) body += `<div><img src="${esc(imgUrl)}" alt="" width="96"></div>`;
      body += `<h2>${esc(entry.name)}</h2>`;
      if (entry.types) body += `<div><strong>Types:</strong> <span class="chip">${esc(entry.types.join("/"))}</span></div>`;
      if (entry.baseStats) {
        body += `<div><strong>Stats:</strong> HP ${entry.baseStats.hp} / Atk ${entry.baseStats.atk} / Def ${entry.baseStats.def} / SpA ${entry.baseStats.spa} / SpD ${entry.baseStats.spd} / Spe ${entry.baseStats.spe}</div>`;
      }
      if (entry.abilities) {
        const abs = Object.entries(entry.abilities).map(([k, v]) => `${v}${k === 'H' ? ' (Hidden)' : ''}`).join(", ");
        body += `<div><strong>Abilities:</strong> ${esc(abs)}</div>`;
      }
    }
    body += `<hr>`;
  }
  
  body += `<p><a href="/battle">Back to battle</a> | <a href="/">Home</a></p>`;
  
  return page(entry ? `Pok&eacute;dex: ${entry.name}` : "Pok&eacute;dex", body);
}

export function renderDebug(state, extra) {
  let body = `<h1>System Debug</h1>`;
  body += `<p><a href="/">Home</a> | <a href="/reconnect">Force Reconnect</a> | <a href="/debug">Refresh Debug</a></p>`;
  body += `<h2>State Overview</h2>`;
  body += `<pre style="background:#222;padding:6px;border-radius:4px;font-size:12px;overflow-x:auto;">`;
  body += `WebSocket Open: ${extra.wsOpen}\n`;
  body += `WS readyState: ${extra.wsState}\n`;
  body += `Connected: ${state.connected}\n`;
  body += `Username: ${state.username || "none"}\n`;
  body += `Logged In (named=1): ${state.loggedIn}\n`;
  body += `Saved Account: ${state.loginName || "none"}\n`;
  body += `Fresh Challstr: ${extra.freshChallstr}\n`;
  body += `Connecting Now: ${extra.connectingNow}\n`;
  body += `Pending Login Confirm: ${extra.pendingLoginName}\n`;
  body += `Consecutive Quick Drops: ${extra.consecutiveQuickDrops}\n`;
  body += `Auto-login Disabled (relogDisabled): ${extra.relogDisabled}\n`;
  body += `Room ID: ${state.roomId || "none"}\n`;
  body += `Searching: ${JSON.stringify(state.searching || [])}\n`;
  body += `Timer: ${state.timerOn ? "ON" : "OFF"}\n`;
  body += `Notice: ${state.notice || "none"}\n`;
  body += `Login Error: ${state.loginError || "none"}\n`;
  body += `Server Msg: ${state.serverMsg || "none"}\n`;
  body += `IP Locked (proxy): ${state.ipLocked}\n`;
  body += `IP Locked At: ${state.ipLockedAt ? new Date(state.ipLockedAt).toISOString() : "none"}\n`;
  body += `Upstream Cookie: ${state.upstreamCookie ? "present" : "none"}\n`;
  body += `</pre>`;

  body += `<h2>System & Combat Logs (Last 50)</h2>`;
  const recentLogs = (state.log || []).slice(-50);
  body += `<div class="log">${recentLogs.map((l) => `<div>${esc(l)}</div>`).join("") || '<div class="muted">(no logs)</div>'}</div>`;

  body += `<p><a href="/">Back to Home</a></p>`;
  return page("System Debug", body);
}

export function renderError(message) {
  return page(
    "Error",
    `<h1>Error</h1>
<p>${esc(message)}</p>
<p><a href="/debug">View Debug Logs</a> | <a href="/">Home</a></p>`
  );
}
