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
server-rendered HTML with plain `<a href>` links (and a couple of simple
`<form>`s for text input) for moves/switches/challenges, no client-side JS at
all -- same approach as your dumbphone chess site. The home page also has a
plain "Refresh" link since there's no auto-polling JS to notice new state on
its own.

This client is **random-battle only** -- there's no teambuilder, so only
formats that hand you a randomized team are offered:

- `gen9randombattle` -- by far Showdown's biggest ladder, currently
- `gen9hackmonscup` -- fully randomized mons/movesets/abilities, very active
- `gen8randombattle` -- kept around for players who prefer the previous gen

That gets you the whole current Pokedex without building a team editor for a
keypad phone. (If Showdown's popular-format lineup shifts over time, swap the
three entries in `RANDOM_FORMATS` at the top of `src/html.js`.)

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

## Battle-page intel

The battle page (`/battle`) now shows more than just HP bars:

- **Stats.** Your active Pokemon and every non-fainted teammate you can
  switch to show their exact `Atk/Def/SpA/SpD/Spe` (Showdown sends these to
  you directly in `|request|` for your own team). The opponent's active
  Pokemon shows its **Pokedex base stats** instead, labeled as such -
  Showdown never sends you the opponent's real computed stats, so this is
  the closest approximation available, not the exact number.
- **Type matchup.** A ranked list of your non-fainted team, sorted by the
  best effectiveness multiplier among each one's *known* move types against
  the opponent's current type(s) - e.g. "2x - super effective". This uses
  the real movesets in `side.pokemon[].moves` (yes, Showdown sends you your
  whole team's moves, not just your active Pokemon's) cross-referenced
  against a hardcoded Gen 6+ type chart in `src/protocol.js`.
- **Move descriptions.** Each selectable move shows its `shortDesc` inline.
  If that's ever too long for a keypad screen, it's truncated with a "More"
  link to a separate `/moveinfo?move=ID` page with the full description,
  power, accuracy, and PP - kept as a distinct page (rather than an
  expand/collapse widget) since there's no client-side JS available to
  implement one.

## Battling a friend

The home page has a "Battle a friend" section:

- To challenge someone, enter their username, pick a format, and submit.
  This sends `/challenge USERNAME, FORMAT` upstream; the page shows
  "Challenging ... " with a cancel link while it's pending, and
  auto-refreshes every few seconds so you'll see if it's accepted.
- If someone challenges you, their name/format shows up with Accept/Reject
  links. Accepting sends `/accept USERNAME` upstream.
- Either way, once a challenge is accepted Showdown creates a battle room and
  auto-joins both players to it -- this reuses the exact same
  `|updatesearch|` → `games` plumbing that already handles matchmaking (the
  protocol docs are explicit that `|updatesearch|` fires for *all* games a
  user is in, including challenge-started ones), so no extra room-detection
  code was needed for this.
- Because there's no teambuilder, this client always sends a `null` team
  (`/utm null`). That's fine for the random formats offered above. If a
  friend challenges you in a format that requires a real built team, Accept
  will fail server-side validation (you'll see it as a raw `[popup] ...`
  line in the log) -- there's currently no way to build a team to satisfy
  that, by design.

## Known limitations (read before reporting something as "broken")

- **I could not test this against the live Showdown server** -- this
  sandbox's network is locked to package registries (npm/GitHub/PyPI), not
  `psim.us`. The protocol messages and command formats are implemented from
  Showdown's published `PROTOCOL.md` / `SIM-PROTOCOL.md`, but expect to need
  a debugging pass. Good first move: add a temporary `console.log` in
  `webSocketMessage` and check `wrangler tail`.
- **Guest only.** No login -- Showdown assigns a "Guest 1234" name
  automatically, which is enough to ladder into random battles or send/accept
  friend challenges. Add the `|challstr|` -> `POST /api/login` flow from
  `PROTOCOL.md` if you want a registered/named account (the login form is
  already wired up for this).
- **Random battles only, no teambuilder.** Constructed tiers (OU, UU, etc.)
  that require a custom team aren't offered, and accepting a challenge into
  one of those formats from a friend won't work (see above).
- **Team preview** (picking your lead in the handful of random formats that
  use it) is wired up via `/lead` -- you can tap a specific Pokemon or use
  "Auto lead first".
- **Singles-oriented.** Doubles formats aren't offered on the home page
  because the choice UI doesn't handle multi-target move selection; stick to
  the singles random formats listed above.
- **One battle at a time per session**, no chat, no tournament support.
  These are addable later using the same `sendToRoom` plumbing.
- **Opponent's active Pokemon** is tracked by watching `switch`/`damage`
  log lines, not full request data (Showdown only sends you your own
  team's detail) -- so it shows species + HP condition, not full stats.

## File map

- `src/index.js` -- Worker entry, session cookie, routes to the Durable Object.
- `src/battle_session.js` -- the Durable Object: owns the WebSocket, parses
  incoming protocol lines, exposes `/`, `/search`, `/battle`, `/choose`,
  `/challenge`, `/accept`, `/reject`, etc.
- `src/protocol.js` -- line parsing + human-readable log formatting.
- `src/html.js` -- plain server-rendered HTML pages, no CSS/JS frameworks.
