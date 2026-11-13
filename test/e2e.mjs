// E2E qua HTTP tới wrangler dev. Tenant tạm + chiến dịch tạm, tự dọn.
// Chạy: terminal 1 `npm run dev`; terminal 2 `DATABASE_URL=... ADMIN_SECRET=... npm run test:e2e` (E2E_BASE đổi địa chỉ server).
import { neon } from "@neondatabase/serverless";
import { createNeonRepository } from "../src/neonRepository.js";
import { generateApiKey, sha256Hex } from "../src/auth.js";

const BASE = process.env.E2E_BASE || "http://localhost:8788";
const url = process.env.DATABASE_URL, ADMIN = process.env.ADMIN_SECRET;
if (!url || !ADMIN) { console.error("Cần DATABASE_URL và ADMIN_SECRET."); process.exit(2); }
try { await fetch(BASE + "/docs.html"); } catch { console.error(`Không kết nối được ${BASE}. Chạy 'npm run dev' trước.`); process.exit(2); }
const tenant = `e2e-${crypto.randomUUID().slice(0, 8)}`;
const sql = neon(url);
const repo = createNeonRepository(url);
const key = generateApiKey();
await repo.createApiKey({ tenant, name: "e2e", keyPrefix: key.slice(0, 10), keyHash: await sha256Hex(key) });

