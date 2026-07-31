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
//   >roomid
//   |line1
//   |line2
// or, for global/lobby messages, the ">roomid" line is omitted.
export function splitFrame(text) {
  const rawLines = text.split("\n");
  let roomId = "";
  let lines = rawLines;
  if (rawLines[0] && rawLines[0].startsWith(">")) {
    roomId = rawLines[0].slice(1).trim();
    lines = rawLines.slice(1);
  }
  return { roomId, lines: lines.filter((l) => l.length > 0) };
}

// A single protocol line -> { type, parts } or null for plain text lines.
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

// Turns one parsed battle-log line into a human readable string, or null
// if it should be skipped entirely (chat/join/leave/timer noise etc).
export function formatBattleLine(type, parts) {
  switch (type) {
    case "raw":
      return parts[0];
    case "player":
      return null;
    case "teamsize":
      return null;
    case "gametype":
      return null;
    case "gen":
      return null;
    case "tier":
      return `Format: ${parts[0]}`;
    case "rule":
      return null;
    case "clearpoke":
      return null;
    case "poke":
      return null;
    case "teampreview":
      return "Team preview.";
    case "start":
      return "Battle started!";
    case "turn":
      return `--- Turn ${parts[0]} ---`;
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
      return null;
    case "move": {
      const src = parseIdent(parts[0]);
      return `${src.name} used ${parts[1]}!`;
    }
    case "switch":
    case "drag": {
      const p = parseIdent(parts[0]);
      const species = parts[1].split(",")[0];
      return `${p.side.startsWith("p1") ? "Your" : "Opponent's"} ${species} (${p.name}) came in.`;
    }
    case "faint": {
      const p = parseIdent(parts[0]);
      return `${p.name} fainted!`;
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
    case "-item":
      return null;
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
    case "html":
    case "uhtml":
    case "uhtmlchange":
      return null; // rendering arbitrary HTML is out of scope for a feature-phone log
    default:
      // Fallback so nothing silently disappears -- useful for debugging too.
      return parts.length ? `[${type}] ${parts.join(" ")}` : null;
  }
}
