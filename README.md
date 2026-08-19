# Dumbphone-pokemon-showdown

A Pokemon Showdown battle client built for CloudPhone's keypad-only, JS-limited
browser. It does not reimplement the battle engine -- it connects to the real
Showdown server (`wss://sim3.psim.us/showdown/websocket`) and lets the actual
Smogon simulator do all stat calculation, move validation, and mechanics, the
same way the official client does.

## How it works

CloudPhone's browser can't hold a WebSocket connection or run real client-side
JS, so it never talks to Showdown directly. Instead:

```
CloudPhone browser  <--plain HTTP, links only-->  Render Node.js web service
                                                          |
                                        In-memory BattleSession (1 per
                                        session cookie, keyed in a Map)
                                                          |
                                     persistent WebSocket, via outbound proxy
                                                          |
                                          wss://sim3.psim.us/showdown/websocket
                                              (the real Showdown server)
```

Each browser session gets a cookie (`sid`) that maps to one `BattleSession`
object held in memory by the Node process. That object holds the live
WebSocket to Showdown for as long as the process stays up. Every page is
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

### Why this runs on Render instead of Cloudflare Workers

This project originally ran on Cloudflare Workers + Durable Objects, but
Showdown flags Cloudflare's outbound edge IPs as proxy/datacenter addresses
and disconnects immediately, before a session can ever stabilize -- no login
or reconnect fix gets around that, since it's blocked at the IP level. Render
gives a normal long-running Node process instead of a stateless edge
function, which sidesteps the Durable Object constraints entirely, but the
underlying IP-reputation problem doesn't automatically go away just by
switching host -- Render's shared IPs can get flagged the same way. That's
what `PROXY_URL` (below) is for: it routes the WebSocket, and the HTTP login
call, out through a separate proxy with IPs Showdown doesn't flag.

### A note on session persistence

Sessions now live in an in-memory `Map` inside the Node process (see
`server.js`), not in Durable Object storage. That means:

- Every active session -- including anyone currently logged in -- is lost on
  a restart, redeploy, or crash of the Render service.
- This only works as a **single instance**. If you scale to more than one
  Render instance, a browser's requests could land on an instance that
  doesn't have its session, and account state would appear to reset in the
  middle of a battle. Keep this at one instance.

## Setup (Render + GitHub)

1. Create a new GitHub repo and add all the files in this folder to it,
   keeping the folder structure (`src/` as a subfolder, `package.json` and
   `server.js` at the repo root). GitHub's web upload page (**Add file >
   Upload files**) accepts multiple files/folders dragged in at once and
   works fine from a phone browser.
2. Get an HTTP/HTTPS proxy with IPs that aren't flagged as datacenter/proxy
   by Pokemon Showdown (a paid rotating or static residential proxy plan --
   Webshare and similar providers work). You'll need the proxy URL in the
   form `http://username:password@host:port`.
3. In the Render dashboard, select **New > Web Service** and connect the
   GitHub repo you just created.
4. Configure the service:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start` (runs `node server.js`)
5. Under the service's **Environment** tab, add an environment variable:
   - `PROXY_URL` = your proxy URL from step 2, e.g.
     `http://username:password@host:port`

   This is required -- the app throws a startup error and refuses to boot if
   `PROXY_URL` isn't set, rather than silently running unproxied and getting
   flagged. **Never commit a proxy URL into the source** -- it's a public
   GitHub repo, so anything hardcoded there is exposed the moment it's
   pushed. If a proxy credential ever does end up committed, rotate it with
   your proxy provider immediately, even after removing it from the code.
6. Deploy. Render will give you a `*.onrender.com` URL once the build
   finishes -- watch the deploy logs if the service fails to start (a
   missing `PROXY_URL` will show up there immediately).
7. Open that URL on CloudPhone.

From then on, every push to your connected branch redeploys automatically
(this will drop any active sessions, per the note above).

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

## File map

- `server.js` -- Express entry point: same-origin sprite proxy (`/sprite/*`),
  session cookie handling, and routing each request to the right in-memory
  `BattleSession`.
- `src/battle_session.js` -- owns the WebSocket to Showdown (via the outbound
  proxy), parses incoming protocol lines in order, and handles `/`,
  `/search`, `/battle`, `/choose`, `/challenge`, `/accept`, `/reject`,
  `/login`, `/debug`, etc.
- `src/protocol.js` -- line parsing + human-readable log formatting.
- `src/html.js` -- plain server-rendered HTML pages, no CSS/JS frameworks.
