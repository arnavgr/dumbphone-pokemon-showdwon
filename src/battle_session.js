import { DurableObject } from "cloudflare:workers";
import {
  splitFrame,
  parseLine,
  parseIdent,
  formatBattleLine,
  normalizeName,
  parseDetails,
  spriteUrl,
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
// Global Data Caches: Persist across DO invocations in the V8 isolate.
// We use Singleton Promises to prevent duplicate 2MB downloads on cold starts.
// ---------------------------------------------------------------------------
let pokedexCache = null;
let pokedexPromise = null;
async function getPokedex() {
  if (pokedexCache) return pokedexCache;
  if (!pokedexPromise) {
    pokedexPromise = fetch("https://play.pokemonshowdown.com/data/pokedex.json")
      .then(res => res.ok ? res.json() : {})
      .then(data => { pokedexCache = data || {}; return pokedexCache; })
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
      .then(res => res.ok ? res.json() : {})
      .then(data => { movesCache = data || {}; return movesCache; })
      .catch(() => { movesCache = {}; return movesCache; });
  }
  return movesPromise;
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
  request: null,
  searching: [],
  turn: 0,
  ended: false,
  resultMsg: null,
  challstr: null,
  notice: null,
  loginError: null,
  upstreamCookie: null,
  // {userid: format} of challenges other people have sent you
  challengesFrom: {},
  // {to, format} if you're currently challenging someone, else null
  challengeTo: null,
};

export class BattleSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ws = null;
    this.state_ = null;
    this.keepAliveInterval = null;

    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get("state");
      this.state_ = { ...DEFAULT_STATE, ...(saved || {}) };
      if (!this.state_.players) this.state_.players = {};
      if (!this.state_.active) this.state_.active = {};
      if (!this.state_.challengesFrom) this.state_.challengesFrom = {};
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

  resetBattle() {
    Object.assign(this.state_, {
      roomId: null,
      roomTitle: null,
      log: [],
      request: null,
      turn: 0,
      ended: false,
      resultMsg: null,
      mySide: null,
      players: {},
      active: {},
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

  async upsertActive(parts) {
    const p = parseIdent(parts[0] || "");
    const { species, shiny } = parseDetails(parts[1] || "");
    const condition = parts[2] || "";

    const dex = await getPokedex();
    const id = normalizeName(species);
    const types = dex[id]?.types || [];
    // Showdown never sends us the opponent's actual computed stats (only
    // our own team gets that in |request|), so base stats are the best
    // approximation we can show for them - always labeled as "base stats"
    // in the UI, never presented as the real thing.
    const baseStats = dex[id]?.baseStats || null;

    this.state_.active[p.side] = {
      slot: p.side,
      nickname: p.name,
      species,
      condition,
      shiny,
      types,
      baseStats,
      spriteFront: spriteUrl(species, { shiny, back: false, anim: ANIMATED_SPRITES }),
      spriteBack: spriteUrl(species, { shiny, back: true, anim: ANIMATED_SPRITES }),
    };
  }

  updateActiveCondition(parts) {
    const p = parseIdent(parts[0] || "");
    const mon = this.state_.active[p.side];
    if (mon) mon.condition = parts[1] || "";
  }

  async readForm(request) {
    const text = await request.text();
    return new URLSearchParams(text);
  }

  async login(username, password) {
    if (!this.state_.challstr) {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (!this.state_.challstr) {
      throw new Error("No challstr received yet. Refresh and try again.");
    }

    const body = new URLSearchParams();
    body.set("act", "login");
    body.set("name", username);
    body.set("pass", password);
    body.set("challstr", this.state_.challstr);

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

    if (!assertion) {
      throw new Error(
        action?.actionerror || data?.actionerror || "Login failed."
      );
    }

    const finalName = action?.username || username;

    this.send(`|/trn ${finalName},0,${assertion}`);

    this.state_.username = finalName;
    this.state_.loggedIn = true;
    this.state_.loginError = null;
    this.state_.notice = "Logged in.";
  }

  async ensureConnected() {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      return;
    }

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
    this.pushLog(`(disconnected from server: ${event.reason || event.code})`);
    await this.save();
  }

  async onSocketError() {
    this.ws = null;
    this.state_.connected = false;
    this.pushLog(`(connection error)`);
    await this.save();
  }

  async handleLine(roomId, rawLine) {
    const { type, parts } = parseLine(rawLine);
    const mySide = this.state_.mySide;

    switch (type) {
      case "challstr": {
        this.state_.challstr = parts.join("|");
        this.state_.connected = true;
        if (this.state_.roomId && !this.state_.ended) {
          try {
            this.sendToRoom(this.state_.roomId, `/join ${this.state_.roomId}`);
          } catch { }
        }
        break;
      }

      case "updateuser": {
        const rawName = parts[0] || "";
        const name = rawName.trim().replace(/^[^A-Za-z0-9]+/, "");
        this.state_.username = name;
        this.state_.loggedIn = !/^guest/i.test(name);
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
        // Fired for ALL games the user is in - both matchmaking AND
        // accepted friend challenges - so this one handler covers both.
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
        } catch { }
        break;
      }

      case "updatechallenges": {
        // {challengesFrom: {userid: format}, challengeTo: {to, format} | null}
        try {
          const json = JSON.parse(parts[0]);
          this.state_.challengesFrom = json.challengesFrom || {};
          this.state_.challengeTo = json.challengeTo || null;
        } catch { }
        break;
      }

      case "title": {
        if (roomId === this.state_.roomId) this.state_.roomTitle = parts[0];
        break;
      }

      case "request": {
        if (roomId !== this.state_.roomId) break;
        if (!parts[0]) { this.state_.request = null; break; }
        try {
          const req = JSON.parse(parts[0]);
          const side = String(
            req?.side?.id || req?.side?.pokemon?.[0]?.ident || ""
          ).slice(0, 2);
          if (side === "p1" || side === "p2") this.state_.mySide = side;

          const dex = await getPokedex();
          const movesData = await getMoves();

          // Append type data to swappable Pokémon array, plus the set of
          // types their known moves cover (side.pokemon[].moves is a list
          // of move IDs for ALL your team, not just the active one) - this
          // is what powers the "type matchup" ranking on the battle page.
          if (req.side && req.side.pokemon) {
             for (const p of req.side.pokemon) {
                const species = String(p.details || "").split(",")[0].trim();
                const id = normalizeName(species);
                if (dex[id] && dex[id].types) p.types = dex[id].types;
                if (Array.isArray(p.moves)) {
                  p.moveTypes = [...new Set(
                    p.moves.map((mId) => movesData[mId]?.type).filter(Boolean)
                  )];
                }
             }
          }
          // Append type data and a short effect description to active move
          // choices array, so the battle page can explain what each move
          // does without needing a separate data fetch per move.
          if (req.active) {
             for (const active of req.active) {
                if (active.moves) {
                   for (const m of active.moves) {
                      const mId = m.id || normalizeName(m.move);
                      m.id = mId;
                      const data = movesData[mId];
                      if (data) {
                        if (data.type) m.type = data.type;
                        if (data.shortDesc || data.desc) m.shortDesc = data.shortDesc || data.desc;
                      }
                   }
                }
             }
          }

          this.state_.request = req;
        } catch { }
        break;
      }

      case "turn": {
        if (roomId !== this.state_.roomId) break;
        this.state_.turn = Number(parts[0]) || this.state_.turn;
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "switch":
      case "drag": {
        if (roomId === this.state_.roomId) await this.upsertActive(parts);
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "-damage":
      case "-heal": {
        if (roomId === this.state_.roomId) this.updateActiveCondition(parts);
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "faint": {
        if (roomId === this.state_.roomId) {
          const p = parseIdent(parts[0] || "");
          const mon = this.state_.active[p.side];
          if (mon) mon.condition = "0 fnt";
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      case "win": {
        if (roomId === this.state_.roomId) {
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
        if (roomId === this.state_.roomId) {
          this.state_.ended = true;
          this.state_.request = null;
          this.state_.resultMsg = "The battle ended in a tie.";
        }
        this.pushLog(formatBattleLine(type, parts, mySide));
        break;
      }

      default: {
        if (roomId === this.state_.roomId || roomId === "") {
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

  async fetch(request) {
    try {
      await this.ensureConnected();
      const url = new URL(request.url);

      if (url.pathname === "/search") {
        const format = url.searchParams.get("format") || "gen9randombattle";
        // Only random formats are offered, and those never need a
        // user-built team, so we always search with a null team.
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

      if (url.pathname === "/moveinfo") {
        const moveId = url.searchParams.get("move") || "";
        const movesData = await getMoves();
        return this.htmlResponse(renderMoveInfo(movesData[moveId] || null, moveId));
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
        this.state_.mySide = null;
        await this.save();
        return Response.redirect(new URL("/", url), 302);
      }

      if (url.pathname === "/battle") {
        if (!this.state_.roomId) {
          return Response.redirect(new URL("/", url), 302);
        }
        return this.htmlResponse(renderBattle(this.state_));
      }

      return this.htmlResponse(renderHome(this.state_));
    } catch (err) {
      return new Response(renderError(err.message || String(err)), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  }
}
