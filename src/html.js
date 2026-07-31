// Every page here is plain server-rendered HTML: no client-side JS, no
// CSS beyond a few inline tweaks, and every action is a plain <a href>
// link so it works with CloudPhone's keypad + number-select navigation
// (same approach as the dumbphone chess site).

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function page(title, body) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${esc(title)}</title>
<style>
body{font-family:sans-serif;font-size:14px;margin:8px;background:#fff;color:#111}
h1{font-size:16px;margin:4px 0}
h2{font-size:14px;margin:8px 0 4px}
a{display:block;padding:4px 0;color:#0645ad}
.log{border:1px solid #ccc;padding:4px;margin-bottom:8px;font-size:13px}
.log div{margin:1px 0}
.hp{font-weight:bold}
.small{color:#666;font-size:12px}
hr{border:none;border-top:1px solid #ddd;margin:8px 0}
</style>
</head><body>
${body}
</body></html>`;
}

export function renderHome(state) {
  const formats = [
    ["gen9randombattle", "Gen 9 Random Battle"],
    ["gen9randomdoublesbattle", "Gen 9 Random Doubles"],
    ["gen8randombattle", "Gen 8 Random Battle"],
    ["gen1randombattle", "Gen 1 Random Battle"],
  ];

  let body = `<h1>PS CloudPhone</h1>`;
  body += `<p class="small">${state.connected ? `Connected as ${esc(state.username || "guest")}` : "Not connected yet."}</p>`;

  if (state.roomId && !state.ended) {
    body += `<p><a href="/battle">&gt; Resume battle in progress</a></p><hr>`;
  }

  if (state.searching && state.searching.length) {
    body += `<h2>Searching for: ${esc(state.searching.join(", "))}</h2>`;
    body += `<a href="/">Check again</a>`;
    body += `<a href="/cancelsearch">Cancel search</a>`;
  } else {
    body += `<h2>Start a random battle</h2>`;
    for (const [id, label] of formats) {
      body += `<a href="/search?format=${encodeURIComponent(id)}">${esc(label)}</a>`;
    }
    body += `<p class="small">Random Battle formats use the full, current Pok\u00e9dex with sets picked for you \u2014 no team builder needed.</p>`;
  }

  if (state.ended && state.resultMsg) {
    body += `<hr><p><b>${esc(state.resultMsg)}</b></p>`;
    body += `<a href="/newgame">Start another battle</a>`;
  }

  return page("PS CloudPhone", body);
}

function renderLog(log) {
  const recent = log.slice(-25);
  return `<div class="log">${recent.map((l) => `<div>${esc(l)}</div>`).join("") || "<div>(no messages yet)</div>"}</div>`;
}

export function renderBattle(state) {
  let body = `<h1>${esc(state.roomTitle || "Battle")}</h1>`;
  body += `<p class="small">Turn ${state.turn || 0}${state.ended ? " \u2014 battle over" : ""}</p>`;

  if (state.myActive || state.oppActive) {
    body += `<p>You: <span class="hp">${esc(state.myActive?.name || "?")}</span> ${esc(state.myActive?.cond || "")}<br>`;
    body += `Opponent: <span class="hp">${esc(state.oppActive?.name || "?")}</span> ${esc(state.oppActive?.cond || "")}</p>`;
  }

  body += renderLog(state.log);

  if (state.ended) {
    body += `<p><b>${esc(state.resultMsg || "Battle ended.")}</b></p>`;
    body += `<a href="/newgame">Start another battle</a>`;
    return page(state.roomTitle || "Battle", body);
  }

  const req = state.request;
  if (req) {
    if (req.forceSwitch) {
      body += `<h2>Choose a Pok\u00e9mon to send out</h2>`;
      (req.side?.pokemon || []).forEach((p, i) => {
        if (p.active || p.condition === "0 fnt") return;
        body += `<a href="/choose?value=${encodeURIComponent("switch " + (i + 1))}">${i + 1}. ${esc(p.details.split(",")[0])} (${esc(p.condition)})</a>`;
      });
    } else if (req.active) {
      const moves = req.active[0]?.moves || [];
      body += `<h2>Choose a move</h2>`;
      moves.forEach((m, i) => {
        if (m.disabled) {
          body += `<span class="small">${i + 1}. ${esc(m.move)} (disabled)</span>`;
        } else {
          body += `<a href="/choose?value=${encodeURIComponent("move " + (i + 1))}">${i + 1}. ${esc(m.move)} (${m.pp}/${m.maxpp} pp)</a>`;
        }
      });
      body += `<h2>Or switch out</h2>`;
      (req.side?.pokemon || []).forEach((p, i) => {
        if (p.active || p.condition === "0 fnt") return;
        body += `<a href="/choose?value=${encodeURIComponent("switch " + (i + 1))}">${esc(p.details.split(",")[0])} (${esc(p.condition)})</a>`;
      });
    } else {
      body += `<p class="small">Waiting on the other player...</p>`;
    }
  } else {
    body += `<p class="small">Waiting for the next request from the server...</p>`;
  }

  body += `<hr><a href="/battle">Refresh</a><a href="/">Home</a>`;
  return page(state.roomTitle || "Battle", body);
}

export function renderError(message) {
  return page("Error", `<h1>Error</h1><p>${esc(message)}</p><a href="/">Home</a>`);
}
