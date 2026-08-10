import { spriteUrl, typeEffectiveness } from "./protocol.js";

const SHOW_BACK_SPRITES_FOR_YOU = true;

// Only the random formats worth surfacing on a keypad-only phone: no
// teambuilder, so only formats that hand you a randomized team belong here.
// gen9randombattle is by far Showdown's biggest ladder; gen9hackmonscup and
// gen8randombattle are the next most-played random formats that stay
// singles-only (so the existing move/switch UI below handles them fine).
const RANDOM_FORMATS = [
  ["gen9randombattle", "Gen 9 Random Battle"],
  ["gen9hackmonscup", "Gen 9 Hackmons Cup"],
  ["gen8randombattle", "Gen 8 Random Battle"],
];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c];
  });
}

function page(title, body, refresh = 0) {
  const refreshTag =
    refresh > 0 ? `<meta http-equiv="refresh" content="${refresh}">` : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=240, initial-scale=1">
${refreshTag}
<title>${esc(title)}</title>
<style>
body { font-family: sans-serif; font-size: 14px; margin: 4px; background: #fff; color: #111; }
a { display: block; margin: 7px 0; }
h1 { font-size: 18px; margin: 4px 0; }
h2 { font-size: 15px; margin: 8px 0 4px; }
img { image-rendering: pixelated; vertical-align: middle; }
.mon { margin: 5px 0; }
.hpbar { width: 145px; height: 7px; border: 1px solid #555; background: #ddd; margin: 2px 0; }
.hpfill { height: 7px; }
.log { border-top: 1px solid #aaa; margin-top: 8px; padding-top: 5px; }
.log div { margin: 2px 0; }
.small { font-size: 11px; color: #444; }
.movedesc { margin: -3px 0 8px 2px; color: #333; }
.statline { color: #555; }
input, textarea, select { max-width: 220px; }
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
    return `<div class="hpbar"><div class="hpfill" style="width:0%;background:#000"></div></div><small>fainted</small>`;
  }

  const m = String(cond).match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(?:\s+(.*))?$/);
  if (!m) return `<small>${esc(cond)}</small>`;

  const cur = Number(m[1]);
  const max = Number(m[2]);
  const pct = max ? Math.max(0, Math.min(100, Math.round((cur / max) * 100))) : 0;
  const status = m[3] ? ` [${esc(m[3])}]` : "";
  const color = pct > 50 ? "#2a7a2a" : pct > 20 ? "#cc7700" : "#bb2222";

  return `<div class="hpbar"><div class="hpfill" style="width:${pct}%;background:${color}"></div></div><small>${pct}%${status}</small>`;
}

function activeForSide(state, which) {
  const mySide = state.mySide || "p1";
  const side = which === "my" ? mySide : mySide === "p1" ? "p2" : "p1";

  return Object.entries(state.active || {})
    .filter(([slot]) => slot.startsWith(side))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, info]) => info);
}

// Compact "atk/def/spa/spd/spe" string. A legend is printed once near the
// top of each stats-bearing section instead of repeating labels per mon.
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

function renderActive(state, which) {
  const mons = activeForSide(state, which);
  if (!mons.length) return `<div class="mon">?</div>`;

  // Your own active mon's exact stats come from the request; the opponent's
  // are never sent to you, so we fall back to Pokedex base stats for them
  // (labeled as such below, since they aren't the real in-battle numbers).
  const myActiveStats =
    which === "my"
      ? (state.request?.side?.pokemon || []).find((p) => p.active)?.stats
      : null;

  return mons
    .map((info) => {
      const url =
        which === "my" && SHOW_BACK_SPRITES_FOR_YOU
          ? info.spriteBack || info.spriteFront
          : info.spriteFront;

      const img = url
        ? `<img src="${esc(url)}" alt="${esc(info.species || info.nickname || "")}" width="56" height="56">`
        : "";

      const label = info.species || info.nickname || "?";
      const nick =
        info.nickname && info.nickname !== info.species
          ? ` <small>(${esc(info.nickname)})</small>`
          : "";

      const types = info.types && info.types.length ? ` <small>[${esc(info.types.join("/"))}]</small>` : "";

      let statsHtml = "";
      if (which === "my" && myActiveStats) {
        statsHtml = `<div class="small statline">Atk/Def/SpA/SpD/Spe: ${esc(statsLine(myActiveStats))}</div>`;
      } else if (which === "opp" && info.baseStats) {
        statsHtml = `<div class="small statline">Base stats: ${esc(statsLine(info.baseStats))}</div>`;
      }

      return `<div class="mon">${img}<div><strong>${esc(label)}</strong>${nick}${types}</div>${hpBar(info.condition)}${statsHtml}</div>`;
    })
    .join("");
}

// "Which of my Pokemon hits this thing hardest" - ranks every non-fainted
// team member by the best effectiveness multiplier among their known move
// types against the opponent's active type(s).
function renderTypeMatchup(state) {
  const req = state.request;
  const teamPokemon = req?.side?.pokemon;
  if (!teamPokemon || !teamPokemon.length) return "";

  // state.active is keyed by full slot ("p1a", "p2a", ...), not bare
  // "p1"/"p2", so reuse the same side-prefix lookup renderActive() uses
  // rather than indexing directly.
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
      return { species, active: !!p.active, best };
    })
    .sort((a, b) => (b.best ?? -1) - (a.best ?? -1));

  if (!rows.length) return "";

  const oppLabel = oppInfo.species || oppInfo.nickname || "the opponent";

  let body = `<h2>Type matchup vs ${esc(oppLabel)} [${esc(oppTypes.join("/"))}]</h2>`;
  for (const r of rows) {
    const label = r.best === null ? "moves unknown" : describeMultiplier(r.best);
    body += `<div>${r.active ? "&gt; " : ""}${esc(r.species)}: <small>${esc(label)}</small></div>`;
  }
  return body;
}

