import test from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { onRequest } from "../functions/api/v1/[[path]].js";

const url = process.env.DATABASE_URL;
const tenant = `test-${crypto.randomUUID().slice(0, 8)}`;
const env = { DATABASE_URL: url, FIREBASE_PROJECT_ID: "test-project", ADMIN_SECRET: "x" };
const call = (path, { key, method = "GET", body } = {}) => onRequest({
  env, request: new Request(`http://t${path}`, { method, body: body && JSON.stringify(body), headers: key ? { authorization: `Bearer ${key}` } : {} }),
});
const j = (r) => r.json();

test("PIN trang khách", { skip: !url && "DATABASE_URL not set" }, async (t) => {
  const sql = neon(url);
  t.after(async () => {
    for (const tbl of ["customer_pins", "game_checkins", "game_settings", "loyalty_ledger", "loyalty_customers", "loyalty_programs", "store_pages", "api_keys"])
      await sql.query(`DELETE FROM ${tbl} WHERE tenant = $1`, [tenant]);
  });
  const { createNeonRepository } = await import("../src/neonRepository.js");
  const { generateApiKey, sha256Hex } = await import("../src/auth.js");
  const key = generateApiKey();
  await createNeonRepository(url).createApiKey({ tenant, name: "t", keyPrefix: key.slice(0, 10), keyHash: await sha256Hex(key) });

  const slug = `pin-${tenant.slice(5)}`, P = `/api/v1/public/${slug}`, ph = "0933444555";
  await call("/api/v1/loyalty/store-page", { key });
  await call("/api/v1/loyalty/store-page", { key, method: "PUT", body: { slug, name: "Quán PIN" } });
  await call("/api/v1/loyalty/program", { key, method: "PUT", body: { spend_per_point_minor: 10000 } });
  await call("/api/v1/loyalty/events", { key, method: "POST", body: { type: "purchase", customer_ref: ph, order_id: "PIN1", amount_minor: 100000 } });
  const me = (pin, phone = ph) => call(`${P}/me`, { method: "POST", body: { phone, pin } });
  const attempts = async () => (await sql.query("SELECT failed_attempts, locked_until FROM customer_pins WHERE tenant=$1 AND customer_ref=$2", [tenant, ph]))[0];

  // Mặc định không bật PIN: dùng như cũ, /pin bị từ chối
  assert.equal((await j(await call(P))).pin_required, false);
  assert.equal((await me()).status, 200);
  assert.equal((await call(`${P}/pin`, { method: "POST", body: { phone: ph, new_pin: "1234" } })).status, 409);
  assert.equal((await call("/api/v1/loyalty/store-page", { key, method: "PUT", body: { require_pin: "yes" } })).status, 400);

  // Bật PIN: chưa có PIN → phải tạo; mọi endpoint đều bị chặn
  const on = await j(await call("/api/v1/loyalty/store-page", { key, method: "PUT", body: { require_pin: true } }));
  assert.equal(on.page.require_pin, true);
  assert.equal((await j(await call(P))).pin_required, true);
  const noPin = await me(); assert.equal(noPin.status, 403); assert.equal((await j(noPin)).code, "pin_setup");
  for (const route of ["/checkin", "/missions/x/claim", "/spin"]) {
    const r = await call(`${P}${route}`, { method: "POST", body: { phone: ph, request_id: "abcdefgh12" } });
    assert.equal(r.status, 403, route);
  }
  assert.equal((await call(`${P}/pin`, { method: "POST", body: { phone: "0900000000", new_pin: "1234" } })).status, 404); // số lạ
  for (const bad of ["12", "abcd", "1234567", ""]) assert.equal((await call(`${P}/pin`, { method: "POST", body: { phone: ph, new_pin: bad } })).status, 400, bad);

  // Tạo PIN, rồi xem được; thiếu/sai PIN bị từ chối; không lộ hash
  assert.equal((await call(`${P}/pin`, { method: "POST", body: { phone: ph, new_pin: "1234" } })).status, 200);
  assert.equal((await call(`${P}/pin`, { method: "POST", body: { phone: ph, new_pin: "9999" } })).status, 401); // đã có PIN: phải nhập PIN hiện tại
  const ok = await me("1234"); assert.equal(ok.status, 200); const okBody = await j(ok);
  assert.equal(okBody.balance, 10); assert.equal(JSON.stringify(okBody).includes("hash"), false);
  const missing = await me(); assert.equal(missing.status, 401); assert.equal((await j(missing)).code, "pin_required");
  assert.equal((await attempts()).failed_attempts, 0); // thiếu PIN không tốn lượt
  const wrong = await me("0000"); assert.equal(wrong.status, 401); const wb = await j(wrong);
  assert.equal(wb.code, "pin_wrong"); assert.equal(wb.attempts_left, 4);
  assert.equal((await me("12ab")).status, 401);
  assert.equal((await call(`${P}/checkin`, { method: "POST", body: { phone: ph, pin: "0000" } })).status, 401);
  assert.equal((await call(`${P}/checkin`, { method: "POST", body: { phone: ph, pin: "1234" } })).status, 201);
  assert.equal((await attempts()).failed_attempts, 0); // đúng PIN xóa bộ đếm

  // Khóa sau 5 lần sai, kể cả khi sau đó nhập đúng
  for (let i = 1; i <= 4; i++) assert.equal((await me("0000")).status, 401);
  const fifth = await me("0000"); assert.equal(fifth.status, 429); assert.equal((await j(fifth)).code, "pin_locked");
  const lockedOk = await me("1234"); assert.equal(lockedOk.status, 429); assert.ok((await j(lockedOk)).retry_after > 0);
  assert.equal((await call(`${P}/pin`, { method: "POST", body: { phone: ph, pin: "1234", new_pin: "5555" } })).status, 429);
  // Hết hạn khóa → đúng PIN vào lại được và bộ đếm về 0
  await sql.query("UPDATE customer_pins SET locked_until = now() - interval '1 minute' WHERE tenant=$1", [tenant]);
  assert.equal((await me("1234")).status, 200);
  assert.deepEqual({ ...(await attempts()), locked_until: null }, { failed_attempts: 0, locked_until: null });
  // Hết hạn khóa mà đoán sai → đếm lại từ 1, không khóa ngay
  await sql.query("UPDATE customer_pins SET failed_attempts = 5, locked_until = now() - interval '1 minute' WHERE tenant=$1", [tenant]);
  const afterExpiry = await me("0000"); assert.equal((await j(afterExpiry)).attempts_left, 4);

  // Đoán song song: tối đa 5 lượt được xét, phần còn lại bị khóa
  await call("/api/v1/loyalty/store-page/pin-reset", { key, method: "POST", body: { customer_ref: ph, pin: "4321" } });
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => me(String(1000 + i))));
  const codes = burst.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 401).length, 4, JSON.stringify(codes));
  assert.equal(codes.filter((c) => c === 429).length, 16, JSON.stringify(codes));
  assert.equal((await attempts()).failed_attempts, 5);

  // Chủ cửa hàng đặt lại: PIN mới, hoặc xóa để khách tự tạo
  assert.equal((await call("/api/v1/loyalty/store-page/pin-reset", { key, method: "POST", body: { customer_ref: "0900000000" } })).status, 404);
  assert.equal((await call("/api/v1/loyalty/store-page/pin-reset", { key, method: "POST", body: {} })).status, 400);
  assert.equal((await call("/api/v1/loyalty/store-page/pin-reset", { key, method: "POST", body: { customer_ref: ph, pin: "12" } })).status, 400);
  assert.equal((await call("/api/v1/loyalty/store-page/pin-reset", { key, method: "POST", body: { customer_ref: ph, pin: "2468" } })).status, 200);
  assert.equal((await me("2468")).status, 200); // đặt lại cũng mở khóa
  assert.equal((await me("4321")).status, 401);
  const cleared = await j(await call("/api/v1/loyalty/store-page/pin-reset", { key, method: "POST", body: { customer_ref: ph } }));
  assert.equal(cleared.cleared, true); assert.equal((await me("2468")).status, 403);

  // Đổi PIN bằng PIN hiện tại
  await call(`${P}/pin`, { method: "POST", body: { phone: ph, new_pin: "1111" } });
  assert.equal((await call(`${P}/pin`, { method: "POST", body: { phone: ph, pin: "1111", new_pin: "2222" } })).status, 200);
  assert.equal((await me("1111")).status, 401); assert.equal((await me("2222")).status, 200);
  const stored = (await sql.query("SELECT pin_hash, salt FROM customer_pins WHERE tenant=$1", [tenant]))[0];
  assert.equal(stored.pin_hash.includes("2222"), false); assert.equal(stored.pin_hash.length, 64);

  // Tắt PIN → quay lại như cũ
  await call("/api/v1/loyalty/store-page", { key, method: "PUT", body: { require_pin: false } });
  assert.equal((await me()).status, 200);
});
