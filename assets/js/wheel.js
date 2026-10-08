/** Vòng quay SVG: mỗi giải một múi, nhãn nằm theo bán kính. */
const WHEEL_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6'];

function wheelSvg(prizes) {
  const n = prizes.length, c = 200, r = 192;
  const point = (deg, radius) => { const a = (deg - 90) * Math.PI / 180; return [c + radius * Math.cos(a), c + radius * Math.sin(a)]; };
  if (!n) return `<svg viewBox="0 0 400 400"><circle cx="200" cy="200" r="${r}" fill="#cbd5e1"/><text x="200" y="206" text-anchor="middle" fill="#fff" font-weight="700">Chưa có giải</text></svg>`;
  const size = 360 / n;
  const slices = prizes.map((p, i) => {
    const fill = WHEEL_COLORS[i % WHEEL_COLORS.length];
    const mid = (i + .5) * size;
    const label = esc(String(p.name).length > 16 ? String(p.name).slice(0, 15) + '…' : p.name);
    const font = n > 8 ? 11 : 13;
    const shape = n === 1 ? `<circle cx="${c}" cy="${c}" r="${r}" fill="${fill}"/>`
      : (([x1, y1], [x2, y2]) => `<path d="M${c} ${c} L${x1} ${y1} A${r} ${r} 0 ${size > 180 ? 1 : 0} 1 ${x2} ${y2} Z" fill="${fill}" stroke="#fff" stroke-width="2"/>`)(point(i * size, r), point((i + 1) * size, r));
    return `${shape}<text transform="rotate(${mid} ${c} ${c})" x="${c}" y="${c - 118}" text-anchor="middle" dominant-baseline="middle" fill="#fff" font-size="${font}" font-weight="700" style="paint-order:stroke;stroke:rgba(0,0,0,.25);stroke-width:2px">${label}</text>`;
  }).join('');
  return `<svg viewBox="0 0 400 400" id="wheel-svg">${slices}</svg>`;
}

function mountWheel(container, prizes) {
  container.innerHTML = `<div class="wheel-stage"><div class="rim"></div><div class="wheel-pointer"></div>${wheelSvg(prizes)}<div class="wheel-hub">QUAY</div></div>`;
}

// Quay tới giải `index`; trả về Promise khi vòng quay dừng.
function spinWheelTo(container, prizes, index, ms = 5200) {
  const svg = container.querySelector('svg');
  const size = 360 / Math.max(prizes.length, 1);
  const jitter = (Math.random() - .5) * size * .6; // dừng lệch tâm múi cho tự nhiên, vẫn nằm trong múi
  const target = 360 * 7 - ((Math.max(index, 0) + .5) * size + jitter);
  svg.style.transition = 'none'; svg.style.transform = 'rotate(0deg)'; svg.getBoundingClientRect();
  svg.style.transition = ''; svg.style.transform = `rotate(${target}deg)`;
  return new Promise(resolve => setTimeout(resolve, ms));
}
