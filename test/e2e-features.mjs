// E2E cho: /events, webhook, trang khách công khai, API trang cửa hàng. Chạy qua HTTP tới wrangler dev.
// Terminal 1: DATABASE_URL=... npx wrangler pages dev dist --binding DATABASE_URL=$DATABASE_URL --binding ADMIN_SECRET=e2e-secret --binding FIREBASE_PROJECT_ID=test --port 8799
// Terminal 2: DATABASE_URL=... ADMIN_SECRET=e2e-secret E2E_BASE=http://localhost:8799 node test/e2e-features.mjs
import http from "node:http";
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createNeonRepository } from "../src/neonRepository.js";
import { generateApiKey, sha256Hex } from "../src/auth.js";
import { createWebhooksApi } from "../src/api/webhooks.js";

const BASE = process.env.E2E_BASE || "http://localhost:8799";
const url = process.env.DATABASE_URL, ADMIN = process.env.ADMIN_SECRET;
if (!url || !ADMIN) { console.error("Cần DATABASE_URL và ADMIN_SECRET."); process.exit(2); }
const sql = neon(url), repo = createNeonRepository(url);
const run = crypto.randomUUID().slice(0, 6);
const tenantA = `e2f-a-${run}`, tenantB = `e2f-b-${run}`;
const L = "/api/v1/loyalty", G = `${L}/games`, A = "/api/v1/admin/reward-world";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; const fails = [];
const check = (name, cond, extra) => { if (cond) pass++; else fails.push(name + (extra !== undefined ? " :: " + JSON.stringify(extra).slice(0, 400) : "")); };

async function mkKey(tenant) {
  const key = generateApiKey();
  await repo.createApiKey({ tenant, name: "e2e", keyPrefix: key.slice(0, 10), keyHash: await sha256Hex(key) });
  return key;
}
const keyA = await mkKey(tenantA), keyB = await mkKey(tenantB);
async function raw(path, { method = "GET", body, headers = {}, key, admin, rawBody } = {}) {
  const h = { ...(body !== undefined || rawBody !== undefined ? { "content-type": "application/json" } : {}), ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  if (admin) h["x-admin-secret"] = admin;
  const r = await fetch(BASE + path, { method, headers: h, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { s: r.status, j, text, headers: r.headers };
}
const api = (key) => (path, opts = {}) => raw(path, { ...opts, key });
const a = api(keyA), b = api(keyB);
const pub = (slug, route, body) => raw(`/api/v1/public/${slug}${route}`, body === undefined ? {} : { method: "POST", body });

// ---- Webhook receiver cục bộ
const received = []; let receiverStatus = 200;
const server = http.createServer((req, res) => {
  let data = ""; req.on("data", (c) => (data += c));
  req.on("end", () => { received.push({ url: req.url, headers: req.headers, body: data }); res.statusCode = req.url.startsWith("/fail") ? receiverStatus : 200; res.end("ok"); });
});
await new Promise((r) => server.listen(9911, "127.0.0.1", r));
const hookUrl = (p = "/hook") => `http://127.0.0.1:9911${p}`;
const sinceCount = () => received.length;
const verifySig = (r, secret) => {
  const [t, v1] = String(r.headers["x-loyalty-signature"] || "").split(",").map((p) => p.split("=")[1]);
  return v1 === crypto.createHmac("sha256", secret).update(`${t}.${r.body}`).digest("hex") && Math.abs(Date.now() / 1000 - Number(t)) < 60;
};
const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150); } return false; };

