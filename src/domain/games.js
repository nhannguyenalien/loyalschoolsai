import { LoyaltyValidationError } from "./loyalty/errors.js";

export const DEFAULT_GAME_SETTINGS = {
  checkin_points: 10,
  streak_milestones: [{ days: 7, points: 50 }, { days: 14, points: 120 }, { days: 30, points: 300 }],
};

const VN_OFFSET_MS = 7 * 3600 * 1000; // Việt Nam không có giờ mùa hè

/** Ngày (YYYY-MM-DD) theo giờ Việt Nam: một "ngày" của game luôn tính theo múi giờ này. */
export const vnDate = (date = new Date()) => new Date(date.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);

export function addDays(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

const integer = (value, field, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new LoyaltyValidationError(`${field} must be an integer between ${min} and ${max}.`);
  return n;
};

export function validateGameSettings(input) {
  const checkinPoints = integer(input.checkin_points ?? DEFAULT_GAME_SETTINGS.checkin_points, "checkin_points", 0, 100000);
  const raw = input.streak_milestones ?? DEFAULT_GAME_SETTINGS.streak_milestones;
  if (!Array.isArray(raw) || raw.length > 10) throw new LoyaltyValidationError("streak_milestones must be a list of at most 10 items.");
  const seen = new Set();
  const milestones = raw.map((m) => {
    const days = integer(m?.days, "milestone days", 2, 365);
    if (seen.has(days)) throw new LoyaltyValidationError(`Duplicate milestone for ${days} days.`);
    seen.add(days);
    return { days, points: integer(m?.points, "milestone points", 0, 1000000) };
  }).sort((a, b) => a.days - b.days);
  return { checkin_points: checkinPoints, streak_milestones: milestones };
}

/** Chuỗi hiện tại: còn "sống" nếu lần điểm danh cuối là hôm nay hoặc hôm qua. */
export function currentStreak(lastCheckin, today) {
  if (!lastCheckin) return 0;
  return lastCheckin.day === today || lastCheckin.day === addDays(today, -1) ? Number(lastCheckin.streak) : 0;
}

export function nextMilestone(streak, milestones) {
  const next = milestones.find((m) => m.days > streak);
  return next ? { days: next.days, points: next.points, remaining: next.days - streak } : null;
}

export const MISSION_KINDS = new Set(["checkin", "receipts", "spend"]);
export const MISSION_REWARDS = new Set(["points", "spin"]);

export function validateMission(input, { partial = false } = {}) {
  const out = {};
  const has = (k) => input[k] !== undefined;
  if (!partial || has("name")) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 120) throw new LoyaltyValidationError("name is required (max 120 characters).");
    out.name = name;
  }
  if (has("description")) out.description = String(input.description).trim().slice(0, 500);
  if (!partial || has("kind")) {
    if (!MISSION_KINDS.has(input.kind)) throw new LoyaltyValidationError("kind must be checkin, receipts or spend.");
    out.kind = input.kind;
  }
  if (!partial || has("target")) out.target = integer(input.target ?? 1, "target", 1, 1_000_000_000_000);
  if (!partial || has("reward_type")) {
    if (!MISSION_REWARDS.has(input.reward_type)) throw new LoyaltyValidationError("reward_type must be points or spin.");
    out.reward_type = input.reward_type;
  }
  if (has("reward_points")) out.reward_points = integer(input.reward_points, "reward_points", 0, 1000000);
  if (has("reward_campaign_id")) out.reward_campaign_id = input.reward_campaign_id ? String(input.reward_campaign_id) : null;
  if (has("sort_order")) out.sort_order = integer(input.sort_order, "sort_order", 0, 100000);
  if (has("status")) {
    if (!["active", "paused", "archived"].includes(input.status)) throw new LoyaltyValidationError("status is invalid.");
    out.status = input.status;
  }
  return out;
}

export function validateDraw(input, { partial = false } = {}) {
  const out = {};
  const has = (k) => input[k] !== undefined;
  if (!partial || has("name")) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 150) throw new LoyaltyValidationError("name is required (max 150 characters).");
    out.name = name;
  }
  if (has("description")) out.description = String(input.description).trim().slice(0, 1000);
  if (has("status")) {
    if (!["draft", "open", "closed"].includes(input.status)) throw new LoyaltyValidationError("status must be draft, open or closed.");
    out.status = input.status;
  }
  for (const key of ["starts_at", "ends_at"]) {
    if (!has(key)) continue;
    if (!input[key]) { out[key] = null; continue; }
    const date = new Date(input[key]);
    if (Number.isNaN(date.getTime())) throw new LoyaltyValidationError(`${key} must be a valid date.`);
    out[key] = date.toISOString();
  }
  if (out.starts_at && out.ends_at && new Date(out.ends_at) <= new Date(out.starts_at)) throw new LoyaltyValidationError("ends_at must be after starts_at.");
  if (!partial || has("spend_per_ticket_minor")) out.spend_per_ticket_minor = integer(input.spend_per_ticket_minor ?? 0, "spend_per_ticket_minor", 0, 1_000_000_000_000);
  if (!partial || has("max_tickets_per_sale")) out.max_tickets_per_sale = integer(input.max_tickets_per_sale ?? 1, "max_tickets_per_sale", 1, 100);
  if (has("one_prize_per_customer")) out.one_prize_per_customer = Boolean(input.one_prize_per_customer);
  if (!partial || has("prizes")) {
    const prizes = input.prizes ?? [];
    if (!Array.isArray(prizes) || prizes.length === 0 || prizes.length > 30) throw new LoyaltyValidationError("prizes must be a list of 1 to 30 items.");
    out.prizes = prizes.map((p) => {
      const name = String(p?.name ?? "").trim();
      if (!name || name.length > 120) throw new LoyaltyValidationError("Each prize needs a name (max 120 characters).");
      return { name, quantity: integer(p?.quantity ?? 1, "prize quantity", 1, 1000) };
    });
  }
  return out;
}

/** Fisher–Yates với nguồn ngẫu nhiên an toàn. */
export function secureShuffle(items, random = secureRandomInt) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function secureRandomInt(maxExclusive) {
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive; // loại bỏ thiên lệch modulo
  const buf = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % maxExclusive;
}

/**
 * Chọn người thắng: lấy ngẫu nhiên từ các vé, gán lần lượt các giải đã xáo trộn.
 * Nếu one_prize_per_customer thì mỗi khách tối đa một giải.
 */
export function pickDrawWinners(tickets, prizes, { onePerCustomer = true, random = secureRandomInt } = {}) {
  const slots = prizes.flatMap((p, index) => Array.from({ length: p.quantity }, () => ({ prize_name: p.name, prize_index: index })));
  const winners = [];
  const usedCustomers = new Set();
  for (const ticket of secureShuffle(tickets, random)) {
    if (winners.length >= slots.length) break;
    if (onePerCustomer && usedCustomers.has(ticket.customer_ref)) continue;
    usedCustomers.add(ticket.customer_ref);
    winners.push(ticket);
  }
  // Giải giá trị cao (đứng trước trong danh sách) được rút trước: gán theo thứ tự slot.
  return winners.map((ticket, i) => ({ ticket_id: ticket.id, ticket_no: ticket.ticket_no, customer_ref: ticket.customer_ref, ...slots[i] }));
}
