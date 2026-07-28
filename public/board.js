/* Shared race-board renderer (Space Race theme).
   Used by both the phone client (index.html) and the dashboard (display.html)
   so the board looks identical everywhere. Draws only what the server
   broadcasts — sprites, obstacles, progress — never ownership info.

   Usage:
     const board = Board.attach(document.getElementById('canvas'), { showLead: true });
     board.draw({ sprites, obstacles, leadTeam });
*/
const Board = (() => {
  const GAME_W = 400, GAME_H = 600;
  const SPRITE_SIZE = 24;
  const FINISH_H = 28;
  const TRAIL_LEN = 7;

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
    const trails = new Map(); // team -> [{x, y}]

    function draw(state) {
      const { sprites = [], obstacles = [], leadTeam = null } = state;
      const now = performance.now();

      // deep-space backdrop
      const bg = ctx.createLinearGradient(0, 0, 0, GAME_H);
      bg.addColorStop(0, '#0e1436');
      bg.addColorStop(1, '#070b1e');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, GAME_W, GAME_H);

      // twinkling starfield
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
      ctx.shadowColor = '#4cc9f0';
      ctx.shadowBlur = 8;
      ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(0, FINISH_H); ctx.lineTo(GAME_W, FINISH_H); ctx.stroke();
      ctx.restore();

      // obstacles — moving ones are striped red hazards, static ones grey rocks
      for (const o of obstacles) {
        if (o.moving) {
          ctx.save();
          ctx.shadowColor = '#fb7185';
          ctx.shadowBlur = 10;
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

      // thruster trails (fading echoes of recent positions)
      for (const s of sprites) {
        let trail = trails.get(s.team);
        if (!trail) { trail = []; trails.set(s.team, trail); }
        const last = trail[trail.length - 1];
        if (!last || last.x !== s.x || last.y !== s.y) {
          trail.push({ x: s.x, y: s.y });
          if (trail.length > TRAIL_LEN) trail.shift();
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

        ctx.save();
        ctx.shadowColor = flashing ? '#fb7185' : s.color;
        ctx.shadowBlur = 12;
        ctx.fillStyle = flashing ? '#fca5a5' : s.color;
        roundRect(ctx, s.x, s.y, SPRITE_SIZE, SPRITE_SIZE, 6); ctx.fill();
        ctx.restore();

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

    return { draw };
  }

  function hexAlpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  return { attach, GAME_W, GAME_H };
})();