let campaignId, campaign2;
try {
  // ================= Chuẩn bị =================
  const camp = await raw(`${A}/campaigns`, { method: "POST", admin: ADMIN, body: { name: `E2F ${run}`, status: "active", spend_per_spin_minor: 1000000, max_spins_per_sale: 5 } });
  campaignId = camp.j?.id; check("setup campaign", camp.s === 201, camp);
  for (const [i, p] of [["Quà lớn", "product", 1000, 1], ["Chúc may mắn", "none", 1, 0]].entries())
    await raw(`${A}/campaigns/${campaignId}/prizes`, { method: "POST", admin: ADMIN, body: { name: p[0], prize_type: p[1], weight: p[2], max_wins: p[3], sort_order: i } });
  // chiến dịch thứ hai: chỉ tenant B tham gia (kiểm tra cô lập)
  const c2 = await raw(`${A}/campaigns`, { method: "POST", admin: ADMIN, body: { name: `E2F2 ${run}`, status: "active", spend_per_spin_minor: 1000000, max_spins_per_sale: 5 } });
  campaign2 = c2.j?.id;
  await raw(`${A}/campaigns/${campaign2}/prizes`, { method: "POST", admin: ADMIN, body: { name: "Có", prize_type: "none", weight: 1, max_wins: 0, sort_order: 0 } });
  await b(`${L}/reward-world/campaigns/${campaign2}/join`, { method: "POST" });

  // ================= 1. /events — kiểm tra đầu vào, chưa có luật =================
  const E = `${L}/events`;
  check("events no auth 401", (await raw(E, { method: "POST", body: { type: "checkin", customer_ref: "x" } })).s === 401);
  check("events type thiếu → 400", (await a(E, { method: "POST", body: { customer_ref: "0901" } })).s === 400);
  check("events type lạ → 400", (await a(E, { method: "POST", body: { type: "refund", customer_ref: "0901" } })).s === 400);
  check("events JSON hỏng → 400", (await a(E, { method: "POST", rawBody: "{x" })).s === 400);
  check("events GET không hỗ trợ → 404", (await a(E)).s === 404);
  check("events thiếu customer_ref → 400", (await a(E, { method: "POST", body: { type: "purchase", order_id: "o", amount_minor: 1 } })).s === 400);
  check("purchase thiếu order_id → 400", (await a(E, { method: "POST", body: { type: "purchase", customer_ref: "0901", amount_minor: 100000 } })).s === 400);
  check("purchase chưa có luật → 404", (await a(E, { method: "POST", body: { type: "purchase", customer_ref: "0901", order_id: "o1", amount_minor: 100000 } })).s === 404);

  await a(`${L}/program`, { method: "PUT", body: { spend_per_point_minor: 10000, points_per_step: 1 } });
  await a(`${G}/settings`, { method: "PUT", body: { checkin_points: 5, streak_milestones: [{ days: 2, points: 20 }] } });
  check("purchase amount 0 → 400", (await a(E, { method: "POST", body: { type: "purchase", customer_ref: "0901", order_id: "o0", amount_minor: 0 } })).s === 400);
  check("purchase amount chuỗi → 400", (await a(E, { method: "POST", body: { type: "purchase", customer_ref: "0901", order_id: "o0", amount_minor: "abc" } })).s === 400);
  check("purchase dưới mức tối thiểu → 409", (await a(E, { method: "POST", body: { type: "purchase", customer_ref: "0901", order_id: "oMin", amount_minor: 100 } })).s === 409);

  // ================= 2. /events — luồng chính + idempotency =================
  await a(`${L}/reward-world/campaigns/${campaignId}/join`, { method: "POST" });
  const C1 = "0909111222";
  const ev = { type: "purchase", customer_ref: C1, order_id: "HD1", source_type: "pos", amount_minor: 2500000, customer: { name: "Nguyễn Văn Anh", phone: C1 } };
  const p1 = await a(E, { method: "POST", body: ev, headers: { "idempotency-key": "pos:HD1" } });
  check("purchase 201", p1.s === 201, p1);
  check("purchase points 250 + balance 250", p1.j?.points_delta === 250 && p1.j?.balance === 250, p1.j);
  check("purchase sinh lượt quay (2.5tr/1tr = 2)", p1.j?.spins_earned === 2, p1.j);
  const p1r = await a(E, { method: "POST", body: ev, headers: { "idempotency-key": "pos:HD1" } });
  check("purchase replay 200, balance không đổi", p1r.s === 200 && p1r.j?.replayed === true && p1r.j?.balance === 250, p1r);
  check("cùng key khác số tiền → 409", (await a(E, { method: "POST", body: { ...ev, amount_minor: 999999 }, headers: { "idempotency-key": "pos:HD1" } })).s === 409);
  check("cùng order_id khác key → 409", (await a(E, { method: "POST", body: ev, headers: { "idempotency-key": "other-key" } })).s === 409);
  const noHeader = await a(E, { method: "POST", body: { ...ev, order_id: "HD2", amount_minor: 100000 } });
  check("không header → key mặc định purchase:HD2", noHeader.s === 201 && noHeader.j?.balance === 260, noHeader);
  check("replay mặc định → 200", (await a(E, { method: "POST", body: { ...ev, order_id: "HD2", amount_minor: 100000 } })).s === 200);
  check("balance đồng bộ với /account", (await a(`${L}/account?customer_ref=${C1}`)).j?.balance === 260);

  // redeem
  check("redeem khách lạ → 404", (await a(E, { method: "POST", body: { type: "redeem", customer_ref: "0000000", order_id: "R0", points: 1 } })).s === 404);
  check("redeem thiếu points → 400", (await a(E, { method: "POST", body: { type: "redeem", customer_ref: C1, order_id: "R0" } })).s === 400);
  check("redeem quá số dư → 409", (await a(E, { method: "POST", body: { type: "redeem", customer_ref: C1, order_id: "R1", points: 99999 } })).s === 409);
  const r1 = await a(E, { method: "POST", body: { type: "redeem", customer_ref: C1, order_id: "R2", points: 60 } });
  check("redeem 201 balance 200", r1.s === 201 && r1.j?.balance === 200 && r1.j?.points_delta === -60, r1);
  check("redeem replay 200", (await a(E, { method: "POST", body: { type: "redeem", customer_ref: C1, order_id: "R2", points: 60 } })).s === 200);
  check("redeem balance vẫn 200 sau replay", (await a(`${L}/account?customer_ref=${C1}`)).j?.balance === 200);

  // checkin
  const c1 = await a(E, { method: "POST", body: { type: "checkin", customer_ref: C1 } });
  check("checkin 201 +5", c1.s === 201 && c1.j?.points_delta === 5 && c1.j?.balance === 205, c1);
  const c1r = await a(E, { method: "POST", body: { type: "checkin", customer_ref: C1 } });
  check("checkin replay 200, không cộng thêm", c1r.s === 200 && c1r.j?.balance === 205, c1r);

  // ================= 3. Đồng thời =================
  const Cc = "0909333444";
  const evc = { type: "purchase", customer_ref: Cc, order_id: "CC1", amount_minor: 500000, customer: { name: "Race" } };
  const par = await Promise.all(Array.from({ length: 10 }, () => a(E, { method: "POST", body: evc, headers: { "idempotency-key": "pos:CC1" } })));
  const statuses = par.map((x) => x.s).sort();
  check("10 request song song cùng key → đúng 1×201, còn lại 200 (không 5xx)", statuses.filter((s) => s === 201).length === 1 && statuses.every((s) => s === 200 || s === 201), statuses);
  check("balance chỉ cộng một lần (50)", (await a(`${L}/account?customer_ref=${Cc}`)).j?.balance === 50);
  const reds = await Promise.all(Array.from({ length: 6 }, (_, i) => a(E, { method: "POST", body: { type: "redeem", customer_ref: Cc, order_id: `CR${i}`, points: 20 } })));
  check("6 lần trừ 20 song song trên 50 điểm → đúng 2 thành công", reds.filter((x) => x.s === 201).length === 2 && reds.every((x) => [201, 409].includes(x.s)), reds.map((x) => x.s));
  check("balance không âm (10)", (await a(`${L}/account?customer_ref=${Cc}`)).j?.balance === 10);
  const cip = await Promise.all(Array.from({ length: 6 }, () => a(E, { method: "POST", body: { type: "checkin", customer_ref: Cc } })));
  check("6 điểm danh song song → đúng 1×201", cip.filter((x) => x.s === 201).length === 1 && cip.every((x) => [200, 201].includes(x.s)), cip.map((x) => x.s));
  check("điểm danh chỉ cộng 5 một lần", (await a(`${L}/account?customer_ref=${Cc}`)).j?.balance === 15);

  // ================= 4. Webhook =================
  const sec1 = "whsec_test_one", sec2 = "whsec_test_two", sec3 = "whsec_test_three", sec4 = "whsec_off";
  const ep1 = await repo.createWebhookEndpoint({ tenant: tenantA, url: hookUrl("/hook"), secret: sec1, events: [] });
  const ep2 = await repo.createWebhookEndpoint({ tenant: tenantA, url: hookUrl("/only-reward"), secret: sec2, events: ["reward.won"] });
  const ep3 = await repo.createWebhookEndpoint({ tenant: tenantA, url: hookUrl("/fail"), secret: sec3, events: ["points.earned"] });
  const ep4 = await repo.createWebhookEndpoint({ tenant: tenantA, url: hookUrl("/disabled"), secret: sec4, events: [] });
  await repo.setWebhookActive(tenantA, ep4.id, false);
  // endpoint của tenant B không được nhận sự kiện của A
  await repo.createWebhookEndpoint({ tenant: tenantB, url: hookUrl("/tenant-b"), secret: "whsec_b", events: [] });
  receiverStatus = 500;

  const C2 = "0909555666";
  const w0 = sinceCount();
  const wp = await a(E, { method: "POST", body: { type: "purchase", customer_ref: C2, order_id: "W1", source_type: "pos", amount_minor: 1500000, customer: { name: "Hook" } } });
  check("webhook: purchase 201", wp.s === 201, wp);
  check("webhook: nhận points.earned + spin.issued tại /hook", await waitFor(() => received.slice(w0).filter((r) => r.url === "/hook").length >= 2));
  const mine = received.slice(w0).filter((r) => r.url === "/hook");
  const earned = mine.map((r) => JSON.parse(r.body)).find((x) => x.type === "points.earned");
  check("webhook: payload points.earned đúng", earned?.data?.points === 150 && earned?.data?.customer_ref === C2 && earned?.id && earned?.created_at, earned);
  check("webhook: chữ ký HMAC hợp lệ & mới", mine.every((r) => verifySig(r, sec1)), mine.map((r) => r.headers["x-loyalty-signature"]));
  check("webhook: header event/delivery", mine.every((r) => r.headers["x-loyalty-event"] && r.headers["x-loyalty-delivery"] && r.headers["content-type"] === "application/json"));
  check("webhook: chữ ký sai khi dùng secret khác", !verifySig(mine[0], "whsec_wrong"));
  check("webhook: lọc sự kiện — /only-reward không nhận gì", !received.slice(w0).some((r) => r.url === "/only-reward"));
  check("webhook: endpoint tắt không nhận", !received.slice(w0).some((r) => r.url === "/disabled"));
  check("webhook: tenant B không nhận sự kiện của A", !received.slice(w0).some((r) => r.url === "/tenant-b"));
  const failHits = received.slice(w0).filter((r) => r.url === "/fail");
  check("webhook: endpoint lỗi 500 được gọi 1 lần", failHits.length === 1, failHits.length);
  const dRow = (await sql.query("SELECT * FROM webhook_deliveries WHERE endpoint_id=$1", [ep3.id]))[0];
  check("webhook: delivery lỗi → pending, attempts=1, last_status=500, có lịch thử lại", dRow?.status === "pending" && dRow.attempts === 1 && dRow.last_status === 500 && new Date(dRow.next_attempt_at) > new Date(), dRow);
  const okRow = (await sql.query("SELECT status, attempts FROM webhook_deliveries WHERE endpoint_id=$1", [ep1.id])).every((r) => r.status === "success" && r.attempts === 1);
  check("webhook: delivery thành công đánh dấu success", okRow);

  // replay không gửi lại
  const w1 = sinceCount();
  await a(E, { method: "POST", body: { type: "purchase", customer_ref: C2, order_id: "W1", source_type: "pos", amount_minor: 1500000 } });
  await sleep(1200);
  check("webhook: replay /events không phát sự kiện mới", sinceCount() === w1, received.slice(w1).map((r) => r.url));

  // thử lại: đưa lịch về quá khứ, sửa receiver OK, một request bất kỳ sẽ nhặt lại
  receiverStatus = 200;
  await sql.query("UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 minute' WHERE endpoint_id=$1", [ep3.id]);
  const w2 = sinceCount();
  await a(E, { method: "POST", body: { type: "checkin", customer_ref: C2 } });
  check("webhook: lần thử lại được giao & đánh dấu success", await waitFor(async () => (await sql.query("SELECT status, attempts FROM webhook_deliveries WHERE endpoint_id=$1 AND status='success'", [ep3.id])).some((r) => r.attempts === 2)), received.slice(w2).map((r) => r.url));
  check("webhook: checkin phát checkin.completed tại /hook", await waitFor(() => received.slice(w2).some((r) => r.url === "/hook" && JSON.parse(r.body).type === "checkin.completed")));

  // redeem
  const w3 = sinceCount();
  await a(E, { method: "POST", body: { type: "redeem", customer_ref: C2, order_id: "WR1", points: 10 } });
  check("webhook: redeem phát points.redeemed", await waitFor(() => received.slice(w3).some((r) => r.url === "/hook" && JSON.parse(r.body).type === "points.redeemed" && JSON.parse(r.body).data.points === 10)));
  // /sales cũ cũng phát
  const w4 = sinceCount();
  await a(`${L}/sales`, { method: "POST", body: { idempotency_key: "oldsale", customer_ref: C2, source_ref: "OLD1", amount_minor: 200000 } });
  check("webhook: /sales (API cũ) phát points.earned", await waitFor(() => received.slice(w4).some((r) => r.url === "/hook" && JSON.parse(r.body).type === "points.earned")));

  // quản lý webhook qua API: key bị chặn
  check("webhooks list bằng API key → 403", (await a(`${L}/webhooks`)).s === 403);
  check("webhooks create bằng API key → 403", (await a(`${L}/webhooks`, { method: "POST", body: { url: "https://x.example/h" } })).s === 403);
  // handler quản lý với phiên (không qua Firebase)
  const mgmt = createWebhooksApi({ repository: repo });
  const call = (path, method = "GET", body, tenant = tenantA) => mgmt(new Request(`http://t${path}`, { method, body: body && JSON.stringify(body) }), { tenant, via: "session" }).then(async (r) => ({ s: r?.status, j: r ? await r.json() : null }), (e) => ({ s: e.status || 500, j: { error: e.message } }));
  const lst = await call(`${L}/webhooks`);
  check("mgmt: list không lộ secret", lst.s === 200 && lst.j.endpoints.length === 4 && !JSON.stringify(lst.j).includes("whsec_"), lst);
  check("mgmt: http:// bị từ chối", (await call(`${L}/webhooks`, "POST", { url: "http://shop.example/h" })).s === 400);
  check("mgmt: localhost bị từ chối", (await call(`${L}/webhooks`, "POST", { url: "https://localhost/h" })).s === 400);
  check("mgmt: sự kiện lạ bị từ chối", (await call(`${L}/webhooks`, "POST", { url: "https://shop.example/h", events: ["nope"] })).s === 400);
  const created = await call(`${L}/webhooks`, "POST", { url: "https://shop.example/h", events: ["reward.won"] });
  check("mgmt: tạo → trả secret một lần", created.s === 201 && /^whsec_[0-9a-f]{48}$/.test(created.j.secret) && !("secret" in created.j.endpoint), created);
  const full = await call(`${L}/webhooks`, "POST", { url: "https://shop2.example/h" });
  check("mgmt: vượt 5 endpoint → 400", full.s === 400, full);
  check("mgmt: ping tới endpoint cục bộ thành công", (await call(`${L}/webhooks/${ep1.id}/test`, "POST")).j?.status === "success");
  check("mgmt: ping endpoint người khác → 404", (await call(`${L}/webhooks/${ep1.id}/test`, "POST", undefined, tenantB)).s === 404);
  check("mgmt: PATCH active sai kiểu → 400", (await call(`${L}/webhooks/${ep1.id}`, "PATCH", { active: "yes" })).s === 400);
  check("mgmt: DELETE endpoint người khác → 404", (await call(`${L}/webhooks/${ep1.id}`, "DELETE", undefined, tenantB)).s === 404);
  check("mgmt: DELETE ok", (await call(`${L}/webhooks/${created.j.endpoint.id}`, "DELETE")).s === 200);
  const dl = await call(`${L}/webhooks/deliveries`);
  check("mgmt: lịch sử giao có dữ liệu", dl.s === 200 && dl.j.deliveries.length >= 5, dl.j?.deliveries?.length);
  check("mgmt: retry thủ công chạy được", (await call(`${L}/webhooks/deliveries/retry`, "POST")).s === 200);

  // ================= 5. Trang cửa hàng (store-page) =================
  check("store-page no auth 401", (await raw(`${L}/store-page`)).s === 401);
  check("store-page PUT trước GET → 404", (await a(`${L}/store-page`, { method: "PUT", body: { name: "x" } })).s === 404);
  const sp1 = await a(`${L}/store-page`), sp2 = await a(`${L}/store-page`);
  check("store-page tạo mặc định, slug ổn định", sp1.s === 200 && /^[a-z0-9]{8}$/.test(sp1.j.page.slug) && sp1.j.page.slug === sp2.j.page.slug && sp1.j.page.enabled === true, sp1);
  check("store-page không lộ tenant", !JSON.stringify(sp1.j).includes("tenant") && !JSON.stringify(sp1.j).includes(tenantA), sp1.j);
  const slugA = `e2f-${run}-a`, slugB = `e2f-${run}-b`;
  for (const bad of ["ab", "a b", "-abc", "a".repeat(31), "x/y", "../x", ""]) check(`store-page slug xấu "${bad.slice(0, 12)}" → 400`, (await a(`${L}/store-page`, { method: "PUT", body: { slug: bad } })).s === 400);
  check("store-page name rỗng → 400", (await a(`${L}/store-page`, { method: "PUT", body: { name: "  " } })).s === 400);
  check("store-page name >80 → 400", (await a(`${L}/store-page`, { method: "PUT", body: { name: "x".repeat(81) } })).s === 400);
  check("store-page enabled sai kiểu → 400", (await a(`${L}/store-page`, { method: "PUT", body: { enabled: "no" } })).s === 400);
  const putA = await a(`${L}/store-page`, { method: "PUT", body: { slug: slugA.toUpperCase(), name: "Quán <b>A</b>" } });
  check("store-page slug hoa → tự hạ chữ thường", putA.s === 200 && putA.j.page.slug === slugA, putA);
  await b(`${L}/store-page`);
  check("store-page trùng slug giữa 2 cửa hàng → 409", (await b(`${L}/store-page`, { method: "PUT", body: { slug: slugA } })).s === 409);
  check("store-page tenant B đặt slug khác OK", (await b(`${L}/store-page`, { method: "PUT", body: { slug: slugB, name: "Quán B" } })).s === 200);
  check("store-page cập nhật một phần không mất dữ liệu", (await a(`${L}/store-page`, { method: "PUT", body: { enabled: true } })).j?.page?.name === "Quán <b>A</b>");

  // ================= 6. API công khai =================
  const info = await pub(slugA, "");
  check("public info 200", info.s === 200 && info.j?.store?.name === "Quán <b>A</b>", info);
  check("public info có chương trình + campaign đã join", info.j?.program?.spend_per_point_minor === 10000 && info.j?.campaigns?.some((c) => c.id === campaignId), info.j);
  check("public info KHÔNG lộ tenant/weight/secret", !/e2f-a-|weight|max_wins|secret|key_hash/.test(info.text), info.text.slice(0, 200));
  check("public info không có campaign của tenant khác", !info.text.includes(campaign2));
  check("public info Cache-Control no-store", /no-store/.test(info.headers.get("cache-control") || ""), info.headers.get("cache-control"));
  check("public slug không tồn tại → 404", (await pub("khong-co-shop-nay", "")).s === 404);
  check("public slug chữ hoa → 404", (await pub(slugA.toUpperCase(), "")).s === 404);
  check("public slug ngắn → không match", [404].includes((await pub("ab", "")).s));
  check("public route lạ → 404", (await pub(slugA, "/admin")).s === 404);
  check("public GET /me (phải POST) → 404", (await pub(slugA, "/me")).s === 404);

  check("me: số sai định dạng → 400", (await pub(slugA, "/me", { phone: "abc" })).s === 400);
  check("me: thiếu phone → 400", (await pub(slugA, "/me", {})).s === 400);
  check("me: body hỏng → 400", (await raw(`/api/v1/public/${slugA}/me`, { method: "POST", rawBody: "{x" })).s === 400);
  check("me: SQL injection chỉ là số sai → 400", (await pub(slugA, "/me", { phone: "0909' OR '1'='1" })).s === 400);
  check("me: số lạ → 404, thông điệp thân thiện", (await pub(slugA, "/me", { phone: "0999888777" })).j?.error?.includes("first purchase"));
  const me = await pub(slugA, "/me", { phone: "0909 111 222" });
  check("me: chấp nhận khoảng trắng; tên chỉ còn tên gọi", me.s === 200 && me.j?.customer?.name === "Anh" && me.j?.balance === 205, me);
  check("me: dấu chấm/gạch cũng được", (await pub(slugA, "/me", { phone: "0909.111-222" })).s === 200);
  check("me: không lộ lịch sử/ledger/tenant", !/entries|ledger|tenant|e2f-a-/.test(me.text), me.text.slice(0, 200));
  check("me: có lượt quay còn lại", me.j?.spins?.[0]?.available === 2 && me.j.spins[0].campaign_id === campaignId, me.j?.spins);
  // cô lập: khách của B không thấy ở trang A
  await b(E, { method: "POST", body: { type: "purchase", customer_ref: "0909777888", order_id: "B1", amount_minor: 100000 } }); // chưa có luật → 404 (B chưa có luật)
  await b(`${L}/program`, { method: "PUT", body: { spend_per_point_minor: 10000 } });
  await b(E, { method: "POST", body: { type: "purchase", customer_ref: "0909777888", order_id: "B1", amount_minor: 100000 } });
  check("cô lập: khách của B không xem được qua trang A", (await pub(slugA, "/me", { phone: "0909777888" })).s === 404);
  check("cô lập: khách của B xem được ở trang B", (await pub(slugB, "/me", { phone: "0909777888" })).j?.balance === 10);
  check("cô lập: khách của A không xem được ở trang B", (await pub(slugB, "/me", { phone: C1 })).s === 404);

  // điểm danh công khai
  check("checkin: số lạ → 404 và KHÔNG tạo khách", (await pub(slugA, "/checkin", { phone: "0888000999" })).s === 404 && (await sql.query("SELECT 1 FROM loyalty_customers WHERE tenant=$1 AND customer_ref=$2", [tenantA, "0888000999"])).length === 0);
  const pc = await pub(slugA, "/checkin", { phone: C2 }); // C2 đã điểm danh hôm nay qua /events
  check("checkin: đã điểm danh qua API → replay 200", pc.s === 200 && pc.j?.replayed === true, pc);
  const C3 = "0909999000";
  await a(E, { method: "POST", body: { type: "purchase", customer_ref: C3, order_id: "P3", amount_minor: 100000, customer: { name: "<img src=x onerror=alert(1)> Mai" } } });
  const pc3 = await pub(slugA, "/checkin", { phone: C3 });
  check("checkin: 201 +5, balance 15", pc3.s === 201 && pc3.j?.points === 5 && pc3.j?.balance === 15, pc3);
  check("checkin: lần hai trong ngày 200", (await pub(slugA, "/checkin", { phone: C3 })).s === 200);
  const me3 = await pub(slugA, "/me", { phone: C3 });
  check("me: tên chứa HTML chỉ trả token cuối (frontend phải escape)", me3.j?.customer?.name === "Mai", me3.j?.customer);

  // nhiệm vụ công khai
  const mk = await a(`${G}/missions`, { method: "POST", body: { name: "Điểm danh nhiệm vụ", kind: "checkin", target: 1, reward_type: "points", reward_points: 7 } });
  const mk2 = await a(`${G}/missions`, { method: "POST", body: { name: "Mua 5 đơn", kind: "receipts", target: 5, reward_type: "points", reward_points: 9 } });
  const meM = await pub(slugA, "/me", { phone: C3 });
  const m1 = meM.j.missions.find((m) => m.id === mk.j.id), m2 = meM.j.missions.find((m) => m.id === mk2.j.id);
  check("nhiệm vụ: checkin đã hoàn thành, receipts chưa", m1?.completed === true && m1.claimed === false && m2?.completed === false && m2.current === 1, meM.j.missions);
  check("claim chưa đủ điều kiện → 409", (await pub(slugA, `/missions/${mk2.j.id}/claim`, { phone: C3 })).s === 409);
  check("claim nhiệm vụ không tồn tại → 404", (await pub(slugA, "/missions/khong-co/claim", { phone: C3 })).s === 404);
  check("claim nhiệm vụ của tenant khác → 404", (await pub(slugA, `/missions/${(await b(`${G}/missions`, { method: "POST", body: { name: "B", kind: "checkin", target: 1, reward_type: "points", reward_points: 1 } })).j.id}/claim`, { phone: C3 })).s === 404);
  const cl = await Promise.all(Array.from({ length: 5 }, () => pub(slugA, `/missions/${mk.j.id}/claim`, { phone: C3 })));
  check("claim song song → đúng 1×201, không 5xx", cl.filter((x) => x.s === 201).length === 1 && cl.every((x) => [200, 201].includes(x.s)), cl.map((x) => x.s));
  check("claim chỉ cộng 7 một lần (balance 22)", (await pub(slugA, "/me", { phone: C3 })).j?.balance === 22);
  check("me: nhiệm vụ đã nhận hiển thị claimed", (await pub(slugA, "/me", { phone: C3 })).j.missions.find((m) => m.id === mk.j.id)?.claimed === true);

  // quay công khai
  const SPIN = (phone, extra = {}) => pub(slugA, "/spin", { phone, campaign_id: campaignId, request_id: crypto.randomUUID(), ...extra });
  check("spin: request_id thiếu/sai → 400", (await pub(slugA, "/spin", { phone: C1, campaign_id: campaignId })).s === 400 && (await pub(slugA, "/spin", { phone: C1, campaign_id: campaignId, request_id: "!!" })).s === 400);
  check("spin: campaign không tồn tại → 404", (await SPIN(C1, { campaign_id: "khong-co" })).s === 404);
  check("spin: campaign chỉ tenant B tham gia → 409", (await SPIN(C1, { campaign_id: campaign2 })).s === 409);
  check("spin: khách không có lượt → 409", (await SPIN(C3)).s === 409);
  check("spin: số lạ → 404", (await SPIN("0123456789")).s === 404);
  const rid = crypto.randomUUID();
  const w5 = sinceCount();
  const s1 = await pub(slugA, "/spin", { phone: C1, campaign_id: campaignId, request_id: rid });
  check("spin 201, trả đúng prize + spins_left", s1.s === 201 && s1.j?.prize?.id && s1.j?.prize?.name && s1.j.spins_left[0].available === 1, s1);
  check("spin: không lộ weight/value", !/weight|value_json|max_wins/.test(s1.text), s1.text);
  const s1r = await pub(slugA, "/spin", { phone: C1, campaign_id: campaignId, request_id: rid });
  check("spin replay cùng request_id → 200, cùng giải, không trừ thêm lượt", s1r.s === 200 && s1r.j?.prize?.id === s1.j?.prize?.id && s1r.j?.replayed === true && s1r.j.spins_left[0].available === 1, s1r);
  check("webhook: spin công khai phát reward.won tại /hook & /only-reward", await waitFor(() => received.slice(w5).some((r) => r.url === "/only-reward" && JSON.parse(r.body).type === "reward.won")) && received.slice(w5).some((r) => r.url === "/hook" && JSON.parse(r.body).type === "reward.won"), received.slice(w5).map((r) => r.url));
  const w6 = sinceCount(); await pub(slugA, "/checkin", { phone: "0909555666" });
  // spin trên /loyalty (API) cũng phát reward.won
  // đồng thời: C1 còn 1 lượt, bắn 6 yêu cầu → đúng 1 thành công
  const par2 = await Promise.all(Array.from({ length: 6 }, () => SPIN(C1)));
  // Thiết kế: yêu cầu thua cuộc đua trên cùng một lượt quay nhận lại kết quả của yêu cầu thắng (200), không tạo thêm kết quả.
  check("6 spin song song với 1 lượt → không 5xx, chỉ có 1 kết quả mới được ghi", par2.every((x) => [200, 201, 409].includes(x.s)) && (await sql.query("SELECT count(*)::int n FROM reward_spin_results WHERE tenant=$1 AND customer_ref=$2", [tenantA, C1]))[0].n === 2, par2.map((x) => x.s));
  check("các yêu cầu thua cuộc đua nhận cùng một giải với yêu cầu thắng", new Set(par2.filter((x) => x.s !== 409).map((x) => x.j.prize.id)).size === 1);
  check("hết lượt sau đó → 409", (await SPIN(C1)).s === 409);
  // giải max_wins=1: tối đa 1 người trúng "Quà lớn" dù quay nhiều
  const bulk = [];
  for (let i = 0; i < 4; i += 1) {
    const ph = `09099000${i}${i}`; await a(E, { method: "POST", body: { type: "purchase", customer_ref: ph, order_id: `BULK${i}`, amount_minor: 5000000 } });
    for (let k = 0; k < 5; k += 1) { const r = await SPIN(ph); if (r.s === 201) bulk.push(r); }
  }
  const bigWins = bulk.filter((x) => x.j.prize.name === "Quà lớn").length;
  check(`giải max_wins=1 chỉ trúng tối đa 1 lần (thực tế ${bigWins}/${bulk.length} lượt)`, bigWins <= 1 && bulk.length >= 15, { bigWins, spins: bulk.length });
  check("kết quả quay lưu đúng tenant", (await sql.query("SELECT count(*)::int n FROM reward_spin_results WHERE tenant=$1 AND game='wheel'", [tenantA]))[0].n >= bulk.length);

  // tắt trang → khách không vào được; bật lại → vào được; đổi slug → link cũ chết
  await a(`${L}/store-page`, { method: "PUT", body: { enabled: false } });
  check("trang tắt: info/me/checkin/spin đều 404", (await pub(slugA, "")).s === 404 && (await pub(slugA, "/me", { phone: C1 })).s === 404 && (await pub(slugA, "/checkin", { phone: C1 })).s === 404 && (await SPIN(C1)).s === 404);
  await a(`${L}/store-page`, { method: "PUT", body: { enabled: true } });
  check("bật lại: vào được", (await pub(slugA, "")).s === 200);
  const slugA2 = `${slugA}-new`;
  await a(`${L}/store-page`, { method: "PUT", body: { slug: slugA2 } });
  check("đổi slug: link cũ 404, link mới 200", (await pub(slugA, "")).s === 404 && (await pub(slugA2, "")).s === 200);

  // ================= 7. Trang tĩnh =================
  const page = await raw("/c?s=abc");
  check("/c phục vụ trang khách", page.s === 200 && /Điểm thưởng/.test(page.text));
  check("/qr.html phục vụ", (await raw("/qr.html")).s === 200 || (await raw("/qr")).s === 200);
  check("trang khách không nhúng secret/tenant", !/DATABASE_URL|ADMIN_SECRET|x-admin-secret/.test(page.text));
  // Pages không có 404.html nên trả index.html cho đường dẫn lạ; quan trọng là nội dung nguồn không lộ.
  check("src/ & schema.sql không bị public", !/CREATE TABLE/.test((await raw("/schema.sql")).text) && !/emitWebhookEvent/.test((await raw("/src/webhooks.js")).text));
} catch (error) {
  fails.push("EXCEPTION " + (error.stack || error));
} finally {
  server.close();
  const tables = ["webhook_deliveries", "webhook_endpoints", "store_pages", "game_treasure_claims", "game_treasures", "game_gifts", "game_mission_claims", "game_missions", "game_streak_rewards", "game_checkins", "game_settings", "reward_claims", "reward_spin_results", "reward_spin_entitlements", "reward_store_joins", "loyalty_ledger", "loyalty_customers", "loyalty_programs", "api_keys"];
  for (const tenant of [tenantA, tenantB]) for (const tb of tables) { try { await sql.query(`DELETE FROM ${tb} WHERE tenant=$1`, [tenant]); } catch (e) { console.log("cleanup", tb, e.message); } }
  for (const id of [campaignId, campaign2].filter(Boolean)) {
    await sql.query("DELETE FROM reward_campaign_prizes WHERE campaign_id=$1", [id]); await sql.query("DELETE FROM reward_store_joins WHERE campaign_id=$1", [id]); await sql.query("DELETE FROM reward_campaigns WHERE id=$1", [id]);
  }
  const left = await sql.query("SELECT (SELECT count(*) FROM loyalty_ledger WHERE tenant IN ($1,$2)) + (SELECT count(*) FROM webhook_endpoints WHERE tenant IN ($1,$2)) AS n", [tenantA, tenantB]);
  console.log(`PASS ${pass}  FAIL ${fails.length}  (còn dữ liệu test: ${left[0].n})`);
  for (const f of fails) console.log(" ✖", f);
}
process.exit(fails.length ? 1 : 0);
