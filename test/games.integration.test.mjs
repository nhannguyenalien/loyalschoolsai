import test from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { createNeonRepository } from "../src/neonRepository.js";
import { configureLoyaltyProgram } from "../src/workflows/loyalty/configureProgram.js";
import { recordLoyaltySale } from "../src/workflows/loyalty/recordSale.js";
import { checkIn, getCheckinStatus, getGameSettings, saveGameSettings } from "../src/workflows/games/checkin.js";
import { claimMission, createMission, getMissionBoard } from "../src/workflows/games/missions.js";
import { claimDrawWinner, createDraw, getDrawDetail, grantTickets, runDraw, updateDraw } from "../src/workflows/games/draws.js";
import { createManagedCampaign } from "../src/workflows/loyalty/manageRewardWorld.js";
import { addDays, pickDrawWinners, validateGameSettings, vnDate } from "../src/domain/games.js";

// ---- Thuần logic (không cần DB)
test("vnDate / addDays theo giờ Việt Nam", () => {
  assert.equal(vnDate(new Date("2026-10-01T16:59:00Z")), "2026-10-01"); // 23:59 VN
  assert.equal(vnDate(new Date("2026-10-01T17:00:00Z")), "2026-10-02"); // 00:00 VN hôm sau
  assert.equal(addDays("2026-03-01", -1), "2026-02-28"); assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("validateGameSettings", () => {
  assert.deepEqual(validateGameSettings({ checkin_points: 5, streak_milestones: [{ days: 30, points: 9 }, { days: 7, points: 3 }] }).streak_milestones.map((m) => m.days), [7, 30]);
  assert.throws(() => validateGameSettings({ streak_milestones: [{ days: 7, points: 1 }, { days: 7, points: 2 }] }), /Duplicate/);
  assert.throws(() => validateGameSettings({ checkin_points: -1 }), /checkin_points/);
  assert.throws(() => validateGameSettings({ streak_milestones: [{ days: 1, points: 1 }] }), /days/);
});

test("pickDrawWinners: mỗi khách tối đa một giải, không vượt số giải", () => {
  const tickets = [1, 2, 3, 4, 5].map((n) => ({ id: `t${n}`, ticket_no: n, customer_ref: n <= 3 ? "A" : "B" }));
  const winners = pickDrawWinners(tickets, [{ name: "Nhất", quantity: 1 }, { name: "Nhì", quantity: 3 }], { onePerCustomer: true });
  assert.equal(winners.length, 2); assert.equal(new Set(winners.map((w) => w.customer_ref)).size, 2);
  const many = pickDrawWinners(tickets, [{ name: "Nhất", quantity: 1 }, { name: "Nhì", quantity: 3 }], { onePerCustomer: false });
  assert.equal(many.length, 4); assert.equal(new Set(many.map((w) => w.ticket_id)).size, 4); // vé không trúng hai lần
  assert.equal(many[0].prize_name, "Nhất");
});

// ---- Trên Neon thật
const url = process.env.DATABASE_URL;
const tenant = `test-${crypto.randomUUID().slice(0, 8)}`;

test("game: điểm danh, chuỗi, nhiệm vụ, quay số", { skip: !url && "DATABASE_URL not set" }, async (t) => {
  const repository = createNeonRepository(url);
  const sql = neon(url);
  let campaignId;
  t.after(async () => {
    for (const table of ["game_draw_winners", "game_draw_tickets", "game_draws", "game_mission_claims", "game_missions", "game_streak_rewards", "game_checkins", "game_settings",
      "reward_spin_results", "reward_spin_entitlements", "loyalty_ledger", "loyalty_customers", "loyalty_programs"]) await sql.query(`DELETE FROM ${table} WHERE tenant = $1`, [tenant]);
    if (campaignId) await sql.query("DELETE FROM reward_campaigns WHERE id = $1", [campaignId]);
  });
  const at = (day, hh = 10) => () => new Date(`${day}T${String(hh - 7).padStart(2, "0")}:00:00Z`); // hh giờ VN
  const ref = "0909000111";

  // --- Cấu hình
  assert.equal((await getGameSettings({ repository, tenant })).checkin_points, 10); // mặc định
  await saveGameSettings({ repository, tenant, input: { checkin_points: 10, streak_milestones: [{ days: 3, points: 30 }, { days: 5, points: 50 }] } });

  // --- Điểm danh + chuỗi
  const d1 = await checkIn({ repository, tenant, customerRef: ref, now: at("2026-10-01") });
  assert.equal(d1.streak, 1); assert.equal(d1.points, 10); assert.equal(d1.balance, 10); assert.equal(d1.replayed, false);
  const d1b = await checkIn({ repository, tenant, customerRef: ref, now: at("2026-10-01", 22) }); // cùng ngày VN
  assert.equal(d1b.replayed, true); assert.equal(d1b.balance, 10);
  await checkIn({ repository, tenant, customerRef: ref, now: at("2026-10-02") });
  const d3 = await checkIn({ repository, tenant, customerRef: ref, now: at("2026-10-03") });
  assert.equal(d3.streak, 3); assert.equal(d3.milestone?.points, 30); assert.equal(d3.balance, 10 + 10 + 10 + 30);
  const d3b = await checkIn({ repository, tenant, customerRef: ref, now: at("2026-10-03", 23) });
  assert.equal(d3b.milestone, null); assert.equal(d3b.balance, 60); // mốc không nhận hai lần
  const status3 = await getCheckinStatus({ repository, tenant, customerRef: ref, now: at("2026-10-03") });
  assert.equal(status3.streak, 3); assert.equal(status3.checked_in_today, true); assert.equal(status3.next_milestone.days, 5);
  // Bỏ ngày 04 → chuỗi đứt, ngày 05 bắt đầu lại từ 1 (và không có thưởng mốc).
  assert.equal((await getCheckinStatus({ repository, tenant, customerRef: ref, now: at("2026-10-05") })).streak, 0);
  const d5 = await checkIn({ repository, tenant, customerRef: ref, now: at("2026-10-05") });
  assert.equal(d5.streak, 1); assert.equal(d5.milestone, null); assert.equal(d5.balance, 70);
  // Hai yêu cầu đồng thời cùng ngày chỉ tính một lần.
  const [r1, r2] = await Promise.all([1, 2].map(() => checkIn({ repository, tenant, customerRef: "0909000222", now: at("2026-10-05") })));
  assert.equal(r1.balance, 10); assert.equal(r2.balance, 10);

  // --- Nhiệm vụ hằng ngày
  await configureLoyaltyProgram({ repository, tenant, input: { spend_per_point_minor: 10000, points_per_step: 1 } });
  const campaign = await createManagedCampaign({ repository, input: { name: `T ${tenant}`, status: "active", spend_per_spin_minor: 1000000 } });
  campaignId = campaign.id;
  const mCheckin = await createMission({ repository, tenant, input: { name: "Điểm danh", kind: "checkin", reward_type: "points", reward_points: 5 } });
  const mReceipt = await createMission({ repository, tenant, input: { name: "Mua 1 hóa đơn", kind: "receipts", target: 1, reward_type: "points", reward_points: 20 } });
  const mSpend = await createMission({ repository, tenant, input: { name: "Chi 200k", kind: "spend", target: 200000, reward_type: "spin", reward_campaign_id: campaignId } });
  await assert.rejects(createMission({ repository, tenant, input: { name: "x", kind: "spend", target: 1, reward_type: "spin" } }), /reward_campaign_id/);
  await assert.rejects(createMission({ repository, tenant, input: { name: "x", kind: "bogus", reward_type: "points", reward_points: 1 } }), /kind/);

  let board = await getMissionBoard({ repository, tenant, customerRef: ref, now: at("2026-10-05") });
  const by = (id) => board.missions.find((m) => m.id === id);
  assert.equal(by(mCheckin.id).completed, true); assert.equal(by(mReceipt.id).completed, false); assert.equal(by(mSpend.id).current, 0);
  await assert.rejects(claimMission({ repository, tenant, missionId: mReceipt.id, customerRef: ref, now: at("2026-10-05") }), /not completed/);
  const c1 = await claimMission({ repository, tenant, missionId: mCheckin.id, customerRef: ref, now: at("2026-10-05") });
  assert.equal(c1.replayed, false); assert.equal(c1.balance, 75);
  assert.equal((await claimMission({ repository, tenant, missionId: mCheckin.id, customerRef: ref, now: at("2026-10-05") })).balance, 75);

  await recordLoyaltySale({ repository, tenant, now: at("2026-10-05", 15), input: { idempotency_key: "s1", customer_ref: ref, source_ref: "S1", amount_minor: 250000 } });
  board = await getMissionBoard({ repository, tenant, customerRef: ref, now: at("2026-10-05", 16) });
  assert.equal(by(mReceipt.id).completed, true); assert.equal(by(mSpend.id).completed, true); assert.equal(by(mCheckin.id).claimed, true);
  const cr = await claimMission({ repository, tenant, missionId: mReceipt.id, customerRef: ref, now: at("2026-10-05", 16) });
  assert.equal(cr.reward.points, 20); assert.equal(cr.balance, 75 + 25 + 20); // +25 điểm từ hóa đơn 250k
  const cs = await claimMission({ repository, tenant, missionId: mSpend.id, customerRef: ref, now: at("2026-10-05", 16) });
  assert.deepEqual(cs.reward, { type: "spin", campaign_id: campaignId, spins: 1 });
  await claimMission({ repository, tenant, missionId: mSpend.id, customerRef: ref, now: at("2026-10-05", 17) }); // gọi lại: không thêm lượt
  assert.equal((await repository.countAvailableSpins(tenant, ref)).available, 1);
  // Sang ngày mới: tiến độ về 0.
  board = await getMissionBoard({ repository, tenant, customerRef: ref, now: at("2026-10-06") });
  assert.ok(board.missions.every((m) => !m.completed && !m.claimed));

  // --- Quay số may mắn
  const draw = await createDraw({ repository, tenant, input: { name: "Quay số tháng 10", status: "open", spend_per_ticket_minor: 100000, max_tickets_per_sale: 3,
    prizes: [{ name: "Giải nhất", quantity: 1 }, { name: "Giải nhì", quantity: 2 }] } });
  await assert.rejects(createDraw({ repository, tenant, input: { name: "rỗng", prizes: [] } }), /prizes/);
  const sale = (key, customer, amount) => recordLoyaltySale({ repository, tenant, input: { idempotency_key: key, customer_ref: customer, source_ref: key.toUpperCase(), amount_minor: amount } });
  const sA = await sale("a1", "A", 250000); assert.equal(sA.tickets.length, 2);                 // 250k / 100k = 2 vé
  const sB = await sale("b1", "B", 900000); assert.equal(sB.tickets.length, 3);                 // tối đa 3 vé / hóa đơn
  const sAagain = await sale("a1", "A", 250000); assert.deepEqual(sAagain.tickets.map((x) => x.ticket_no), sA.tickets.map((x) => x.ticket_no)); // gọi lại: cùng vé
  assert.equal((await sale("c0", "C", 50000)).tickets.length, 0);                              // không đủ mức
  // Cấp vé thủ công đồng thời: số vé không trùng, không lỗi.
  await Promise.all([1, 2, 3, 4, 5].map((i) => grantTickets({ repository, tenant, drawId: draw.id, input: { customer_ref: `M${i}`, count: 2 } })));
  const all = await repository.listAllTickets(tenant, draw.id);
  assert.equal(all.length, 15);
  assert.deepEqual(all.map((x) => x.ticket_no), Array.from({ length: 15 }, (_, i) => i + 1)); // liên tục 1..15, không trùng
  const mine = await getDrawDetail({ repository, tenant, drawId: draw.id, customerRef: "A" });
  assert.equal(mine.tickets.length, 2);

  await assert.rejects(runDraw({ repository, tenant, drawId: (await createDraw({ repository, tenant, input: { name: "nháp", prizes: [{ name: "x", quantity: 1 }] } })).id }), /Open the draw/);
  const [d1r, d2r] = await Promise.allSettled([runDraw({ repository, tenant, drawId: draw.id }), runDraw({ repository, tenant, drawId: draw.id })]);
  assert.equal([d1r, d2r].filter((r) => r.status === "fulfilled").length, 1); // chỉ một yêu cầu rút thắng
  const ran = [d1r, d2r].find((r) => r.status === "fulfilled").value;
  assert.equal(ran.winners.length, 3); assert.equal(new Set(ran.winners.map((w) => w.customer_ref)).size, 3);
  assert.equal(ran.winners.filter((w) => w.prize_name === "Giải nhất").length, 1);
  await assert.rejects(runDraw({ repository, tenant, drawId: draw.id }), /already been drawn/);
  await assert.rejects(updateDraw({ repository, tenant, drawId: draw.id, input: { name: "sửa" } }), /already been drawn/);
  await assert.rejects(grantTickets({ repository, tenant, drawId: draw.id, input: { customer_ref: "Z" } }), /draft or open/);
  const claimed = await claimDrawWinner({ repository, tenant, drawId: draw.id, winnerId: ran.winners[0].id });
  assert.equal(claimed.winner.status, "claimed");
  assert.equal((await repository.listDraws(tenant)).find((d) => d.id === draw.id).winner_count, 3);
});