// A move's shortDesc under its link, truncated defensively (most are well
// under this already) with a "More" link to the full /moveinfo page for
// anything that doesn't fit in one line on a keypad-phone screen.
function renderMoveDesc(m) {
  if (!m.shortDesc) return "";
  const text = m.shortDesc.length > 90 ? `${m.shortDesc.slice(0, 87)}...` : m.shortDesc;
  const moreLink = m.id
    ? ` <a href="/moveinfo?move=${encodeURIComponent(m.id)}" style="display:inline">More</a>`
    : "";
  return `<div class="movedesc small">${esc(text)}${moreLink}</div>`;
}

function renderLog(log) {
  const recent = (log || []).slice(-25);
  return `${recent.map((l) => `<div>${esc(l)}</div>`).join("") || "<div>(no messages yet)</div>"}`;
}

function renderChallenges(state) {
  let body = `<h2>Battle a friend</h2>`;

  const incoming = Object.entries(state.challengesFrom || {});
  if (incoming.length) {
    for (const [userid, format] of incoming) {
      body += `<p><strong>${esc(userid)}</strong> challenged you to ${esc(format)}</p>`;
      body += `<a href="/accept?user=${encodeURIComponent(userid)}">Accept</a>`;
      body += `<a href="/reject?user=${encodeURIComponent(userid)}">Reject</a>`;
    }
  }

  if (state.challengeTo && state.challengeTo.to) {
    body += `<p>Challenging <strong>${esc(state.challengeTo.to)}</strong> to ${esc(
      state.challengeTo.format || ""
    )}...</p>`;
    body += `<a href="/cancelchallenge">Cancel challenge</a>`;
  } else {
    body += `
<form method="post" action="/challenge">
<label>Friend's username<br><input name="username" maxlength="50"></label>
<br><br>
<label>Format<br>
<select name="format">
${RANDOM_FORMATS.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join("")}
</select>
</label>
<br><br>
<input type="submit" value="Send challenge">
</form>`;
  }

  return body;
}

