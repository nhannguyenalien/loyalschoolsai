import test from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { createNeonRepository } from "../src/neonRepository.js";
import { configureLoyaltyProgram } from "../src/workflows/loyalty/configureProgram.js";
import { recordLoyaltySale } from "../src/workflows/loyalty/recordSale.js";
import { createManagedCampaign } from "../src/workflows/loyalty/manageRewardWorld.js";
import { checkIn } from "../src/workflows/games/checkin.js";
import { claimMission, createMission, getMissionBoard } from "../src/workflows/games/missions.js";
import { createTreasure, deliverGift, listGifts, redeemTreasure, updateTreasure } from "../src/workflows/games/treasures.js";
import { generateTreasureCode, normalizeCode, periodRange, validateMission, validateTreasure, weekStart } from "../src/domain/games.js";

// ---- Logic thuần
test("tuần bắt đầu từ thứ Hai (giờ VN)", () => {
  assert.equal(weekStart("2026-10-05"), "2026-10-05"); // thứ Hai
  assert.equal(weekStart("2026-10-08"), "2026-10-05"); // thứ Năm
  assert.equal(weekStart("2026-10-11"), "2026-10-05"); // Chủ nhật vẫn thuộc tuần trước
  assert.equal(weekStart("2026-10-12"), "2026-10-12");
  assert.deepEqual(periodRange("week", "2026-10-08"), { start: "2026-10-05", end: "2026-10-11" });
  assert.deepEqual(periodRange("day", "2026-10-08"), { start: "2026-10-08", end: "2026-10-08" });
});

test("mã kho báu: chuẩn hóa và sinh mã", () => {
  assert.equal(normalizeCode(" abcd-ef12 "), "ABCDEF12");
  const codes = new Set(Array.from({ length: 200 }, () => generateTreasureCode()));
  assert.ok(codes.size > 195); // gần như không trùng
  for (const c of codes) assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/); // không có I L O 0 1
  assert.equal(validateTreasure({ name: "x", reward_type: "points", reward_points: 5, code: "ab-cd ef12" }).code, "ABCDEF12");
  assert.throws(() => validateTreasure({ name: "x", reward_type: "points", code: "abc" }), /code/);
  assert.throws(() => validateTreasure({ name: "x", reward_type: "nope" }), /reward_type/);
  assert.equal(validateMission({ name: "w", kind: "spend", target: 5, reward_type: "gift", reward_label: "Quà", period: "week" }).period, "week");
  assert.throws(() => validateMission({ name: "w", kind: "spend", target: 5, reward_type: "gift", period: "year" }), /period/);
});

// ---- Neon thật
const url = process.env.DATABASE_URL;
const tenant = `test-${crypto.randomUUID().slice(0, 8)}`;

