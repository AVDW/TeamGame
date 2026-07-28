# 🏁 Sprite Race

A quick multiplayer party game for the office, built to run on **Cloudflare
Workers + Durable Objects**. Everyone opens the same link on their phone, gets
shuffled into secret teams, and races a sprite from the bottom of the screen to
the top.

## The twist

* **Hidden sprite** — you're never told which sprite your team controls. Your
  phone shows only the button(s) you control, so you press and watch the board
  to work out which sprite responds. State broadcasts carry no ownership info,
  so it can't be reverse-engineered from network traffic.
* **Split controls** — a team always covers all four directions, split across
  its members. In a full team of four that's one direction each; in a smaller
  team each person controls two or more. Nobody is ever left with nothing to do.
* **Auto-balanced teams** — the server splits whoever's connected into 2–4
  teams, so it's always a race whatever the headcount (more players → more
  sprites).
* **Moving traps** — red obstacles patrol left and right; grey ones sit still.
  Hit any of them and your sprite is sent back to the start with a time penalty.
* **Every press moves it** — any teammate's valid press nudges the sprite
  immediately, so a teammate pushing the wrong way is part of the fun.

Watch which sprite your button moves, then coordinate with your team to weave to
the top. First team to the top wins. At the end, each player gets a personal
reveal: their sprite, their direction(s), and whether they won.

## How it plays

1. Everyone opens the link and enters a name.
2. Anyone taps **Start Race**.
3. The server auto-balances everyone into 2–4 teams; each team drives one sprite
   and collectively controls all four directions.
4. Race to the top before the 2-minute timer runs out. If time expires, the
   sprite that got furthest wins.
5. Tap **Back to lobby** to play again with fresh teams.

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

Open **`/display`** on a TV or projector at the front of the room. It's a
big-screen spectator view showing:

* the live race board with the current leader crowned,
* a **standings** leaderboard (who's in the lead, progress %, and crashes),
* an **input-activity** meter (inputs/sec, a live sparkline, and total inputs).

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
| `wrangler.toml` | Cloudflare config: static assets from `public/`, the Durable Object binding, and the SQLite migration. |

The client protocol is deliberately thin: the phone sends every button press as
`{type:'move', dir}`, and the server decides whether that press matches the
player's secret direction. Board state broadcasts carry **no** ownership info,
so the hidden-controls mechanic can't be reverse-engineered from network traffic.