let pass = 0; const fails = [];
const check = (name, cond, extra) => { if (cond) pass++; else { fails.push(name + (extra !== undefined ? " :: " + JSON.stringify(extra).slice(0, 300) : "")); } };
async function api(path, { method = "GET", body, auth = key, admin } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (admin) headers["x-admin-secret"] = admin;
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { s: r.status, j };
}
const L = "/api/v1/loyalty", G = `${L}/games`, A = "/api/v1/admin/reward-world";
let campaignId;
try {
  // ---- Auth & admin
  check("no auth → 401", (await api(`${L}/program`, { auth: null })).s === 401);
  check("bad key → 401", (await api(`${L}/program`, { auth: "lsk_bad" })).s === 401);
  check("admin w/o secret → 401/403", [401, 403].includes((await api(`${A}/campaigns`, { auth: null })).s));
  check("admin wrong secret", [401, 403].includes((await api(`${A}/campaigns`, { auth: null, admin: "nope" })).s));
  check("unknown route 404", (await api(`${L}/nothing`)).s === 404);
  check("api-keys via key → 403", (await api(`${L}/api-keys`)).s === 403);
  check("invalid JSON → 400", (await fetch(BASE + `${L}/sales`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "{x" })).status === 400);

  // ---- Admin: campaign + prizes
  const camp = await api(`${A}/campaigns`, { method: "POST", auth: null, admin: ADMIN, body: { name: `E2E ${tenant}`, status: "active", spend_per_spin_minor: 1000000, max_spins_per_sale: 3 } });
  check("admin create campaign 201", camp.s === 201, camp);
  campaignId = camp.j?.id;
  check("campaign invalid status 400", (await api(`${A}/campaigns`, { method: "POST", auth: null, admin: ADMIN, body: { name: "x", status: "zzz", spend_per_spin_minor: 1 } })).s === 400);
  const prizes = [];
  for (const [i, p] of [["Giảm 10%", "voucher"], ["10 điểm", "points"], ["Túi vải", "product"], ["Chúc may mắn", "none"], ["Mã đối tác", "partner_code"], ["Bonus", "points"]].entries()) {
    const r = await api(`${A}/campaigns/${campaignId}/prizes`, { method: "POST", auth: null, admin: ADMIN, body: { name: p[0], prize_type: p[1], weight: 1, max_wins: 0, sort_order: i, value: p[1] === "points" ? { points: 10 } : {} } });
    check(`prize ${p[0]} 201`, r.s === 201, r); prizes.push(r.j);
  }
  check("prize bad type 400", (await api(`${A}/campaigns/${campaignId}/prizes`, { method: "POST", auth: null, admin: ADMIN, body: { name: "x", prize_type: "bad", weight: 1 } })).s === 400);
  check("prize weight 0 → 400", (await api(`${A}/campaigns/${campaignId}/prizes`, { method: "POST", auth: null, admin: ADMIN, body: { name: "x", prize_type: "none", weight: 0 } })).s === 400);
  check("patch prize 200", (await api(`${A}/prizes/${prizes[0].id}`, { method: "PATCH", auth: null, admin: ADMIN, body: { name: "Giảm 15%" } })).s === 200);
  check("patch campaign 200", (await api(`${A}/campaigns/${campaignId}`, { method: "PATCH", auth: null, admin: ADMIN, body: { description: "desc" } })).s === 200);
  check("patch missing campaign 404", (await api(`${A}/campaigns/nope`, { method: "PATCH", auth: null, admin: ADMIN, body: { name: "x" } })).s === 404);
  check("admin list has campaign", JSON.stringify((await api(`${A}/campaigns`, { auth: null, admin: ADMIN })).j).includes(campaignId));

  // ---- Program (luật tích điểm)
  check("program empty", (await api(`${L}/program`)).s === 200);
  check("program invalid", (await api(`${L}/program`, { method: "PUT", body: { spend_per_point_minor: -1 } })).s === 400);
  const prog = await api(`${L}/program`, { method: "PUT", body: { spend_per_point_minor: 10000, points_per_step: 1 } });
  check("program PUT 200", prog.s === 200, prog);
  check("program version", (await api(`${L}/program`)).j?.program?.version >= 1);

  // ---- Sales / account / redemptions
  const R = "0909000111";
  const sale1 = { idempotency_key: "s1", customer_ref: R, source_type: "pos", source_ref: "HD1", amount_minor: 2500000, customer: { name: "An", phone: R } };
  const s1 = await api(`${L}/sales`, { method: "POST", body: sale1 });
  check("sale 201 +250 điểm", s1.s === 201 && Number(s1.j?.entry?.points_delta) === 250, s1);
  check("sale replay 200", (await api(`${L}/sales`, { method: "POST", body: sale1 })).s === 200);
  check("sale invalid 400", (await api(`${L}/sales`, { method: "POST", body: { customer_ref: R } })).s === 400);
  check("sale amount 0/neg 400", (await api(`${L}/sales`, { method: "POST", body: { ...sale1, idempotency_key: "s0", source_ref: "HD0", amount_minor: -5 } })).s === 400);
  let acc = await api(`${L}/account?customer_ref=${R}`);
  check("account balance 250", acc.j?.balance === 250, acc.j);
  check("account missing ref 400", (await api(`${L}/account`)).s === 400);
  const red = { idempotency_key: "r1", customer_ref: R, source_ref: "G1", points: 50 };
  check("redeem 201", (await api(`${L}/redemptions`, { method: "POST", body: red })).s === 201);
  check("redeem replay 200", (await api(`${L}/redemptions`, { method: "POST", body: red })).s === 200);
  check("redeem too many → 4xx", [400, 409].includes((await api(`${L}/redemptions`, { method: "POST", body: { ...red, idempotency_key: "r2", source_ref: "G2", points: 99999 } })).s));
  check("balance after redeem 200", (await api(`${L}/account?customer_ref=${R}`)).j?.balance === 200);
  check("stats 200", (await api(`${L}/stats`)).s === 200);

  // ---- Reward world: join, entitlements, spin 4 game, claim
  const camps = await api(`${L}/reward-world/campaigns`);
  check("list campaigns", camps.s === 200 && JSON.stringify(camps.j).includes(campaignId), camps.s);
  check("spin before join → 409", (await api(`${L}/reward-world/spins`, { method: "POST", body: { campaign_id: campaignId, customer_ref: R, idempotency_key: "x0" } })).s === 409);
  check("join 200", (await api(`${L}/reward-world/campaigns/${campaignId}/join`, { method: "POST" })).s === 200);
  check("join missing 404", (await api(`${L}/reward-world/campaigns/nope/join`, { method: "POST" })).s === 404);
  // Tạo thêm hóa đơn lớn để có lượt quay (sau khi join)
  const bigs = await api(`${L}/sales`, { method: "POST", body: { idempotency_key: "s2", customer_ref: R, source_type: "pos", source_ref: "HD2", amount_minor: 5000000 } });
  check("big sale 201", bigs.s === 201, bigs);
  let ent = await api(`${L}/reward-world/entitlements?customer_ref=${R}`);
  check("có lượt quay", JSON.stringify(ent.j).match(/\d/) && (ent.j?.available ?? ent.j?.count ?? 0) >= 1, ent.j);
  const have = ent.j?.available ?? ent.j?.count ?? 0;
  const results = [];
  for (const [i, game] of ["wheel", "cards", "dice", "slot", "bogus"].entries()) {
    const r = await api(`${L}/reward-world/spins`, { method: "POST", body: { campaign_id: campaignId, customer_ref: R, idempotency_key: `sp${i}`, game } });
    if (game === "bogus") check("spin game bogus → 400 hoặc fallback", [400, 201].includes(r.s), r);
    else if (i < have) { check(`spin ${game} ok`, r.s === 201 && r.j?.result, r); results.push(r.j?.result); }
    else check(`spin ${game} hết lượt → 409`, r.s === 409, r);
  }
  const replay = await api(`${L}/reward-world/spins`, { method: "POST", body: { campaign_id: campaignId, customer_ref: R, idempotency_key: "sp0", game: "wheel" } });
  check("spin replay 200", replay.s === 200, replay);
  const rewards = await api(`${L}/reward-world/rewards?customer_ref=${R}`);
  check("rewards list 200", rewards.s === 200, rewards);
  const won = results.find((x) => x?.status === "won");
  if (won) {
    const c1 = await api(`${L}/reward-world/results/${won.id}/claim`, { method: "POST", body: { claim_note: "ok" } });
    check("claim 201", c1.s === 201, c1);
    check("claim replay 200", (await api(`${L}/reward-world/results/${won.id}/claim`, { method: "POST", body: { claim_note: "ok" } })).s === 200);
    check("claim note too long 400", (await api(`${L}/reward-world/results/${won.id}/claim`, { method: "POST", body: { claim_note: "x".repeat(600) } })).s === 400);
  }
  const nowin = results.find((x) => x?.status === "no_win");
  if (nowin) check("claim no_win 409", (await api(`${L}/reward-world/results/${nowin.id}/claim`, { method: "POST", body: {} })).s === 409);
  check("claim missing 404", (await api(`${L}/reward-world/results/nope/claim`, { method: "POST", body: {} })).s === 404);

  // ---- Games: settings, check-in, streak
  const gs = await api(`${G}/settings`);
  check("game settings GET", gs.s === 200, gs);
  check("game settings invalid", (await api(`${G}/settings`, { method: "PUT", body: { checkin_points: -1 } })).s === 400);
  check("game settings PUT", (await api(`${G}/settings`, { method: "PUT", body: { checkin_points: 5, streak_milestones: [{ days: 2, points: 20 }, { days: 3, points: 30 }] } })).s === 200);
  const ci = await api(`${G}/checkin`, { method: "POST", body: { customer_ref: R } });
  check("checkin 201", ci.s === 201 && ci.j?.streak === 1, ci);
  check("checkin replay 200", (await api(`${G}/checkin`, { method: "POST", body: { customer_ref: R } })).s === 200);
  check("checkin no ref 400", (await api(`${G}/checkin`, { method: "POST", body: {} })).s === 400);
  const cs = await api(`${G}/checkin?customer_ref=${R}`);
  check("checkin status", cs.s === 200 && cs.j?.checked_in_today === true, cs);

  // ---- Missions (day) & Challenges (week)
  for (const [kind, base, per] of [["missions", `${G}/missions`, "day"], ["challenges", `${G}/challenges`, "week"]]) {
    check(`${kind} create invalid`, (await api(base, { method: "POST", body: { name: "", kind: "x" } })).s === 400);
    const mc = await api(base, { method: "POST", body: { name: `${kind} checkin`, kind: "checkin", target: 1, reward_type: "points", reward_points: 7 } });
    check(`${kind} create checkin 201`, mc.s === 201 && mc.j?.period === per, mc);
    const mr = await api(base, { method: "POST", body: { name: `${kind} receipts`, kind: "receipts", target: 99, reward_type: "spin", reward_campaign_id: campaignId } });
    check(`${kind} create receipts 201`, mr.s === 201, mr);
    const ms = await api(base, { method: "POST", body: { name: `${kind} spend`, kind: "spend", target: 1000, reward_type: "points", reward_points: 3 } });
    check(`${kind} create spend 201`, ms.s === 201, ms);
    check(`${kind} spin w/o campaign 400`, (await api(base, { method: "POST", body: { name: "x", kind: "spend", target: 1, reward_type: "spin" } })).s === 400);
    check(`${kind} admin list`, (await api(base)).j?.missions?.length === 3);
    check(`${kind} patch`, (await api(`${base}/${mc.j.id}`, { method: "PATCH", body: { name: "renamed" } })).s === 200);
    check(`${kind} patch missing 404`, (await api(`${base}/nope`, { method: "PATCH", body: { name: "x" } })).s === 404);
    const board = await api(`${base}?customer_ref=${R}`);
    check(`${kind} board`, board.s === 200, board);
    const c1 = await api(`${base}/${mc.j.id}/claim`, { method: "POST", body: { customer_ref: R } });
    check(`${kind} claim checkin 201`, c1.s === 201, c1);
    check(`${kind} claim replay 200`, (await api(`${base}/${mc.j.id}/claim`, { method: "POST", body: { customer_ref: R } })).s === 200);
    check(`${kind} claim incomplete 409`, (await api(`${base}/${mr.j.id}/claim`, { method: "POST", body: { customer_ref: R } })).s === 409);
    check(`${kind} claim spend 201`, (await api(`${base}/${ms.j.id}/claim`, { method: "POST", body: { customer_ref: R } })).s === 201); // đã chi 7.5tr hôm nay
    check(`${kind} claim missing 404`, (await api(`${base}/nope/claim`, { method: "POST", body: { customer_ref: R } })).s === 404);
    check(`${kind} archive`, (await api(`${base}/${mr.j.id}`, { method: "PATCH", body: { status: "archived" } })).s === 200);
    check(`${kind} claim archived 404`, (await api(`${base}/${mr.j.id}/claim`, { method: "POST", body: { customer_ref: R } })).s === 404);
  }
  // week checkin target > 7
  check("challenge checkin target 8 → 400", (await api(`${G}/challenges`, { method: "POST", body: { name: "x", kind: "checkin", target: 8, reward_type: "points", reward_points: 1 } })).s === 400);
  // cross-use: challenge id via missions route must 404
  const chList = (await api(`${G}/challenges`)).j.missions;
  check("challenge id không claim được qua /missions", (await api(`${G}/missions/${chList[0].id}/claim`, { method: "POST", body: { customer_ref: R } })).s === 404);

  // ---- Treasures + gifts
  check("treasure invalid", (await api(`${G}/treasures`, { method: "POST", body: { name: "x", reward_type: "nope" } })).s === 400);
  check("treasure code short", (await api(`${G}/treasures`, { method: "POST", body: { name: "x", reward_type: "points", reward_points: 1, code: "ab" } })).s === 400);
  const tr = await api(`${G}/treasures`, { method: "POST", body: { name: "Kho 1", reward_type: "gift", reward_label: "Ly sứ", max_claims: 1, hint: "ở poster" } });
  check("treasure create auto code", tr.s === 201 && /^[A-Z0-9]{8}$/.test(tr.j?.code || ""), tr);
  const tp = await api(`${G}/treasures`, { method: "POST", body: { name: "Kho 2", reward_type: "points", reward_points: 15, code: "e2e-code-1" } });
  check("treasure custom code normalized", tp.j?.code === "E2ECODE1", tp);
  check("treasure duplicate code 409", (await api(`${G}/treasures`, { method: "POST", body: { name: "dup", reward_type: "points", reward_points: 1, code: "E2ECODE1" } })).s === 409);
  check("treasure list", (await api(`${G}/treasures`)).j?.treasures?.length === 2);
  const rd = await api(`${G}/treasure/redeem`, { method: "POST", body: { customer_ref: R, code: "e2e code-1" } });
  check("redeem treasure 201", rd.s === 201, rd);
  check("redeem treasure replay 200", (await api(`${G}/treasure/redeem`, { method: "POST", body: { customer_ref: R, code: "E2ECODE1" } })).s === 200);
  check("redeem wrong code 404", (await api(`${G}/treasure/redeem`, { method: "POST", body: { customer_ref: R, code: "ZZZZZZZZ" } })).s === 404);
  check("redeem gift 201", (await api(`${G}/treasure/redeem`, { method: "POST", body: { customer_ref: R, code: tr.j.code } })).s === 201);
  check("redeem full (max_claims 1) by other → 409", (await api(`${G}/treasure/redeem`, { method: "POST", body: { customer_ref: "0909999", code: tr.j.code } })).s === 409);
  check("treasure pause", (await api(`${G}/treasures/${tp.j.id}`, { method: "PATCH", body: { status: "paused" } })).s === 200);
  check("redeem paused 409", (await api(`${G}/treasure/redeem`, { method: "POST", body: { customer_ref: "0909888", code: "E2ECODE1" } })).s === 409);
  // concurrency: max_claims=2, 8 người đồng thời
  const tc = await api(`${G}/treasures`, { method: "POST", body: { name: "Race", reward_type: "points", reward_points: 1, max_claims: 2 } });
  const race = await Promise.all(Array.from({ length: 8 }, (_, i) => api(`${G}/treasure/redeem`, { method: "POST", body: { customer_ref: `race${i}`, code: tc.j.code } })));
  check("race: đúng 2 người nhận", race.filter((x) => x.s === 201).length === 2, race.map((x) => x.s));
  const gifts = await api(`${G}/gifts`);
  check("gifts list có quà chờ giao", gifts.s === 200 && gifts.j?.gifts?.length >= 1, gifts);
  const pending = (await api(`${G}/gifts?status=pending`)).j?.gifts || gifts.j.gifts;
  const g0 = pending[0];
  check("gift deliver 200", (await api(`${G}/gifts/${g0.id}/deliver`, { method: "POST" })).s === 200);
  check("gift deliver missing 404", (await api(`${G}/gifts/nope/deliver`, { method: "POST" })).s === 404);

  // ---- Draws
  check("draw invalid", (await api(`${G}/draws`, { method: "POST", body: { name: "x", prizes: [] } })).s === 400);
  const dr = await api(`${G}/draws`, { method: "POST", body: { name: "Rút thăm", status: "open", spend_per_ticket_minor: 1000000, max_tickets_per_sale: 5, one_prize_per_customer: true, prizes: [{ name: "Giải nhất", quantity: 1 }, { name: "Giải nhì", quantity: 2 }] } });
  check("draw create 201", dr.s === 201, dr);
  const D = dr.j?.id;
  check("draw list", (await api(`${G}/draws`)).j?.draws?.length >= 1);
  check("draw draw w/o tickets 409", (await api(`${G}/draws/${D}/draw`, { method: "POST" })).s === 409);
  // hóa đơn tạo vé tự động
  await api(`${L}/sales`, { method: "POST", body: { idempotency_key: "s3", customer_ref: "dA", source_type: "pos", source_ref: "HD3", amount_minor: 3000000 } });
  await api(`${L}/sales`, { method: "POST", body: { idempotency_key: "s4", customer_ref: "dB", source_type: "pos", source_ref: "HD4", amount_minor: 2000000 } });
  const gt = await api(`${G}/draws/${D}/tickets`, { method: "POST", body: { customer_ref: "dC", count: 2, idempotency_key: "m1" } });
  check("grant tickets 201", gt.s === 201, gt);
  check("grant count 0 → 400", (await api(`${G}/draws/${D}/tickets`, { method: "POST", body: { customer_ref: "dC", count: 0 } })).s === 400);
  const dd = await api(`${G}/draws/${D}?customer_ref=dA`);
  check("draw detail", dd.s === 200, dd);
  check("auto tickets từ hóa đơn", JSON.stringify(dd.j).match(/ticket/i) !== null, dd.j);
  check("patch draw", (await api(`${G}/draws/${D}`, { method: "PATCH", body: { name: "Rút thăm v2" } })).s === 200);
  const run = await api(`${G}/draws/${D}/draw`, { method: "POST" });
  check("run draw 201", run.s === 201, run);
  check("run draw again 409", (await api(`${G}/draws/${D}/draw`, { method: "POST" })).s === 409);
  check("edit drawn 409", (await api(`${G}/draws/${D}`, { method: "PATCH", body: { name: "x" } })).s === 409);
  check("grant after drawn 409", (await api(`${G}/draws/${D}/tickets`, { method: "POST", body: { customer_ref: "dZ" } })).s === 409);
  const after = await api(`${G}/draws/${D}`);
  const winners = after.j?.winners || [];
  check("winners ≤ 3 & mỗi khách 1 giải", winners.length >= 1 && winners.length <= 3 && new Set(winners.map((w) => w.customer_ref)).size === winners.length, winners.map((w) => w.customer_ref));
  if (winners[0]) {
    check("claim winner 200", (await api(`${G}/draws/${D}/winners/${winners[0].id}/claim`, { method: "POST" })).s === 200);
    check("claim winner missing 404", (await api(`${G}/draws/${D}/winners/nope/claim`, { method: "POST" })).s === 404);
  }
  check("draw missing 404", (await api(`${G}/draws/nope`)).s === 404);

  // ---- Cách ly tenant
  const key2 = generateApiKey(); const t2 = `${tenant}-b`;
  await repo.createApiKey({ tenant: t2, name: "b", keyPrefix: key2.slice(0, 10), keyHash: await sha256Hex(key2) });
  check("tenant B không thấy khách tenant A", (await api(`${L}/account?customer_ref=${R}`, { auth: key2 })).j?.balance === 0 || (await api(`${L}/account?customer_ref=${R}`, { auth: key2 })).s === 404);
  check("tenant B không thấy draw A", (await api(`${G}/draws/${D}`, { auth: key2 })).s === 404);
  check("tenant B không thấy treasure A", (await api(`${G}/treasures`, { auth: key2 })).j?.treasures?.length === 0);
  check("tenant B không sửa mission A", (await api(`${G}/missions/${chList[0].id}`, { auth: key2, method: "PATCH", body: { name: "hack" } })).s === 404);
  await sql.query("DELETE FROM api_keys WHERE tenant=$1", [t2]);
  for (const tb of ["game_treasure_claims","game_treasures","game_gifts","game_draw_winners","game_draw_tickets","game_draws","game_mission_claims","game_missions","game_streak_rewards","game_checkins","game_settings","reward_spin_entitlements","reward_spin_results","reward_claims","reward_store_joins","loyalty_ledger","loyalty_customers","loyalty_programs"]) await sql.query(`DELETE FROM ${tb} WHERE tenant=$1`, [t2]);

  // ---- Thu hồi key
  await sql.query("UPDATE api_keys SET revoked_at=now() WHERE tenant=$1", [tenant]);
  check("revoked key → 401", (await api(`${L}/program`)).s === 401);
} catch (e) {
  fails.push("EXCEPTION " + e.stack);
} finally {
  const tables = ["game_treasure_claims","game_treasures","game_gifts","game_draw_winners","game_draw_tickets","game_draws","game_mission_claims","game_missions","game_streak_rewards","game_checkins","game_settings","reward_claims","reward_spin_results","reward_spin_entitlements","reward_store_joins","loyalty_ledger","loyalty_customers","loyalty_programs","api_keys"];
  for (const tb of tables) { try { await sql.query(`DELETE FROM ${tb} WHERE tenant=$1`, [tenant]); } catch (e) { console.log("cleanup", tb, e.message); } }
  if (campaignId) { await sql.query("DELETE FROM reward_campaign_prizes WHERE campaign_id=$1", [campaignId]); await sql.query("DELETE FROM reward_store_joins WHERE campaign_id=$1", [campaignId]); await sql.query("DELETE FROM reward_campaigns WHERE id=$1", [campaignId]); }
  const left = await sql.query("SELECT count(*)::int n FROM loyalty_ledger WHERE tenant=$1", [tenant]);
  console.log(`PASS ${pass}  FAIL ${fails.length}  (còn dữ liệu test: ${left[0].n})`);
  for (const f of fails) console.log(" ✖", f);
}

process.exit(fails.length ? 1 : 0);
