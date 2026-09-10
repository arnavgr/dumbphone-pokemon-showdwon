import { normalizeName, typeEffectiveness } from "./protocol.js";

let dexCache = null;
let dexPromise = null;
let movesCache = null;
let movesPromise = null;

async function getPokedex() {
  if (dexCache) return dexCache;
  if (!dexPromise) {
    dexPromise = fetch("https://play.pokemonshowdown.com/data/pokedex.json")
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => { dexCache = data || {}; return dexCache; })
      .catch(() => { dexCache = {}; return dexCache; });
  }
  return dexPromise;
}

async function getMoves() {
  if (movesCache) return movesCache;
  if (!movesPromise) {
    movesPromise = fetch("https://play.pokemonshowdown.com/data/moves.json")
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => { movesCache = data || {}; return movesCache; })
      .catch(() => { movesCache = {}; return movesCache; });
  }
  return movesPromise;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
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

function currentTeamPokemon(state) {
  return state.request?.side?.pokemon || [];
}

function hpParts(condition) {
  const m = String(condition || "").match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(?:\s+(.*))?$/);
  if (!m) return null;
  return { current: Number(m[1]), max: Number(m[2]), status: m[3] || "" };
}

function hpText(condition) {
  if (!condition) return "?";
  if (condition === "0 fnt") return "fainted";
  const p = hpParts(condition);
  if (!p) return condition;
  return `${Math.round((p.current / Math.max(1, p.max)) * 100)}%${p.status ? ` [${p.status}]` : ""}`;
}

function statStageFactor(stage) {
  const n = Math.max(-6, Math.min(6, Number(stage) || 0));
  return n >= 0 ? (2 + n) / 2 : 2 / (2 - n);
}

function adjustedSpeed(speed, boosts) {
  if (!Number.isFinite(speed)) return null;
  return Math.floor(speed * statStageFactor(boosts?.spe || 0));
}

function formatDamage(n) {
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : null;
}

function stageLabel(stage) {
  const n = Number(stage) || 0;
  if (!n) return "";
  return `${n > 0 ? "+" : ""}${n} Spe stage`;
}

function weatherMultiplier(moveType, weather) {
  if (!weather) return 1;
  if ((weather === "RainDance" || weather === "PrimordialSea") && moveType === "Water") return 1.5;
  if ((weather === "RainDance" || weather === "PrimordialSea") && moveType === "Fire") return 0.5;
  if ((weather === "SunnyDay" || weather === "DesolateLand") && moveType === "Fire") return 1.5;
  if ((weather === "SunnyDay" || weather === "DesolateLand") && moveType === "Water") return 0.5;
  return 1;
}

function estimateDamage({ level, power, attack, defense, stab, typeMult, weatherMult, burnPenalty }) {
  if (![level, power, attack, defense].every(Number.isFinite) || power <= 0 || defense <= 0) return null;
  let base = Math.floor(Math.floor(Math.floor((2 * level) / 5 + 2) * power * attack / defense) / 50) + 2;
  base = Math.floor(base * stab);
  base = Math.floor(base * typeMult);
  base = Math.floor(base * weatherMult);
  base = Math.floor(base * burnPenalty);
  return {
    min: formatDamage(base * 0.85),
    max: formatDamage(base),
  };
}

function speedComparison(state, dex) {
  const mine = activeFor(state, "my")[0];
  const opp = activeFor(state, "opp")[0];
  const ownReq = currentTeamPokemon(state).find((p) => p.active);
  if (!mine || !opp || !ownReq) return "";

  const ownSpeed = ownReq.stats?.spe;
  const oppBase = dex[normalizeName(opp.species)]?.baseStats?.spe;
  const oppPred = Number.isFinite(opp.predictedSpeed)
    ? opp.predictedSpeed
    : (Number.isFinite(oppBase) && opp.level ? Math.floor(((2 * oppBase + 85) * opp.level) / 100) + 5 : null);
  if (!Number.isFinite(ownSpeed) || !Number.isFinite(oppPred)) return "";

  const ownBoost = Number(mine.boosts?.spe) || 0;
  const oppBoost = Number(opp.boosts?.spe) || 0;
  const ownAdj = adjustedSpeed(ownSpeed, ownBoost);
  const oppAdj = adjustedSpeed(oppPred, oppBoost);
  const verdict = ownAdj > oppAdj ? "You are faster" : ownAdj < oppAdj ? "Opponent is faster" : "Speed tie";

  let body = `<h2>Speed comparison</h2>`;
  body += `<div>You: ${ownAdj} Spe${ownBoost ? ` (${ownSpeed}, ${stageLabel(ownBoost)})` : ""}</div>`;
  body += `<div>Opponent: ~${oppAdj} Spe${oppBoost ? ` (~${oppPred}, ${stageLabel(oppBoost)})` : " (base-stat estimate)"}</div>`;
  body += `<div><strong>${esc(verdict)}</strong></div>`;
  body += `<div class="muted">Opponent Speed is estimated because its EVs/nature/items are hidden.</div>`;
  return body;
}

