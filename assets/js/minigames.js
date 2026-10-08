/**
 * Mini-game dùng chung lượt quay. Kết quả luôn do MÁY CHỦ quyết định; mỗi game chỉ là cách trình bày:
 *   - wheel : vòng quay            - cards : chọn 1 trong nhiều thẻ bí mật
 *   - dice  : tung xúc xắc         - slot  : quay 3 biểu tượng
 * Giao diện chung: createGame(kind, container, prizes) → { hint, start(), reveal(index, result), cancel() }
 *   start()  : chờ khách bấm/chọn (vòng quay thì tự chạy ngay). Gọi API sau khi start() xong.
 *   reveal() : chạy hiệu ứng dừng đúng giải mà máy chủ đã chọn.
 */
const GAMES = {
  wheel: { label: 'Vòng quay', icon: 'ti-rotate-clockwise-2', cta: 'Quay ngay' },
  cards: { label: 'Thẻ bí mật', icon: 'ti-cards', cta: 'Chọn thẻ' },
  dice:  { label: 'Xúc xắc', icon: 'ti-dice-5', cta: 'Tung xúc xắc' },
  slot:  { label: 'Slot', icon: 'ti-slot-machine', cta: 'Quay slot' },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randInt = n => Math.floor(Math.random() * n);
const isNoPrize = p => p?.prize_type === 'none';
const prizeLabel = p => isNoPrize(p) ? '🍀 ' + p.name : '🎁 ' + p.name;

function cancellable() {
  let reject; const promise = new Promise((_, rej) => { reject = rej; });
  promise.catch(() => {}); // tránh cảnh báo khi không ai chờ
  return { promise, cancel: () => reject(Object.assign(new Error('cancelled'), { cancelled: true })) };
}

/* ---------------- Vòng quay ---------------- */
function wheelGame(container, prizes) {
  mountWheel(container, prizes);
  return { hint: '', start: () => Promise.resolve(), reveal: index => spinWheelTo(container, prizes, index), cancel() {} };
}

/* ---------------- Thẻ bí mật ---------------- */
function cardsGame(container, prizes) {
  const count = 6;
  container.innerHTML = `<div class="cards-grid">${Array.from({ length: count }, (_, i) =>
    `<button type="button" class="pcard" data-i="${i}"><span class="pcard-inner"><span class="pcard-face pcard-back"><i class="ti ti-help"></i></span><span class="pcard-face pcard-front"></span></span></button>`).join('')}</div>`;
  const cards = [...container.querySelectorAll('.pcard')];
  const gate = cancellable();
  let chosen = null;
  const started = new Promise(resolve => cards.forEach(card => card.addEventListener('click', () => {
    if (chosen) return; chosen = card; card.classList.add('picked'); cards.forEach(c => { if (c !== card) c.classList.add('locked'); }); resolve();
  })));
  const fill = (card, text, cls) => { card.querySelector('.pcard-front').innerHTML = `<span>${esc(text)}</span>`; card.classList.add(cls); };
  return {
    hint: 'Chọn một thẻ bí mật',
    start: () => Promise.race([started, gate.promise]),
    cancel: gate.cancel,
    async reveal(index) {
      const won = prizes[index];
      const rest = prizes.filter((_, i) => i !== index).sort(() => Math.random() - .5); // các giải còn lại, xáo trộn, không lặp
      fill(chosen, prizeLabel(won), isNoPrize(won) ? 'lose' : 'win');
      await sleep(350); chosen.classList.add('flipped'); await sleep(1000);
      cards.filter(c => c !== chosen).forEach((card, i) => { // các thẻ còn lại lật mờ để khách xem "đáng lẽ có gì"
        const p = rest.length ? rest[i % rest.length] : null;
        fill(card, p ? prizeLabel(p) : '🍀 Chúc may mắn', 'dim');
        setTimeout(() => card.classList.add('flipped'), i * 120);
      });
      await sleep(count * 120 + 500);
    },
  };
}

/* ---------------- Xúc xắc ---------------- */
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const dieHtml = value => `<span class="die" data-v="${value}">${Array.from({ length: 9 }, (_, i) => `<i class="pip ${PIPS[value].includes(i) ? 'on' : ''}"></i>`).join('')}</span>`;

function diceGame(container, prizes) {
  const n = prizes.length, two = n > 6;
  if (n > 11) {
    container.innerHTML = '<div class="alert alert-warning">Xúc xắc hỗ trợ tối đa 11 giải. Chương trình này có nhiều giải hơn, hãy chọn game khác.</div>';
    return { hint: '', start: () => Promise.reject(Object.assign(new Error('Xúc xắc hỗ trợ tối đa 11 giải; hãy chọn game khác.'), { unsupported: true })), reveal: async () => {}, cancel() {} };
  }
  const values = two ? Array.from({ length: 11 }, (_, i) => i + 2) : [1, 2, 3, 4, 5, 6];
  const prizeOf = v => (two ? v - 2 : v - 1) % n;            // mặt/tổng → giải
  const legend = values.map(v => `<span class="dice-legend"><b>${v}</b> ${esc(prizes[prizeOf(v)]?.name || '')}</span>`).join('');
  container.innerHTML = `<div class="dice-stage">${dieHtml(1)}${two ? dieHtml(1) : ''}</div><div class="dice-legends">${legend}</div><button class="btn btn-grad btn-lg mt-3" id="dice-go" type="button"><i class="ti ti-dice-5 me-1"></i>Tung xúc xắc</button>`;
  const gate = cancellable();
  const started = new Promise(resolve => container.querySelector('#dice-go').addEventListener('click', e => { e.currentTarget.disabled = true; resolve(); }));
  const stage = container.querySelector('.dice-stage');
  const setDice = vals => { stage.innerHTML = vals.map(dieHtml).join(''); };
  return {
    hint: 'Bấm để tung xúc xắc',
    start: () => Promise.race([started, gate.promise]),
    cancel: gate.cancel,
    async reveal(index) {
      const options = values.filter(v => prizeOf(v) === index);
      const total = options[randInt(options.length)] ?? values[0];
      let faces; // tách tổng thành hai xúc xắc hợp lệ
      if (two) { const lo = Math.max(1, total - 6), hi = Math.min(6, total - 1); const a = lo + randInt(hi - lo + 1); faces = [a, total - a]; } else faces = [total];
      stage.classList.add('rolling');
      const end = performance.now() + 1700;
      while (performance.now() < end) { setDice(faces.map(() => 1 + randInt(6))); await sleep(90); }
      stage.classList.remove('rolling'); setDice(faces);
      const label = container.querySelector('.dice-legends');
      label.querySelectorAll('.dice-legend').forEach(el => el.classList.toggle('hit', el.querySelector('b').textContent === String(total)));
      await sleep(600);
    },
  };
}

/* ---------------- Slot ---------------- */
const SLOT_SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '💎', '7️⃣', '🍀', '🍇'];

