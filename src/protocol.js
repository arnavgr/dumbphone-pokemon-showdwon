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
  const idx = ident.indexOf(": ");
  if (idx === -1) return { side: ident, name: ident };
  return { side: ident.slice(0, idx), name: ident.slice(idx + 2) };
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

function stripRank(user) {
  return String(user || "").replace(/^[^A-Za-z0-9]+/, "");
}

export function formatBattleLine(type, parts, mySide = null) {
  const mine = (side) =>
    mySide ? side.startsWith(mySide) : side.startsWith("p1");

  switch (type) {
    case "raw":
      return parts[0];
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
    case "html":
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
    case "chat":
      return `${stripRank(parts[0])}: ${parts.slice(1).join("|")}`;
    case "c:":
      return `${stripRank(parts[1])}: ${parts.slice(2).join("|")}`;
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