function renderDossier(state) {
  const oppSide = sideFor(state, "opp");
  const entries = Object.values(state.revealed?.[oppSide] || {});
  if (!entries.length) return "";
  entries.sort((a, b) => (b.lastSeenTurn || 0) - (a.lastSeenTurn || 0));
  const active = activeFor(state, "opp")[0];

  let body = `<h2>Opponent dossier</h2>`;
  for (const e of entries) {
    const isActive = active && normalizeName(active.species) === normalizeName(e.species) && active.condition !== "0 fnt";
    const seenMoves = e.usedMoves?.length ? e.usedMoves.join(", ") : "none seen";
    const ability = e.ability ? `Ability: ${e.ability}` : "Ability: unknown";
    const item = e.item ? `Item: ${e.item}` : "Item: unknown";
    const speed = active?.species === e.species && active.predictedSpeed != null
      ? `~${active.predictedSpeed} Spe`
      : (e.predictedSpeed != null ? `~${e.predictedSpeed} Spe` : "Spe unknown");

    body += `<div><strong>${esc(e.species)}</strong>${isActive ? " (active)" : ""}`;
    if (e.types?.length) body += ` [${esc(e.types.join("/"))}${e.teraType ? ` Tera ${esc(e.teraType)}` : ""}]`;
    body += `<br>${esc(hpText(e.condition))} | ${esc(ability)} | ${esc(item)}`;
    body += `<br>${esc(speed)} | Seen moves: ${esc(seenMoves)}`;
    body += `<br><span class="muted">Last seen turn ${esc(e.lastSeenTurn ?? 0)}</span></div><hr>`;
  }
  return body;
}

function bestMoveMatch(moveTypes, targetTypes) {
  if (!moveTypes?.length || !targetTypes?.length) return 1;
  return Math.max(...moveTypes.map((t) => typeEffectiveness(t, targetTypes)));
}

