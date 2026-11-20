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

test("Trang khách công khai", { skip: !url && "DATABASE_URL not set" }, async (t) => {
  const sql = neon(url);
  t.after(async () => {
    for (const tbl of ["game_mission_claims", "game_missions", "game_checkins", "game_settings", "loyalty_ledger", "loyalty_customers", "loyalty_programs", "store_pages", "api_keys"])
      await sql.query(`DELETE FROM ${tbl} WHERE tenant = $1`, [tenant]);
  });
  const { createNeonRepository } = await import("../src/neonRepository.js");
  const { generateApiKey, sha256Hex } = await import("../src/auth.js");
  const repo = createNeonRepository(url);
  const key = generateApiKey();
  await repo.createApiKey({ tenant, name: "t", keyPrefix: key.slice(0, 10), keyHash: await sha256Hex(key) });

  // Chủ cửa hàng: trang tự tạo, slug hợp lệ, đổi slug, trùng slug
  const first = await j(await call("/api/v1/loyalty/store-page", { key }));
  assert.match(first.page.slug, /^[a-z0-9]{8}$/); assert.equal(first.page.enabled, true);
  const slug = `shop-${tenant.slice(5)}`;
  assert.equal((await call("/api/v1/loyalty/store-page", { key, method: "PUT", body: { slug: "A B" } })).status, 400);
  const saved = await call("/api/v1/loyalty/store-page", { key, method: "PUT", body: { slug, name: "Quán Test" } });
  assert.equal(saved.status, 200);
  assert.equal((await call("/api/v1/loyalty/store-page", { key })).status, 200);

  // Dữ liệu: luật điểm + một khách đã mua
  await call("/api/v1/loyalty/program", { key, method: "PUT", body: { spend_per_point_minor: 10000 } });
  await call("/api/v1/loyalty/events", { key, method: "POST", body: { type: "purchase", customer_ref: "0911222333", order_id: "P1", amount_minor: 250000, customer: { name: "Nguyễn Văn An" } } });
  await call("/api/v1/loyalty/games/missions", { key, method: "POST", body: { name: "Điểm danh", kind: "checkin", target: 1, reward_type: "points", reward_points: 7 } });

  const P = `/api/v1/public/${slug}`;
  // Công khai: không cần khóa
  const info = await j(await call(P));
  assert.equal(info.store.name, "Quán Test"); assert.equal(info.program.spend_per_point_minor, 10000);
  assert.equal(JSON.stringify(info).includes(tenant), false); // không lộ tenant
  assert.equal((await call("/api/v1/public/khong-co-shop")).status, 404);

  // Khách: số lạ → 404, số sai định dạng → 400, số đã có hồ sơ → xem được
  assert.equal((await call(`${P}/me`, { method: "POST", body: { phone: "0999999999" } })).status, 404);
  assert.equal((await call(`${P}/me`, { method: "POST", body: { phone: "abc" } })).status, 400);
  const me = await j(await call(`${P}/me`, { method: "POST", body: { phone: "0911 222 333" } }));
  assert.equal(me.balance, 25); assert.equal(me.customer.name, "An"); assert.equal(me.missions.length, 1);
  assert.equal(me.missions[0].completed, false); assert.equal(me.entries, undefined);

  // Điểm danh + replay + nhận nhiệm vụ
  const ci = await call(`${P}/checkin`, { method: "POST", body: { phone: "0911222333" } });
  assert.equal(ci.status, 201);
  assert.equal((await call(`${P}/checkin`, { method: "POST", body: { phone: "0911222333" } })).status, 200);
  assert.equal((await call(`${P}/checkin`, { method: "POST", body: { phone: "0888000111" } })).status, 404); // không tạo khách mới
  const mid = me.missions[0].id;
  const claim = await call(`${P}/missions/${mid}/claim`, { method: "POST", body: { phone: "0911222333" } });
  assert.equal(claim.status, 201); assert.equal((await j(claim)).balance, 25 + 10 + 7);

  // Quay: request_id sai → 400; chiến dịch không tồn tại → 404
  assert.equal((await call(`${P}/spin`, { method: "POST", body: { phone: "0911222333", campaign_id: "x", request_id: "!" } })).status, 400);
  assert.equal((await call(`${P}/spin`, { method: "POST", body: { phone: "0911222333", campaign_id: "khong-co", request_id: "req-12345678" } })).status, 404);

  // Tắt trang → khách không vào được
  await call("/api/v1/loyalty/store-page", { key, method: "PUT", body: { enabled: false } });
  assert.equal((await call(P)).status, 404);
});
