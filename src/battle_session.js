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
  renderTeam,
} from "./html.js";

// Real Pokemon Showdown server, per PROTOCOL.md.
const SHOWDOWN_WS_URL = "https://sim3.psim.us/showdown/websocket";

// Animated (gif) sprites look much nicer; set false for extremely
// low-bandwidth phones to use the static gen5 png sets instead.
const ANIMATED_SPRITES = true;

const DEFAULT_STATE = {
  connected: false,
  username: null,
  loggedIn: false,

  // Side detection: NEVER assume p1 == you.
  mySide: null, // "p1" | "p2" | null
  players: {},  // { p1: "Name", p2: "Name" }
  active: {},   // { p1a: {...}, p1b: {...}, p2a: {...} }

  roomId: null,
  roomTitle: null,
  log: [],
  request: null,
  searching: [],
  turn: 0,
  ended: false,
  resultMsg: null,

  challstr: null,
  team: "",
  notice: null,
  loginError: null,
};

export class BattleSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ws = null;
    this.state_ = null;

    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get("state");
      this.state_ = { ...DEFAULT_STATE, ...(saved || {}) };
      if (!this.state_.players) this.state_.players = {};
      if (!this.state_.active) this.state_.active = {};
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

  // Figure out whether we are p1 or p2 by matching |player| names against
  // our own username. Called whenever either piece of info changes.
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

  // |switch| / |drag| -> store the active Pokemon under its slot (p1a etc).
  upsertActive(parts) {
    const p = parseIdent(parts[0] || "");
    const { species, shiny } = parseDetails(parts[1] || "");
    const condition = parts[2] || "";

    this.state_.active[p.side] = {
      slot: p.side,
      nickname: p.name,
      species,
      condition,
      shiny,
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

  // ---- Login (challstr -> action.php -> /trn) -------------------------------
  async login(username, password) {
    if (!this.state_.challstr) {
      // Give the socket a moment to deliver challstr.
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
    if (jsonText.startsWith("]")) jsonText = jsonText.slice(1); // Showdown JSON prefix

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

  // ---- Outbound WebSocket lifecycle ----------------------------------------
  // Lazily open (or re-open) the outbound WebSocket to the real Showdown
  // server. This is a client connection the DO initiates via fetch(), not a
  // connection accepted from an incoming request -- so it does NOT use the
  // Hibernatable WebSockets API (ctx.acceptWebSocket only applies to sockets
  // a DO accepts from an Upgrade request it receives; outbound sockets aren't
  // hibernatable yet -- see cloudflare/workerd#4864).
  // Practically: this DO stays pinned in memory (billed) while this socket is
  // open, and gets evicted -- closing the socket -- after ~70-140s with no
  // incoming HTTP request. A page left idle that long will need to reconnect
  // on the next tap (the /reconnect route and the challstr rejoin help).
  async ensureConnected() {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      return;
    }

    const resp = await fetch(SHOWDOWN_WS_URL, {
      headers: { Upgrade: "websocket" },
    });
    const ws = resp.webSocket;
    if (!ws) {
      throw new Error("Showdown server did not accept the WebSocket upgrade");
    }

    ws.accept();
    ws.addEventListener("message", (event) => {
      this.ctx.waitUntil(this.onSocketMessage(event.data));
    });
    ws.addEventListener("close", (event) => {
      this.ctx.waitUntil(this.onSocketClose(event));
    });
    ws.addEventListener("error", () => {
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

  // ---- Protocol handling ----------------------------------------------------
  async handleLine(roomId, rawLine) {
    const { type, parts } = parseLine(rawLine);
    const mySide = this.state_.mySide;

    switch (type) {
      case "challstr": {
        this.state_.challstr = parts.join("|");
        this.state_.connected = true;
        // After a (re)connect, try to rejoin a battle room we had before.
        if (this.state_.roomId && !this.state_.ended) {
          try {
            this.sendToRoom(this.state_.roomId, `/join ${this.state_.roomId}`);
          } catch { /* socket not ready yet; ignore */ }
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
        } catch { /* ignore malformed json */ }
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

          // Belt-and-braces side detection straight from the request JSON.
          const side = String(
            req?.side?.id || req?.side?.pokemon?.[0]?.ident || ""
          ).slice(0, 2);
          if (side === "p1" || side === "p2") this.state_.mySide = side;

          this.state_.request = req;
          // Team preview is now handled by the /lead UI (no auto-submit).
        } catch { /* ignore malformed json */ }
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
        if (roomId === this.state_.roomId) this.upsertActive(parts);
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

  // ---- HTTP surface ----------------------------------------------------------
  htmlResponse(body) {
    return new Response(body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store", // feature-phone proxies love stale pages
      },
    });
  }

  async fetch(request) {
    try {
      await this.ensureConnected();
      const url = new URL(request.url);

      if (url.pathname === "/search") {
        const format = url.searchParams.get("format") || "gen9randombattle";
        const useTeam = url.searchParams.get("team") === "1";
        const team =
          useTeam && this.state_.team && this.state_.team.trim()
            ? this.state_.team.trim().replace(/\r?\n/g, "")
            : null;

        this.send(`|/utm ${team || "null"}`);
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
          this.state_.request = null; // UI shows "waiting" until next request
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

      if (url.pathname === "/team") {
        if (request.method === "POST") {
          const params = await this.readForm(request);
          const team = params.get("team") || "";
          // Packed teams are single-line.
          this.state_.team = team.replace(/\r?\n/g, "").trim();
          this.state_.notice = "Team saved.";
          await this.save();
          return Response.redirect(new URL("/", url), 302);
        }
        return this.htmlResponse(renderTeam(this.state_));
      }

      if (url.pathname === "/battle") {
        if (!this.state_.roomId) {
          return Response.redirect(new URL("/", url), 302);
        }
        return this.htmlResponse(renderBattle(this.state_));
      }

      // default: home
      return this.htmlResponse(renderHome(this.state_));
    } catch (err) {
      return new Response(renderError(err.message || String(err)), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  }
}
