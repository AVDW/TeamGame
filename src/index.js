// Sprite Race — Cloudflare Worker + Durable Object
//
// A quick multiplayer party game for the office. Phones connect, get shuffled
// into teams of 3-4, and each team SECRETLY controls one sprite racing from the
// bottom of the screen to the top.
//
// The twists:
//  * Hidden sprite   — a player is never told which sprite their team controls.
//  * Split controls  — a team always covers all four directions, split across
//                      its members. Small teams mean each player controls more
//                      directions; a full team of four is one direction each.
//                      Enforced server-side; state broadcasts never reveal which
//                      sprite a player drives, so they must find it themselves.
//  * Auto-balancing  — the server splits whoever's connected into 2-4 teams so
//                      it's always a race, whatever the headcount.
//  * Moving traps    — some obstacles patrol back and forth.
//
// Players must watch the board ("which sprite did my button move?") and
// coordinate with teammates to win.

// ---- Tunables -------------------------------------------------------------
const GAME_WIDTH = 400;
const GAME_HEIGHT = 600;
const SPRITE_SIZE = 24;
const STEP = 20; // px moved per honoured press
const TICK_MS = 100; // server tick
const GAME_SECONDS = 120; // default race length; overridable per game via config
const GRACE_TICKS = 6; // ticks of immunity after a hit (~600ms) — no chain-crashes
const MAX_TEAMS = 4; // cap on sprites so the board stays readable
const COUNTDOWN = 3; // seconds of "3·2·1" before a race actually begins
const MOVE_COOLDOWN_MS = 70; // min gap between a player's honoured moves (~14/s)
                             // so races are won by coordination, not tap speed

// Difficulty presets — chosen on the dashboard before a race. Control how many
// obstacles there are, how fast the traps move, and how punishing a hit is.
const DIFFICULTY = {
  easy:   { rows: 3, movers: 2, speed: 2, knockback: 60,  penalty: 1 },
  normal: { rows: 4, movers: 4, speed: 3, knockback: 80,  penalty: 2 },
  hard:   { rows: 5, movers: 6, speed: 4, knockback: 100, penalty: 3 },
};
const START_MARGIN = 12;
const START_Y = GAME_HEIGHT - SPRITE_SIZE - START_MARGIN;