export function renderHome(state) {
  let body = `<h1>PS CloudPhone</h1>`;

  body += `<p>${
    state.connected ? `Connected as ${esc(state.username || "guest")}` : "Not connected yet."
  }${state.loggedIn ? `<br><small>(logged in)</small>` : ""}</p>`;

  if (state.notice) body += `<p>${esc(state.notice)}</p>`;
  if (state.loginError) body += `<p style="color:#b00">Login error: ${esc(state.loginError)}</p>`;

  body += `<p>
<a href="/">Refresh</a>
<a href="/login">Login</a>
<a href="/logout">Logout</a>
<a href="/reconnect">Reconnect</a>
</p>`;

  if (state.roomId && !state.ended) {
    body += `<p><a href="/battle"><strong>&gt; Resume battle in progress</strong></a></p>`;
  }

  body += renderChallenges(state);

  if (state.searching && state.searching.length) {
    body += `<h2>Searching</h2>`;
    body += `<p>${esc(state.searching.join(", "))}</p>`;
    body += `<a href="/">Check again</a>`;
    body += `<a href="/cancelsearch">Cancel search</a>`;
  } else {
    body += `<h2>Random battles</h2>`;
    for (const [id, label] of RANDOM_FORMATS) {
      const href = `/search?format=${encodeURIComponent(id)}`;
      body += `<a href="${esc(href)}">${esc(label)}</a>`;
    }
    body += `<p class="small">Random formats pick a team for you - no team builder needed.</p>`;
  }

  if (state.ended && state.resultMsg) {
    body += `<h2>Result</h2>`;
    body += `<p>${esc(state.resultMsg)}</p>`;
    body += `<a href="/newgame">Start another battle</a>`;
  }

  const shouldAutoRefresh =
    (state.searching && state.searching.length > 0) ||
    Boolean(state.challengeTo && state.challengeTo.to);

  return page("PS CloudPhone", body, shouldAutoRefresh ? 8 : 0);
}

export function renderLogin(state) {
  let body = `<h1>Login</h1>`;

  if (state.loginError) body += `<p style="color:#b00">${esc(state.loginError)}</p>`;

  body += `
<form method="post" action="/login">
<label>Username<br><input name="username" value="${esc(state.username || "")}" maxlength="50"></label>
<br><br>
<label>Password<br><input type="password" name="password" maxlength="100"></label>
<br><br>
<input type="submit" value="Login">
</form>
<p class="small">Warning: this worker can see your password while processing login. Use only on your own personal deployment.</p>
<p><a href="/">Back</a></p>`;

  return page("Login", body, 0);
}

