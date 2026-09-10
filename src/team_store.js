const TEAMS_URL = "https://teams.pokemonshowdown.com/api/getteams?full=1";

function normaliseTeam(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.teamid ?? raw.id ?? "").trim();
  const name = String(raw.name ?? raw.title ?? `Team ${id || "?"}`).trim();
  const format = String(raw.format ?? "").trim();
  const packed = String(raw.team ?? raw.packed ?? "").trim();
  if (!id || !packed) return null;
  return {
    id,
    name: name || `Team ${id}`,
    format,
    packed,
    private: !!Number(raw.private),
    ownerid: String(raw.ownerid ?? raw.owner ?? "").trim(),
  };
}

export async function fetchRemoteTeams(upstreamCookie) {
  if (!upstreamCookie) {
    throw new Error("No authenticated Showdown session is available for team storage.");
  }

  const res = await fetch(TEAMS_URL, {
    headers: {
      Cookie: upstreamCookie,
      Accept: "application/json",
      "User-Agent": "ps-cloudphone-team-picker",
    },
  });

  if (!res.ok) throw new Error(`Team server returned HTTP ${res.status}.`);

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The Showdown team server returned an invalid response.");
  }

  const source = Array.isArray(data) ? data : (data?.teams || data?.data || []);
  return source.map(normaliseTeam).filter(Boolean);
}

export function teamMatchesFormat(team, format) {
  const f = String(format || "").toLowerCase().trim();
  const tf = String(team?.format || "").toLowerCase().trim();
  if (!tf) return false;

  if (f === "gen9ou") {
    return [
      "gen9ou",
      "gen9overused",
      "gen9overusedou",
      "ou",
      "gen 9 ou",
      "[gen 9] ou",
    ].includes(tf) || /gen\s*9.*ou/.test(tf);
  }
  return tf === f;
}

export function unpackTeamPreview(packed) {
  return String(packed || "")
    .split("]")
    .filter(Boolean)
    .map((set) => {
      const fields = set.split("|");
      const nickname = String(fields[0] || "").trim();
      const species = String(fields[1] || nickname).trim();
      return nickname && nickname !== species ? `${species} (${nickname})` : species;
    })
    .filter(Boolean);
}
