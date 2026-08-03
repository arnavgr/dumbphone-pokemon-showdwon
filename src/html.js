// Every page here is plain server-rendered HTML: no client-side JS, no CSS
// beyond a few inline tweaks, and every action is a plain <a> link or tiny
// form so it works with CloudPhone's keypad + number-select navigation
// (same approach as the dumbphone chess site).

// Show your own active Pokemon from behind (like the real games).
// Set false to always show front sprites (saves one fallback tier).
const SHOW_BACK_SPRITES_FOR_YOU = true;

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
input, textarea { max-width: 220px; }
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

// Which slot(s) belong to "me" vs "opponent", based on detected side.
function activeForSide(state, which) {
  const mySide = state.mySide || "p1";
  const side = which === "my" ? mySide : mySide === "p1" ? "p2" : "p1";

  return Object.entries(state.active || {})
    .filter(([slot]) => slot.startsWith(side))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, info]) => info);
}

function renderActive(state, which) {
  const mons = activeForSide(state, which);
  if (!mons.length) return `<div class="mon">?</div>`;

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

      return `<div class="mon">${img}<div>${esc(label)}${nick}</div>${hpBar(info.condition)}</div>`;
    })
    .join("");
}

function renderLog(log) {
  const recent = (log || []).slice(-25);
  return `${recent.map((l) => `<div>${esc(l)}</div>`).join("") || "<div>(no messages yet)</div>"}`;
}

export function renderHome(state) {
  const randomFormats = [
    ["gen9randombattle", "Gen 9 Random Battle"],
    ["gen9randomdoublesbattle", "Gen 9 Random Doubles"],
    ["gen8randombattle", "Gen 8 Random Battle"],
    ["gen1randombattle", "Gen 1 Random Battle"],
  ];

  const teamFormats = [
    ["gen9ou", "Gen 9 OU"],
    ["gen9uu", "Gen 9 UU"],
    ["gen9nu", "Gen 9 NU"],
    ["gen9pu", "Gen 9 PU"],
    ["gen9lc", "Gen 9 LC"],
  ];

  let body = `<h1>PS CloudPhone</h1>`;

  body += `<p>${
    state.connected ? `Connected as ${esc(state.username || "guest")}` : "Not connected yet."
  }${state.loggedIn ? `<br><small>(logged in)</small>` : ""}</p>`;

  if (state.notice) body += `<p>${esc(state.notice)}</p>`;
  if (state.loginError) body += `<p style="color:#b00">Login error: ${esc(state.loginError)}</p>`;

  body += `<p>
<a href="/login">Login</a>
<a href="/logout">Logout</a>
<a href="/team">Team importer</a>
<a href="/reconnect">Reconnect</a>
</p>`;

  if (state.roomId && !state.ended) {
    body += `<p><a href="/battle"><strong>&gt; Resume battle in progress</strong></a></p>`;
  }

  if (state.searching && state.searching.length) {
    body += `<h2>Searching</h2>`;
    body += `<p>${esc(state.searching.join(", "))}</p>`;
    body += `<a href="/">Check again</a>`;
    body += `<a href="/cancelsearch">Cancel search</a>`;
  } else {
    body += `<h2>Random battles</h2>`;
    for (const [id, label] of randomFormats) {
      const href = `/search?format=${encodeURIComponent(id)}`;
      body += `<a href="${esc(href)}">${esc(label)}</a>`;
    }
    body += `<p class="small">Random formats pick sets for you - no team needed.</p>`;

    body += `<h2>Constructed formats</h2>`;
    if (!state.team) {
      body += `<p class="small">No saved team yet. These need a packed team first.</p>`;
    }
    for (const [id, label] of teamFormats) {
      const href = `/search?format=${encodeURIComponent(id)}&team=1`;
      body += `<a href="${esc(href)}">${esc(label)} (use saved team)</a>`;
    }
  }

  if (state.ended && state.resultMsg) {
    body += `<h2>Result</h2>`;
    body += `<p>${esc(state.resultMsg)}</p>`;
    body += `<a href="/newgame">Start another battle</a>`;
  }

  return page("PS CloudPhone", body, state.searching && state.searching.length ? 8 : 0);
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

export function renderTeam(state) {
  const body = `
<h1>Team importer</h1>
<p class="small">Paste a <strong>packed</strong> Showdown team. Random battles ignore teams; constructed formats use the saved team.</p>
<form method="post" action="/team">
<textarea name="team" rows="10" cols="28">${esc(state.team || "")}</textarea>
<br><br>
<input type="submit" value="Save team">
</form>
<p><a href="/">Back</a></p>`;

  return page("Team", body, 0);
}

export function renderBattle(state) {
  let body = `<h1>${esc(state.roomTitle || "Battle")}</h1>`;
  body += `<p>Turn ${state.turn || 0}${state.ended ? " - battle over" : ""}</p>`;

  if (!state.mySide) body += `<p class="small">Detecting your side...</p>`;

  body += `<h2>You</h2>`;
  body += renderActive(state, "my");
  body += `<h2>Opponent</h2>`;
  body += renderActive(state, "opp");

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
      (req.side?.pokemon || []).forEach((p, i) => {
        const species = (p.details || "").split(",")[0];
        body += `<a href="/lead?i=${i + 1}">${i + 1}. ${esc(species)} (${esc(p.condition || "")})</a>`;
      });
      body += `<a href="/lead?i=1">Auto lead first</a>`;
    } else if (req.forceSwitch) {
      body += `<h2>Choose a Pokemon to send out</h2>`;
      (req.side?.pokemon || []).forEach((p, i) => {
        if (p.active || p.condition === "0 fnt") return;
        const species = (p.details || "").split(",")[0];
        const href = `/choose?value=${encodeURIComponent(`switch ${i + 1}`)}`;
        body += `<a href="${esc(href)}">${i + 1}. ${esc(species)} (${esc(p.condition || "")})</a>`;
      });
    } else if (req.active) {
      if (req.active.length > 1) {
        body += `<p class="small">Doubles: this UI picks for the first active slot, or use default.</p>`;
      }

      const moves = req.active[0]?.moves || [];
      body += `<h2>Choose a move</h2>`;
      moves.forEach((m, i) => {
        if (m.disabled) {
          body += `<p>${i + 1}. ${esc(m.move)} (disabled)</p>`;
        } else {
          const href = `/choose?value=${encodeURIComponent(`move ${i + 1}`)}`;
          body += `<a href="${esc(href)}">${i + 1}. ${esc(m.move)} (${m.pp ?? "?"}/${m.maxpp ?? "?"} pp)</a>`;
        }
      });
      body += `<a href="/choose?value=${encodeURIComponent("default")}">Use default move</a>`;

      body += `<h2>Switch out</h2>`;
      (req.side?.pokemon || []).forEach((p, i) => {
        if (p.active || p.condition === "0 fnt") return;
        const species = (p.details || "").split(",")[0];
        const href = `/choose?value=${encodeURIComponent(`switch ${i + 1}`)}`;
        body += `<a href="${esc(href)}">${esc(species)} (${esc(p.condition || "")})</a>`;
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

  // Auto-refresh only while waiting; never while a choice menu is on screen
  // (a reload would reset keypad focus).
  const refresh = state.request ? 0 : 7;

  return page(state.roomTitle || "Battle", body, refresh);
}

export function renderError(message) {
  return page(
    "Error",
    `<h1>Error</h1><p>${esc(message)}</p><p><a href="/">Home</a></p>`
  );
}
