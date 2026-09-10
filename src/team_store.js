import { ProxyAgent, fetch as undiciFetch } from "undici";

const TEAMS_URL = "https://teams.pokemonshowdown.com/api/getteams?full=1";

function buildProxyDispatcher() {
  const proxyUrl = process.env.PROXY_URL;
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    const opts = { uri: `${u.protocol}//${u.host}` };
    if (u.username || u.password) {
      const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
      opts.token = `Basic ${Buffer.from(creds).toString("base64")}`;
    }
    return new ProxyAgent(opts);
  } catch {
    return undefined;
  }
}

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

  const dispatcher = buildProxyDispatcher();
  const options = {
    headers: {
      Cookie: upstreamCookie,
      Accept: "application/json",
      "User-Agent": "ps-cloudphone-team-picker",
    },
  };
  if (dispatcher) options.dispatcher = dispatcher;

  const res = await undiciFetch(TEAMS_URL, options);
  if (!res.ok) throw new Error(`Team server returned HTTP ${res.status}.`);

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The Showdown team server returned an invalid response.");
  }

  const source = Array.isArray(data) ? data : (data?.teams || data?.data || []);
  const teams = source.map(normaliseTeam).filter(Boolean);
  return teams;
}

export function teamMatchesFormat(team, format) {
  const f = String(format || "").toLowerCase();
  const tf = String(team?.format || "").toLowerCase();
  if (!tf) return false;

  if (f === "gen9ou") {
    return tf === "gen9ou" || tf === "gen9overused" || tf === "ou";
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
