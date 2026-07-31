# PS CloudPhone

A Pokemon Showdown battle client built for CloudPhone's keypad-only, JS-limited
browser. It does not reimplement the battle engine -- it connects to the real
Showdown server (`wss://sim3.psim.us/showdown/websocket`) and lets the actual
Smogon simulator do all stat calculation, move validation, and mechanics, the
same way the official client does.

## How it works

CloudPhone's browser can't hold a WebSocket connection or run real client-side
JS, so it never talks to Showdown directly. Instead:

```
CloudPhone browser  <--plain HTTP, links only-->  Cloudflare Worker
                                                          |
                                              Durable Object (1 per session)
                                                          |
                                          persistent WebSocket
                                                          |
                                          wss://sim3.psim.us/showdown/websocket
                                              (the real Showdown server)
```

Each browser session gets a cookie (`sid`) that maps to one Durable Object.
That object holds the live WebSocket to Showdown, using the [Hibernatable
WebSockets API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
so the connection survives between your (infrequent, manual) page loads
without you paying for compute while nothing's happening. Every page is
server-rendered HTML with plain `<a href>` links for moves/switches, no
client-side JS at all -- same approach as your dumbphone chess site.

Random Battle formats (`gen9randombattle`, etc.) are used instead of a team
builder, since they draw from the full current Pokedex with sets picked
automatically -- that gets you the whole roster without building a team
editor for a keypad phone.

## Setup (dashboard + GitHub only, no wrangler CLI)

This uses Cloudflare's **Workers Builds** Git integration, which connects a
repo and redeploys automatically on every push -- no CLI, no API token
secrets to manage yourself.

1. Create a new GitHub repo and add all the files in this folder to it,
   keeping the folder structure (`src/` as a subfolder, `wrangler.toml` and
   `package.json` at the repo root). GitHub's web upload page
   (**Add file > Upload files**) accepts multiple files/folders dragged in
   at once and works fine from a phone browser.
2. In the Cloudflare dashboard, go to **Workers & Pages**.
3. Select **Create application** > next to **Import a repository**, select
   **Get started**.
4. Choose your **Git account** (authorize GitHub the first time you do
   this), then pick the repo you just created.
5. Cloudflare will detect `wrangler.toml` and pre-fill the build settings
   (deploy command defaults to `npx wrangler deploy`, which is correct here
   -- leave the build command blank, there's no framework to compile).
   Make sure the **Worker name** it assigns matches the `name` in
   `wrangler.toml` (`ps-cloudphone`) -- if it doesn't, edit one to match the
   other, or the build will fail.
6. Select **Save and Deploy**. The first deploy also provisions the
   Durable Object namespace (the `[[migrations]]` block in `wrangler.toml`
   handles that automatically).
7. Open the `*.workers.dev` URL it gives you on CloudPhone.

From then on, every push to your default branch redeploys automatically.
You can watch build logs under the Worker's **Deployments** tab if
something fails.

Durable Objects with SQLite storage (what this uses) are available on
Cloudflare's **free** Workers plan, so this should cost nothing at your
scale.

## Known limitations (read before reporting something as "broken")

- **I could not test this against the live Showdown server** -- this
  sandbox's network is locked to package registries (npm/GitHub/PyPI), not
  `psim.us`. The protocol messages and command formats are implemented from
  Showdown's published `PROTOCOL.md` / `SIM-PROTOCOL.md`, but expect to need
  a debugging pass. Good first move: add a temporary `console.log` in
  `webSocketMessage` and check `wrangler tail`.
- **Guest only.** No login -- Showdown assigns a "Guest 1234" name
  automatically, which is enough to ladder into random battles. Add the
  `|challstr|` -> `POST /api/login` flow from `PROTOCOL.md` if you want a
  registered/named account.
- **Team preview is auto-submitted** in default order (`team 123456`).
  Random Battle formats mostly don't use team preview at all, but a couple
  do; picking your own lead isn't wired up yet.
- **Singles-oriented.** Doubles formats will connect and battle, but the
  choice UI doesn't handle multi-target move selection, so you'll want to
  stick to `gen9randombattle` / `gen8randombattle` / `gen1randombattle`
  first.
- **One battle at a time per session**, no chat, no challenging a specific
  friend (only laddering into a random opponent via `/search`). Both are
  addable later using the same `sendToRoom` plumbing -- `/challenge`,
  `/accept`, `/reject` are documented in `PROTOCOL.md`.
- **Opponent's active Pokemon** is tracked by watching `switch`/`damage`
  log lines, not full request data (Showdown only sends you your own
  team's detail) -- so it shows species + HP condition, not full stats.

## File map

- `src/index.js` -- Worker entry, session cookie, routes to the Durable Object.
- `src/battle_session.js` -- the Durable Object: owns the WebSocket, parses
  incoming protocol lines, exposes `/`, `/search`, `/battle`, `/choose`, etc.
- `src/protocol.js` -- line parsing + human-readable log formatting.
- `src/html.js` -- plain server-rendered HTML pages, no CSS/JS frameworks.
