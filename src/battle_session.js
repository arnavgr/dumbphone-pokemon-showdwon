import { DurableObject } from "cloudflare:workers";
import { splitFrame, parseLine, parseIdent, formatBattleLine } from "./protocol.js";
import { renderHome, renderBattle, renderError } from "./html.js";

// Real Pokemon Showdown server, per PROTOCOL.md.
const SHOWDOWN_WS_URL = "https://sim3.psim.us/showdown/websocket";

const DEFAULT_STATE = {
  connected: false,
  username: null,
  roomId: null,
  roomTitle: null,
  log: [],
  request: null,
  searching: [],
  turn: 0,
  ended: false,
  resultMsg: null,
  myActive: null,
  oppActive: null,
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
      this.state_ = saved || { ...DEFAULT_STATE };
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

  // Lazily open (or re-open) the outbound WebSocket to the real Showdown
  // server. This is a *client* connection the DO initiates via fetch(),
  // not a connection accepted from an incoming request -- so it does NOT
  // use the Hibernatable WebSockets API (ctx.acceptWebSocket only applies
  // to sockets a DO accepts from an Upgrade request it receives; outbound
  // sockets aren't hibernatable yet -- see cloudflare/workerd#4864).
  // Practically: this DO stays pinned in memory (billed) while this socket
  // is open, and gets evicted -- closing the socket -- after ~70-140s with
  // no incoming HTTP request. A page left idle that long will need to
  // reconnect / re-search on the next tap.
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

  // ---- Outbound WebSocket event handlers ----
  // (plain event listeners, since this socket isn't hibernatable -- see
  // the note on ensureConnected above)

  async onSocketMessage(message) {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
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

  // ---- Protocol handling ----

  async handleLine(roomId, rawLine) {
    const { type, parts } = parseLine(rawLine);

    switch (type) {
      case "challstr": {
        // Guest session: Showdown auto-assigns a "Guest 1234" name on
        // connect, no login POST needed to play random battles.
        this.state_.connected = true;
        break;
      }
      case "updateuser": {
        const name = (parts[0] || "").replace(/^[^A-Za-z0-9]/, "");
        this.state_.username = name;
        break;
      }
      case "updatesearch": {
        try {
          const json = JSON.parse(parts[0]);
          this.state_.searching = json.searching || [];
          if (json.games) {
            const ids = Object.keys(json.games);
            if (ids.length && ids[0] !== this.state_.roomId) {
              this.state_.roomId = ids[0];
              this.state_.roomTitle = json.games[ids[0]];
              this.state_.log = [];
              this.state_.turn = 0;
              this.state_.ended = false;
              this.state_.resultMsg = null;
              this.state_.myActive = null;
              this.state_.oppActive = null;
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
          this.state_.request = req;
          if (req.teamPreview) {
            // Simplification: auto-submit default team order so play
            // isn't blocked on a full reorder UI. See README.
            const size = req.side?.pokemon?.length || 6;
            const order = Array.from({ length: size }, (_, i) => i + 1).join("");
            this.sendToRoom(this.state_.roomId, `/choose team ${order}|${req.rqid || ""}`);
            this.state_.request = null;
          }
        } catch { /* ignore malformed json */ }
        break;
      }
      case "turn": {
        if (roomId !== this.state_.roomId) break;
        this.state_.turn = Number(parts[0]) || this.state_.turn;
        this.pushLog(formatBattleLine(type, parts));
        break;
      }
      case "switch":
      case "drag": {
        if (roomId === this.state_.roomId) {
          const p = parseIdent(parts[0]);
          const species = parts[1].split(",")[0];
          const info = { name: species, cond: parts[2] || "" };
          if (p.side.startsWith("p1")) this.state_.myActive = info;
          else this.state_.oppActive = info;
        }
        this.pushLog(formatBattleLine(type, parts));
        break;
      }
      case "-damage":
      case "-heal": {
        if (roomId === this.state_.roomId) {
          const p = parseIdent(parts[0]);
          const cond = parts[1] || "";
          if (p.side.startsWith("p1") && this.state_.myActive) this.state_.myActive.cond = cond;
          if (p.side.startsWith("p2") && this.state_.oppActive) this.state_.oppActive.cond = cond;
        }
        this.pushLog(formatBattleLine(type, parts));
        break;
      }
      case "win": {
        if (roomId === this.state_.roomId) {
          this.state_.ended = true;
          this.state_.resultMsg = `${parts[0] === this.state_.username ? "You" : parts[0]} won the battle!`;
        }
        this.pushLog(formatBattleLine(type, parts));
        break;
      }
      case "tie": {
        if (roomId === this.state_.roomId) {
          this.state_.ended = true;
          this.state_.resultMsg = "The battle ended in a tie.";
        }
        this.pushLog(formatBattleLine(type, parts));
        break;
      }
      default: {
        if (roomId === this.state_.roomId || roomId === "") {
          this.pushLog(formatBattleLine(type, parts));
        }
        break;
      }
    }
  }

  // ---- HTTP surface, called from the Worker (src/index.js) ----

  async fetch(request) {
    try {
      await this.ensureConnected();
      const url = new URL(request.url);

      if (url.pathname === "/search") {
        const format = url.searchParams.get("format") || "gen9randombattle";
        this.send(`|/utm null`);
        this.send(`|/search ${format}`);
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
        this.state_.roomId = null;
        this.state_.roomTitle = null;
        this.state_.log = [];
        this.state_.request = null;
        this.state_.turn = 0;
        this.state_.ended = false;
        this.state_.resultMsg = null;
        this.state_.myActive = null;
        this.state_.oppActive = null;
        await this.save();
        return Response.redirect(new URL("/", url), 302);
      }

      if (url.pathname === "/choose") {
        const value = url.searchParams.get("value");
        if (value && this.state_.roomId && this.state_.request) {
          const rqid = this.state_.request.rqid;
          this.sendToRoom(this.state_.roomId, `/choose ${value}${rqid !== undefined ? "|" + rqid : ""}`);
        }
        return Response.redirect(new URL("/battle", url), 302);
      }

      if (url.pathname === "/battle") {
        if (!this.state_.roomId) return Response.redirect(new URL("/", url), 302);
        return new Response(renderBattle(this.state_), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // default: home
      return new Response(renderHome(this.state_), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (err) {
      return new Response(renderError(err.message || String(err)), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  }
}
