import WebSocket from "ws";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import {
  splitFrame,
  parseLine,
  parseIdent,
  formatBattleLine,
  normalizeName,
  parseDetails,
  spriteUrl,
  typeEffectiveness,
  cleanRawHtml,
  FORMATS,
  formatNeedsTeam,
} from "./protocol.js";
import {
  renderHome,
  renderBattle,
  renderError,
  renderLogin,
  renderMoveInfo,
  renderDex,
  renderDebug,
  renderTypeChart,
  renderCommands,
  renderTeams,
} from "./html.js";

const SHOWDOWN_WS_URL = "wss://sim3.psim.us/showdown/websocket";
const ANIMATED_SPRITES = true;

// ---------------------------------------------------------------------------
// Outbound Proxy Configuration
// ---------------------------------------------------------------------------
const PROXY_URL = process.env.PROXY_URL;
if (!PROXY_URL) {
  throw new Error(
    "PROXY_URL environment variable is not set. Set it in Render's " +
      "dashboard (Environment tab) -- do not hardcode a proxy URL in source."
  );
}

const proxyAgent = new HttpsProxyAgent(PROXY_URL);

function buildProxyDispatcher(proxyUrlStr) {
  const u = new URL(proxyUrlStr);
  const uri = `${u.protocol}//${u.host}`;
  const opts = { uri };
  if (u.username || u.password) {
    const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    opts.token = `Basic ${Buffer.from(creds).toString("base64")}`;
  }
  return new ProxyAgent(opts);
}
const proxyDispatcher = buildProxyDispatcher(PROXY_URL);

// ---------------------------------------------------------------------------
// Cookie Persistence Encryption Helpers
// ---------------------------------------------------------------------------
const COOKIE_SECRET = process.env.COOKIE_SECRET || "ps-cloudphone-default-secret-salt-key";
const CIPHER_KEY = crypto.createHash("sha256").update(COOKIE_SECRET).digest();

