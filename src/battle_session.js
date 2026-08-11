import { DurableObject } from "cloudflare:workers";
import {
  splitFrame,
  parseLine,
  parseIdent,
  formatBattleLine,
  normalizeName,
  parseDetails,
  spriteUrl,
  typeEffectiveness,
} from "./protocol.js";
import {
  renderHome,
  renderBattle,
  renderError,
  renderLogin,
  renderMoveInfo,
} from "./html.js";

const SHOWDOWN_WS_URL = "https://sim3.psim.us/showdown/websocket";
const ANIMATED_SPRITES = true;

// ---------------------------------------------------------------------------
// Global Data Caches
// ---------------------------------------------------------------------------
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
  upstreamCookie: null,
  challengesFrom: {},
  challengeTo: null,
  // Saved account credentials so a fresh socket can silently re-login.
  // Necessary because the DO's websocket dies whenever the isolate idles,
  // and a fresh socket is ALWAYS a guest session on Showdown's side.
  loginName: null,
  loginPassword: null,
  // side ("p1"/"p2") -> normalized species -> revealed info
  revealed: {},
  // weather / terrains / per-side conditions
  field: { weather: null, fields: [], sides: {} },
};

export class BattleSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ws = null;
    this.state_ = null;
    this.keepAliveInterval = null;
    this.pendingAuth = null;
    this.relogPromise = null;
    this.relogDisabled = false;
    // Challstr of the LIVE socket only. Assertions are bound to it, so a
    // stale one from a previous connection makes /trn fail silently.
    this.connChallstr = null;
    // login() waiters woken by the confirming |updateuser| line.
    this.renameWaiters = [];

    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get("state");
      this.state_ = { ...DEFAULT_STATE, ...(saved || {}) };
      if (!this.state_.players) this.state_.players = {};
      if (!this.state_.active) this.state_.active = {};
      if (!this.state_.challengesFrom) this.state_.challengesFrom = {};
      if (!Array.isArray(this.state_.chat)) this.state_.chat = [];
      if (!Array.isArray(this.state_.log)) this.state_.log = [];
      if (!this.state_.revealed) this.state_.revealed = {};
      if (!this.state_.field) this.state_.field = { weather: null, fields: [], sides: {} };
      if (!this.state_.field.fields) this.state_.field.fields = [];
      if (!this.state_.field.sides) this.state_.field.sides = {};
    });
  }

  async save() {
    await this.ctx.storage.put("state", this.state_);
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

  // We hold credentials but the live socket never became that user
  // (re-login failed). Acting as guest here is exactly the bug that
  // produced "spiddygriddy vs. Guest 22523645".
  authBroken() {
    return Boolean(this.state_.loginName) && !this.state_.loggedIn;
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
    const types = entry.types || [];

    const baseStats = entry.baseStats || null;
    let predictedSpeed = null;
    if (baseStats && Number.isFinite(baseStats.spe) && level) {
      predictedSpeed = Math.floor(((2 * baseStats.spe + 85) * level) / 100) + 5;
    }
    const possibleAbilities = entry.abilities
      ? [...new Set(Object.values(entry.abilities))]
      : [];

    this.state_.active[p.side] = {
      slot: p.side,
      nickname: p.name,
      species,
      condition,
      shiny,
      level,
      types,
      predictedSpeed,
      possibleAbilities,
      ability: null,
      item: null,
      usedMoves: [],
      boosts: {},
      spriteFront: spriteUrl(species, { shiny, back: false, anim: ANIMATED_SPRITES }),
      spriteBack: spriteUrl(species, { shiny, back: true, anim: ANIMATED_SPRITES }),
    };
  }

  updateActiveCondition(parts) {
    const p = parseIdent(parts[0] || "");
    const mon = this.state_.active[p.side];
    if (mon) mon.condition = parts[1] || "";
  }

  // --- Opponent revealed-team tracker -------------------------------------

  trackRevealed(parts) {
    const p = parseIdent(parts[0] || "");
    const { species, level } = parseDetails(parts[1] || "");
    if (!p.side || !species) return;
    const side = sideKey(p.side);
    const sideMap = this.state_.revealed[side] || (this.state_.revealed[side] = {});
    const key = normalizeName(species);
    const existing = sideMap[key];
    sideMap[key] = {
      species,
      nickname: p.name,
      level,
      condition: parts[2] || existing?.condition || "",
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

  async readForm(request) {
    const text = await request.text();
    return new URLSearchParams(text);
  }

  // Woken by the |updateuser| handler when the server confirms the rename.
  waitForRename(name, timeoutMs) {
    return new Promise((resolve) => {
      const entry = { name: normalizeName(name), resolve };
      this.renameWaiters.push(entry);
      setTimeout(() => {
        const i = this.renameWaiters.indexOf(entry);
        if (i !== -1) {
          this.renameWaiters.splice(i, 1);
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  async login(username, password) {
    // /trn MUST use the challstr of the LIVE connection: assertions are
    // bound to it, and one from a previous socket is silently rejected
    // (leaving us a guest while the UI claims we're logged in).
    const deadline = Date.now() + 4000;
    while (!this.connChallstr && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.connChallstr) {
      throw new Error("No challstr received yet. Refresh and try again.");
    }

    const body = new URLSearchParams();
    body.set("act", "login");
    body.set("name", username);
    body.set("pass", password);
    body.set("challstr", this.connChallstr);

    const res = await fetch("https://play.pokemonshowdown.com/action.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
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

    // Login-server error assertions start with ";". Without this check a
    // wrong password still "looked" logged in locally.
    if (!assertion || String(assertion).startsWith(";")) {
      throw new Error(
        (assertion && String(assertion).replace(/^;+/, "")) ||
          action?.actionerror ||
          data?.actionerror ||
          "Login failed."
      );
    }

    const finalName = action?.username || username;
    this.send(`|/trn ${finalName},0,${assertion}`);

    // Wait for the server to CONFIRM the rename. Without this, a rejected
    // /trn leaves the socket as a guest and /search quietly creates a
    // guest battle while every page still shows the account name.
    const confirmed = await this.waitForRename(finalName, 5000);
    if (!confirmed) {
      throw new Error("Server didn't confirm the login (still guest). Try again.");
    }

    this.state_.username = finalName;
    this.state_.loggedIn = true;
    this.state_.loginError = null;
    this.state_.loginName = username;
    this.state_.loginPassword = password;
    this.relogDisabled = false;
    this.state_.notice = "Logged in.";
  }

  // Silent re-login after a socket reconnect. All callers share one promise
  // so concurrent triggers can't double-fire; a failed attempt disables
  // retries until the next fresh connection or a manual login.
  async autoRelogin() {
    if (this.relogDisabled) return;
    const { loginName, loginPassword } = this.state_;
    if (!loginName || !loginPassword) return;
    if (!this.relogPromise) {
      this.relogPromise = (async () => {
        try {
          await this.login(loginName, loginPassword);
          this.pushLog(`(logged back in as ${loginName})`);
        } catch (err) {
          this.relogDisabled = true;
          this.pushLog(`(auto-login failed: ${err.message || err})`);
        } finally {
          this.relogPromise = null;
        }
      })();
    }
    return this.relogPromise;
  }

  async ensureConnected() {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      return;
    }
    // New socket -> its challstr hasn't arrived yet. Null it so login()
    // can never accidentally use the previous connection's.
    this.connChallstr = null;

    if (!this.state_.upstreamCookie) {
      try {
        const infoRes = await fetch("https://sim3.psim.us/showdown/info");
        const sc = infoRes.headers.get("Set-Cookie");
        if (sc) {
          const match = sc.match(/(sid=[^;]+)/);
          if (match) this.state_.upstreamCookie = match[1];
        }
      } catch {}
    }

    const headers = new Headers({ Upgrade: "websocket" });
    if (this.state_.upstreamCookie) {
      headers.set("Cookie", this.state_.upstreamCookie);
    }
    const resp = await fetch(SHOWDOWN_WS_URL, { headers });
    const ws = resp.webSocket;
    if (!ws) {
      throw new Error("Showdown server did not accept the WebSocket upgrade");
    }
    const setCookie = resp.headers.get("Set-Cookie");
    if (setCookie) {
      const match = setCookie.match(/(sid=[^;]+)/);
      if (match) this.state_.upstreamCookie = match[1];
    }

    ws.accept();
    if (this.state_.roomId && !this.state_.ended) {
      ws.send(`|/join ${this.state_.roomId}`);
    }

    // A brand-new socket is always an anonymous guest session on Showdown's
    // side, even if our state says "logged in". Re-auth immediately so
    // identity-sensitive commands don't fire as Guest.
    this.relogDisabled = false;
    if (this.state_.loginName && this.state_.loginPassword) {
      this.pendingAuth = this.autoRelogin();
    }

    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
    this.keepAliveInterval = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === 1) this.ws.send("");
      } catch {}
    }, 45000);

    ws.addEventListener("message", (event) => {
      this.ctx.waitUntil(this.onSocketMessage(event.data));
    });
    ws.addEventListener("close", (event) => {
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      this.ctx.waitUntil(this.onSocketClose(event));
    });
    ws.addEventListener("error", () => {
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      this.ctx.waitUntil(this.onSocketError());
    });

    this.ws = ws;
    this.state_.connected = true;
    await this.save();
  }

  send(text) {
    if (!this.ws) throw new Error("Not connected");
    this.ws.send(text);
  }

  sendToRoom(roomId, text) {
    this.send(`${roomId || ""}|${text}`);
  }

  async onSocketMessage(message) {
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    const { roomId, lines } = splitFrame(text);
    for (const rawLine of lines) {
      await this.handleLine(roomId, rawLine);
    }
    await this.save();
  }

  async onSocketClose(event) {
    this.ws = null;
    this.state_.connected = false;
    this.connChallstr = null;
    this.pushLog(`(disconnected from server: ${event.reason || event.code})`);
    await this.save();
  }

  async onSocketError() {
    this.ws = null;
    this.state_.connected = false;
    this.connChallstr = null;
    this.pushLog(`(connection error)`);
    await this.save();
  }

  async handleLine(roomId, rawLine) {
    const { type, parts } = parseLine(rawLine);
    const mySide = this.state_.mySide;
    const inBattle = roomId === this.state_.roomId;

    switch (type) {
      case "challstr": {
        // Challstr of THIS connection. login() uses only this one.
        this.connChallstr = parts.join("|");
        this.state_.challstr = this.connChallstr;
        this.state_.connected = true;
        if (this.state_.roomId && !this.state_.ended) {
          try {
            this.sendToRoom(this.state_.roomId, `/join ${this.state_.roomId}`);
          } catch {}
        }
        break;
      }

      case "updateuser": {
        const rawName = parts[0] || "";
        const name = rawName.trim().replace(/^[^A-Za-z0-9]+/, "");
        const isGuest = /^guest/i.test(name);
        this.state_.username = name;
        this.state_.loggedIn = !isGuest;

        // Wake a pending login() that's waiting for rename confirmation.
        if (!isGuest && this.renameWaiters.length) {
          const norm = normalizeName(name);
          const idx = this.renameWaiters.findIndex((w) => w.name === norm);
          if (idx !== -1) {
            const [w] = this.renameWaiters.splice(idx, 1);
            w.resolve(true);
          }
        }

        // Demoted to guest while we hold credentials -> re-auth. Do NOT
        // await it here: login() blocks on a FUTURE updateuser line, which
        // can't be processed while this handler holds the line queue.
        if (isGuest && this.state_.loginName && this.state_.loginPassword) {
          this.ctx.waitUntil(this.autoRelogin());
        }
        this.detectMySide();
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
            const ids = Object.keys(json.games);
            if (ids.length && ids[0] !== this.state_.roomId) {
              this.resetBattle();
              this.state_.roomId = ids[0];
              this.state_.roomTitle = json.games[ids[0]];
              this.sendToRoom(ids[0], "/join " + ids[0]);
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
          const side = String(
            req?.side?.id || req?.side?.pokemon?.[0]?.ident || ""
          ).slice(0, 2);
          if (side === "p1" || side === "p2") this.state_.mySide = side;

          const dex = await getPokedex();
          const movesData = await getMoves();

          if (req.side && req.side.pokemon) {
            for (const p of req.side.pokemon) {
              const species = String(p.details || "").split(",")[0].trim();
              const id = normalizeName(species);
              if (dex[id] && dex[id].types) p.types = dex[id].types;
              if (Array.isArray(p.moves)) {
                p.moveTypes = [...new Set(
                  p.moves
                    .map((mId) => {
                      const d = movesData[mId];
                      if (!d || d.category === "Status") return null;
                      if (!(Number(d.basePower) > 0)) return null;
                      return d.type || null;
                    })
                    .filter(Boolean)
                )];
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
            const entry =
              this.state_.revealed[sideKey(p.side)]?.[normalizeName(mon.species)];
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
            if (entry.types) mon.types = entry.types;
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
        if (!this.state_.timerOn) {
          this.state_.timerOn = true;
          this.pushLog("Timer: ON");
        }
        break;
      }

      case "inactiveoff": {
        if (this.state_.timerOn) {
          this.state_.timerOn = false;
          this.pushLog("Timer: OFF");
        }
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

  htmlResponse(body) {
    return new Response(body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  // Bounce identity-sensitive actions to /login instead of silently running
  // them as a guest when a saved login failed to re-apply.
  authGuard(url) {
    if (!this.authBroken()) return null;
    this.state_.loginError =
      "Your login didn't survive the reconnect - please log in again.";
    return this.save().then(() =>
      Response.redirect(new URL("/login", url), 302)
    );
  }

  async fetch(request) {
    try {
      await this.ensureConnected();
      // If a reconnect kicked off a silent re-login, wait for it (it
      // resolves only after the server confirms the rename, or fails).
      if (this.pendingAuth) {
        const p = this.pendingAuth;
        this.pendingAuth = null;
        try { await p; } catch {}
      }
      const url = new URL(request.url);

      if (url.pathname === "/search") {
        const blocked = await this.authGuard(url);
        if (blocked) return blocked;
        const format = url.searchParams.get("format") || "gen9randombattle";
        this.send(`|/utm null`);
        this.send(`|/search ${format}`);
        this.state_.notice = `Searching for ${format}...`;
        await this.save();
        return Response.redirect(new URL("/", url), 302);
      }

      if (url.pathname === "/cancelsearch") {
        this.send(`|/cancelsearch`);
        this.state_.searching = [];
        await this.save();
        return Response.redirect(new URL("/", url), 302);
      }

      if (url.pathname === "/challenge") {
        if (request.method === "POST") {
          const blocked = await this.authGuard(url);
          if (blocked) return blocked;
          const params = await this.readForm(request);
          const target = (params.get("username") || "").trim();
          const format = params.get("format") || "gen9randombattle";
          if (target) {
            this.send(`|/utm null`);
            this.send(`|/challenge ${target}, ${format}`);
            this.state_.notice = `Challenge sent to ${target}.`;
            await this.save();
          }
        }
        return Response.redirect(new URL("/", url), 302);
      }

      if (url.pathname === "/cancelchallenge") {
        const to = this.state_.challengeTo && this.state_.challengeTo.to;
        if (to) {
          try { this.send(`|/cancelchallenge ${to}`); } catch {}
        }
        return Response.redirect(new URL("/", url), 302);
      }

      if (url.pathname === "/accept") {
        const blocked = await this.authGuard(url);
        if (blocked) return blocked;
        const user = url.searchParams.get("user");
        if (user) {
          this.send(`|/utm null`);
          this.send(`|/accept ${user}`);
        }
        return Response.redirect(new URL("/", url), 302);
      }

      if (url.pathname === "/reject") {
        const user = url.searchParams.get("user");
        if (user) {
          try { this.send(`|/reject ${user}`); } catch {}
        }
        return Response.redirect(new URL("/", url), 302);
      }

      if (url.pathname === "/newgame") {
        this.resetBattle();
        await this.save();
        return Response.redirect(new URL("/", url), 302);
      }

      if (url.pathname === "/choose") {
        const value = url.searchParams.get("value");
        if (value && this.state_.roomId && this.state_.request) {
          const rqid = this.state_.request.rqid;
          this.sendToRoom(
            this.state_.roomId,
            `/choose ${value}${rqid !== undefined ? "|" + rqid : ""}`
          );
          this.state_.request = null;
          await this.save();
        }
        return Response.redirect(new URL("/battle", url), 302);
      }

      if (url.pathname === "/lead") {
        const idx = Number(url.searchParams.get("i") || 0) - 1;
        const req = this.state_.request;
        if (req?.teamPreview && this.state_.roomId) {
          const size = req.side?.pokemon?.length || 6;
          const nums = Array.from({ length: size }, (_, i) => i + 1);
          if (idx >= 0 && idx < size) {
            const lead = idx + 1;
            const order = [lead, ...nums.filter((n) => n !== lead)].join("");
            this.sendToRoom(
              this.state_.roomId,
              `/choose team ${order}|${req.rqid || ""}`
            );
            this.state_.request = null;
            await this.save();
          }
        }
        return Response.redirect(new URL("/battle", url), 302);
      }

      if (url.pathname === "/chat") {
        if (request.method === "POST" && this.state_.roomId && !this.state_.ended) {
          const params = await this.readForm(request);
          const msg = (params.get("msg") || "").trim().slice(0, 300);
          if (msg && !msg.startsWith("/")) {
            try { this.sendToRoom(this.state_.roomId, msg); } catch {}
          }
        }
        return Response.redirect(new URL("/battle", url), 302);
      }

      if (url.pathname === "/moveinfo") {
        const moveId = url.searchParams.get("move") || "";
        const movesData = await getMoves();
        return this.htmlResponse(
          renderMoveInfo(movesData[moveId] || null, moveId, this.state_)
        );
      }

      if (url.pathname === "/timer") {
        if (this.state_.roomId && !this.state_.ended) {
          try { this.sendToRoom(this.state_.roomId, "/timer"); } catch {}
        }
        return Response.redirect(new URL("/battle", url), 302);
      }

      if (url.pathname === "/forfeit") {
        if (this.state_.roomId && !this.state_.ended) {
          try { this.sendToRoom(this.state_.roomId, "/forfeit"); } catch {}
        }
        return Response.redirect(new URL("/battle", url), 302);
      }

      if (url.pathname === "/reconnect") {
        try { this.ws?.close(); } catch {}
        this.ws = null;
        this.state_.connected = false;
        await this.save();
        await this.ensureConnected();
        if (this.pendingAuth) {
          const p = this.pendingAuth;
          this.pendingAuth = null;
          try { await p; } catch {}
        }
        return Response.redirect(new URL("/", url), 302);
      }

      if (url.pathname === "/login") {
        if (request.method === "POST") {
          const params = await this.readForm(request);
          const username = (params.get("username") || "").trim();
          const password = params.get("password") || "";
          try {
            await this.login(username, password);
          } catch (err) {
            this.state_.loginError = err.message || String(err);
          }
          await this.save();
          return Response.redirect(new URL("/", url), 302);
        }
        return this.htmlResponse(renderLogin(this.state_));
      }

      if (url.pathname === "/logout") {
        try { this.send("|/logout"); } catch {}
        this.state_.loggedIn = false;
        this.state_.username = null;
        this.state_.loginName = null;
        this.state_.loginPassword = null;
        this.state_.mySide = null;
        this.relogDisabled = false;
        await this.save();
        return Response.redirect(new URL("/", url), 302);
      }

      if (url.pathname === "/battle") {
        if (!this.state_.roomId) {
          return Response.redirect(new URL("/", url), 302);
        }
        return this.htmlResponse(renderBattle(this.state_));
      }

      const homeHtml = renderHome(this.state_);
      if (this.state_.notice || this.state_.loginError) {
        this.state_.notice = null;
        this.state_.loginError = null;
        await this.save();
      }
      return this.htmlResponse(homeHtml);
    } catch (err) {
      return new Response(renderError(err.message || String(err)), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  }
}
