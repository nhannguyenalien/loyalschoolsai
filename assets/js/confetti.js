/** Pháo giấy nhẹ cho lúc khách trúng thưởng. */
function launchConfetti(duration = 2800) {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const resize = () => { canvas.width = innerWidth; canvas.height = innerHeight; };
  resize();
  const colors = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6'];
  const pieces = Array.from({ length: 150 }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 160, y: innerHeight * .45,
    vx: (Math.random() - .5) * 15, vy: -Math.random() * 15 - 4, size: 6 + Math.random() * 7,
    color: colors[Math.floor(Math.random() * colors.length)], rot: Math.random() * 6, vr: (Math.random() - .5) * .35,
  }));
  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.vy += .32; p.vx *= .992; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - duration * .6) / (duration * .4));
      ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); ctx.restore();
    }
    if (t < duration) requestAnimationFrame(frame); else canvas.remove();
  })(start);
}