async function renderSwitchRecommendations(state) {
  const opp = activeFor(state, "opp")[0];
  if (!opp) return "";
  const team = currentTeamPokemon(state);
  if (!team.length) return "";
  const moves = await getMoves();

  const knownOppMoves = (opp.usedMoves || [])
    .map((name) => moves[normalizeName(name)])
    .filter(Boolean)
    .filter((m) => m.type && m.category !== "Status");

  const rows = team.filter((p) => !p.active && p.condition !== "0 fnt").map((p) => {
    const myTypes = p.types || [];
    const knownMoveTypes = (p.moveDetails || []).map((m) => m.type).filter(Boolean);
    const bestOff = bestMoveMatch(knownMoveTypes, opp.types || []);

    const threats = knownOppMoves.map((m) => typeEffectiveness(m.type, myTypes));
    if (!threats.length && opp.types?.length) {
      // A rough fallback when the opponent has not shown an attacking move:
      // use its own STAB types as the likely threat profile.
      for (const t of opp.types) threats.push(typeEffectiveness(t, myTypes));
    }
    const worstThreat = threats.length ? Math.max(...threats) : 1;
    const avgThreat = threats.length ? threats.reduce((a, b) => a + b, 0) / threats.length : 1;
    const offensive = Math.log2(Math.max(0.25, bestOff));
    const defensive = Math.log2(Math.max(0.25, Math.max(worstThreat, avgThreat)));
    const score = offensive - defensive;

    const reasons = [];
    if (bestOff >= 2) reasons.push(`${bestOff}x pressure`);
    else if (bestOff === 0) reasons.push("no known damage");
    else reasons.push(`${bestOff}x offense`);
    if (worstThreat === 0) reasons.push("immune to known threat");
    else if (worstThreat < 1) reasons.push("resists threat");
    else if (worstThreat > 1) reasons.push(`${worstThreat}x threat");
    return { p, score, reasons };
  }).sort((a, b) => b.score - a.score).slice(0, 3);

  if (!rows.length) return "";
  let body = `<h2>Smart switch recommendations</h2>`;
  body += `<div class="muted">Based on your known moves/types and the opponent's revealed typing/moves.</div>`;
  for (const r of rows) {
    const species = (r.p.details || "").split(",")[0];
    body += `<div><strong>${esc(species)}</strong>`;
    if (r.p.types?.length) body += ` [${esc(r.p.types.join("/"))}]`;
    body += ` — ${esc(r.reasons.join(", "))}</div>`;
  }
  return body;
}

async function renderDamageEstimator(state, dex, moves) {
  const ownReq = currentTeamPokemon(state).find((p) => p.active);
  const own = activeFor(state, "my")[0];
  const opp = activeFor(state, "opp")[0];
  if (!ownReq || !own || !opp) return "";
  const oppDex = dex[normalizeName(opp.species)] || {};
  const oppBase = oppDex.baseStats || {};
  const oppHp = hpParts(opp.condition);
  if (!oppHp || !Number.isFinite(oppHp.current)) return "";

  const level = Number(own.level || ownReq.level || 100);
  const attackerTypes = own.types || ownReq.types || [];
  const weather = state.field?.weather || null;
  const candidateMoves = (state.request?.active?.[0]?.moves || []).filter((m) => !m.disabled && m.category !== "Status");
  if (!candidateMoves.length) return "";

  let body = `<h2>Damage / KO estimator</h2>`;
  body += `<div class="muted">Approximate only: opponent EVs, nature, item and some abilities are hidden.</div>`;

  for (const m of candidateMoves) {
    const data = moves[m.id || normalizeName(m.move)];
    if (!data || !Number(data.basePower)) continue;
    const category = data.category;
    const atkStat = category === "Physical" ? ownReq.stats?.atk : ownReq.stats?.spa;
    const defBase = category === "Physical" ? oppBase.def : oppBase.spd;
    const defLevel = opp.level || level;
    const targetDef = Number.isFinite(defBase) ? Math.floor(((2 * defBase + 85) * defLevel) / 100) + 5 : null;
    const stab = attackerTypes.includes(data.type) ? 1.5 : 1;
    const typeMult = typeEffectiveness(data.type, opp.types || []);
    const w = weatherMultiplier(data.type, weather);
    const burned = category === "Physical" && /\bbrn\b/i.test(own.condition || "") ? 0.5 : 1;
    const dmg = estimateDamage({
      level,
      power: Number(data.basePower),
      attack: Number(atkStat),
      defense: Number(targetDef),
      stab,
      typeMult,
      weatherMult: w,
      burnPenalty: burned,
    });
    if (!dmg) continue;
    const pctMin = Math.max(0, Math.min(100, Math.round((dmg.min / Math.max(1, oppHp.max)) * 100)));
    const pctMax = Math.max(0, Math.min(100, Math.round((dmg.max / Math.max(1, oppHp.max)) * 100)));
    const hitsBest = Math.max(1, Math.ceil(oppHp.current / dmg.max));
    const hitsWorst = Math.max(1, Math.ceil(oppHp.current / dmg.min));
    const ko = hitsBest === 1 ? "possible OHKO" : `${hitsBest}-${hitsWorst} hit KO`;
    body += `<div><strong>${esc(m.move)}</strong> [${esc(data.type)} / ${esc(category)}] `;
    body += `~${dmg.min}-${dmg.max} damage (${pctMin}-${pctMax}%) — ${esc(ko)}</div>`;
  }
  return body;
}

export async function renderEnhancedBattle(state) {
  const dex = await getPokedex();
  const moves = await getMoves();
  const my = activeFor(state, "my")[0];
  const opp = activeFor(state, "opp")[0];

  let body = `<h1>${esc(state.roomTitle || "Battle")}</h1>`;
  body += `<div>Turn ${esc(state.turn || 0)}${state.ended ? " - battle over" : ""}</div>`;
  body += `<div><a href="/battle">Refresh</a> | <a href="/">Home</a></div>`;

  if (state.serverMsg && !state.ipLocked) {
    body += `<div class="banner">${esc(state.serverMsg)}</div>`;
  }
  if (state.resultMsg) body += `<div class="banner"><strong>${esc(state.resultMsg)}</strong></div>`;

  body += `<h2>You</h2>`;
  if (my) {
    body += `<div><strong>${esc(my.species || my.nickname || "?")}</strong>`;
    if (my.types?.length) body += ` [${esc(my.types.join("/"))}]`;
    body += ` — ${esc(hpText(my.condition))}</div>`;
    const ownReq = currentTeamPokemon(state).find((p) => p.active);
    if (ownReq?.stats) body += `<div class="muted">Atk/Def/SpA/SpD/Spe: ${esc(`${ownReq.stats.atk}/${ownReq.stats.def}/${ownReq.stats.spa}/${ownReq.stats.spd}/${ownReq.stats.spe}`)}</div>`;
  } else body += `<div class="muted">Waiting for active Pokémon...</div>`;

  body += `<h2>Opponent</h2>`;
  if (opp) {
    body += `<div><strong>${esc(opp.species || opp.nickname || "?")}</strong>`;
    if (opp.types?.length) body += ` [${esc(opp.types.join("/"))}]`;
    body += ` — ${esc(hpText(opp.condition))}</div>`;
    if (opp.ability) body += `<div>Ability: ${esc(opp.ability)} (revealed)</div>`;
    if (opp.item) body += `<div>Item: ${esc(opp.item)} (revealed)</div>`;
    if (opp.usedMoves?.length) body += `<div class="muted">Seen moves: ${esc(opp.usedMoves.join(", "))}</div>`;
  } else body += `<div class="muted">Waiting for opponent...</div>`;

  body += speedComparison(state, dex);
  body += await renderDamageEstimator(state, dex, moves);
  body += await renderSwitchRecommendations(state);
  body += renderDossier(state);

  body += `<hr><h2>Battle actions</h2>`;
  const req = state.request;
  if (req?.teamPreview) {
    body += `<div>Choose lead:</div>`;
    (req.side?.pokemon || []).forEach((p, i) => {
      const species = (p.details || "").split(",")[0];
      body += `<p><a href="/lead?i=${i + 1}">${i + 1}. ${esc(species)}</a></p>`;
    });
  } else if (req?.forceSwitch) {
    (req.side?.pokemon || []).forEach((p, i) => {
      if (p.active || p.condition === "0 fnt") return;
      const species = (p.details || "").split(",")[0];
      body += `<p><a href="/choose?value=${encodeURIComponent(`switch ${i + 1}`)}">${i + 1}. Switch to ${esc(species)}</a></p>`;
    });
  } else if (req?.active?.length) {
    const movesForTurn = req.active[0]?.moves || [];
    movesForTurn.forEach((m, i) => {
      if (m.disabled) body += `<div>${i + 1}. ${esc(m.move)} (disabled)</div>`;
      else body += `<p><a href="/choose?value=${encodeURIComponent(`move ${i + 1}`)}">${i + 1}. ${esc(m.move)}</a></p>`;
    });
    body += `<div>Switch:</div>`;
    (req.side?.pokemon || []).forEach((p, i) => {
      if (p.active || p.condition === "0 fnt") return;
      const species = (p.details || "").split(",")[0];
      body += `<p><a href="/choose?value=${encodeURIComponent(`switch ${i + 1}`)}">Switch to ${i + 1}. ${esc(species)}</a></p>`;
    });
  } else if (!state.ended) {
    body += `<div>Waiting for the next request...</div>`;
  }

  body += `<hr><div><a href="/battle">Refresh</a> | <a href="/timer">${state.timerOn ? "Turn timer off" : "Turn timer on"}</a> | <a href="/dex">Pokédex</a> | <a href="/commands">Commands</a> | <a href="/forfeit">Forfeit</a> | <a href="/">Home</a></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(state.roomTitle || "Battle")}</title><style>
body{font-family:sans-serif;font-size:14px;margin:8px;background:#111;color:#eee}a{color:#7ec3ff}h1{font-size:18px;margin:4px 0}h2{font-size:15px;margin:12px 0 4px}.muted{color:#999;font-size:12px}.banner{background:#2a2510;border:1px solid #775500;padding:6px;border-radius:4px;margin:6px 0;font-size:12px}hr{border:0;border-top:1px solid #333;margin:10px 0}
</style></head><body>${body}</body></html>`;
}
