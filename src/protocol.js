export function splitFrame(text) {
  const rawLines = String(text || "").split("\n");
  let roomId = "";
  let lines = rawLines;
  if (rawLines[0] && rawLines[0].startsWith(">")) {
    roomId = rawLines[0].slice(1).trim();
    lines = rawLines.slice(1);
  }
  return { roomId, lines: lines.filter((l) => l.length > 0) };
}

export function parseLine(line) {
  if (!line.startsWith("|")) {
    return { type: "raw", parts: [line] };
  }
  const parts = line.slice(1).split("|");
  const type = parts.shift();
  return { type, parts };
}

export function parseIdent(ident) {
  const str = String(ident || "");
  const idx = str.indexOf(": ");
  if (idx === -1) return { side: str, name: str };
  return { side: str.slice(0, idx), name: str.slice(idx + 2) };
}

function condText(cond) {
  if (!cond) return "";
  if (cond === "0 fnt") return "fainted";
  return cond;
}

export function normalizeName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseDetails(details) {
  const parts = String(details || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const species = parts[0] || "";
  const shiny = parts.some((p) => p.toLowerCase() === "shiny");
  let level = 100;
  for (const p of parts) {
    const m = p.match(/^L(\d+)$/);
    if (m) level = Number(m[1]);
  }
  return { species, shiny, level };
}

export function spriteId(species) {
  let s = String(species || "").toLowerCase().trim();
  if (!s) return "";
  s = s
    .replace(/♀/g, "f")
    .replace(/♂/g, "m")
    .replace(/'/g, "")
    .replace(/\./g, "");
  if (s.includes("-")) {
    return s
      .split("-")
      .map((part) => part.replace(/[^a-z0-9]/g, ""))
      .filter(Boolean)
      .join("-");
  }
  return s.replace(/[^a-z0-9]/g, "");
}

export function spriteUrl(species, { shiny = false, back = false, anim = false } = {}) {
  const id = spriteId(species);
  if (!id) return null;
  const folder = anim
    ? back ? "gen5ani-back" : "gen5ani"
    : back ? "gen5-back" : "gen5";
  const ext = anim ? "gif" : "png";
  const file = shiny ? `${id}-shiny` : id;
  return `/sprite/${folder}/${file}.${ext}`;
}

// ---------------------------------------------------------------------------
// Formats - single source of truth. Edit ids here if your upstream sim uses
// different ids for the Champions formats.
// ---------------------------------------------------------------------------
export const FORMATS = [
  ["gen9randombattle", "Gen 9 Random Battle"],
  ["gen9championsrandombattle", "Gen 9 Champions Random Battle"],
  ["gen9randomdoublesbattle", "Gen 9 Random Doubles Battle"],
  ["gen9championsrandomdoublesbattle", "Gen 9 Champions Random Doubles Battle"],
  ["gen9ou", "Gen 9 OU"],
];

export function formatNeedsTeam(id) {
  return !String(id || "").includes("random");
}

export const TYPE_CHART = {
  Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water: { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass: { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
  Poison: { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
  Ground: { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying: { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic: { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug: { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
  Rock: { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost: { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
  Dragon: { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark: { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
  Steel: { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
  Fairy: { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 },
};

export function typeEffectiveness(moveType, defenderTypes) {
  if (!moveType) return 1;
  const chart = TYPE_CHART[moveType];
  if (!chart) return 1;
  let mult = 1;
  for (const dType of defenderTypes || []) {
    if (chart[dType] !== undefined) mult *= chart[dType];
  }
  return mult;
}

export const ALL_TYPES = Object.keys(TYPE_CHART);

export function typeChartTable() {
  return ALL_TYPES.map((defType) => {
    const weakTo = [];
    const resists = [];
    const immuneTo = [];
    for (const atkType of ALL_TYPES) {
      const chart = TYPE_CHART[atkType];
      const mult = chart && chart[defType] !== undefined ? chart[defType] : 1;
      if (mult === 0) immuneTo.push(atkType);
      else if (mult > 1) weakTo.push(atkType);
      else if (mult < 1) resists.push(atkType);
    }
    return { type: defType, weakTo, resists, immuneTo };
  });
}

// ---------------------------------------------------------------------------
// Approximate damage estimation. Assumes 31 IVs, ~85 EVs everywhere, neutral
// nature, no items/abilities/weather/screens/crits. Includes type chart,
// STAB, Tera STAB, stat boosts, burn, multi-hit average, and fixed-damage
// moves. Everything shown to the user carries a "~" so nobody mistakes it
// for exact math.
// ---------------------------------------------------------------------------
const EST_IV = 31;
const EST_EV = 85;

export function estStat(base, level) {
  base = Number(base) || 0;
  level = Number(level) || 100;
  return Math.floor(((2 * base + EST_IV + Math.floor(EST_EV / 4)) * level) / 100) + 5;
}

export function estHp(base, level) {
  base = Number(base) || 0;
  level = Number(level) || 100;
  return Math.floor(((2 * base + EST_IV + Math.floor(EST_EV / 4)) * level) / 100) + level + 10;
}

export function boostMultiplier(stage) {
  const n = Math.max(-6, Math.min(6, Number(stage) || 0));
  return n >= 0 ? (2 + n) / 2 : 2 / (2 - n);
}

export function parseConditionHp(cond) {
  const m = String(cond || "").match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return { cur: Number(m[1]), max: Number(m[2]) };
}

// move: { type, category, basePower, multihit, damage } (enriched from moves.json)
// atk:  { level, baseStats, types, boosts, status, teraType }
// def:  { level, baseStats, types, boosts, maxHp }
// Returns { min, max, eff, rough } as damage percent, or null.
export function estimateDamage(move, atk, def) {
  if (!move || !atk || !def) return null;
  if (move.category === "Status") return null;
  const eff = typeEffectiveness(move.type, def.types);
  if (eff === 0) return { min: 0, max: 0, eff, rough: false };

  const level = Number(atk.level) || 100;
  let rough = false;
  let dmg;
  if (move.damage === "level") {
    dmg = level;
  } else if (typeof move.damage === "number") {
    dmg = move.damage;
  } else {
    let bp = Number(move.basePower) || 0;
    if (!bp) {
      bp = 60; // situational BP (Gyro Ball, Grass Knot, Return...) - rough guess
      rough = true;
    }
    const phys = move.category === "Physical";
    const aStat = phys ? "atk" : "spa";
    const dStat = phys ? "def" : "spd";
    const aBase = atk.baseStats ? atk.baseStats[aStat] : 100;
    const dBase = def.baseStats ? def.baseStats[dStat] : 100;
    let A = estStat(aBase, level) * boostMultiplier((atk.boosts || {})[aStat]);
    if (phys && atk.status === "brn") A *= 0.5;
    const D = estStat(dBase, Number(def.level) || 100) * boostMultiplier((def.boosts || {})[dStat]);
    if (D <= 0 || A <= 0) return null;
    dmg = Math.floor(Math.floor(Math.floor(((2 * level) / 5 + 2) * bp * A / D) / 50) + 2);
    if (move.multihit) {
      if (Array.isArray(move.multihit)) {
        dmg *= 3; // average of 2-5 (or 1-3) hit ranges
        rough = true;
      } else {
        dmg *= Number(move.multihit) || 1;
      }
    }
  }

  let stab = 1;
  if (atk.teraType && normalizeName(atk.teraType) === normalizeName(move.type)) stab = 2;
  else if ((atk.types || []).includes(move.type)) stab = 1.5;
  const mid = Math.floor(Math.floor(dmg * stab) * eff);

  let maxHp = Number(def.maxHp) || 0;
  if (!maxHp && def.baseStats) maxHp = estHp(def.baseStats.hp, def.level || 100);
  if (!maxHp) return null;

  const lo = Math.max(1, Math.floor(mid * 0.85));
  const hi = Math.max(lo, mid);
  return {
    min: Math.min(100, Math.round((lo * 100) / maxHp)),
    max: Math.min(100, Math.round((hi * 100) / maxHp)),
    eff,
    rough,
  };
}

function stripRank(user) {
  return String(user || "").replace(/^[^A-Za-z0-9]+/, "");
}

export function cleanRawHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<img[^>]*alt=["']?([^"'>]+)["']?[^>]*>/gi, " [$1] ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&ThickSpace;/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatBattleLine(type, parts, mySide = null) {
  const mine = (side) =>
    mySide ? side.startsWith(mySide) : side.startsWith("p1");

  switch (type) {
    case "raw":
    case "html":
      return cleanRawHtml(parts.join("|"));
    case "player":
    case "teamsize":
    case "gametype":
    case "gen":
    case "rule":
    case "clearpoke":
    case "poke":
    case "upkeep":
    case "j":
    case "J":
    case "l":
    case "L":
    case "n":
    case "N":
    case ":":
    case "uhtml":
    case "uhtmlchange":
    case "formats":
    case "customgroups":
    case "updateuser":
    case "challstr":
    case "init":
    case "users":
      return null;
    case "c":
    case "chat": {
      const user = stripRank(parts[0]);
      let text = parts.slice(1).join("|");
      if (text.startsWith("/raw ")) {
        text = cleanRawHtml(text.slice(5));
      }
      return `${user}: ${text}`;
    }
    case "c:": {
      const user = stripRank(parts[1]);
      let text = parts.slice(2).join("|");
      if (text.startsWith("/raw ")) {
        text = cleanRawHtml(text.slice(5));
      }
      return `${user}: ${text}`;
    }
    case "inactive":
    case "inactiveoff":
      return parts[0] || null; 
    case "teampreview":
      return "Team preview.";
    case "start":
      return "Battle started!";
    case "turn":
      return `--- Turn ${parts[0]} ---`;
    case "move": {
      const src = parseIdent(parts[0]);
      return `${src.name} used ${parts[1]}!`;
    }
    case "switch":
    case "drag": {
      const p = parseIdent(parts[0]);
      const species = String(parts[1] || "").split(",")[0];
      return `${mine(p.side) ? "Your" : "Opponent's"} ${species} (${p.name}) came in.`;
    }
    case "faint": {
      const p = parseIdent(parts[0]);
      return `${mine(p.side) ? "Your" : "Opponent's"} ${p.name} fainted!`;
    }
    case "-damage": {
      const p = parseIdent(parts[0]);
      return `${p.name} is at ${condText(parts[1])}.`;
    }
    case "-heal": {
      const p = parseIdent(parts[0]);
      return `${p.name} healed to ${condText(parts[1])}.`;
    }
    case "-status": {
      const p = parseIdent(parts[0]);
      return `${p.name} was afflicted with ${parts[1]}.`;
    }
    case "-curestatus": {
      const p = parseIdent(parts[0]);
      return `${p.name} recovered from its status.`;
    }
    case "-start": {
      const p = parseIdent(parts[0]);
      return `${p.name}: ${parts[1]} started.`;
    }
    case "-end": {
      const p = parseIdent(parts[0]);
      return `${p.name}'s ${parts[1]} ended.`;
    }
    case "-boost": {
      const p = parseIdent(parts[0]);
      return `${p.name}'s ${parts[1]} rose! (+${parts[2]})`;
    }
    case "-unboost": {
      const p = parseIdent(parts[0]);
      return `${p.name}'s ${parts[1]} fell! (-${parts[2]})`;
    }
    case "-setboost": {
      const p = parseIdent(parts[0]);
      const amt = Number(parts[2]) || 0;
      return `${p.name}'s ${parts[1]} was set to ${amt > 0 ? "+" : ""}${amt}!`;
    }
    case "-clearboost": {
      const p = parseIdent(parts[0]);
      return `${p.name}'s stat changes were erased!`;
    }
    case "-clearallboost":
      return "All stat changes were cleared!";
    case "-crit":
      return "A critical hit!";
    case "-supereffective":
      return "It's super effective!";
    case "-resisted":
      return "It's not very effective.";
    case "-immune": {
      const p = parseIdent(parts[0]);
      return `It doesn't affect ${p.name}.`;
    }
    case "-miss":
      return "The attack missed!";
    case "-fail": {
      const p = parseIdent(parts[0]);
      return `${p.name}'s move failed.`;
    }
    case "-weather":
      return parts[0] === "none" ? "The weather cleared." : `Weather: ${parts[0]}`;
    case "-fieldstart":
      return `${parts[0]} took hold!`;
    case "-fieldend":
      return `${parts[0]} ended.`;
    case "-sidestart":
      return `${parts[1]} started on ${parts[0]}.`;
    case "-sideend":
      return `${parts[1]} ended on ${parts[0]}.`;
    case "-activate": {
      const p = parseIdent(parts[0]);
      return `${p.name}: ${parts[1]}`;
    }
    case "cant": {
      const p = parseIdent(parts[0]);
      return `${p.name} can't move (${parts[1]}).`;
    }
    case "-ability": {
      const p = parseIdent(parts[0]);
      return `${p.name}'s ability: ${parts[1]}`;
    }
    case "-item": {
      const p = parseIdent(parts[0]);
      return `${p.name}'s item: ${parts[1]}`;
    }
    case "-enditem": {
      const p = parseIdent(parts[0]);
      return `${p.name}'s ${parts[1]} was used up.`;
    }
    case "-mega": {
      const p = parseIdent(parts[0]);
      return `${p.name} Mega Evolved!`;
    }
    case "-terastallize": {
      const p = parseIdent(parts[0]);
      return `${p.name} Terastallized into ${parts[1]}!`;
    }
    case "-formechange": {
      const p = parseIdent(parts[0]);
      return `${p.name} changed into ${parts[1]}!`;
    }
    case "win":
      return `${parts[0]} won the battle!`;
    case "tie":
      return "The battle ended in a tie.";
    case "error":
      return `Error: ${parts[0]}`;
    case "message":
      return parts[0];
    default:
      return parts.length ? `[${type}] ${parts.join(" ")}` : null;
  }
}
