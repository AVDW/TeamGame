/* Shared race-board renderer (Space Race theme).
   Used by both the phone client (index.html) and the dashboard (display.html)
   so the board looks identical everywhere. Draws only what the server
   broadcasts — sprites, obstacles, progress — never ownership info.

   The server only broadcasts state ~10×/sec, so drawing straight from those
   packets looks choppy. Instead we buffer the two most recent snapshots and
   run our own requestAnimationFrame loop that INTERPOLATES between them, giving
   smooth ~60fps motion (rendering ~one tick / 100ms in the past) with no extra
   network traffic.

   Usage:
     const board = Board.attach(document.getElementById('canvas'), { showLead: true });
     board.update(stateMsg); // feed each server 'state' message
     board.start();          // begin the render loop (idempotent)
     board.stop();           // stop and clear (e.g. back to lobby)
*/
const Board = (() => {
  const GAME_W = 400, GAME_H = 600;
  const SPRITE_SIZE = 24;
  const FINISH_H = 28;
  const TRAIL_LEN = 8;
  const TRAIL_MS = 45; // record a trail point at most this often (time-based, not per-frame)

  function makeStars() {
    const stars = [];
    for (let i = 0; i < 90; i++) {
      stars.push({
        x: Math.random() * GAME_W,
        y: Math.random() * GAME_H,
        r: Math.random() < 0.85 ? 1 : 1.6,
        base: 0.25 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
        speed: 0.4 + Math.random() * 1.2,
      });
    }
    return stars;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function attach(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    const stars = makeStars();
    const trails = new Map();  // team -> [{x, y}]
    const trailT = new Map();  // team -> last-recorded timestamp

    // Snapshot buffer for interpolation.
    let prev = null, next = null, prevT = 0, nextT = 0;
    let raf = null;

    // Feed a fresh server state; keep the previous one to interpolate from.
    function update(state) {
      const now = performance.now();
      if (!next) { prev = state; next = state; prevT = now; nextT = now; }
      else { prev = next; next = state; prevT = nextT; nextT = now; }
    }

    // Interpolated view of the world, rendered ~one tick behind real time so
    // there's always a "next" snapshot to head toward.
    function interpolated() {
      if (!next) return null;
      const span = nextT - prevT;
      let a = span > 0 ? (performance.now() - nextT) / span : 1;
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      if (!prev || span === 0) return next;

      const prevByTeam = new Map(prev.sprites.map((s) => [s.team, s]));
      const sprites = next.sprites.map((s) => {
        const p = prevByTeam.get(s.team) || s;
        return { ...s, x: p.x + (s.x - p.x) * a, y: p.y + (s.y - p.y) * a };
      });
      const obstacles = next.obstacles.map((o, i) => {
        const p = prev.obstacles[i] || o;
        return { ...o, x: p.x + (o.x - p.x) * a, y: p.y + (o.y - p.y) * a };
      });
      return { sprites, obstacles };
    }

    function frame() {
      const world = interpolated();
      if (world) {
        let leadTeam = null;
        if (opts.showLead) {
          let best = -1;
          for (const s of world.sprites) if (s.progress > best) { best = s.progress; leadTeam = s.team; }
        }
        draw({ sprites: world.sprites, obstacles: world.obstacles, leadTeam });
      }
      raf = requestAnimationFrame(frame);
    }

    function start() { if (!raf) raf = requestAnimationFrame(frame); }
    function stop() {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      prev = next = null;
      trails.clear(); trailT.clear();
    }

    function draw(state) {
      const { sprites = [], obstacles = [], leadTeam = null } = state;
      const now = performance.now();

      // deep-space backdrop
      const bg = ctx.createLinearGradient(0, 0, 0, GAME_H);
      bg.addColorStop(0, '#0e1436');
      bg.addColorStop(1, '#070b1e');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, GAME_W, GAME_H);

      // twinkling starfield (now animates every frame, not every server tick)
      for (const st of stars) {
        const a = st.base + 0.25 * Math.sin(st.phase + now / 1000 * st.speed);
        ctx.fillStyle = `rgba(233,237,255,${Math.max(0.05, a)})`;
        ctx.fillRect(st.x, st.y, st.r, st.r);
      }

      // goal gate — glowing band across the top
      const gate = ctx.createLinearGradient(0, 0, 0, FINISH_H + 14);
      gate.addColorStop(0, 'rgba(76,201,240,0.30)');
      gate.addColorStop(1, 'rgba(76,201,240,0)');
      ctx.fillStyle = gate;
      ctx.fillRect(0, 0, GAME_W, FINISH_H + 14);
      ctx.save();
      ctx.strokeStyle = 'rgba(76,201,240,0.8)';
      ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(0, FINISH_H); ctx.lineTo(GAME_W, FINISH_H); ctx.stroke();
      ctx.restore();

      // obstacles — moving ones are striped red hazards, static ones grey rocks
      for (const o of obstacles) {
        if (o.moving) {
          ctx.save();
          ctx.fillStyle = '#3d1220';
          roundRect(ctx, o.x, o.y, o.w, o.h, 5); ctx.fill();
          ctx.clip();
          ctx.strokeStyle = 'rgba(251,113,133,0.9)';
          ctx.lineWidth = 4;
          for (let sx = -o.h; sx < o.w + o.h; sx += 10) {
            ctx.beginPath();
            ctx.moveTo(o.x + sx, o.y + o.h);
            ctx.lineTo(o.x + sx + o.h, o.y);
            ctx.stroke();
          }
          ctx.restore();
        } else {
          ctx.fillStyle = '#3b4665';
          roundRect(ctx, o.x, o.y, o.w, o.h, 5); ctx.fill();
          ctx.fillStyle = 'rgba(233,237,255,0.08)';
          roundRect(ctx, o.x, o.y, o.w, 3, 2); ctx.fill();
        }
      }

      // thruster trails (fading echoes of recent positions, sampled by time)
      for (const s of sprites) {
        let trail = trails.get(s.team);
        if (!trail) { trail = []; trails.set(s.team, trail); }
        if (now - (trailT.get(s.team) || 0) > TRAIL_MS) {
          trail.push({ x: s.x, y: s.y });
          if (trail.length > TRAIL_LEN) trail.shift();
          trailT.set(s.team, now);
        }
        for (let i = 0; i < trail.length - 1; i++) {
          const t = trail[i];
          const a = ((i + 1) / trail.length) * 0.28;
          ctx.fillStyle = hexAlpha(s.color, a);
          const sz = SPRITE_SIZE * (0.4 + 0.5 * (i / trail.length));
          const off = (SPRITE_SIZE - sz) / 2;
          roundRect(ctx, t.x + off, t.y + off, sz, sz, 5); ctx.fill();
        }
      }

      // sprites
      for (const s of sprites) {
        // the server's grace flag marks a sprite recovering from a hit — flash it
        const flashing = !!s.grace;

        ctx.fillStyle = flashing ? '#fca5a5' : s.color;
        roundRect(ctx, s.x, s.y, SPRITE_SIZE, SPRITE_SIZE, 6); ctx.fill();

        // eyes for a bit of character
        ctx.fillStyle = '#fff';
        ctx.fillRect(s.x + 5, s.y + 7, 4, 4);
        ctx.fillRect(s.x + SPRITE_SIZE - 9, s.y + 7, 4, 4);

        if (opts.showLead && s.team === leadTeam && !s.finished) {
          ctx.font = '16px sans-serif';
          ctx.fillText('👑', s.x + 3, s.y - 4);
        }
        if (s.finished) {
          ctx.font = 'bold 14px sans-serif';
          ctx.fillText('🏁', s.x + 3, s.y + 18);
        }
      }
    }

    return { draw, update, start, stop };
  }

  function hexAlpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  return { attach, GAME_W, GAME_H };
})();
