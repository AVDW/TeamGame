// server.js
const WebSocket = require('ws');
const serverPort = process.env.PORT || 3001;
const server = new WebSocket.Server({ port: serverPort });

const NUM_PLAYERS = 2;
const NUM_TEAMS = 4;
const PLAYERS_PER_TEAM = 5;
const GAME_WIDTH = 400;
const GAME_HEIGHT = 600;
const FROG_SIZE = 20;
const OBSTACLE_SIZE = 40;
const TICK_RATE = 100; // ms

let players = [];
let frogs = [];
let obstacles = [];
let gameStarted = false;
let timer = 180; // seconds

function assignTeams() {
  // Shuffle and assign teams
  const teamAssignments = Array(NUM_PLAYERS).fill().map((_, i) => Math.floor(i / PLAYERS_PER_TEAM));
  for (let i = teamAssignments.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [teamAssignments[i], teamAssignments[j]] = [teamAssignments[j], teamAssignments[i]];
  }
  return teamAssignments;
}

function initGame() {
  frogs = [];
  obstacles = [];
  timer = 180;
  // Place frogs at bottom, spaced horizontally
  for (let t = 0; t < NUM_TEAMS; t++) {
    frogs.push({
      id: t,
      team: t,
      x: GAME_WIDTH / (NUM_TEAMS + 1) * (t + 1) - FROG_SIZE / 2,
      y: GAME_HEIGHT - FROG_SIZE - 10,
      alive: true,
    });
  }
  // Add some obstacles
  for (let i = 0; i < 10; i++) {
    obstacles.push({
      x: Math.random() * (GAME_WIDTH - OBSTACLE_SIZE),
      y: Math.random() * (GAME_HEIGHT - 200),
      type: 'block',
    });
  }
}

function broadcast(msg) {
  players.forEach(p => p.ws.send(JSON.stringify(msg)));
}

function sendState() {
  broadcast({
    type: 'state',
    frogs,
    obstacles,
    timer,
  });
}

function checkCollision(frog) {
  for (const obs of obstacles) {
    if (
      frog.x < obs.x + OBSTACLE_SIZE &&
      frog.x + FROG_SIZE > obs.x &&
      frog.y < obs.y + OBSTACLE_SIZE &&
      frog.y + FROG_SIZE > obs.y
    ) {
      return true;
    }
  }
  return false;
}

function gameTick() {
  if (!gameStarted) return;
  timer -= TICK_RATE / 1000;
  // Check win condition
  for (const frog of frogs) {
    if (frog.y <= 0) {
      gameStarted = false;
      broadcast({ type: 'end', winner: frog.team });
      return;
    }
  }
  // Check timer
  if (timer <= 0) {
    gameStarted = false;
    broadcast({ type: 'end', winner: null });
    return;
  }
  sendState();
}

setInterval(gameTick, TICK_RATE);

server.on('connection', (ws) => {
  if (players.length >= NUM_PLAYERS) {
    ws.send(JSON.stringify({ type: 'error', message: 'Lobby full' }));
    ws.close();
    return;
  }
  const id = players.length;
  players.push({ ws, id, team: null });

//   ws.send(JSON.stringify({ type: 'start', message: `Lobby waiting - players joined = ${players.length}` }));

  if (players.length === NUM_PLAYERS) {
    // Assign teams and start game
    const teamAssignments = assignTeams();
    players.forEach((p, i) => p.team = teamAssignments[i]);
    initGame();
    gameStarted = true;
    broadcast({ type: 'start', yourId: id });
    sendState();
  }

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    if (!gameStarted) return;
    if (data.type === 'move') {
      // Move frog for the team
      const frog = frogs[data.frogId];
      if (!frog || !frog.alive) return;
      // Only allow movement if player is in the frog's team
      // But for now, allow all players to move any frog
      const step = 20;
      if (data.dir === 'up') frog.y -= step;
      if (data.dir === 'down') frog.y += step;
      if (data.dir === 'left') frog.x -= step;
      if (data.dir === 'right') frog.x += step;
      // Clamp position
      frog.x = Math.max(0, Math.min(GAME_WIDTH - FROG_SIZE, frog.x));
      frog.y = Math.max(0, Math.min(GAME_HEIGHT - FROG_SIZE, frog.y));
      // Check collision
      if (checkCollision(frog)) {
        frog.x = GAME_WIDTH / (NUM_TEAMS + 1) * (frog.team + 1) - FROG_SIZE / 2;
        frog.y = GAME_HEIGHT - FROG_SIZE - 10;
        timer -= 5; // penalty
      }
    }
  });

  ws.on('close', () => {
    players = players.filter(p => p.ws !== ws);
  });
});

console.log(`Server running on port ${serverPort}`);
