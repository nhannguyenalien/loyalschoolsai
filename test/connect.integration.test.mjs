import test from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { onRequest } from "../functions/api/v1/[[path]].js";
import { createConnectApi, pkceChallenge } from "../src/api/connect.js";

const url = process.env.DATABASE_URL;
const run = crypto.randomUUID().slice(0, 8);
const tenant = `test-${run}`, usdTenant = `test-usd-${run}`;
const env = { DATABASE_URL: url, FIREBASE_PROJECT_ID: "test-project", ADMIN_SECRET: "x", CONNECT_ALLOWED_ORIGINS: "https://pos.example, http://localhost:8788" };
const call = (path, { key, admin, method = "GET", body, headers = {} } = {}) => onRequest({
  env, request: new Request(`http://loyalty.test${path}`, { method, body: body && JSON.stringify(body), headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(admin ? { "x-admin-secret": "x" } : {}), ...headers } }),
});
const j = async (p) => (await p).json();

test("Kết nối POS một nút + hoàn đơn", { skip: !url && "DATABASE_URL not set" }, async (t) => {
  const sql = neon(url), campaigns = [];
  t.after(async () => {
    for (const tn of [tenant, usdTenant]) {
      for (const tbl of ["connect_codes", "game_draw_tickets", "game_draws", "game_mission_claims", "game_missions", "reward_spin_results", "reward_spin_entitlements", "reward_store_joins", "loyalty_ledger", "loyalty_customers", "loyalty_programs", "store_pages", "api_keys"])
        await sql.query(`DELETE FROM ${tbl} WHERE tenant = $1`, [tn]);
    }
    for (const id of campaigns) { await sql.query("DELETE FROM reward_campaign_prizes WHERE campaign_id=$1", [id]); await sql.query("DELETE FROM reward_campaigns WHERE id=$1", [id]); }
  });
  const { createNeonRepository } = await import("../src/neonRepository.js");
  const repository = createNeonRepository(url);
  const api = createConnectApi({ repository, env });
  const session = (tn, path, { method = "GET", body } = {}) => api(new Request(`http://loyalty.test${path}`, { method, body: body && JSON.stringify(body) }), { tenant: tn, via: "session" });
  const redirect = "https://pos.example/api/loyalty/callback";
  const verifier = "v".repeat(20) + crypto.randomUUID().replaceAll("-", "");
  const challenge = await pkceChallenge(verifier);
  const authorize = (tn, extra = {}) => session(tn, "/api/v1/loyalty/connect/authorize", { method: "POST", body: { redirect_uri: redirect, state: "s".repeat(32), code_challenge: challenge, store: "Tiệm Vàng A", ...extra } });
  const token = (code, extra = {}) => call("/api/v1/connect/token", { method: "POST", body: { code, code_verifier: verifier, redirect_uri: redirect, ...extra } });
  const codeOf = async (res) => new URL((await res.json()).redirect_to).searchParams.get("code");

  // Chỉ origin + đường dẫn được phép
  for (const bad of ["https://evil.example/api/loyalty/callback", "https://pos.example/other", "https://pos.example/api/loyalty/callback?x=1", "https://pos.example.evil.com/api/loyalty/callback", "javascript:alert(1)", ""]) {
    await assert.rejects(() => authorize(tenant, { redirect_uri: bad }), { status: 400 }, bad);
  }
  await assert.rejects(() => authorize(tenant, { state: "short" }), { status: 400 });
  // API key không được tự cấp quyền kết nối
  await assert.rejects(() => api(new Request("http://loyalty.test/api/v1/loyalty/connect/authorize", { method: "POST" }), { tenant, via: "api_key" }), { status: 403 });
  assert.equal((await call("/api/v1/loyalty/connect/authorize", { method: "POST" })).status, 401);

  // Sai verifier / redirect_uri → từ chối và code bị tiêu hủy
  const c1 = await codeOf(await authorize(tenant));
  assert.equal((await token(c1, { code_verifier: "w".repeat(52) })).status, 400);
  assert.equal((await token(c1)).status, 400);
  const c2 = await codeOf(await authorize(tenant));
  assert.equal((await token(c2, { redirect_uri: "http://localhost:8788/api/loyalty/callback" })).status, 400);
  // Hết hạn
  const c3 = await codeOf(await authorize(tenant));
  await sql.query("UPDATE connect_codes SET expires_at = now() - interval '1 second' WHERE tenant = $1", [tenant]);
  assert.equal((await token(c3)).status, 400);

  // Thành công: có key, tạo luật VND mặc định + trang khách; code chỉ dùng một lần
  const code = await codeOf(await authorize(tenant));
  const results = await Promise.all([token(code), token(code), token(code)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400, 400]);
  const grant = await results.find((r) => r.status === 200).json();
  assert.match(grant.api_key, /^lsk_/); assert.equal(grant.currency, "VND"); assert.equal(grant.program.spend_per_point_minor, 10000);
  assert.equal(grant.store.name, "Tiệm Vàng A"); assert.match(grant.store.public_url, /^http:\/\/loyalty\.test\/c\?s=/);
  assert.equal(JSON.stringify(grant).includes(tenant), false);
  // Nối lại: key cũ bị thay
  const grant2 = await j(token(await codeOf(await authorize(tenant))));
  assert.equal((await call("/api/v1/loyalty/program", { key: grant.api_key })).status, 401);
  assert.equal((await call("/api/v1/loyalty/program", { key: grant2.api_key })).status, 200);
  const key = grant2.api_key;
  // Cửa hàng dùng USD không nối được
  await call("/api/v1/loyalty/program", { key: (await (async () => { const { generateApiKey, sha256Hex } = await import("../src/auth.js"); const k = generateApiKey(); await repository.createApiKey({ tenant: usdTenant, name: "t", keyPrefix: "x", keyHash: await sha256Hex(k) }); return k; })()), method: "PUT", body: { currency: "USD", spend_per_point_minor: 100 } });
  await assert.rejects(() => authorize(usdTenant), { status: 409 });

  // ---------- Hoàn đơn
  const campaign = await j(call("/api/v1/admin/reward-world/campaigns", { admin: true, method: "POST", body: { name: `rf ${run}`, status: "active", spend_per_spin_minor: 100000, max_spins_per_sale: 3 } }));
  campaigns.push(campaign.id);
  await call(`/api/v1/admin/reward-world/campaigns/${campaign.id}/prizes`, { admin: true, method: "POST", body: { name: "x", prize_type: "none", weight: 1 } });
  await call(`/api/v1/loyalty/reward-world/campaigns/${campaign.id}/join`, { key, method: "POST" });
  await call("/api/v1/loyalty/games/draws", { key, method: "POST", body: { name: "d", status: "open", spend_per_ticket_minor: 100000, max_tickets_per_sale: 3, prizes: [{ name: "p", quantity: 1 }] } });
  await call("/api/v1/loyalty/games/missions", { key, method: "POST", body: { name: "m", kind: "spend", target: 100000, reward_type: "points", reward_points: 1 } });
  const ev = (body) => call("/api/v1/loyalty/events", { key, method: "POST", body });
  const buy = (id, amount) => j(ev({ type: "purchase", customer_ref: "0901000001", order_id: id, source_type: "pos", amount_minor: amount }));
  const A = await buy("A", 250000), B = await buy("B:1", 100000);
  assert.equal(A.points_delta, 25); assert.equal(A.spins_earned, 2); assert.equal(A.tickets_earned, 2); assert.equal(B.balance, 35);
  await call("/api/v1/loyalty/reward-world/spins", { key, method: "POST", body: { campaign_id: campaign.id, customer_ref: "0901000001", idempotency_key: `sp-${run}` } }); // dùng 1 lượt
  const spinsBefore = (await j(call("/api/v1/loyalty/reward-world/entitlements?customer_ref=0901000001", { key }))).available;
  assert.equal(spinsBefore, 2);

  assert.equal((await ev({ type: "refund", order_id: "KHONGCO", source_type: "pos" })).status, 404);
  assert.equal((await ev({ type: "refund", order_id: "A" })).status, 404); // sai source_type
  assert.equal((await ev({ type: "refund", order_id: "A", source_type: "pos", customer_ref: "0999" })).status, 409);
  const parallel = await Promise.all([1, 2, 3, 4].map(() => ev({ type: "refund", order_id: "A", source_type: "pos" })));
  assert.deepEqual(parallel.map((r) => r.status).sort(), [200, 200, 200, 201]);
  const done = await parallel.find((r) => r.status === 201).json();
  assert.equal(done.points_delta, -25); assert.equal(done.balance, 10); assert.equal(done.customer_ref, "0901000001");
  const spinsAfter = (await j(call("/api/v1/loyalty/reward-world/entitlements?customer_ref=0901000001", { key }))).available;
  assert.ok(spinsAfter <= 1 && spinsAfter >= 0, String(spinsAfter)); // lượt chưa dùng của đơn A bị thu hồi, lượt của B còn nguyên
  assert.equal((await sql.query("SELECT count(*)::int n FROM reward_spin_entitlements WHERE tenant=$1 AND source_ref LIKE 'B:1:%' AND status='available'", [tenant]))[0].n, 1);
  assert.equal((await sql.query("SELECT count(*)::int n FROM game_draw_tickets WHERE tenant=$1 AND source_ref='A'", [tenant]))[0].n, 0);
  assert.equal((await sql.query("SELECT count(*)::int n FROM game_draw_tickets WHERE tenant=$1 AND source_ref='B:1'", [tenant]))[0].n, 1);
  const stats = await j(call("/api/v1/loyalty/stats", { key }));
  assert.equal(stats.sales_30d, 100000); assert.equal(stats.points_issued, 10); assert.equal(stats.points_redeemed, 0); assert.equal(stats.receipts_today, 1);
  const board = await j(call("/api/v1/loyalty/games/missions?customer_ref=0901000001", { key }));
  assert.equal(board.missions[0].current, 100000);
  // Gửi lại đơn đã hoàn: không cộng lại
  assert.equal((await buy("A", 250000)).balance, 10);
  // Đã tiêu điểm rồi mới hủy đơn → số dư âm, không đổi thưởng được
  await ev({ type: "redeem", customer_ref: "0901000001", order_id: "R1", points: 8 });
  const neg = await j(ev({ type: "refund", order_id: "B:1", source_type: "pos" }));
  assert.equal(neg.balance, -8);
  assert.equal((await ev({ type: "redeem", customer_ref: "0901000001", order_id: "R2", points: 1 })).status, 409);

  // Ngắt kết nối: key tự thu hồi
  assert.equal((await call("/api/v1/loyalty/connect", { key, method: "DELETE" })).status, 200);
  assert.equal((await call("/api/v1/loyalty/program", { key })).status, 401);
});