function encryptCredentials(username, password) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", CIPHER_KEY, iv);
  const payload = JSON.stringify({ u: username, p: password });
  let enc = cipher.update(payload, "utf8", "hex");
  enc += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${tag}:${enc}`;
}

function decryptCredentials(cookieStr) {
  try {
    const [ivHex, tagHex, enc] = String(cookieStr || "").split(":");
    if (!ivHex || !tagHex || !enc) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", CIPHER_KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    let dec = decipher.update(enc, "hex", "utf8");
    dec += decipher.final("utf8");
    return JSON.parse(dec);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Team storage - keyed by logged-in Showdown username, persisted best-effort
// to data/teams.json so teams survive restarts/redeploys when the disk allows.
// ---------------------------------------------------------------------------
const TEAMS_FILE = path.join(process.cwd(), "data", "teams.json");

function loadTeamsStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TEAMS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
const teamsStore = loadTeamsStore();
function saveTeamsStore() {
  try {
    fs.mkdirSync(path.dirname(TEAMS_FILE), { recursive: true });
    fs.writeFileSync(TEAMS_FILE, JSON.stringify(teamsStore));
  } catch {
    // read-only filesystem: teams just live until the next restart
  }
}

const NATURES = new Set([
  "hardy", "lonely", "brave", "adamant", "naughty",
  "bold", "docile", "relaxed", "impish", "lax",
  "timid", "hasty", "serious", "jolly", "naive",
  "modest", "mild", "quiet", "rash",
  "calm", "gentle", "sassy", "careful", "quirky",
]);

let pokedexCache = null;
let pokedexPromise = null;
async function getPokedex() {
  if (pokedexCache) return pokedexCache;
  if (!pokedexPromise) {
    pokedexPromise = fetch("https://play.pokemonshowdown.com/data/pokedex.json")
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => { pokedexCache = data || {}; return pokedexCache; })
      .catch(() => { pokedexCache = {}; return pokedexCache; });
  }
  return pokedexPromise;
}

let movesCache = null;
let movesPromise = null;
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

let itemsCache = null;
let itemsPromise = null;
async function getItems() {
  if (itemsCache) return itemsCache;
  if (!itemsPromise) {
    itemsPromise = fetch("https://play.pokemonshowdown.com/data/items.json")
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => { itemsCache = data || {}; return itemsCache; })
      .catch(() => { itemsCache = {}; return itemsCache; });
  }
  return itemsPromise;
}

// ---------------------------------------------------------------------------
// Team import: parse a Showdown-exported team (teambuilder "Export" text),
// validate it against the fetched dex/moves/items, and produce the packed
// string that /utm expects. Tera type is intentionally not packed - the sim
// defaults it to the Pokemon's first type, and the battle request tells the
// player which Tera type is available.
// ---------------------------------------------------------------------------
async function importTeam(text) {
  const dex = await getPokedex();
  const movesData = await getMoves();
  const itemsData = await getItems();

  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^={3,}/.test(l));

  const statMap = {
    hp: "hp", atk: "atk", attack: "atk", def: "def", defense: "def",
    spa: "spa", specialattack: "spa", spatk: "spa",
    spd: "spd", specialdefense: "spd", spdef: "spd",
    spe: "spe", speed: "spe",
  };
  const statFrom = (s) => statMap[normalizeName(s)];
  const parseSpread = (s, bag) => {
    for (const part of String(s).split("/")) {
      const m = part.trim().match(/^(\d+)\s+([A-Za-z ]+)$/);
      if (m) {
        const key = statFrom(m[2]);
        if (key) bag[key] = Number(m[1]) || 0;
      }
    }
  };

  const sets = [];
  let cur = null;
  for (const line of lines) {
    if (/^[-\u2022\u00b7\u2013]\s+/.test(line)) {
      if (cur && cur.moves.length < 4) {
        cur.moves.push(line.replace(/^[-\u2022\u00b7\u2013]\s+/, "").trim());
      }
      continue;
    }
    let m;
    if ((m = line.match(/^Ability:\s*(.+)$/i))) { if (cur) cur.ability = m[1].trim(); continue; }
    if ((m = line.match(/^Level:\s*(\d+)$/i))) { if (cur) cur.level = Number(m[1]); continue; }
    if ((m = line.match(/^Happiness:\s*(\d+)$/i))) { if (cur) cur.happiness = Number(m[1]); continue; }
    if (/^Shiny:\s*(Yes|True)$/i.test(line)) { if (cur) cur.shiny = true; continue; }
    if (/^Gigantamax:\s*(Yes|True)$/i.test(line)) { if (cur) cur.gmax = true; continue; }
    if ((m = line.match(/^Tera Type:\s*(.+)$/i))) { if (cur) cur.teraType = m[1].trim(); continue; }
    if ((m = line.match(/^EVs:\s*(.+)$/i))) { if (cur) parseSpread(m[1], cur.evs); continue; }
    if ((m = line.match(/^IVs:\s*(.+)$/i))) { if (cur) parseSpread(m[1], cur.ivs); continue; }
    if ((m = line.match(/^([A-Za-z]+)\s+Nature$/i))) { if (cur) cur.nature = m[1].trim(); continue; }

    // Otherwise: a new set header line ("Species @ Item" or "Nick (Species) @ Item")
    const atSplit = line.split("@");
    const head = atSplit[0].trim();
    if (!head) continue;
    let item = atSplit.slice(1).join("@").trim().replace(/\s*\([MF]\)$/i, "");
    let species = head;
    let nick = "";
    const paren = head.match(/^(.*)\(([^()]*)\)\s*$/);
    if (paren && /^[MF]$/i.test(paren[2].trim())) {
      species = paren[1].trim(); // trailing gender marker, not a nickname
    } else if (paren) {
      nick = paren[1].trim();
      species = paren[2].trim();
    }
    cur = {
      nick: nick.replace(/[|\[\]]/g, "").trim(),
      species,
      item,
      ability: "",
      nature: "",
      evs: {},
      ivs: {},
      moves: [],
      level: 100,
      shiny: false,
      happiness: 255,
    };
    sets.push(cur);
  }

  if (!sets.length) {
    throw new Error("No Pokemon found - paste a Showdown-exported team (teambuilder -> Export).");
  }
  if (sets.length > 6) throw new Error("A team can have at most 6 Pokemon.");

  const packedSets = [];
  const summary = [];
  for (const set of sets) {
    const spId = normalizeName(set.species);
    const entry = dex[spId];
    if (!entry) throw new Error(`Unknown Pokemon: "${set.species}"`);
    const speciesName = entry.name;

    const moves = set.moves.map((mv) => {
      const mvId = normalizeName(String(mv).replace(/\s*\[.*\]\s*$/, ""));
      if (!movesData[mvId]) throw new Error(`${speciesName}: unknown move "${mv}"`);
      return mvId;
    });
    if (!moves.length) throw new Error(`${speciesName} has no moves.`);

    const itemId = set.item ? normalizeName(set.item) : "";
    if (itemId && !itemsData[itemId]) throw new Error(`${speciesName}: unknown item "${set.item}"`);

    let abilityId = set.ability ? normalizeName(set.ability) : "";
    if (!abilityId && entry.abilities) {
      abilityId = normalizeName(entry.abilities["0"] || Object.values(entry.abilities)[0]);
    }

    const natureId = set.nature ? normalizeName(set.nature) : "serious";
    if (!NATURES.has(natureId)) throw new Error(`${speciesName}: unknown nature "${set.nature}"`);

    const evKeys = ["hp", "atk", "def", "spa", "spd", "spe"];
    const evs = evKeys.map((k) => Math.max(0, Math.min(252, Number(set.evs[k]) || 0)));
    if (evs.reduce((a, b) => a + b, 0) > 510) {
      throw new Error(`${speciesName}: more than 510 total EVs.`);
    }
    const ivs = evKeys.map((k) => {
      const v = set.ivs[k];
      return v === undefined ? 31 : Math.max(0, Math.min(31, Number(v) || 0));
    });

    const level = Math.max(1, Math.min(100, Number(set.level) || 100));
    const namePart =
      set.nick && normalizeName(set.nick) !== normalizeName(speciesName)
        ? `${set.nick}|${spId}`
        : spId;

    packedSets.push([
      namePart,
      itemId,
      abilityId,
      moves.join(","),
      natureId,
      evs.join(","),
      ivs.join(","),
      set.shiny ? "S" : "",
      String(level),
      set.happiness !== 255 ? String(set.happiness) : "",
    ].join("|"));
    summary.push(speciesName);
  }

  return { packed: packedSets.join("]"), count: sets.length, summary: summary.join(", ") };
}

function cleanSideCond(s) {
  return String(s || "").replace(/^move:\s*/i, "").trim();
}

function sideKey(side) {
  return String(side || "").slice(0, 2);
}

const DEFAULT_STATE = {
  connected: false,
  username: null,
  loggedIn: false,
  mySide: null,
  players: {},
  active: {},
  roomId: null,
  roomTitle: null,
  log: [],
  chat: [],
  request: null,
  searching: [],
  turn: 0,
  ended: false,
  timerOn: false,
  resultMsg: null,
  challstr: null,
  notice: null,
  loginError: null,
  serverMsg: null,
  upstreamCookie: null,
  challengesFrom: {},
  challengeTo: null,
  loginName: null,
  loginPassword: null,
  revealed: {},
  field: { weather: null, fields: [], sides: {} },
  ipLocked: false,
  ipLockedAt: null,
  ipLockedMsg: null,
  gameType: null,
  dexData: null,
  movesData: null,
  lastTeam: {},
  teamNext: null,
  teamError: null,
  teamView: null,
};

export class BattleSession {
  constructor(sid) {
    this.sid = sid;
    this.state_ = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this.ws = null;
    this.keepAliveInterval = null;
    this.relogDisabled = false;
    this.freshChallstr = false;
    this.loginConfirmResolve = null;
    this.pendingLoginName = null;
    this._loginLock = Promise.resolve();
    this._connectLock = null;
    this.connectedAt = null;
    this.consecutiveQuickDrops = 0;
    this._dropHandled = false;
    this._messageQueue = Promise.resolve();
  }

  pushLog(line) {
    if (!line) return;
    this.state_.log.push(line);
    if (this.state_.log.length > 200) {
      this.state_.log = this.state_.log.slice(-200);
    }
  }

  pushChat(line) {
    if (!line) return;
    this.state_.chat.push(line);
    if (this.state_.chat.length > 50) {
      this.state_.chat = this.state_.chat.slice(-50);
    }
  }

  resetBattle() {
    Object.assign(this.state_, {
      roomId: null,
      roomTitle: null,
      log: [],
      chat: [],
      request: null,
      turn: 0,
      ended: false,
      timerOn: false,
      resultMsg: null,
      mySide: null,
      players: {},
      active: {},
      revealed: {},
      field: { weather: null, fields: [], sides: {} },
      gameType: null,
    });
  }

  detectMySide() {
    if (!this.state_.username) return;
    const mine = normalizeName(this.state_.username);
    if (!mine) return;
    for (const [slot, name] of Object.entries(this.state_.players)) {
      if (normalizeName(name) === mine) {
        this.state_.mySide = slot;
        return;
      }
    }
  }

  oppSide() {
    const mySide = this.state_.mySide || "p1";
    return mySide === "p1" ? "p2" : "p1";
  }

  oppActiveInfo() {
    const oppPrefix = this.oppSide();
    for (const [slot, info] of Object.entries(this.state_.active || {})) {
      if (slot.startsWith(oppPrefix)) return info;
    }
    return null;
  }

  async upsertActive(parts) {
    const p = parseIdent(parts[0] || "");
    const { species, shiny, level } = parseDetails(parts[1] || "");
    const condition = parts[2] || "";
    const dex = await getPokedex();
    const id = normalizeName(species);
    const entry = dex[id] || {};
    let types = entry.types || [];

    const baseStats = entry.baseStats || null;
    let predictedSpeed = null;
    if (baseStats && Number.isFinite(baseStats.spe) && level) {
      predictedSpeed = Math.floor(((2 * baseStats.spe + 85) * level) / 100) + 5;
    }
    const possibleAbilities = entry.abilities
      ? [...new Set(Object.values(entry.abilities))]
      : [];

    // If this Pokemon was already revealed earlier in the battle (e.g. it
    // Terastallized or Mega Evolved before switching out), restore that
    // instead of resetting to its base dex data.
    const revealedEntry = this.state_.revealed[sideKey(p.side)]?.[id];
    const teraType = revealedEntry?.teraType || null;
    if (teraType) types = [teraType];

    this.state_.active[p.side] = {
      slot: p.side,
      nickname: p.name,
      species,
      condition,
      shiny,
      level,
      types,
      teraType,
      predictedSpeed,
      possibleAbilities,
      ability: revealedEntry?.ability || null,
      item: revealedEntry?.item || null,
      usedMoves: revealedEntry?.usedMoves ? [...revealedEntry.usedMoves] : [],
      boosts: {},
      volatiles: [],
      spriteFront: spriteUrl(species, { shiny, back: false, anim: ANIMATED_SPRITES }),
      spriteBack: spriteUrl(species, { shiny, back: true, anim: ANIMATED_SPRITES }),
    };
  }

  updateActiveCondition(parts) {
    const p = parseIdent(parts[0] || "");
    const mon = this.state_.active[p.side];
    if (mon) mon.condition = parts[1] || "";
  }

  trackRevealed(parts) {
    const p = parseIdent(parts[0] || "");
    const { species, level } = parseDetails(parts[1] || "");
    if (!p.side || !species) return;
    const side = sideKey(p.side);
    const sideMap = this.state_.revealed[side] || (this.state_.revealed[side] = {});
    const key = normalizeName(species);
    const existing = sideMap[key];
    // upsertActive() runs just before this and already resolved the
    // correct types (including any Tera override), so reuse it here.
    const activeMon = this.state_.active[p.side];
    sideMap[key] = {
      species,
      nickname: p.name,
      level,
      condition: parts[2] || existing?.condition || "",
      types: (activeMon && activeMon.types) || existing?.types || [],
      teraType: activeMon?.teraType || existing?.teraType || null,
      ability: existing?.ability || null,
      item: existing?.item || null,
      usedMoves: existing?.usedMoves || [],
      lastSeenTurn: this.state_.turn,
    };
  }

  syncRevealedCondition(side) {
    const mon = this.state_.active[side];
    if (!mon || !mon.species) return;
    const entry = this.state_.revealed[sideKey(side)]?.[normalizeName(mon.species)];
    if (!entry) return;
    entry.condition = mon.condition;
    if (mon.ability) entry.ability = mon.ability;
    if (mon.item) entry.item = mon.item;
  }

  revealMonDetail(side, field, value) {
    const mon = this.state_.active[side];
    if (!mon) return;
    mon[field] = value;
    const entry = this.state_.revealed[sideKey(side)]?.[normalizeName(mon.species)];
    if (entry) entry[field] = value;
  }

  adjustBoosts(parts, mode) {
    const p = parseIdent(parts[0] || "");
    const mon = this.state_.active[p.side];
    if (!mon) return;
    mon.boosts = mon.boosts || {};
    const stat = parts[1];
    const amt = Number(parts[2]) || 1;
    if (mode === "set") {
      mon.boosts[stat] = Math.max(-6, Math.min(6, amt));
    } else {
      const delta = mode === "down" ? -amt : amt;
      mon.boosts[stat] = Math.max(-6, Math.min(6, (mon.boosts[stat] || 0) + delta));
    }
  }

  // Shared by -formechange and -mega: swap species, retype, re-speed, re-sprite,
  // and record the forme in the revealed map if it's new.
  async applyFormeChange(side, newSpecies) {
    const mon = this.state_.active[side];
    if (!mon || !newSpecies) return;
    const dex = await getPokedex();
    const entry = dex[normalizeName(newSpecies)] || {};
    mon.species = newSpecies;
    if (mon.teraType) {
      mon.types = [mon.teraType];
    } else if (entry.types) {
      mon.types = entry.types;
    }
    if (entry.abilities) {
      mon.possibleAbilities = [...new Set(Object.values(entry.abilities))];
    }
    if (entry.baseStats && Number.isFinite(entry.baseStats.spe) && mon.level) {
      mon.predictedSpeed =
        Math.floor(((2 * entry.baseStats.spe + 85) * mon.level) / 100) + 5;
    }
    mon.spriteFront = spriteUrl(newSpecies, { shiny: mon.shiny, back: false, anim: ANIMATED_SPRITES });
    mon.spriteBack = spriteUrl(newSpecies, { shiny: mon.shiny, back: true, anim: ANIMATED_SPRITES });
    const map = this.state_.revealed[sideKey(side)];
    if (map && !map[normalizeName(newSpecies)]) {
      map[normalizeName(newSpecies)] = {
        species: newSpecies,
        nickname: mon.nickname,
        level: mon.level,
        condition: mon.condition,
        types: mon.types || [],
        teraType: mon.teraType || null,
        ability: mon.ability || null,
        item: mon.item || null,
        usedMoves: [...(mon.usedMoves || [])],
        lastSeenTurn: this.state_.turn,
      };
    }
  }

  async waitForFreshChallstr(timeoutMs = 8000) {
    const start = Date.now();
    while (!this.freshChallstr || !this.state_.challstr) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("Timed out waiting for challenge token from Showdown.");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  enqueueLogin(fn) {
    const run = this._loginLock.catch(() => {}).then(fn);
    this._loginLock = run.catch(() => {});
    return run;
  }

  async login(username, password) {
    return this.enqueueLogin(() => this._doLogin(username, password));
  }

  async _doLogin(username, password, isRetry = false) {
    this.state_.loginName = username;
    this.state_.loginPassword = password;
    this.state_.username = username;
    this.state_.loginError = null;

    await this.waitForFreshChallstr(8000);

    const usedWs = this.ws;
    const usedChallstr = this.state_.challstr;

    const body = new URLSearchParams();
    body.set("act", "login");
    body.set("name", username);
    body.set("pass", password);
    body.set("challstr", usedChallstr);

    const res = await undiciFetch("https://play.pokemonshowdown.com/action.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      dispatcher: proxyDispatcher,
    });

    const text = await res.text();
    let jsonText = text.trim();
    if (jsonText.startsWith("]")) jsonText = jsonText.slice(1);

    let data;
    try {
      data = JSON.parse(jsonText);
    } catch {
      throw new Error(`Unexpected login response: ${text.slice(0, 120)}`);
    }

    const action = Array.isArray(data?.actions) ? data.actions[0] : data;
    const assertion =
      action?.assertion || data?.assertion || action?.data?.assertion || null;

    if (!assertion || assertion.startsWith(";;")) {
      const errReason = assertion
        ? assertion.replace(/^;;/, "").trim()
        : (action?.actionerror || data?.actionerror || "Login assertion rejected.");

      if (/signature|token|expired/i.test(errReason)) {
        this.freshChallstr = false;
        this.state_.challstr = null;
      }
      this.relogDisabled = true;
      throw new Error(errReason);
    }

    if (this.ws !== usedWs || this.state_.challstr !== usedChallstr) {
      if (isRetry) {
        throw new Error("Connection changed mid-login; please try again.");
      }
      return this._doLogin(username, password, true);
    }

    const finalName = action?.username || username;

    let confirmResolve;
    const confirmPromise = new Promise((resolve) => {
      confirmResolve = resolve;
      setTimeout(() => resolve(false), 8000);
    });
    this.loginConfirmResolve = confirmResolve;
    this.pendingLoginName = finalName;

    this.send(`|/trn ${finalName},0,${assertion}`);

    const confirmed = await confirmPromise;
    if (this.loginConfirmResolve === confirmResolve) this.loginConfirmResolve = null;
    this.pendingLoginName = null;

    if (!confirmed) {
      this.state_.loggedIn = false;
      throw new Error("Showdown did not confirm authenticated state.");
    }

    this.state_.username = finalName;
    this.state_.loggedIn = true;
    this.state_.loginName = finalName;
    this.state_.loginPassword = password;
    this.state_.loginError = null;
    this.relogDisabled = false;
    this.state_.notice = `Logged in as ${finalName}.`;
  }

  async autoRelogin() {
    if (this.relogDisabled) return;
    const { loginName, loginPassword } = this.state_;
    if (!loginName || !loginPassword) return;

    const alreadyIn = () =>
      this.state_.loggedIn &&
      this.ws &&
      this.ws.readyState === 1 &&
      this.state_.username?.toLowerCase() === loginName.toLowerCase();

    if (alreadyIn()) return;

    return this.enqueueLogin(async () => {
      if (alreadyIn()) return;
      try {
        const oldNotice = this.state_.notice;
        await this._doLogin(loginName, loginPassword);
        this.pushLog(`(authenticated as ${loginName})`);
        this.state_.notice = oldNotice;
      } catch (err) {
        this.pushLog(`(auto-login failed: ${err.message || err})`);
        throw err;
      }
    });
  }

  async ensureConnected() {
    if (this.ws && this.ws.readyState === 1) return;

    if (this._connectLock) return this._connectLock;
    this._connectLock = this._doEnsureConnected().finally(() => {
      this._connectLock = null;
    });
    return this._connectLock;
  }

  async _doEnsureConnected() {
    if (this.ws && this.ws.readyState === 1) return;

    const ws = new WebSocket(SHOWDOWN_WS_URL, {
      agent: proxyAgent,
      headers: { "User-Agent": "ps-cloudphone" },
    });

    this.ws = ws;
    this.connectedAt = Date.now();
    this._dropHandled = false;
    this.freshChallstr = false;
    this.state_.challstr = null;
    this.state_.connected = false;
    this.state_.loggedIn = false;

    ws.on("open", () => {
      this.state_.connected = true;
      if (this.state_.roomId && this.state_.roomId.startsWith("battle-")) {
        try { ws.send(`${this.state_.roomId}|/join ${this.state_.roomId}`); } catch {}
      }
      if (this.state_.loginName && this.state_.loginPassword) {
        this.autoRelogin().catch(() => {});
      }
    });

    ws.on("message", (data) => {
      const text = data.toString();
      const { roomId, lines } = splitFrame(text);
      this._messageQueue = this._messageQueue
        .then(async () => {
          for (const rawLine of lines) {
            await this.handleLine(roomId, rawLine);
          }
        })
        .catch((err) => {
          this.pushLog(`(error handling message: ${err.message || err})`);
        });
    });

    ws.on("close", (code, reason) => {
      this.ws = null;
      this.freshChallstr = false;
      this.state_.connected = false;
      this.state_.loggedIn = false;
      this.pushLog(`(disconnected: ${reason || code})`);
      this.noteDropAndMaybeReconnect();
    });

    ws.on("error", (err) => {
      this.pushLog(`(socket error: ${err.message || err})`);
    });

    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
    this.keepAliveInterval = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === 1) this.ws.send("");
      } catch {}
    }, 45000);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 8000);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (e) => { clearTimeout(timer); reject(e); });
    }).catch(() => {});
  }

  send(text) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error("Not connected");
    this.ws.send(text);
  }

  sendToRoom(roomId, text) {
    this.send(`${roomId || ""}|${text}`);
  }

  noteDropAndMaybeReconnect() {
    if (this._dropHandled) return;
    this._dropHandled = true;

    const elapsed = this.connectedAt ? Date.now() - this.connectedAt : QUICK_DROP_THRESHOLD_MS;
    this.connectedAt = null;

    if (elapsed < 5000 && this.state_.loginName) {
      this.relogDisabled = true;
      this.pushLog(`(Showdown terminated session for ${this.state_.loginName}; pausing auto-login)`);
    }

    if (elapsed < QUICK_DROP_THRESHOLD_MS) {
      this.consecutiveQuickDrops += 1;
    } else {
      this.consecutiveQuickDrops = 0;
    }

    if (this.consecutiveQuickDrops >= MAX_AUTO_RECONNECT_ATTEMPTS) {
      this.pushLog(
        `(connection dropped ${this.consecutiveQuickDrops} times in a row - pausing background reconnect; use /reconnect to retry)`
      );
      return;
    }

    const idx = Math.min(this.consecutiveQuickDrops - 1, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[Math.max(idx, 0)];
    setTimeout(() => {
      this.ensureConnected().catch((err) => {
        this.pushLog(`(background reconnect failed: ${err.message || err})`);
      });
    }, delay);
  }

  // Resolve which stored team to use for a team format. Returns { team, idx }
  // or null if none is available.
  pickTeam(format, explicitIdx) {
    const user = normalizeName(this.state_.loginName || "");
    const list = teamsStore[user] || [];
    let picked = null;
    let pickedIdx = -1;
    if (Number.isInteger(explicitIdx) && explicitIdx >= 0 && explicitIdx < list.length) {
      picked = list[explicitIdx];
      pickedIdx = explicitIdx;
    } else {
      const lastIdx = this.state_.lastTeam[format];
      if (Number.isInteger(lastIdx) && lastIdx >= 0 && lastIdx < list.length) {
        picked = list[lastIdx];
        pickedIdx = lastIdx;
      }
    }
    return picked ? { team: picked, idx: pickedIdx } : null;
  }

  async handleLine(roomId, rawLine) {
    const { type, parts } = parseLine(rawLine);
    const mySide = this.state_.mySide;
    const inBattle = roomId && roomId === this.state_.roomId && roomId.startsWith("battle-");

    if (roomId && roomId.startsWith("help-")) {
      try { this.sendToRoom(roomId, "/leave"); } catch {}
    }

    switch (type) {
      case "html":
      case "raw": {
        const text = cleanRawHtml(parts.join("|"));
        if (text && inBattle) {
          this.pushChat(`[info] ${text}`);
        }
        break;
      }

      case "challstr": {
        this.state_.challstr = parts.join("|");
        this.freshChallstr = true;
        this.state_.connected = true;
        break;
      }

      case "updateuser": {
        const rawName = parts[0] || "";
        const name = rawName.trim().replace(/^[^A-Za-z0-9]+/, "");
        const named = parts[1] === "1" || parts[1] === 1 || (!/^guest/i.test(name) && name.length > 0 && parts[1] !== "0");

        if (named) {
          this.state_.username = name;
          this.state_.loggedIn = true;
        } else if (!this.state_.loginName) {
          this.state_.username = name;
          this.state_.loggedIn = false;
        }

        if (
          this.loginConfirmResolve &&
          named &&
          (!this.pendingLoginName || normalizeName(name) === normalizeName(this.pendingLoginName))
        ) {
          const res = this.loginConfirmResolve;
          this.loginConfirmResolve = null;
          res(true);
        }
        this.detectMySide();
        break;
      }

      case "nametaken": {
        const takenUser = parts[0] || "";
        const reason = parts[1] || "Name taken or login rejected";
        this.state_.serverMsg = reason;
        this.pushLog(`[server] Name rejected for ${takenUser}: ${reason}`);
        if (this.loginConfirmResolve) {
          const res = this.loginConfirmResolve;
          this.loginConfirmResolve = null;
          res(false);
        }
        break;
      }

      case "noinit":
      case "deinit": {
        if (roomId === this.state_.roomId || (this.state_.roomId && !this.state_.roomId.startsWith("battle-"))) {
          this.resetBattle();
        }
        break;
      }

      case "popup":
      case "message":
      case "error":
      case "warning": {
        const msg = cleanRawHtml(parts.join("|"));
        if (msg) {
          this.state_.serverMsg = msg;
          this.pushLog(`[server] ${msg}`);
          if (this.loginConfirmResolve && /signature|assertion|authentication|token/i.test(msg)) {
            const res = this.loginConfirmResolve;
            this.loginConfirmResolve = null;
            res(false);
          }
          if (/locked due to being a proxy/i.test(msg)) {
            this.state_.ipLocked = true;
            this.state_.ipLockedAt = Date.now();
            this.state_.ipLockedMsg = msg;
          }
        }
        break;
      }

      case "player": {
        const slot = parts[0];
        const name = (parts[1] || "").trim();
        if (slot && name) this.state_.players[slot] = name;
        this.detectMySide();
        break;
      }

      case "gametype": {
        this.state_.gameType = parts[0] || null;
        break;
      }

      case "updatesearch": {
        try {
          const json = JSON.parse(parts[0]);
          this.state_.searching = json.searching || [];
          if (json.games) {
            const battleIds = Object.keys(json.games).filter((id) => id.startsWith("battle-"));
            if (battleIds.length > 0) {
              const gid = battleIds[0];
              if (gid !== this.state_.roomId) {
                this.resetBattle();
                this.state_.roomId = gid;
                this.state_.roomTitle = json.games[gid] || gid;
                this.sendToRoom(gid, "/join " + gid);
                this.state_.ipLocked = false;
              }
            } else if (this.state_.roomId && !this.state_.ended) {
              this.state_.ended = true;
            }
          }
        } catch {}
        break;
      }

      case "updatechallenges": {
        try {
          const json = JSON.parse(parts[0]);
          this.state_.challengesFrom = json.challengesFrom || {};
          this.state_.challengeTo = json.challengeTo || null;
        } catch {}
        break;
      }

      case "title": {
        if (inBattle) this.state_.roomTitle = parts[0];
        break;
      }

      case "request": {
        if (!inBattle) break;
        if (!parts[0] || parts[0] === "null") {
          this.state_.request = null;
          break;
        }
        try {
          const req = JSON.parse(parts[0]);
          if (!req) {
            this.state_.request = null;
            break;
          }
          const side = String(req?.side?.id || req?.side?.pokemon?.[0]?.ident || "").slice(0, 2);
          if (side === "p1" || side === "p2") this.state_.mySide = side;

          const dex = await getPokedex();
          const movesData = await getMoves();
          // Stash for the server-rendered damage estimates (renderBattle is sync).
          this.state_.dexData = dex;
          this.state_.movesData = movesData;

          if (req.side && req.side.pokemon) {
            for (const p of req.side.pokemon) {
              const species = String(p.details || "").split(",")[0].trim();
              const id = normalizeName(species);
              if (dex[id] && dex[id].types) p.types = dex[id].types;
              if (Array.isArray(p.moves)) {
                p.moveTypes = [
                  ...new Set(
                    p.moves
                      .map((mId) => {
                        const d = movesData[mId];
                        if (!d || d.category === "Status") return null;
                        if (!(Number(d.basePower) > 0)) return null;
                        return d.type || null;
                      })
                      .filter(Boolean)
                  ),
                ];
                p.moveDetails = p.moves.map((mId) => {
                  const d = movesData[mId];
                  return {
                    id: mId,
                    name: d?.name || mId,
                    type: d?.type || null,
                    category: d?.category || null,
                  };
                });
              }
            }
          }

          const oppTypes = this.oppActiveInfo()?.types || [];
          if (req.active) {
            for (const active of req.active) {
              if (!active.moves) continue;
              for (const m of active.moves) {
                const mId = m.id || normalizeName(m.move);
                m.id = mId;
                const data = movesData[mId];
                if (data) {
                  if (data.type) m.type = data.type;
                  if (data.category) m.category = data.category;
                  if (data.shortDesc || data.desc) m.shortDesc = data.shortDesc || data.desc;
                  // Extra fields the damage estimator needs.
                  if (Number.isFinite(data.basePower)) m.basePower = data.basePower;
                  if (data.multihit) m.multihit = data.multihit;
                  if (data.damage !== undefined) m.damage = data.damage;
                  if (data.target) m.target = data.target;
                }
                if (m.category !== "Status" && m.type && oppTypes.length) {
                  m.oppMult = typeEffectiveness(m.type, oppTypes);
                }
              }
            }
          }

          this.state_.request = req;
        } catch {}
        break;
      }

      case "turn": {
        if (inBattle) {
          this.state_.turn = Number(parts[0]) || this.state_.turn;
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "switch":
      case "drag": {
        if (inBattle) {
          await this.upsertActive(parts);
          this.trackRevealed(parts);
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "move": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          const mon = this.state_.active[p.side];
          const mv = parts[1];
          if (mon && mv) {
            mon.usedMoves = mon.usedMoves || [];
            if (!mon.usedMoves.includes(mv)) mon.usedMoves.push(mv);
            const entry = this.state_.revealed[sideKey(p.side)]?.[normalizeName(mon.species)];
            if (entry) {
              entry.usedMoves = entry.usedMoves || [];
              if (!entry.usedMoves.includes(mv)) entry.usedMoves.push(mv);
            }
          }
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-damage":
      case "-heal": {
        if (inBattle) {
          this.updateActiveCondition(parts);
          const p = parseIdent(parts[0] || "");
          this.syncRevealedCondition(p.side);
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-status": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          const mon = this.state_.active[p.side];
          if (mon && parts[1]) {
            const hp = String(mon.condition || "100/100").split(" ")[0];
            mon.condition = `${hp} ${parts[1]}`;
            this.syncRevealedCondition(p.side);
          }
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-curestatus": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          const mon = this.state_.active[p.side];
          if (mon) {
            mon.condition = String(mon.condition || "100/100").split(" ")[0];
            this.syncRevealedCondition(p.side);
          }
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-start": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          const mon = this.state_.active[p.side];
          const effect = parts[1];
          if (mon && effect) {
            mon.volatiles = mon.volatiles || [];
            if (!mon.volatiles.includes(effect)) mon.volatiles.push(effect);
          }
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-end": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          const mon = this.state_.active[p.side];
          const effect = parts[1];
          if (mon && effect && mon.volatiles) {
            mon.volatiles = mon.volatiles.filter((v) => v !== effect);
          }
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-boost":
      case "-unboost": {
        if (inBattle) this.adjustBoosts(parts, type === "-unboost" ? "down" : "up");
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-setboost": {
        if (inBattle) this.adjustBoosts(parts, "set");
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-clearboost": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          const mon = this.state_.active[p.side];
          if (mon) mon.boosts = {};
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-clearallboost": {
        if (inBattle) {
          for (const mon of Object.values(this.state_.active)) mon.boosts = {};
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-ability": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          if (parts[1]) this.revealMonDetail(p.side, "ability", parts[1]);
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-item": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          if (parts[1]) this.revealMonDetail(p.side, "item", parts[1]);
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-enditem": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          this.revealMonDetail(p.side, "item", null);
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-mega": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          const newSpecies = String(parts[1] || "").split(",")[0].trim();
          await this.applyFormeChange(p.side, newSpecies);
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-terastallize": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          const mon = this.state_.active[p.side];
          const teraType = parts[1];
          if (mon && teraType) {
            mon.types = [teraType];
            mon.teraType = teraType;
            const entry = this.state_.revealed[sideKey(p.side)]?.[normalizeName(mon.species)];
            if (entry) entry.teraType = teraType;
          }
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-formechange": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          const newSpecies = String(parts[1] || "").split(",")[0].trim();
          await this.applyFormeChange(p.side, newSpecies);
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-weather": {
        if (inBattle) {
          const w = parts[0];
          this.state_.field.weather = !w || w === "none" ? null : w;
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-fieldstart": {
        if (inBattle) {
          const name = cleanSideCond(parts[0]);
          if (name && !this.state_.field.fields.includes(name)) {
            this.state_.field.fields.push(name);
          }
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-fieldend": {
        if (inBattle) {
          const name = cleanSideCond(parts[0]);
          this.state_.field.fields = this.state_.field.fields.filter((x) => x !== name);
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-sidestart": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          const name = cleanSideCond(parts[1]);
          const side = sideKey(p.side);
          if (side && name) {
            const sides = this.state_.field.sides;
            const arr = sides[side] || (sides[side] = []);
            const ex = arr.find((x) => x.name === name);
            if (ex) ex.count += 1;
            else arr.push({ name, count: 1 });
          }
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-sideend": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          const name = cleanSideCond(parts[1]);
          const side = sideKey(p.side);
          if (side && this.state_.field.sides[side]) {
            this.state_.field.sides[side] = this.state_.field.sides[side].filter(
              (x) => x.name !== name
            );
          }
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "inactive": {
        this.state_.timerOn = true;
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "inactiveoff": {
        this.state_.timerOn = false;
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "c":
      case "chat":
      case "c:": {
        this.pushChat(formatBattleLine(type, parts, mySide));
        break;
      }

      case "faint": {
        if (inBattle) {
          const p = parseIdent(parts[0] || "");
          const mon = this.state_.active[p.side];
          if (mon) mon.condition = "0 fnt";
          this.syncRevealedCondition(p.side);
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "win": {
        if (inBattle) {
          this.state_.ended = true;
          this.state_.request = null;
          this.state_.resultMsg =
            parts[0] === this.state_.username
              ? "You won the battle!"
              : `${parts[0]} won the battle!`;
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "tie": {
        if (inBattle) {
          this.state_.ended = true;
          this.state_.request = null;
          this.state_.resultMsg = "The battle ended in a tie.";
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      default: {
        if (inBattle || roomId === "") {
          this.pushLog(formatBattleLine(type, parts, mySide));
        }
        break;
      }
    }
  }

  async handleRequest(req, res) {
    try {
      // Auto-hydrate login state from encrypted cookie if memory state was reset by server sleep
      if (!this.state_.loginName && req.cookies?.ps_auth) {
        const creds = decryptCredentials(req.cookies.ps_auth);
        if (creds?.u && creds?.p) {
          this.state_.loginName = creds.u;
          this.state_.loginPassword = creds.p;
        }
      }

      await this.ensureConnected();

      const path = req.path;

      if (path === "/search") {
        const format = String(req.query.format || "gen9randombattle");
        if (!FORMATS.some(([id]) => id === format)) {
          return res.status(400).send(renderError(`Unknown or unsupported format: ${format}`));
        }

        if (this.state_.roomId) {
          try { this.sendToRoom(this.state_.roomId, "/leave"); } catch {}
          this.resetBattle();
        }

        if (this.state_.loginName) {
          try {
            await this.autoRelogin();
          } catch (err) {
            this.state_.notice = `Search blocked: Authentication failed (${err.message}).`;
            return res.redirect("/debug");
          }
        }

        // Team formats need /utm with a packed team before /search.
        let teamPacked = null;
        if (formatNeedsTeam(format)) {
          const explicitIdx = Number(req.query.team);
          const picked =
            Number.isInteger(explicitIdx)
              ? this.pickTeam(format, explicitIdx)
              : this.pickTeam(format, undefined);
          if (!picked) {
            this.state_.teamNext = format;
            this.state_.notice = `${format} needs a team - pick or upload one below.`;
            return res.redirect("/teams");
          }
          if (Number.isInteger(explicitIdx) && picked.idx === explicitIdx) {
            this.state_.lastTeam[format] = picked.idx; // remember for next time
          }
          teamPacked = picked.team.packed;
        }

        if (this.state_.searching.length > 0) {
          try { this.send(`|/cancelsearch`); } catch {}
        }

        this.send(`|/utm ${teamPacked || "null"}`);
        this.send(`|/search ${format}`);

        const hadBattle = !!(this.state_.roomId && !this.state_.ended);
        const deadline = Date.now() + 6000;
        let ok = false;
        let instantMatch = false;

        while (Date.now() < deadline) {
          if ((this.state_.searching || []).includes(format)) { ok = true; break; }
          if (!hadBattle && this.state_.roomId && !this.state_.ended) {
            ok = true;
            instantMatch = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }

        if (instantMatch) {
          this.state_.notice = null;
          return res.redirect("/battle");
        }

        this.state_.notice = ok
          ? `Searching for ${format}...`
          : `Searching for ${format}... (check back shortly)`;
        return res.redirect("/");
      }

      if (path === "/cancelsearch") {
        try { this.send(`|/cancelsearch`); } catch {}
        this.state_.searching = [];
        return res.redirect("/");
      }

      if (path === "/dismiss") {
        this.state_.serverMsg = null;
        return res.redirect(req.query.from || "/");
      }

      if (path === "/challenge") {
        if (req.method === "POST") {
          const target = (req.body.username || "").trim();
          const format = String(req.body.format || "");
          if (target) {
            if (!FORMATS.some(([id]) => id === format)) {
              this.state_.notice = `Unknown format: ${format}`;
              return res.redirect("/");
            }
            if (this.state_.loginName) {
              await this.autoRelogin();
            }
            let utm = "null";
            if (formatNeedsTeam(format)) {
              const idx = Number(req.body.team);
              const picked = this.pickTeam(format, Number.isInteger(idx) ? idx : undefined);
              if (!picked) {
                this.state_.teamNext = format;
                this.state_.notice = `${format} needs a team - pick or upload one below, then challenge again.`;
                return res.redirect("/teams");
              }
              this.state_.lastTeam[format] = picked.idx;
              utm = picked.team.packed;
            }
            this.send(`|/utm ${utm}`);
            this.send(`|/challenge ${target}, ${format}`);
            this.state_.notice = `Challenge sent to ${target}.`;
          }
        }
        return res.redirect("/");
      }

      if (path === "/cancelchallenge") {
        const to = this.state_.challengeTo && this.state_.challengeTo.to;
        if (to) {
          try { this.send(`|/cancelchallenge ${to}`); } catch {}
        }
        return res.redirect("/");
      }

      if (path === "/accept") {
        const user = req.query.user;
        if (user) {
          if (this.state_.loginName) {
            await this.autoRelogin();
          }
          // If the incoming challenge is a team format, attach the remembered team.
          const fmt = this.state_.challengesFrom?.[user] || "";
          if (formatNeedsTeam(fmt)) {
            const picked = this.pickTeam(fmt, undefined);
            this.send(`|/utm ${picked ? picked.team.packed : "null"}`);
          } else {
            this.send(`|/utm null`);
          }
          this.send(`|/accept ${user}`);
        }
        return res.redirect("/");
      }

      if (path === "/reject") {
        const user = req.query.user;
        if (user) {
          try { this.send(`|/reject ${user}`); } catch {}
        }
        return res.redirect("/");
      }

      if (path === "/newgame") {
        if (this.state_.roomId) {
          try { this.sendToRoom(this.state_.roomId, "/leave"); } catch {}
        }
        this.resetBattle();
        return res.redirect("/");
      }

      if (path === "/choose") {
        const value = req.query.value;
        if (value && this.state_.roomId && this.state_.request) {
          const rqid = this.state_.request.rqid;
          this.sendToRoom(
            this.state_.roomId,
            `/choose ${value}${rqid !== undefined ? "|" + rqid : ""}`
          );
          this.state_.request = null;
        }
        return res.redirect("/battle");
      }

      if (path === "/lead") {
        const idx = Number(req.query.i || 0) - 1;
        const reqData = this.state_.request;
        if (reqData?.teamPreview && this.state_.roomId) {
          const size = reqData.side?.pokemon?.length || 6;
          const nums = Array.from({ length: size }, (_, i) => i + 1);
          if (idx >= 0 && idx < size) {
            const lead = idx + 1;
            const order = [lead, ...nums.filter((n) => n !== lead)].join("");
            this.sendToRoom(
              this.state_.roomId,
              `/choose team ${order}|${reqData.rqid || ""}`
            );
            this.state_.request = null;
          }
        }
        return res.redirect("/battle");
      }

      if (path === "/chat") {
        if (req.method === "POST" && this.state_.roomId && !this.state_.ended) {
          const msg = (req.body.msg || "").trim().slice(0, 300);
          if (msg) {
            try { this.sendToRoom(this.state_.roomId, msg); } catch {}
          }
        }
        return res.redirect("/battle");
      }

      if (path === "/teams") {
        const user = normalizeName(this.state_.loginName || "");
        if (!user) {
          this.state_.notice = "Log in first - teams are stored per account.";
          return res.redirect("/login");
        }
        const next = String(req.query.next || this.state_.teamNext || "");
        this.state_.teamNext = next || null;
        this.state_.teamView = { list: teamsStore[user] || [], next };
        const html = renderTeams(this.state_);
        this.state_.teamError = null;
        return res.send(html);
      }

      if (path === "/teams/upload" && req.method === "POST") {
        const user = normalizeName(this.state_.loginName || "");
        if (!user) {
          this.state_.notice = "Log in first - teams are stored per account.";
          return res.redirect("/login");
        }
        const next = String(req.query.next || this.state_.teamNext || "");
        const name = String(req.body.name || "").replace(/[<>]/g, "").trim().slice(0, 40);
        const text = String(req.body.teamtext || "");
        try {
          const parsed = await importTeam(text);
          const list = teamsStore[user] || (teamsStore[user] = []);
          if (list.length >= 12) throw new Error("Team limit reached (12). Delete one first.");
          list.push({
            name: name || `Team ${list.length + 1}`,
            packed: parsed.packed,
            summary: parsed.summary,
            count: parsed.count,
            added: Date.now(),
          });
          saveTeamsStore();
          this.state_.notice = `Team saved: ${name || "Unnamed"}.`;
        } catch (err) {
          this.state_.teamError = err.message || String(err);
        }
        this.state_.teamNext = next || null;
        return res.redirect("/teams");
      }

      if (path === "/team/delete") {
        const user = normalizeName(this.state_.loginName || "");
        const idx = Number(req.query.id);
        const list = teamsStore[user];
        if (list && Number.isInteger(idx) && idx >= 0 && idx < list.length) {
          list.splice(idx, 1);
          if (!list.length) delete teamsStore[user];
          // Fix remembered-team indexes so they don't point at the wrong team.
          for (const fmt of Object.keys(this.state_.lastTeam)) {
            const li = this.state_.lastTeam[fmt];
            if (li === idx) delete this.state_.lastTeam[fmt];
            else if (li > idx) this.state_.lastTeam[fmt] = li - 1;
          }
          saveTeamsStore();
        }
        return res.redirect("/teams");
      }

      if (path === "/moveinfo") {
        const moveId = req.query.move || "";
        const movesData = await getMoves();
        return res.send(renderMoveInfo(movesData[moveId] || null, moveId, this.state_));
      }

      if (path === "/typechart") {
        return res.send(renderTypeChart());
      }

      if (path === "/commands") {
        return res.send(renderCommands());
      }

      if (path === "/dex") {
        const q = req.query.q || "";
        const dex = await getPokedex();
        const id = normalizeName(q);
        const entry = id ? dex[id] : null;
        return res.send(renderDex(entry, q));
      }

      if (path === "/debug") {
        const extra = {
          wsOpen: Boolean(this.ws && this.ws.readyState === 1),
          wsState: this.ws ? this.ws.readyState : "NULL",
          freshChallstr: this.freshChallstr,
          connectingNow: Boolean(this._connectLock),
          pendingLoginName: this.pendingLoginName || "none",
          consecutiveQuickDrops: this.consecutiveQuickDrops,
          relogDisabled: this.relogDisabled,
        };
        return res.send(renderDebug(this.state_, extra));
      }

      if (path === "/timer") {
        if (this.state_.roomId && !this.state_.ended) {
          const cmd = this.state_.timerOn ? "/timer off" : "/timer on";
          try { this.sendToRoom(this.state_.roomId, cmd); } catch {}
        }
        return res.redirect("/battle");
      }

      if (path === "/forfeit") {
        if (this.state_.roomId && !this.state_.ended) {
          try { this.sendToRoom(this.state_.roomId, "/forfeit"); } catch {}
        }
        return res.redirect("/battle");
      }

      if (path === "/reconnect") {
        try { this.ws?.close(); } catch {}
        this.ws = null;
        this.freshChallstr = false;
        this.state_.connected = false;
        this.state_.loggedIn = false;
        this.state_.ipLocked = false;
        this.state_.ipLockedAt = null;
        this.relogDisabled = false;
        this.consecutiveQuickDrops = 0;
        this.connectedAt = null;
        this._dropHandled = false;
        await this.ensureConnected();
        return res.redirect("/debug");
      }

      if (path === "/login") {
        if (req.method === "POST") {
          const username = (req.body.username || "").trim();
          const password = req.body.password || "";
          try {
            this.relogDisabled = false;
            await this.login(username, password);

            // Persist encrypted login credentials across server sleep cycles
            res.cookie("ps_auth", encryptCredentials(username, password), {
              maxAge: 30 * 24 * 60 * 60 * 1000,
              httpOnly: true,
              sameSite: "lax",
              secure: req.secure,
              path: "/",
            });
          } catch (err) {
            this.state_.loginError = err.message || String(err);
          }
          return res.redirect("/");
        }
        return res.send(renderLogin(this.state_));
      }

      if (path === "/logout") {
        try { this.send("|/logout"); } catch {}
        try { this.ws?.close(); } catch {}
        this.ws = null;
        this.state_.loggedIn = false;
        this.state_.username = null;
        this.state_.loginName = null;
        this.state_.loginPassword = null;
        this.state_.mySide = null;
        this.state_.connected = false;
        this.relogDisabled = false;
        this.state_.notice = "Logged out.";

        // Clear auth cookie
        res.clearCookie("ps_auth", { path: "/" });
        return res.redirect("/");
      }

      if (path === "/battle") {
        if (!this.state_.roomId) return res.redirect("/");
        return res.send(renderBattle(this.state_, String(req.query.part || "")));
      }

      // Home page needs the team list for the challenge form.
      const homeUser = normalizeName(this.state_.loginName || "");
      this.state_.teamView = { list: teamsStore[homeUser] || [], next: this.state_.teamNext || "" };
      const homeHtml = renderHome(this.state_);
      if (this.state_.notice) this.state_.notice = null;
      return res.send(homeHtml);
    } catch (err) {
      return res.status(500).send(renderError(err.message || String(err)));
    }
  }
}

const QUICK_DROP_THRESHOLD_MS = 15000;
const MAX_AUTO_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BACKOFF_MS = [2000, 4000, 8000, 15000, 30000, 60000];