export function renderBattle(state) {
  let body = `<h1>${esc(state.roomTitle || "Battle")}</h1>`;
  body += `<p>Turn ${state.turn || 0}${state.ended ? " - battle over" : ""}</p>`;

  if (!state.mySide) body += `<p class="small">Detecting your side...</p>`;

  body += `<h2>You</h2>`;
  body += renderActive(state, "my");
  body += `<h2>Opponent</h2>`;
  body += renderActive(state, "opp");

  body += renderTypeMatchup(state);

  body += `<div class="log">${renderLog(state.log)}</div>`;

  if (state.ended) {
    body += `<h2>Result</h2>`;
    body += `<p>${esc(state.resultMsg || "Battle ended.")}</p>`;
    body += `<a href="/newgame">Start another battle</a>`;
    body += `<a href="/">Home</a>`;
    return page(state.roomTitle || "Battle", body, 0);
  }

  const req = state.request;

  if (req) {
    if (req.teamPreview) {
      body += `<h2>Choose lead</h2>`;
      body += `<p class="small">Stats shown as Atk/Def/SpA/SpD/Spe.</p>`;
      (req.side?.pokemon || []).forEach((p, i) => {
        const species = (p.details || "").split(",")[0];
        const typesText = p.types ? esc(p.types.join("/")) : "";
        const imgUrl = spriteUrl(species, { anim: false });
        const stats = statsLine(p.stats);

        body += `<a href="/lead?i=${i + 1}" style="display:block; border:1px solid #ccc; padding:2px; text-decoration:none; color:inherit;">
          <table border="0" cellpadding="0" cellspacing="0"><tr>
            <td valign="middle"><img src="${esc(imgUrl)}" width="40" height="40"></td>
            <td valign="middle" style="padding-left:4px;">
              <strong>${i + 1}. ${esc(species)}</strong> (${esc(p.condition || "")})<br>
              <small>${typesText}</small>${stats ? `<br><small>${esc(stats)}</small>` : ""}
            </td>
          </tr></table>
        </a>`;
      });
      body += `<a href="/lead?i=1">Auto lead first</a>`;
    } else if (req.forceSwitch) {
      body += `<h2>Choose a Pokemon to send out</h2>`;
      body += `<p class="small">Stats shown as Atk/Def/SpA/SpD/Spe.</p>`;
      (req.side?.pokemon || []).forEach((p, i) => {
        if (p.active || p.condition === "0 fnt") return;
        const species = (p.details || "").split(",")[0];
        const href = `/choose?value=${encodeURIComponent(`switch ${i + 1}`)}`;
        const typesText = p.types ? esc(p.types.join("/")) : "";
        const imgUrl = spriteUrl(species, { anim: false });
        const stats = statsLine(p.stats);

        body += `<a href="${esc(href)}" style="display:block; border:1px solid #ccc; padding:2px; text-decoration:none; color:inherit;">
          <table border="0" cellpadding="0" cellspacing="0"><tr>
            <td valign="middle"><img src="${esc(imgUrl)}" width="40" height="40"></td>
            <td valign="middle" style="padding-left:4px;">
              <strong>${i + 1}. ${esc(species)}</strong> (${esc(p.condition || "")})<br>
              <small>${typesText}</small>${stats ? `<br><small>${esc(stats)}</small>` : ""}
            </td>
          </tr></table>
        </a>`;
      });
    } else if (req.active) {
      if (req.active.length > 1) {
        body += `<p class="small">Doubles: this UI picks for the first active slot, or use default.</p>`;
      }

      const moves = req.active[0]?.moves || [];
      body += `<h2>Choose a move</h2>`;
      moves.forEach((m, i) => {
        const typeStr = m.type ? ` [${esc(m.type)}]` : "";
        if (m.disabled) {
          body += `<p>${i + 1}. ${esc(m.move)}${typeStr} (disabled)</p>`;
        } else {
          const href = `/choose?value=${encodeURIComponent(`move ${i + 1}`)}`;
          body += `<a href="${esc(href)}">${i + 1}. ${esc(m.move)}${typeStr} (${m.pp ?? "?"}/${m.maxpp ?? "?"} pp)</a>`;
        }
        body += renderMoveDesc(m);
      });
      body += `<a href="/choose?value=${encodeURIComponent("default")}">Use default move</a>`;

      body += `<h2>Switch out</h2>`;
      body += `<p class="small">Stats shown as Atk/Def/SpA/SpD/Spe.</p>`;
      (req.side?.pokemon || []).forEach((p, i) => {
        if (p.active || p.condition === "0 fnt") return;
        const species = (p.details || "").split(",")[0];
        const href = `/choose?value=${encodeURIComponent(`switch ${i + 1}`)}`;
        const typesText = p.types ? esc(p.types.join("/")) : "";
        const imgUrl = spriteUrl(species, { anim: false });
        const stats = statsLine(p.stats);

        body += `<a href="${esc(href)}" style="display:block; border:1px solid #ccc; padding:2px; text-decoration:none; color:inherit;">
          <table border="0" cellpadding="0" cellspacing="0"><tr>
            <td valign="middle"><img src="${esc(imgUrl)}" width="40" height="40"></td>
            <td valign="middle" style="padding-left:4px;">
              <strong>${esc(species)}</strong> (${esc(p.condition || "")})<br>
              <small>${typesText}</small>${stats ? `<br><small>${esc(stats)}</small>` : ""}
            </td>
          </tr></table>
        </a>`;
      });
    } else {
      body += `<p>Waiting on the other player...</p>`;
    }
  } else {
    body += `<p>Waiting for the next request from the server...</p>`;
  }

  body += `<p>
<a href="/battle">Refresh</a>
<a href="/timer">Toggle timer</a>
<a href="/forfeit">Forfeit</a>
<a href="/">Home</a>
</p>`;

  const refresh = state.request ? 0 : 7;

  return page(state.roomTitle || "Battle", body, refresh);
}

export function renderMoveInfo(move, moveId) {
  if (!move) {
    return page(
      "Move info",
      `<h1>Move info</h1><p>Unknown move (${esc(moveId || "")}).</p><p><a href="/battle">Back to battle</a></p>`,
      0
    );
  }

  const accuracy = move.accuracy === true ? "always hits" : `${move.accuracy}%`;
  const power = move.basePower ? move.basePower : "-";

  let body = `<h1>${esc(move.name || moveId)}</h1>`;
  body += `<p><small>${esc(move.type || "")}${move.category ? ` / ${esc(move.category)}` : ""}</small></p>`;
  body += `<p>Power: ${esc(String(power))}<br>Accuracy: ${esc(String(accuracy))}<br>PP: ${esc(
    String(move.pp ?? "?")
  )}</p>`;
  body += `<p>${esc(move.desc || move.shortDesc || "No description available.")}</p>`;
  body += `<p><a href="/battle">Back to battle</a></p>`;

  return page(move.name || "Move info", body, 0);
}

export function renderError(message) {
  return page(
    "Error",
    `<h1>Error</h1><p>${esc(message)}</p><p><a href="/">Home</a></p>`
  );
}