test("thử thách tuần + quà hiện vật + săn kho báu", { skip: !url && "DATABASE_URL not set" }, async (t) => {
  const repository = createNeonRepository(url);
  const sql = neon(url);
  let campaignId;
  t.after(async () => {
    for (const table of ["game_treasure_claims", "game_treasures", "game_gifts", "game_mission_claims", "game_missions", "game_checkins",
      "reward_spin_entitlements", "loyalty_ledger", "loyalty_customers", "loyalty_programs"]) await sql.query(`DELETE FROM ${table} WHERE tenant = $1`, [tenant]);
    if (campaignId) await sql.query("DELETE FROM reward_campaigns WHERE id = $1", [campaignId]);
  });
  const at = (iso) => () => new Date(iso);
  const vn = (day, hh = 10, mm = 0) => at(`${day}T${String(hh - 7).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`); // giờ VN
  const ref = "0909111222";
  await configureLoyaltyProgram({ repository, tenant, input: { spend_per_point_minor: 10000, points_per_step: 1 } });
  const campaign = await createManagedCampaign({ repository, input: { name: `T ${tenant}`, status: "active", spend_per_spin_minor: 1000000 } });
  campaignId = campaign.id;

  // --- Thử thách tuần
  await assert.rejects(createMission({ repository, tenant, period: "week", input: { name: "x", kind: "checkin", target: 8, reward_type: "points", reward_points: 1 } }), /between 1 and 7/);
  await assert.rejects(createMission({ repository, tenant, period: "week", input: { name: "x", kind: "spend", target: 1, reward_type: "gift" } }), /reward_label/);
  const wCheckin = await createMission({ repository, tenant, period: "week", input: { name: "Điểm danh 3 ngày", kind: "checkin", target: 3, reward_type: "points", reward_points: 30 } });
  const wSpend = await createMission({ repository, tenant, period: "week", input: { name: "Chi 300k trong tuần", kind: "spend", target: 300000, reward_type: "gift", reward_label: "Túi vải" } });
  const wReceipts = await createMission({ repository, tenant, period: "week", input: { name: "2 hóa đơn", kind: "receipts", target: 2, reward_type: "spin", reward_campaign_id: campaignId } });
  const daily = await createMission({ repository, tenant, input: { name: "Hằng ngày", kind: "checkin", reward_type: "points", reward_points: 1 } });
  assert.equal(wCheckin.period, "week"); assert.equal(daily.period, "day");

  const board = (day, who = ref, period = "week") => getMissionBoard({ repository, tenant, customerRef: who, period, now: vn(day) });
  const item = (b, id) => b.missions.find((m) => m.id === id);
  assert.equal((await board("2026-10-08")).missions.length, 3);                      // thử thách tuần không lẫn nhiệm vụ ngày
  assert.equal((await board("2026-10-08", ref, "day")).missions.length, 1);
  assert.deepEqual([(await board("2026-10-08")).period_start, (await board("2026-10-08")).period_end], ["2026-10-05", "2026-10-11"]);

  // Điểm danh thứ Hai & thứ Ba: chưa đủ 3 ngày.
  await checkIn({ repository, tenant, customerRef: ref, now: vn("2026-10-05") });
  await checkIn({ repository, tenant, customerRef: ref, now: vn("2026-10-06") });
  assert.equal(item(await board("2026-10-07"), wCheckin.id).current, 2);
  await assert.rejects(claimMission({ repository, tenant, missionId: wCheckin.id, customerRef: ref, period: "week", now: vn("2026-10-07") }), /not completed/);
  await checkIn({ repository, tenant, customerRef: ref, now: vn("2026-10-07") });
  assert.equal(item(await board("2026-10-08"), wCheckin.id).completed, true);
  const balanceBefore = (await claimMission({ repository, tenant, missionId: wCheckin.id, customerRef: ref, period: "week", now: vn("2026-10-08") }));
  assert.equal(balanceBefore.reward.points, 30); assert.equal(balanceBefore.day, "2026-10-05"); assert.equal(balanceBefore.replayed, false);
  const again = await claimMission({ repository, tenant, missionId: wCheckin.id, customerRef: ref, period: "week", now: vn("2026-10-11", 22) }); // cuối tuần: không thưởng lần 2
  assert.equal(again.replayed, true); assert.equal(again.balance, balanceBefore.balance);
  assert.equal(item(await board("2026-10-11"), wCheckin.id).claimed, true);
  const nextWeek = await board("2026-10-12");                                          // sang tuần mới: tiến độ về 0
  assert.equal(item(nextWeek, wCheckin.id).current, 0); assert.equal(item(nextWeek, wCheckin.id).claimed, false);
  // Nhiệm vụ ngày không nhận được qua đường thử thách tuần (và ngược lại).
  await assert.rejects(claimMission({ repository, tenant, missionId: daily.id, customerRef: ref, period: "week", now: vn("2026-10-08") }), /not found/);

  // Chi tiêu cộng dồn qua nhiều ngày → quà hiện vật chờ giao.
  const sale = (key, who, amount, when) => recordLoyaltySale({ repository, tenant, now: when, input: { idempotency_key: key, customer_ref: who, source_ref: key.toUpperCase(), amount_minor: amount } });
  await sale("w1", ref, 100000, vn("2026-10-05"));
  await assert.rejects(claimMission({ repository, tenant, missionId: wSpend.id, customerRef: ref, period: "week", now: vn("2026-10-06") }), /not completed/);
  await sale("w2", ref, 250000, vn("2026-10-10", 20));
  const gift = await claimMission({ repository, tenant, missionId: wSpend.id, customerRef: ref, period: "week", now: vn("2026-10-11") });
  assert.equal(gift.reward.type, "gift"); assert.equal(gift.reward.label, "Túi vải");
  await claimMission({ repository, tenant, missionId: wSpend.id, customerRef: ref, period: "week", now: vn("2026-10-11", 23) });
  let gifts = (await listGifts({ repository, tenant, status: "pending" })).gifts;
  assert.equal(gifts.length, 1); assert.equal(gifts[0].label, "Túi vải"); assert.equal(gifts[0].customer_ref, ref); // gọi lại không tạo phiếu thứ hai
  // Hai hóa đơn trong tuần → lượt quay
  await claimMission({ repository, tenant, missionId: wReceipts.id, customerRef: ref, period: "week", now: vn("2026-10-11") });
  assert.equal((await repository.countAvailableSpins(tenant, ref)).available, 1);

  // Ranh giới tuần theo giờ VN: 23:30 Chủ nhật thuộc tuần cũ, 00:10 thứ Hai thuộc tuần mới.
  const boundary = "0909333444";
  await sale("b1", boundary, 50000, at("2026-10-11T16:30:00Z")); // 23:30 CN (VN)
  await sale("b2", boundary, 50000, at("2026-10-11T17:10:00Z")); // 00:10 T2 (VN)
  assert.equal(item(await board("2026-10-11", boundary), wReceipts.id).current, 1);
  assert.equal(item(await board("2026-10-12", boundary), wReceipts.id).current, 1);

  // Phát quà
  const delivered = await deliverGift({ repository, tenant, giftId: gifts[0].id });
  assert.equal(delivered.gift.status, "delivered"); assert.ok(delivered.gift.delivered_at);
  assert.equal((await listGifts({ repository, tenant, status: "pending" })).gifts.length, 0);
  assert.equal((await listGifts({ repository, tenant, status: "delivered" })).gifts.length, 1);
  await assert.rejects(deliverGift({ repository, tenant, giftId: "khong-co" }), /not found/);

  // --- Săn kho báu
  await assert.rejects(createTreasure({ repository, tenant, input: { name: "x", reward_type: "spin" } }), /reward_campaign_id/);
  const auto = await createTreasure({ repository, tenant, input: { name: "Kho báu trang chủ", hint: "Cuộn xuống cuối trang chủ", reward_type: "points", reward_points: 15 } });
  assert.match(auto.code, /^[A-Z2-9]{8}$/); assert.equal(auto.claimed_count, 0);
  const custom = await createTreasure({ repository, tenant, input: { name: "Mã Tết", code: "tet-2027", reward_type: "points", reward_points: 100 } });
  assert.equal(custom.code, "TET2027");
  await assert.rejects(createTreasure({ repository, tenant, input: { name: "trùng", code: "TET 2027", reward_type: "points", reward_points: 1 } }), /already used/);

  const spaced = `${auto.code.slice(0, 4).toLowerCase()} - ${auto.code.slice(4)}`;   // khách gõ chữ thường, có khoảng trắng và gạch
  const found = await redeemTreasure({ repository, tenant, customerRef: "K1", code: spaced });
  assert.equal(found.replayed, false); assert.equal(found.reward.points, 15); assert.equal(found.balance, 15); assert.equal(found.treasure.hint, "Cuộn xuống cuối trang chủ");
  const dup = await redeemTreasure({ repository, tenant, customerRef: "K1", code: auto.code });
  assert.equal(dup.replayed, true); assert.equal(dup.balance, 15);                      // không thưởng lần hai
  assert.equal((await redeemTreasure({ repository, tenant, customerRef: "K2", code: auto.code })).balance, 15); // khách khác nhận được
  assert.equal((await repository.getTreasure(tenant, auto.id)).claimed_count, 2);
  await assert.rejects(redeemTreasure({ repository, tenant, customerRef: "K1", code: "SAIMA999" }), /not found/);
  await assert.rejects(redeemTreasure({ repository, tenant, customerRef: "K1", code: "" }), /code/);

  // Hai yêu cầu đồng thời của CÙNG một khách: chỉ thưởng một lần.
  const [c1, c2] = await Promise.all([1, 2].map(() => redeemTreasure({ repository, tenant, customerRef: "K3", code: custom.code })));
  assert.equal(c1.balance, 100); assert.equal(c2.balance, 100); assert.equal([c1, c2].filter((r) => r.replayed).length >= 1, true);
  assert.equal((await repository.getTreasure(tenant, custom.id)).claimed_count, 1);

  // Chỉ còn một suất, năm người cùng nhập: đúng một người được.
  const limited = await createTreasure({ repository, tenant, input: { name: "Suất duy nhất", reward_type: "points", reward_points: 7, max_claims: 1 } });
  const race = await Promise.allSettled(["R1", "R2", "R3", "R4", "R5"].map((who) => redeemTreasure({ repository, tenant, customerRef: who, code: limited.code })));
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(race.filter((r) => r.status === "rejected").every((r) => /claimed by everyone/.test(r.reason.message)));
  assert.equal((await repository.getTreasure(tenant, limited.id)).claimed_count, 1);
  assert.equal((await sql.query("SELECT COUNT(*) n FROM game_treasure_claims WHERE treasure_id = $1", [limited.id]))[0].n, "1");

  // Trạng thái / thời gian
  await updateTreasure({ repository, tenant, treasureId: auto.id, input: { status: "paused" } });
  await assert.rejects(redeemTreasure({ repository, tenant, customerRef: "K9", code: auto.code }), /not active/);
  assert.equal((await redeemTreasure({ repository, tenant, customerRef: "K1", code: auto.code })).replayed, true); // người đã nhận vẫn xem lại được
  const ended = await createTreasure({ repository, tenant, input: { name: "Hết hạn", reward_type: "points", reward_points: 1, starts_at: "2020-01-01T00:00:00Z", ends_at: "2020-02-01T00:00:00Z" } });
  await assert.rejects(redeemTreasure({ repository, tenant, customerRef: "K9", code: ended.code }), /has ended/);
  const future = await createTreasure({ repository, tenant, input: { name: "Sắp mở", reward_type: "points", reward_points: 1, starts_at: "2099-01-01T00:00:00Z" } });
  await assert.rejects(redeemTreasure({ repository, tenant, customerRef: "K9", code: future.code }), /not started/);
  await updateTreasure({ repository, tenant, treasureId: future.id, input: { status: "archived" } });
  await assert.rejects(redeemTreasure({ repository, tenant, customerRef: "K9", code: future.code }), /not found/);

  // Phần thưởng lượt quay & quà hiện vật
  const spinT = await createTreasure({ repository, tenant, input: { name: "Lượt quay ẩn", reward_type: "spin", reward_campaign_id: campaignId } });
  const spinsBefore = (await repository.countAvailableSpins(tenant, "K5")).available;
  assert.equal((await redeemTreasure({ repository, tenant, customerRef: "K5", code: spinT.code })).reward.type, "spin");
  await redeemTreasure({ repository, tenant, customerRef: "K5", code: spinT.code });    // gọi lại không cấp thêm
  assert.equal((await repository.countAvailableSpins(tenant, "K5")).available, spinsBefore + 1);
  const giftT = await createTreasure({ repository, tenant, input: { name: "Quà ẩn", reward_type: "gift", reward_label: "Móc khóa" } });
  await redeemTreasure({ repository, tenant, customerRef: "K6", code: giftT.code });
  gifts = (await listGifts({ repository, tenant, status: "pending" })).gifts;
  assert.equal(gifts.length, 1); assert.equal(gifts[0].label, "Móc khóa"); assert.equal(gifts[0].source_type, "treasure");
});
