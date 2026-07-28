// Sprite Race — Cloudflare Worker + Durable Object
//
// A quick multiplayer party game for the office. Phones connect, get shuffled
// into teams of 3-4, and each team SECRETLY controls one sprite racing from the
// bottom of the screen to the top.
//
// The twists:
//  * Hidden sprite  — a player is never told which sprite their team controls.
//  * Split controls — each player's input only counts for ONE direction, and we
//                     never tell them which. Enforced on the server so the
//                     client protocol can't leak it.
//  * Moving traps   — some obstacles patrol back and forth.
//
// Players must experiment ("which button does something? which sprite jumped?")
// and coordinate with teammates to win.

// ---- Tunables -------------------------------------------------------------
const GAME_WIDTH = 400;
const GAME_HEIGHT = 600;
const SPRITE_SIZE = 24;
const STEP = 20; // px moved per honoured press
const TICK_MS = 100; // server tick
const GAME_SECONDS = 120;
const COLLISION_PENALTY = 3; // seconds lost when a sprite hits a trap
const START_MARGIN = 12;
const START_Y = GAME_HEIGHT - SPRITE_SIZE - START_MARGIN;

const COLORS = ['#22c55e', '#3b82f6', '#ef4444', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#eab308'];
const NAMES = ['Green', 'Blue', 'Red', 'Orange', 'Purple', 'Pink', 'Teal', 'Yellow'];

// ---- helpers --------------------------------------------------------------
function rand(min, max) {
  return min + Math.random() * (max - min);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- Worker entry ---------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const id = env.GAME.idFromName('main'); // one shared room for the office
      return env.GAME.get(id).fetch(request);
    }
    // Everything else is a static asset (index.html etc.). Assets are normally
    // served before the Worker runs; this is just a safety fallback.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

// ---- Durable Object: one game room ---------------------------------------
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.players = new Map(); // ws -> { ws, id, name, team, dir }
    this.sprites = [];
    this.obstacles = [];
    this.gameStarted = false;
    this.timer = GAME_SECONDS;
    this.nextId = 1;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.onConnect(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  onConnect(ws) {
    const player = { ws, id: this.nextId++, name: null, team: null, dir: null };
    this.players.set(ws, player);
    ws.addEventListener('message', (evt) => this.onMessage(player, evt.data));
    ws.addEventListener('close', () => this.onClose(player));
    ws.addEventListener('error', () => this.onClose(player));

    if (this.gameStarted) {
      // Late joiner watches this round, joins the next one.
      this.send(ws, { type: 'inprogress' });
    } else {
      this.broadcastLobby();
    }
  }

  onClose(player) {
    this.players.delete(player.ws);
    if (this.players.size === 0) {
      // Everyone left — fully reset so the room doesn't wedge in a started
      // state and refuse the next group of players.
      this.gameStarted = false;
      this.sprites = [];
      this.obstacles = [];
      this.stopTick();
    } else if (!this.gameStarted) {
      this.broadcastLobby();
    }
  }

  onMessage(player, raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === 'setname') {
      player.name = String(data.name || '').slice(0, 16).trim() || null;
      if (!this.gameStarted) this.broadcastLobby();
      return;
    }

    if (data.type === 'start') {
      if (!this.gameStarted) this.startGame(data.teamSize);
      return;
    }

    if (data.type === 'reset') {
      this.endToLobby();
      return;
    }

    if (data.type === 'move') {
      if (!this.gameStarted || player.team === null) return;
      // The heart of "split controls": only the player's secret direction
      // counts. Every other press is silently dropped, so nothing in the
      // protocol reveals which direction (or sprite) a player controls.
      if (data.dir !== player.dir) return;
      this.moveSprite(player.team, data.dir);
      return;
    }
  }

  // ---- game lifecycle -----------------------------------------------------
  startGame(requestedSize) {
    const size = requestedSize === 3 || requestedSize === 4 ? requestedSize : 4;
    const list = shuffle([...this.players.values()]);
    if (list.length < 1) return;

    // Chunk shuffled players into teams; each team drives one sprite.
    const teams = [];
    for (let i = 0; i < list.length; i += size) teams.push(list.slice(i, i + size));

    this.sprites = [];
    teams.forEach((members, t) => {
      const sprite = {
        team: t,
        color: COLORS[t % COLORS.length],
        name: NAMES[t % NAMES.length],
        finished: false,
        bump: 0,
      };
      this.placeSpriteAtStart(sprite, t, teams.length);
      this.sprites.push(sprite);

      // Assign one live direction per player. "up" is always covered so the
      // race is winnable; the rest are spread over left/right/down. Because
      // members are shuffled, who-controls-what is random and hidden.
      const roster = shuffle([...members]);
      const rest = shuffle(['left', 'right', 'down']);
      roster.forEach((m, idx) => {
        m.team = t;
        m.dir = idx === 0 ? 'up' : rest[(idx - 1) % rest.length];
      });
    });

    this.buildObstacles();
    this.timer = GAME_SECONDS;
    this.gameStarted = true;

    // Tell each player which direction(s) they control so the client can show
    // only the buttons that work — but still NOT which sprite is theirs.
    for (const p of this.players.values()) {
      this.send(p.ws, { type: 'start', dirs: p.dir ? [p.dir] : [] });
    }
    this.scheduleTick();
    this.broadcastState();
  }

  endGame(winner) {
    this.gameStarted = false;
    this.stopTick();

    const standings = this.sprites
      .map((s) => ({
        team: s.team,
        name: s.name,
        color: s.color,
        progress: this.progress(s),
        bump: s.bump,
        finished: s.finished,
      }))
      .sort((a, b) => Number(b.finished) - Number(a.finished) || b.progress - a.progress);

    for (const p of this.players.values()) {
      const mySprite = p.team !== null ? this.sprites[p.team] : null;
      this.send(p.ws, {
        type: 'end',
        winner,
        winnerName: winner !== null && this.sprites[winner] ? this.sprites[winner].name : null,
        standings,
        // Personal reveal — the payoff for the deduction.
        yourTeam: p.team,
        yourColor: mySprite ? mySprite.color : null,
        yourSpriteName: mySprite ? mySprite.name : null,
        yourDir: p.dir,
        youWon: p.team !== null && p.team === winner,
      });
    }
  }

  endToLobby() {
    this.gameStarted = false;
    this.stopTick();
    this.sprites = [];
    this.obstacles = [];
    for (const p of this.players.values()) {
      p.team = null;
      p.dir = null;
    }
    this.broadcastLobby();
  }

  // ---- board setup --------------------------------------------------------
  placeSpriteAtStart(sprite, index, count) {
    sprite.x = (GAME_WIDTH / (count + 1)) * (index + 1) - SPRITE_SIZE / 2;
    sprite.y = START_Y;
    sprite.startX = sprite.x;
  }

  resetSprite(sprite) {
    sprite.x = sprite.startX;
    sprite.y = START_Y;
  }

  buildObstacles() {
    this.obstacles = [];
    // Static blocks in a few rows to weave through.
    for (let row = 0; row < 4; row++) {
      const y = 90 + row * 100 + rand(-15, 15);
      const count = 1 + Math.floor(rand(0, 2)); // 1-2 per row
      for (let c = 0; c < count; c++) {
        const w = 40 + rand(0, 40);
        this.obstacles.push({ x: rand(0, GAME_WIDTH - w), y, w, h: 24, moving: false });
      }
    }
    // Patrolling traps that slide left/right.
    for (let i = 0; i < 3; i++) {
      const w = 36;
      this.obstacles.push({
        x: rand(0, GAME_WIDTH - w),
        y: 120 + i * 130 + rand(-20, 20),
        w,
        h: 24,
        moving: true,
        vx: (rand(0, 1) < 0.5 ? -1 : 1) * (2 + rand(0, 3)), // px per tick
      });
    }
  }

  // ---- movement & collision ----------------------------------------------
  moveSprite(team, dir) {
    const s = this.sprites[team];
    if (!s || s.finished) return;
    if (dir === 'up') s.y -= STEP;
    else if (dir === 'down') s.y += STEP;
    else if (dir === 'left') s.x -= STEP;
    else if (dir === 'right') s.x += STEP;
    s.x = Math.max(0, Math.min(GAME_WIDTH - SPRITE_SIZE, s.x));
    s.y = Math.max(0, Math.min(GAME_HEIGHT - SPRITE_SIZE, s.y));
    if (this.hitsObstacle(s)) {
      this.bump(s);
    } else if (s.y <= 0) {
      // Reached the top — win immediately rather than waiting for the tick.
      s.finished = true;
      this.endGame(s.team);
    }
  }

  bump(sprite) {
    this.resetSprite(sprite);
    this.timer = Math.max(0, this.timer - COLLISION_PENALTY);
    sprite.bump++;
  }

  hitsObstacle(s) {
    for (const o of this.obstacles) {
      if (s.x < o.x + o.w && s.x + SPRITE_SIZE > o.x && s.y < o.y + o.h && s.y + SPRITE_SIZE > o.y) {
        return true;
      }
    }
    return false;
  }

  progress(s) {
    return Math.max(0, Math.min(1, (START_Y - s.y) / START_Y));
  }

  leaderTeam() {
    let best = null;
    let bestP = -1;
    for (const s of this.sprites) {
      const p = this.progress(s);
      if (p > bestP) {
        bestP = p;
        best = s.team;
      }
    }
    return best;
  }

  // ---- tick loop ----------------------------------------------------------
  // Workers don't allow setInterval as a durable game loop, so we drive the
  // tick with Durable Object alarms: each alarm runs one tick and schedules
  // the next one.
  scheduleTick() {
    this.state.storage.setAlarm(Date.now() + TICK_MS).catch(() => {});
  }

  stopTick() {
    this.state.storage.deleteAlarm().catch(() => {});
  }

  async alarm() {
    if (!this.gameStarted) return;
    this.gameTick();
    if (this.gameStarted) await this.state.storage.setAlarm(Date.now() + TICK_MS);
  }

  gameTick() {
    if (!this.gameStarted) return;
    this.timer -= TICK_MS / 1000;

    // Move patrolling traps, bouncing off the walls.
    for (const o of this.obstacles) {
      if (!o.moving) continue;
      o.x += o.vx;
      if (o.x <= 0) {
        o.x = 0;
        o.vx *= -1;
      } else if (o.x + o.w >= GAME_WIDTH) {
        o.x = GAME_WIDTH - o.w;
        o.vx *= -1;
      }
    }

    // A moving trap can run into a sprite; and check for a winner.
    for (const s of this.sprites) {
      if (s.finished) continue;
      if (this.hitsObstacle(s)) this.bump(s);
      if (s.y <= 0) {
        s.finished = true;
        this.endGame(s.team);
        return;
      }
    }

    if (this.timer <= 0) {
      this.endGame(this.leaderTeam());
      return;
    }

    this.broadcastState();
  }

  // ---- outbound messages --------------------------------------------------
  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket closing */
    }
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const p of this.players.values()) {
      try {
        p.ws.send(msg);
      } catch {
        /* socket closing */
      }
    }
  }

  broadcastLobby() {
    this.broadcast({
      type: 'lobby',
      count: this.players.size,
      names: [...this.players.values()].map((p) => p.name || 'Player'),
    });
  }

  broadcastState() {
    // Public board only — no ownership info of any kind.
    this.broadcast({
      type: 'state',
      timer: Math.max(0, Math.round(this.timer)),
      sprites: this.sprites.map((s) => ({
        team: s.team,
        x: Math.round(s.x),
        y: Math.round(s.y),
        color: s.color,
        name: s.name,
        finished: s.finished,
        progress: this.progress(s),
      })),
      obstacles: this.obstacles.map((o) => ({
        x: Math.round(o.x),
        y: Math.round(o.y),
        w: o.w,
        h: o.h,
        moving: o.moving,
      })),
    });
  }
}
