# 🏁 Sprite Race

A quick multiplayer party game for the office, built to run on **Cloudflare
Workers + Durable Objects**. Everyone opens the same link on their phone, gets
shuffled into secret teams, and races a sprite from the bottom of the screen to
the top.

## The twist

* **Hidden sprite** — you're never told which sprite your team controls. Your
  phone shows only the button(s) you control, so you press and watch the board
  to work out which sprite responds. State broadcasts carry no ownership info,
  so it can't be reverse-engineered from network traffic. (An optional **"Your
  sprite: Shown"** toggle on the dashboard turns this off for an easier mode —
  each player's own phone then marks their sprite with a **YOU** ring, while the
  shared big screen still reveals nothing.)
* **Split controls** — a team always covers all four directions, split across
  its members. In a full team of four that's one direction each; in a smaller
  team each person controls two or more. Nobody is ever left with nothing to do.
* **Auto-balanced teams** — the server splits whoever's connected into 2–4
  teams, so it's always a race whatever the headcount (more players → more
  sprites).
* **Moving traps** — red obstacles patrol left and right; grey ones sit still.
  Hit any of them and your sprite is knocked back down a bit (not a full reset)
  with a small time penalty, plus a brief moment of immunity so you don't
  chain-crash on the same trap.
* **Winner celebration** — the dashboard (and each winning player's phone) rains
  confetti when a race is won.
* **Every press moves it** — any teammate's valid press nudges the sprite
  immediately, so a teammate pushing the wrong way is part of the fun. Each
  player's moves are rate-limited (~14/sec) so races are won by coordination,
  not by tapping fast or scripting.

Watch which sprite your button moves, then coordinate with your team to weave to
the top. First team to the top wins. At the end, each player gets a personal
reveal: their sprite, their direction(s), and whether they won.

## How it plays

1. Put the **dashboard** (`/display`) on the big screen and have everyone open
   the link on their phone (or scan the QR) and enter a name.
2. On the dashboard, choose the settings (race length, difficulty, teams) and
   hit **Launch Race** — only the big screen can start the game; players can't.
3. A **3·2·1 countdown** plays, then movement goes live. The server
   auto-balances everyone into teams; each team drives one sprite and
   collectively controls all four directions.
4. Race to the top before the timer runs out. If time expires, the sprite that
   got furthest wins.
5. On the finished screen, hit **New Race** on the dashboard to play again with
   fresh teams and settings.

**Best with 6+ players** (two or more teams). With only a couple of people it
still works — each becomes a solo racer controlling their whole sprite — but the
"find your sprite" deduction really comes alive once there are several sprites
on the board.

## Run locally

```bash
npm install
npm run dev
```

`wrangler dev` prints a local URL (usually `http://localhost:8787`). Open it in
a few browser tabs/phones on the same network to test. Arrow keys work on
desktop; the on-screen d-pad works on touch.

## Front-of-room dashboard

Open **`/display`** on a TV or projector at the front of the room. It's the
game's control surface as well as the shared view:

* a **setup panel** to configure the next race before it starts — race length,
  difficulty (obstacle count / trap speed / knockback), number of teams (auto or
  fixed), and whether each player's sprite is Hidden (the default challenge) or
  Shown (easy mode) — plus the **Launch Race** button. The game can *only* be
  started here, never from a player's phone.
* a compact **join panel** with a QR code and URL (rendered locally from a
  vendored library, no external call) and the count of pilots ready.
* during a race: the live board with the current leader crowned, a **standings**
  leaderboard (progress % and crashes), and an **input-activity** meter
  (inputs/sec, a live sparkline, and total inputs).

It connects as a spectator (`{type:'spectate'}`), so it never joins a team or
counts as a player. Crucially it shows **only board-equivalent aggregates** —
never a player→sprite or player→direction mapping, and no per-direction
breakdown — so having it visible to everyone gives no player an advantage.

## Deploy to Cloudflare

```bash
npm run deploy
```

You'll need a (free) Cloudflare account and to be logged in (`wrangler login`).
Durable Objects here are SQLite-backed, so they work on the free Workers plan.
After deploy, share the `*.workers.dev` URL with the office.

## How it's built

| File | Purpose |
| --- | --- |
| `src/index.js` | The Worker entry + the `GameRoom` Durable Object (players, sprites, obstacles, tick loop, win logic). One shared room named `main`. |
| `public/index.html` | The player client — lobby, canvas board, d-pad, and the end-of-round reveal. |
| `public/display.html` | The front-of-room dashboard (served at `/display`). |
| `public/theme.css` | Shared "Space Race" design tokens + component classes used by every page. See `STYLE.md`. |
| `public/board.js` | Shared canvas renderer for the race board (starfield, goal gate, hazards, sprite trails). |
| `public/confetti.js` | Shared winner-confetti effect used by the phone client and the dashboard. |
| `STYLE.md` | The style guide — how future features should use the tokens, components, and board renderer. |
| `wrangler.toml` | Cloudflare config: static assets from `public/`, the Durable Object binding, and the SQLite migration. |

The client protocol is deliberately thin: the phone sends every button press as
`{type:'move', dir}`, and the server decides whether that press matches the
player's secret direction and isn't coming in faster than the per-player rate
limit. Board state broadcasts carry **no** ownership info, so the hidden-controls
mechanic can't be reverse-engineered from network traffic.
