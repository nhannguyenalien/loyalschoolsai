import test from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { onRequest } from "../functions/api/v1/[[path]].js";

const url = process.env.DATABASE_URL;
const tenant = `test-${crypto.randomUUID().slice(0, 8)}`;
const env = { DATABASE_URL: url, FIREBASE_PROJECT_ID: "test-project", ADMIN_SECRET: "x" };
const call = (path, { key, admin, method = "GET", body } = {}) => onRequest({
  env, request: new Request(`http://t${path}`, { method, body: body && JSON.stringify(body), headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(admin ? { "x-admin-secret": "x" } : {}) } }),
});
const j = async (p) => (await p).json();

test("Đa tiền tệ VND / USD", { skip: !url && "DATABASE_URL not set" }, async (t) => {
  const sql = neon(url), campaignIds = [];
  t.after(async () => {
    for (const tbl of ["reward_spin_entitlements", "reward_store_joins", "loyalty_ledger", "loyalty_customers", "loyalty_programs", "api_keys"]) await sql.query(`DELETE FROM ${tbl} WHERE tenant = $1`, [tenant]);
    for (const id of campaignIds) { await sql.query("DELETE FROM reward_store_joins WHERE campaign_id = $1", [id]); await sql.query("DELETE FROM reward_campaign_prizes WHERE campaign_id = $1", [id]); await sql.query("DELETE FROM reward_campaigns WHERE id = $1", [id]); }
  });
  const { createNeonRepository } = await import("../src/neonRepository.js");
  const { generateApiKey, sha256Hex } = await import("../src/auth.js");
  const key = generateApiKey();
  await createNeonRepository(url).createApiKey({ tenant, name: "t", keyPrefix: key.slice(0, 10), keyHash: await sha256Hex(key) });
  const L = "/api/v1/loyalty";
  const setProgram = (currency, step) => call(`${L}/program`, { key, method: "PUT", body: { currency, spend_per_point_minor: step } });
  const sale = (order, amount) => j(call(`${L}/events`, { key, method: "POST", body: { type: "purchase", customer_ref: "0909", order_id: order, amount_minor: amount } }));
  const campaign = async (body) => { const c = await j(call("/api/v1/admin/reward-world/campaigns", { admin: true, method: "POST", body: { name: `cur ${tenant}`, status: "active", max_spins_per_sale: 5, ...body } })); campaignIds.push(c.id); return c; };

  assert.equal((await setProgram("EUR", 100)).status, 400);
  assert.equal((await call("/api/v1/admin/reward-world/campaigns", { admin: true, method: "POST", body: { name: "x", spend_per_spin_minor: 1, currency: "EUR" } })).status, 400);
  const usd = await campaign({ currency: "USD", spend_per_spin_minor: 1000 }), vnd = await campaign({ spend_per_spin_minor: 1000 });
  assert.equal(usd.currency, "USD"); assert.equal(vnd.currency, "VND"); // mặc định VND cho chiến dịch cũ

  assert.equal((await setProgram("usd", 200)).status, 200); // chấp nhận chữ thường
  const ids = async () => (await j(call(`${L}/reward-world/campaigns`, { key }))).campaigns.map((c) => c.id).filter((id) => campaignIds.includes(id));
  assert.deepEqual(await ids(), [usd.id]);
  assert.equal((await call(`${L}/reward-world/campaigns/${vnd.id}/join`, { key, method: "POST" })).status, 409);
  assert.equal((await call(`${L}/reward-world/campaigns/${usd.id}/join`, { key, method: "POST" })).status, 200);
  const first = await sale("U1", 2500); // $25.00
  assert.equal(first.points_delta, 12); assert.equal(first.spins_earned, 2); assert.equal(first.detail.entry.currency, "USD");
  assert.equal((await j(call(`${L}/stats`, { key }))).sales_30d, 2500);

  // Đổi sang VND: chiến dịch USD đã tham gia vẫn thấy (dùng lượt cũ) nhưng không sinh lượt mới; doanh số chỉ cộng tiền VND
  await setProgram("VND", 10000);
  assert.deepEqual((await ids()).sort(), [usd.id, vnd.id].sort());
  const second = await sale("V1", 50000);
  assert.equal(second.points_delta, 5); assert.equal(second.spins_earned, 0);
  assert.equal((await j(call(`${L}/stats`, { key }))).sales_30d, 50000);
  const account = await j(call(`${L}/account?customer_ref=0909`, { key }));
  assert.deepEqual(account.entries.map((e) => e.currency).sort(), ["USD", "VND"]);
  assert.equal(account.balance, 17); // điểm không phụ thuộc tiền tệ
});
