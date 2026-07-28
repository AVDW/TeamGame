# 🏁 Sprite Race

A quick multiplayer party game for the office, built to run on **Cloudflare
Workers + Durable Objects**. Everyone opens the same link on their phone, gets
shuffled into secret teams, and races a sprite from the bottom of the screen to
the top.

## The twist

* **Hidden sprite** — you're never told which sprite your team controls.
* **Split controls** — each teammate's taps only count for **one** direction,
  and you're not told which. Enforced on the server, so nothing the phone
  receives can leak it.
* **Moving traps** — red obstacles patrol left and right; grey ones sit still.
  Hit any of them and your sprite is sent back to the start with a time penalty.
* **Every press moves it** — any teammate's valid press nudges the sprite
  immediately, so a confused teammate pushing the wrong way is part of the fun.

Tap around, watch which sprite jumps, and coordinate with your team to figure
out who controls what. First team to the top wins. At the end, each player gets
a personal reveal: their sprite, their secret direction, and whether they won.

## How it plays

1. Everyone opens the link and enters a name.
2. Anyone taps **Start Race** and picks a team size (3 or 4).
3. Players are randomly split into teams; each team drives one sprite.
4. Race to the top before the 2-minute timer runs out. If time expires, the
   sprite that got furthest wins.
5. Tap **Back to lobby** to play again with fresh teams.

## Run locally

```bash
npm install
npm run dev
```

`wrangler dev` prints a local URL (usually `http://localhost:8787`). Open it in
a few browser tabs/phones on the same network to test. Arrow keys work on
desktop; the on-screen d-pad works on touch.

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
| `public/index.html` | The whole client — lobby, canvas board, d-pad, and the end-of-round reveal. |
| `wrangler.toml` | Cloudflare config: static assets from `public/`, the Durable Object binding, and the SQLite migration. |

The client protocol is deliberately thin: the phone sends every button press as
`{type:'move', dir}`, and the server decides whether that press matches the
player's secret direction. Board state broadcasts carry **no** ownership info,
so the hidden-controls mechanic can't be reverse-engineered from network traffic.