function slotGame(container, prizes) {
  const symbolOf = i => SLOT_SYMBOLS[i % SLOT_SYMBOLS.length];
  const legend = prizes.map((p, i) => `<span class="dice-legend">${isNoPrize(p) ? '' : `<b>${symbolOf(i).repeat(3)}</b> `}${esc(p.name)}</span>`).join('');
  container.innerHTML = `<div class="slot-machine"><div class="slot-reels">${[0, 1, 2].map(() => '<div class="slot-reel">❔</div>').join('')}</div></div><div class="dice-legends">${legend}</div><button class="btn btn-grad btn-lg mt-3" id="slot-go" type="button"><i class="ti ti-slot-machine me-1"></i>Kéo cần!</button>`;
  const reels = [...container.querySelectorAll('.slot-reel')];
  const gate = cancellable();
  const started = new Promise(resolve => container.querySelector('#slot-go').addEventListener('click', e => { e.currentTarget.disabled = true; resolve(); }));
  return {
    hint: 'Kéo cần để quay',
    start: () => Promise.race([started, gate.promise]),
    cancel: gate.cancel,
    async reveal(index, result) {
      const won = result?.status === 'won' && !isNoPrize(prizes[index]);
      let target;
      if (won) target = [symbolOf(index), symbolOf(index), symbolOf(index)];
      else { do { target = [0, 1, 2].map(() => SLOT_SYMBOLS[randInt(SLOT_SYMBOLS.length)]); } while (new Set(target).size === 1); } // không trúng: ba biểu tượng không giống nhau
      const stopAt = [1200, 1900, 2600], begin = performance.now(), stopped = [false, false, false];
      reels.forEach(r => r.classList.add('spinning'));
      while (stopped.some(s => !s)) {
        const elapsed = performance.now() - begin;
        reels.forEach((reel, i) => {
          if (stopped[i]) return;
          if (elapsed >= stopAt[i]) { stopped[i] = true; reel.classList.remove('spinning'); reel.textContent = target[i]; reel.classList.add('landed'); }
          else reel.textContent = SLOT_SYMBOLS[randInt(SLOT_SYMBOLS.length)];
        });
        await sleep(70);
      }
      if (won) container.querySelector('.slot-machine').classList.add('jackpot');
      await sleep(600);
    },
  };
}

function createGame(kind, container, prizes) {
  return ({ wheel: wheelGame, cards: cardsGame, dice: diceGame, slot: slotGame }[kind] || wheelGame)(container, prizes);
}
