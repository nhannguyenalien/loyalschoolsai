import { sha256Hex } from "./auth.js";

export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;
const PIN_RE = /^\d{4,6}$/;

/** Lỗi PIN có mã máy đọc được (`code`) để trang khách biết cần hiện bước nào. */
export class PinError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

export function validatePin(pin, field = "pin") {
  const value = String(pin ?? "").trim();
  if (!PIN_RE.test(value)) throw new PinError(400, "pin_invalid", `${field} gồm 4–6 chữ số.`);
  return value;
}

const newSalt = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const hashPin = (salt, tenant, ref, pin) => sha256Hex(`${salt}:${tenant}:${ref}:${pin}`);
const sameHash = (a, b) => { let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; };
const retryAfter = (lockedUntil) => Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000));
const lockedError = (lockedUntil) => new PinError(429, "pin_locked", `Nhập sai quá nhiều lần. Thử lại sau ${Math.max(1, Math.round(retryAfter(lockedUntil) / 60))} phút.`, { retry_after: retryAfter(lockedUntil) });

/** Tạo PIN lần đầu. Đã có PIN thì báo lỗi (đổi PIN phải đi qua verify trước). */
export async function createInitialPin({ repository, tenant, ref, pin }) {
  const value = validatePin(pin, "new_pin"), salt = newSalt();
  if (!(await repository.createCustomerPin(tenant, ref, await hashPin(salt, tenant, ref, value), salt))) throw new PinError(409, "pin_exists", "Số này đã có PIN. Hãy nhập PIN hiện tại để đổi.");
}

/** Chủ cửa hàng đặt lại: có `pin` thì đặt PIN mới, không thì xóa (khách tự tạo lại). */
export async function resetCustomerPin({ repository, tenant, ref, pin }) {
  if (pin === undefined || pin === null || pin === "") return { cleared: await repository.deleteCustomerPin(tenant, ref) };
  const value = validatePin(pin), salt = newSalt();
  await repository.upsertCustomerPin(tenant, ref, await hashPin(salt, tenant, ref, value), salt);
  return { cleared: false };
}

export async function changePin({ repository, tenant, ref, newPin }) {
  const value = validatePin(newPin, "new_pin"), salt = newSalt();
  await repository.upsertCustomerPin(tenant, ref, await hashPin(salt, tenant, ref, value), salt);
}

/** Kiểm tra PIN của khách. Mỗi lần thử được giữ chỗ TRƯỚC khi so khớp để chặn đoán song song. */
export async function verifyCustomerPin({ repository, tenant, ref, pin }) {
  const given = String(pin ?? "").trim();
  if (!given) {
    const existing = await repository.getCustomerPin(tenant, ref);
    if (!existing) throw new PinError(403, "pin_setup", "Hãy tạo mã PIN 4–6 số để bảo vệ điểm của bạn.");
    if (existing.locked_until && new Date(existing.locked_until) > new Date()) throw lockedError(existing.locked_until);
    throw new PinError(401, "pin_required", "Vui lòng nhập mã PIN.");
  }
  if (!PIN_RE.test(given)) throw new PinError(401, "pin_wrong", "PIN không đúng.");
  const row = await repository.reserveCustomerPinAttempt(tenant, ref, PIN_MAX_ATTEMPTS, PIN_LOCK_MINUTES);
  if (!row) {
    const existing = await repository.getCustomerPin(tenant, ref);
    if (!existing) throw new PinError(403, "pin_setup", "Hãy tạo mã PIN 4–6 số để bảo vệ điểm của bạn.");
    throw lockedError(existing.locked_until);
  }
  if (sameHash(await hashPin(row.salt, tenant, ref, given), row.pin_hash)) {
    if (Number(row.failed_attempts) > 0) await repository.resetCustomerPinAttempts(tenant, ref);
    return;
  }
  if (row.locked_until) throw lockedError(row.locked_until);
  throw new PinError(401, "pin_wrong", `PIN không đúng. Còn ${Math.max(0, PIN_MAX_ATTEMPTS - Number(row.failed_attempts))} lần thử.`, { attempts_left: Math.max(0, PIN_MAX_ATTEMPTS - Number(row.failed_attempts)) });
}
