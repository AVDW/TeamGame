/* Shared winner-confetti effect (Space Race theme).
   Used by the phone client (index.html) and the dashboard (display.html) so
   celebrations look and behave the same everywhere.

   Usage:
     const confetti = Confetti.attach(document.getElementById('fx'), { count: 140 });
     confetti.launch(['#4ade80']);  // winner colour(s) first; theme colours pad the mix
     confetti.stop();               // cheap no-op when nothing is falling

   The canvas should be a fixed, full-screen, pointer-events:none overlay.
*/
const Confetti = (() => {
  const THEME_COLORS = ['#fbbf24', '#4cc9f0', '#a78bfa', '#ffffff'];

  function attach(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    const count = opts.count || 160;
    const duration = opts.duration || 6000;
    let parts = [], until = 0, raf = null, colors = THEME_COLORS;

    function size() { canvas.width = innerWidth; canvas.height = innerHeight; }
    function newPart() {
      return {
        x: Math.random() * canvas.width, y: -20 - Math.random() * 300,
        vx: (Math.random() - 0.5) * 3, vy: 4 + Math.random() * 5,
        s: 5 + Math.random() * 8,
        c: colors[Math.floor(Math.random() * colors.length)],
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      };
    }

    function launch(custom) {
      colors = custom && custom.length ? custom.concat(THEME_COLORS) : THEME_COLORS;
      size();
      parts = Array.from({ length: count }, newPart);
      until = performance.now() + duration;
      if (!raf) raf = requestAnimationFrame(tick);
    }

    function stop() {
      if (!raf && !parts.length) return;
      until = 0; parts = [];
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function tick(now) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.r += p.vr;
        if (p.y > canvas.height + 20 && now < until) { Object.assign(p, newPart()); p.y = -20; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore();
      }
      // keep animating until the timer runs out AND the last piece has fallen
      if (now < until || parts.some(p => p.y < canvas.height + 20)) raf = requestAnimationFrame(tick);
      else { raf = null; parts = []; ctx.clearRect(0, 0, canvas.width, canvas.height); }
    }

    addEventListener('resize', () => { if (raf) size(); });
    return { launch, stop };
  }

  return { attach };
})();
