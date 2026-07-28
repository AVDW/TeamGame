# Sprite Race — Style Guide ("Space Race" theme)

The game is themed as a **space race**: deep-space surfaces, starlight
cyan/violet accents, glowing team sprites racing up to a goal gate. Every
screen — the phone client (`public/index.html`) and the big-screen dashboard
(`public/display.html`) — shares one look, defined in two files:

| File | What it owns |
| --- | --- |
| `public/theme.css` | Design tokens (CSS custom properties) + reusable component classes. Loaded by every page. |
| `public/board.js` | The shared canvas renderer for the race board (starfield, goal gate, hazards, sprites, trails). |
| `public/confetti.js` | The shared winner-confetti effect, themed to the palette. |

**The golden rule: never hard-code a colour, radius, or font in a page.**
Use a token from `theme.css`. If a value you need doesn't exist as a token,
add it to `theme.css` first, then use it — that keeps every future screen on
theme automatically.

## Design tokens

All tokens live on `:root` in `public/theme.css`.

### Surfaces
| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#060a1a` | Page background (behind the radial glows) |
| `--surface` | `#101832` | Cards, panels, tiles |
| `--surface-2` | `#172144` | Nested/raised surfaces, progress-bar tracks |
| `--line` | `#263259` | Borders and dividers |

### Ink (text)
| Token | Value | Use |
| --- | --- | --- |
| `--ink` | `#e9edff` | Primary text |
| `--ink-2` | `#a9b4d8` | Secondary text, body copy |
| `--ink-3` | `#66739c` | Muted labels, captions, panel headings |

### Accents & signals
| Token | Value | Use |
| --- | --- | --- |
| `--accent` | `#4cc9f0` (cyan) | Interactive elements, focus, "go" energy, big numbers |
| `--accent-2` | `#a78bfa` (violet) | Pressed states, secondary flair, gradient partner |
| `--good` | `#34d399` | Wins, success |
| `--warn` | `#fbbf24` | Leader highlights, caution |
| `--bad` | `#fb7185` | Hazards, crashes, low-time urgency |

### Effects, shape, type
- Glows: `--glow-accent`, `--glow-good`, `--glow-bad` (soft box-shadows).
- Radii: `--radius-sm` (8px), `--radius` (14px), `--radius-lg` (18px).
- Fonts: `--font` (system stack), `--font-mono` (URLs, code-ish text).
  No webfonts — the game must load instantly on office wifi.

## Component classes

Use these instead of restyling from scratch:

- `.card` — phone-width content block. `.panel` — dashboard block. Both get a
  `--surface` background, `--line` border, themed heading style for `h3`/`h2`.
- `.btn-primary` — the one main action on a screen (cyan gradient + glow).
  `.btn-ghost` — secondary/back actions.
- `input.field` — text inputs (cyan glow on focus).
- `.chip` — player-name pills. `.swatch` — team colour square (set both
  `background` **and** `color` to the team colour so its glow matches).
- `.bar` > `span` — progress bars (set the span's `width` and `background`).
- `.timer` — tabular-nums timer; add `.low` when ≤15s remain for the red pulse.
- `.title-glow` — cyan→violet gradient text for the game name and big banners.
- `.muted` / `.tag` — small captions.

## Team colours

Team colours come **from the server** (`COLORS` in `src/index.js`), never from
CSS — clients must render whatever colour the state broadcast carries. The
palette is bright "400-weight" tones chosen to glow on the dark board:
green `#4ade80`, blue `#60a5fa`, red `#f87171`, orange `#fb923c`, purple
`#c084fc`, pink `#f472b6`, teal `#2dd4bf`, yellow `#facc15`.

Moving hazards are **striped** rose-red so they can never be mistaken for the
red team's sprite; keep any new hazard type visually patterned, not flat.

## The board (canvas)

All board drawing goes through `Board.attach(canvas, opts).draw(state)` in
`public/board.js` — do not hand-roll canvas drawing in a page. The renderer
owns the theme's board conventions:

- Deep-space gradient background with a twinkling starfield.
- The finish line is a **glowing cyan goal gate** at the top.
- Moving obstacles: dark rounded rects with rose warning stripes + red glow.
  Static obstacles: grey rocks with a subtle top highlight.
- Sprites: rounded squares in their team colour with a matching glow, white
  eyes, a fading **thruster trail** of recent positions, a red flash when
  bumped back to the start, 🏁 when finished, 👑 on the leader
  (dashboard only, `opts.showLead`).

The renderer is presentation-only: it must draw solely from the broadcast
state (`sprites`, `obstacles`, `leadTeam`) and must never receive or infer
player→sprite ownership — that would break the hidden-controls mechanic.
Sprites carry a server-set `grace` flag while recovering from a hit; the
renderer flashes them from that flag, never from client-side guessing.

## Celebrations

Winner confetti comes from `Confetti.attach(canvas, { count, duration })` in
`public/confetti.js` — one implementation for the phone and the dashboard.
Pass the winner's team colour(s) to `launch()`; the theme's celebration
colours (`--warn` amber, `--accent` cyan, `--accent-2` violet, white) are
mixed in automatically. Call `stop()` when leaving the end state (it's a
cheap no-op while idle). The confetti canvas is a fixed, full-screen,
`pointer-events: none` overlay — keep board-canvas CSS scoped to `#canvas`
so it never bleeds onto effect overlays.

## Voice & tone

Playful space-crew flavour, lightly applied: players are "pilots", the start
button says **Launch Race**, obstacles are "hazards". Keep copy short and
energetic; emoji are welcome as icons (🚀 🏁 🏆 👑) but not mid-sentence
confetti.

## Adding a new screen or feature — checklist

1. `<link rel="stylesheet" href="/theme.css" />` in the page head, and
   `<meta name="theme-color" content="#060a1a" />`.
2. Build with existing component classes; page-local CSS is for **layout
   only** (grids, sizing, positioning).
3. Any colour/radius/shadow you write must be a `var(--…)` token.
4. Board drawing → `board.js`. New board visuals get added to the shared
   renderer so the phone and dashboard stay identical.
5. Interactive elements give feedback: press/scale on tap, glow on focus,
   `.low`-style urgency states where time matters.
