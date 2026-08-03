// Minimal parser/formatter for Pokemon Showdown's line protocol.
// Reference: https://github.com/smogon/pokemon-showdown/blob/master/PROTOCOL.md
//            https://github.com/smogon/pokemon-showdown/blob/master/sim/SIM-PROTOCOL.md
//
// This does NOT try to cover every message type -- only what's needed to
// show a legible battle log and drive the choice UI on a feature phone.
// Anything unrecognized falls back to a raw "[type] rest" line instead of
// being silently dropped, so nothing important gets lost.

// Splits one raw WebSocket text frame into { roomId, lines }.
// Frames look like:
//    >roomid
//    |line1
//    |line2
// or, for global/lobby messages, the ">roomid" line is omitted.
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

// A single protocol line -> { type, parts }.
export function parseLine(line) {
  if (!line.startsWith("|")) {
    return { type: "raw", parts: [line] };
  }
  const parts = line.slice(1).split("|");
  const type = parts.shift();
  return { type, parts };
}

// "p1a: Pikachu" -> { side: "p1a", name: "Pikachu" }
export function parseIdent(ident) {
  const idx = ident.indexOf(": ");
  if (idx === -1) return { side: ident, name: ident };
  return { side: ident.slice(0, idx), name: ident.slice(idx + 2) };
}

// "78/100 par" or "0 fnt" -> readable condition text
function condText(cond) {
  if (!cond) return "";
  if (cond === "0 fnt") return "fainted";
  return cond;
}

// Normalizes a Showdown username for comparison ("Guest 1234" -> "guest1234").
export function normalizeName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// "Pikachu, L50, M, shiny" -> { species: "Pikachu", shiny: true }
export function parseDetails(details) {
  const parts = String(details || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const species = parts[0] || "";
  const shiny = parts.some((p) => p.toLowerCase() === "shiny");

  return { species, shiny };
}

// Converts a species/form name into a Showdown sprite file id.
//   "Mr. Mime"      -> "mrmime"
//   "Pikachu-Alola" -> "pikachu-alola"
//   "Ho-Oh"         -> "ho-oh"
//   "Nidoran♀"      -> "nidoranf"
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

// Same-origin sprite URL served by the Worker's /sprite/* proxy.
//   anim=false -> gen5 / gen5-back (.png)
//   anim=true  -> gen5ani / gen5ani-back (.gif, animated, higher quality)
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

// Turns one parsed battle-log line into a human readable string, or null
// if it should be skipped entirely (chat/join/leave/timer noise etc).
// `mySide` ("p1"/"p2"/null) controls "Your" vs "Opponent's" wording.
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
    case "inactive":
    case "inactiveoff":
    case "j":
    case "J":
    case "l":
    case "L":
    case "n":
    case "N":
    case "c":
    case "chat":
    case ":":
    case "c:":
    case "-item":
    case "html":
    case "uhtml":
    case "uhtmlchange":
      return null;

    case "tier":
      return `Format: ${parts[0]}`;
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
    case "-boost": {
      const p = parseIdent(parts[0]);
      return `${p.name}'s ${parts[1]} rose! (+${parts[2]})`;
    }
    case "-unboost": {
      const p = parseIdent(parts[0]);
      return `${p.name}'s ${parts[1]} fell! (-${parts[2]})`;
    }
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
    case "-enditem": {
      const p = parseIdent(parts[0]);
      return `${p.name} used its ${parts[1]}!`;
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
      // Fallback so nothing silently disappears -- useful for debugging too.
      return parts.length ? `[${type}] ${parts.join(" ")}` : null;
  }
}
