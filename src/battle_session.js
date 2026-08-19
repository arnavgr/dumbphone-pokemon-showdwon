import WebSocket from "ws";
import crypto from "crypto";
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

const RECONNECT_BACKOFF_MS = [2000, 4000, 8000, 15000, 30000, 60000];
const QUICK_DROP_THRESHOLD_MS = 15000;
const MAX_AUTO_RECONNECT_ATTEMPTS = 8;

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
    // Terastallized before switching out), restore that instead of
    // resetting to its base dex data. Terastallization lasts the whole
    // battle, so a switched-out mon keeps its Tera type when it comes back.
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
          const mon = this.state_.active[p.side];
          const newSpecies = String(parts[1] || "").split(",")[0].trim();
          if (mon && newSpecies) {
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
            const map = this.state_.revealed[sideKey(p.side)];
            if (map) {
              const key = normalizeName(newSpecies);
              if (!map[key]) {
                map[key] = {
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
          }
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

        const format = req.query.format || "gen9randombattle";
        if (this.state_.searching.length > 0) {
          try { this.send(`|/cancelsearch`); } catch {}
        }

        this.send(`|/utm null`);
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
          const format = req.body.format || "gen9randombattle";
          if (target) {
            if (this.state_.loginName) {
              await this.autoRelogin();
            }
            this.send(`|/utm null`);
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
          this.send(`|/utm null`);
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
        return res.send(renderBattle(this.state_));
      }

      const homeHtml = renderHome(this.state_);
      if (this.state_.notice) this.state_.notice = null;
      return res.send(homeHtml);
    } catch (err) {
      return res.status(500).send(renderError(err.message || String(err)));
    }
  }
}