// Team palette tuned for the dark space board — bright 400-weight tones that
// stay readable with a glow around them (see STYLE.md).
const COLORS = ['#4ade80', '#60a5fa', '#f87171', '#fb923c', '#c084fc', '#f472b6', '#2dd4bf', '#facc15'];
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
    // Clean URL for the front-of-room dashboard.
    if ((url.pathname === '/display' || url.pathname === '/display/') && env.ASSETS) {
      return env.ASSETS.fetch(new Request(new URL('/display.html', url), request));
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
    this.players = new Map(); // ws -> { ws, id, name, team, dirs }
    this.sprites = [];
    this.obstacles = [];
    this.gameStarted = false;
    this.counting = false; // true during the 3·2·1 countdown before a race
    this.countdownLeft = 0;
    this.timer = GAME_SECONDS;
    this.nextId = 1;
    this.inputCount = 0; // total presses this race (aggregate — no ownership)
    this.config = { seconds: GAME_SECONDS, difficulty: 'normal', teams: 'auto', reveal: false };
    this.diff = DIFFICULTY.normal;
  }

  // The room is "in the lobby" only when neither counting down nor racing.
  inLobby() {
    return !this.gameStarted && !this.counting;
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
    const player = { ws, id: this.nextId++, name: null, team: null, dirs: [], spectator: false, lastMove: 0 };
    this.players.set(ws, player);
    ws.addEventListener('message', (evt) => this.onMessage(player, evt.data));
    ws.addEventListener('close', () => this.onClose(player));
    ws.addEventListener('error', () => this.onClose(player));

    if (!this.inLobby()) {
      // Late joiner (during countdown or a race) watches, joins the next one.
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
      this.counting = false;
      this.sprites = [];
      this.obstacles = [];
      this.stopTick();
    } else if (this.inLobby()) {
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

    if (data.type === 'spectate') {
      // The front-of-room dashboard: watches everything, never joins a team,
      // and isn't counted as a player.
      player.spectator = true;
      if (this.inLobby()) this.broadcastLobby();
      else this.sendState(player.ws); // mid-countdown/race: show the board, not the lobby
      return;
    }

    if (data.type === 'setname') {
      player.name = String(data.name || '').slice(0, 16).trim() || null;
      if (this.inLobby()) this.broadcastLobby();
      return;
    }

    if (data.type === 'start') {
      // Only the dashboard (a spectator) can start a race, and only from the
      // lobby. Players cannot start the game.
      if (player.spectator && this.inLobby()) this.startGame(data.config);
      return;
    }

    if (data.type === 'reset') {
      // Only the dashboard controls returning the room to the lobby.
      if (player.spectator) this.endToLobby();
      return;
    }

    if (data.type === 'move') {
      if (!this.gameStarted || player.team === null) return;
      this.inputCount++; // aggregate activity counter for the dashboard
      // Only directions this player was assigned count. Enforced here so the
      // protocol never reveals which sprite a player drives — they see their
      // buttons, but have to watch the board to learn which sprite is theirs.
      if (!player.dirs.includes(data.dir)) return;
      // Rate-limit each player's honoured moves so a fast tapper (or a script)
      // can't out-move everyone else — coordination should win, not tap speed.
      const now = Date.now();
      if (now - player.lastMove < MOVE_COOLDOWN_MS) return;
      player.lastMove = now;
      this.moveSprite(player.team, data.dir);
      return;
    }
  }

  // ---- game lifecycle -----------------------------------------------------
  // Auto-balance: aim for teams of ~3, but always at least 2 teams (so it's a
  // race) and at most MAX_TEAMS (so the board stays readable). With 1 player
  // there's only a solo practice run.
  teamCount(n) {
    if (n <= 1) return n;
    return Math.max(2, Math.min(MAX_TEAMS, Math.round(n / 3)));
  }

  // Split a team's four directions across its members so that EVERY direction
  // is covered and EVERY member gets at least one button. Fewer members => each
  // gets more directions; five+ members => some directions are shared.
  assignDirections(members) {
    const dirs = shuffle(['up', 'down', 'left', 'right']);
    const buckets = members.map(() => []);
    // Pass 1: hand out the four directions, cycling through members — this
    // guarantees all four are covered.
    dirs.forEach((d, k) => buckets[k % members.length].push(d));
    // Pass 2: any member still empty (only possible with 5+ members) shares an
    // existing direction, so nobody is left with nothing to press.
    buckets.forEach((b, i) => {
      if (b.length === 0) b.push(dirs[i % dirs.length]);
    });
    members.forEach((m, i) => (m.dirs = buckets[i]));
  }

  // Validate and store the dashboard's chosen settings for this race.
  applyConfig(config) {
    config = config || {};
    const seconds = Math.max(30, Math.min(300, Math.round(Number(config.seconds) || GAME_SECONDS)));
    const difficulty = DIFFICULTY[config.difficulty] ? config.difficulty : 'normal';
    const teamsNum = Number(config.teams);
    const teams = [2, 3, 4].includes(teamsNum) ? teamsNum : 'auto';
    // "Easy mode": when reveal is on, each player is told their own sprite on
    // start (turning off the hidden-sprite challenge).
    const reveal = config.reveal === true;
    this.config = { seconds, difficulty, teams, reveal };
    this.diff = DIFFICULTY[difficulty];
  }

  startGame(config) {
    // Spectators (the dashboard) never join a team.
    const list = shuffle([...this.players.values()].filter((p) => !p.spectator));
    if (list.length < 1) return;
    this.applyConfig(config);
    this.inputCount = 0;

    // Number of teams: honour a fixed choice, else auto-balance. Never more
    // teams than players.
    const count = this.config.teams === 'auto'
      ? this.teamCount(list.length)
      : Math.min(this.config.teams, list.length);
    const teams = Array.from({ length: count }, () => []);
    list.forEach((p, i) => teams[i % count].push(p));

    this.sprites = [];
    teams.forEach((members, t) => {
      const sprite = {
        team: t,
        color: COLORS[t % COLORS.length],
        name: NAMES[t % NAMES.length],
        finished: false,
        bump: 0,
        moves: 0,
        grace: 0,
      };
      this.placeSpriteAtStart(sprite, t, teams.length);
      this.sprites.push(sprite);

      members.forEach((m) => (m.team = t));
      this.assignDirections(members);
    });

    this.buildObstacles();
    this.timer = this.config.seconds;

    // Tell each player which button(s) they control. Only when "reveal" is on
    // do we also tell each player their own sprite (and only to that player —
    // never to the shared dashboard). Then run the 3·2·1 countdown.
    for (const p of this.players.values()) {
      const msg = { type: 'start', dirs: p.dirs };
      if (this.config.reveal && p.team !== null) {
        const sp = this.sprites[p.team];
        msg.you = { team: p.team, color: sp.color, name: sp.name };
      }
      this.send(p.ws, msg);
    }
    this.counting = true;
    this.gameStarted = false;
    this.countdownLeft = COUNTDOWN;
    this.broadcast({ type: 'countdown', n: COUNTDOWN });
    this.broadcastState(); // board renders with sprites at the start line
    this.state.storage.setAlarm(Date.now() + 1000).catch(() => {});
  }

  // Fires once per second during the pre-race countdown, then kicks off the
  // race when it reaches zero.
  tickCountdown() {
    this.countdownLeft -= 1;
    if (this.countdownLeft > 0) {
      this.broadcast({ type: 'countdown', n: this.countdownLeft });
      this.state.storage.setAlarm(Date.now() + 1000).catch(() => {});
    } else {
      this.counting = false;
      this.gameStarted = true;
      this.timer = this.config.seconds;
      this.broadcast({ type: 'countdown', n: 0 }); // GO!
      this.broadcastState();
      this.state.storage.setAlarm(Date.now() + TICK_MS).catch(() => {});
    }
  }

  endGame(winner) {
    this.gameStarted = false;
    this.counting = false;
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
        yourDirs: p.dirs,
        youWon: p.team !== null && p.team === winner,
      });
    }
  }

  endToLobby() {
    this.gameStarted = false;
    this.counting = false;
    this.stopTick();
    this.sprites = [];
    this.obstacles = [];
    for (const p of this.players.values()) {
      p.team = null;
      p.dirs = [];
    }
    this.broadcastLobby();
  }

  // ---- board setup --------------------------------------------------------
  placeSpriteAtStart(sprite, index, count) {
    sprite.x = (GAME_WIDTH / (count + 1)) * (index + 1) - SPRITE_SIZE / 2;
    sprite.y = START_Y;
    sprite.startX = sprite.x;
  }

  buildObstacles() {
    const { rows, movers, speed } = this.diff;
    this.obstacles = [];
    // Static blocks spread across the height of the course to weave through.
    const gap = (GAME_HEIGHT - 180) / rows;
    for (let row = 0; row < rows; row++) {
      const y = 90 + row * gap + rand(-15, 15);
      const count = 1 + Math.floor(rand(0, 2)); // 1-2 per row
      for (let c = 0; c < count; c++) {
        const w = 40 + rand(0, 40);
        this.obstacles.push({ x: rand(0, GAME_WIDTH - w), y, w, h: 24, moving: false });
      }
    }
    // Patrolling traps that slide left/right, spread up the course (including
    // one guarding the approach to the finish) at difficulty-scaled speeds.
    const mgap = (GAME_HEIGHT - 160) / movers;
    for (let i = 0; i < movers; i++) {
      const w = 36;
      this.obstacles.push({
        x: rand(0, GAME_WIDTH - w),
        y: 90 + i * mgap + rand(-18, 18),
        w,
        h: 24,
        moving: true,
        vx: (rand(0, 1) < 0.5 ? -1 : 1) * (speed + rand(0, speed)), // px per tick
      });
    }
  }

  // ---- movement & collision ----------------------------------------------
  moveSprite(team, dir) {
    const s = this.sprites[team];
    if (!s || s.finished) return;
    s.moves++;
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
    if (sprite.grace > 0) return; // still recovering from the last hit
    // Knock back down a chunk (never below the start) instead of a full reset,
    // and clear the obstacle so we don't immediately re-collide.
    sprite.y = Math.min(START_Y, sprite.y + this.diff.knockback);
    this.timer = Math.max(0, this.timer - this.diff.penalty);
    sprite.bump++;
    sprite.grace = GRACE_TICKS;
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
    if (this.counting) {
      this.tickCountdown();
      return;
    }
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
      if (s.grace > 0) s.grace--;
      else if (this.hitsObstacle(s)) this.bump(s);
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
    // Only real players count toward the lobby; spectators (the dashboard) are
    // excluded so they don't inflate the roster or take a team slot.
    const roster = [...this.players.values()].filter((p) => !p.spectator);
    this.broadcast({
      type: 'lobby',
      count: roster.length,
      names: roster.map((p) => p.name || 'Player'),
    });
  }

  // Build the public game state. Deliberately carries NO ownership info: no
  // player→sprite or player→direction mapping, and no per-direction breakdown —
  // only board-equivalent aggregates (progress, crashes, activity), so showing
  // it on a room-wide dashboard gives no player an advantage.
  stateMessage() {
    return {
      type: 'state',
      timer: Math.max(0, Math.round(this.timer)),
      inputs: this.inputCount,
      players: [...this.players.values()].filter((p) => !p.spectator).length,
      sprites: this.sprites.map((s) => ({
        team: s.team,
        x: Math.round(s.x),
        y: Math.round(s.y),
        color: s.color,
        name: s.name,
        finished: s.finished,
        progress: this.progress(s),
        moves: s.moves,
        bump: s.bump,
        grace: s.grace > 0, // just got knocked — clients flash it
      })),
      obstacles: this.obstacles.map((o) => ({
        x: Math.round(o.x),
        y: Math.round(o.y),
        w: o.w,
        h: o.h,
        moving: o.moving,
      })),
    };
  }

  broadcastState() {
    this.broadcast(this.stateMessage());
  }

  // Send a one-off snapshot to a single socket (e.g. a dashboard that connects
  // mid-race and needs to render immediately).
  sendState(ws) {
    if (this.gameStarted) this.send(ws, this.stateMessage());
  }
}
