import test from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { createNeonRepository } from "../src/neonRepository.js";
import { configureLoyaltyProgram } from "../src/workflows/loyalty/configureProgram.js";
import { recordLoyaltySale } from "../src/workflows/loyalty/recordSale.js";
import { redeemLoyaltyPoints } from "../src/workflows/loyalty/redeemPoints.js";
import { getLoyaltyAccount } from "../src/workflows/loyalty/getAccount.js";
import { createManagedCampaign, createManagedPrize } from "../src/workflows/loyalty/manageRewardWorld.js";
import { claimReward, joinRewardCampaign, listCustomerRewards, listRewardWorld, spinRewardWorld } from "../src/workflows/loyalty/rewardWorld.js";

const url = process.env.DATABASE_URL;
const tenant = `test-${crypto.randomUUID().slice(0, 8)}`;
const skip = !url && "DATABASE_URL not set";

test("loyalty + reward world trên Neon", { skip }, async (t) => {
  const repository = createNeonRepository(url);
  const sql = neon(url);
  let campaignId, campaign2Id;
  t.after(async () => {
    if (campaign2Id) {
      await sql.query("DELETE FROM reward_spin_results WHERE campaign_id = $1", [campaign2Id]);
      await sql.query("DELETE FROM reward_spin_entitlements WHERE campaign_id = $1", [campaign2Id]);
      await sql.query("DELETE FROM reward_store_joins WHERE campaign_id = $1", [campaign2Id]);
      await sql.query("DELETE FROM reward_campaign_prizes WHERE campaign_id = $1", [campaign2Id]);
      await sql.query("DELETE FROM reward_campaigns WHERE id = $1", [campaign2Id]);
    }
    await sql.query("DELETE FROM reward_claims WHERE tenant = $1", [tenant]);
    await sql.query("DELETE FROM reward_spin_results WHERE tenant = $1", [tenant]);
    await sql.query("DELETE FROM reward_spin_entitlements WHERE tenant = $1", [tenant]);
    await sql.query("DELETE FROM reward_store_joins WHERE tenant = $1", [tenant]);
    if (campaignId) {
      await sql.query("DELETE FROM reward_campaign_prizes WHERE campaign_id = $1", [campaignId]);
      await sql.query("DELETE FROM reward_campaigns WHERE id = $1", [campaignId]);
    }
    await sql.query("DELETE FROM loyalty_ledger WHERE tenant = $1", [tenant]);
    await sql.query("DELETE FROM loyalty_customers WHERE tenant = $1", [tenant]);
    await sql.query("DELETE FROM loyalty_programs WHERE tenant = $1", [tenant]);
  });

  const v1 = await configureLoyaltyProgram({ repository, tenant, input: { spend_per_point_minor: 10000, points_per_step: 1 } });
  const v2 = await configureLoyaltyProgram({ repository, tenant, input: { spend_per_point_minor: 20000, points_per_step: 2 } });
  assert.equal(v1.version, 1); assert.equal(v2.version, 2);
  assert.equal((await repository.getActiveProgram(tenant)).version, 2);
  assert.equal((await sql.query("SELECT COUNT(*) n FROM loyalty_programs WHERE tenant=$1 AND status='active'", [tenant]))[0].n, "1");

  const sale = { idempotency_key: "manual:R1", customer_ref: "0901", source_type: "manual", source_ref: "R1", amount_minor: 100000, customer: { name: "An", phone: "0901" } };
  const first = await recordLoyaltySale({ repository, tenant, input: sale });
  assert.equal(first.replayed, false); assert.equal(Number(first.entry.points_delta), 10); // 100000/20000*2
  const again = await recordLoyaltySale({ repository, tenant, input: sale });
  assert.equal(again.replayed, true);
  await assert.rejects(recordLoyaltySale({ repository, tenant, input: { ...sale, idempotency_key: "other" } }), /already credited/);

  await assert.rejects(redeemLoyaltyPoints({ repository, tenant, input: { idempotency_key: "r:1", customer_ref: "0901", source_ref: "G1", points: 11 } }), /Insufficient/);
  const redeemed = await redeemLoyaltyPoints({ repository, tenant, input: { idempotency_key: "r:2", customer_ref: "0901", source_ref: "G2", points: 4 } });
  assert.equal(redeemed.balance, 6);
  // Hai lần trừ đồng thời: tổng 8 > số dư 6 nên tối đa một lần thành công.
  const race = await Promise.allSettled(["a", "b"].map((k) => redeemLoyaltyPoints({ repository, tenant, input: { idempotency_key: `race:${k}`, customer_ref: "0901", source_ref: `race-${k}`, points: 4 } })));
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);

  const account = await getLoyaltyAccount({ repository, tenant, customerRef: "0901" });
  assert.equal(account.balance, 2); assert.equal(account.entries.length, 3);
  assert.ok(account.entries[0].created);

  // Reward World
  const campaign = await createManagedCampaign({ repository, input: { name: `T ${tenant}`, status: "active", spend_per_spin_minor: 50000, max_spins_per_sale: 2, starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 86400000).toISOString() } });
  campaignId = campaign.id;
  await createManagedPrize({ repository, campaignId, input: { name: "Voucher", prize_type: "voucher", weight: 1, max_wins: 1 } });
  assert.ok((await listRewardWorld({ repository, tenant })).campaigns.some((c) => c.id === campaignId && !c.joined));
  await joinRewardCampaign({ repository, tenant, campaignId });
  const sale2 = await recordLoyaltySale({ repository, tenant, input: { idempotency_key: "manual:R2", customer_ref: "0901", source_ref: "R2", amount_minor: 100000 } });
  assert.equal(sale2.entitlements.length, 2);
  const replay = await recordLoyaltySale({ repository, tenant, input: { idempotency_key: "manual:R2", customer_ref: "0901", source_ref: "R2", amount_minor: 100000 } });
  assert.equal(replay.entitlements.length, 2);

  const spins = await repository.countAvailableSpins(tenant, "0901");
  assert.equal(spins.available, 2); assert.equal(spins.campaigns[0].campaign_id, campaignId);
  assert.equal(typeof (await repository.getActiveProgram(tenant)).spend_per_point_minor, "number"); // số, không phải chuỗi

  const spin = await spinRewardWorld({ repository, tenant, input: { campaign_id: campaignId, customer_ref: "0901", idempotency_key: "spin:1" } });
  assert.equal(spin.result.status, "won"); assert.equal(spin.result.game, "wheel"); // mặc định là vòng quay
  await assert.rejects(spinRewardWorld({ repository, tenant, input: { campaign_id: campaignId, customer_ref: "0901", idempotency_key: "spin:bad", game: "bogus" } }), /game must be/);
  assert.equal((await spinRewardWorld({ repository, tenant, input: { campaign_id: campaignId, customer_ref: "0901", idempotency_key: "spin:1" } })).replayed, true);
  // Giải duy nhất (max_wins=1) đã hết: lượt thứ hai không còn giải.
  await assert.rejects(spinRewardWorld({ repository, tenant, input: { campaign_id: campaignId, customer_ref: "0901", idempotency_key: "spin:2" } }), /no available prize/);

  const stats = await repository.getStats(tenant);
  assert.equal(stats.customers, 1); assert.equal(stats.points_issued, 20); assert.equal(stats.points_redeemed, 8); // 4 + một lần trừ thắng trong bài test đua
  assert.equal(stats.spins_used, 1); assert.equal(stats.spins_available, 1); assert.equal(stats.prizes_pending, 1);
  assert.equal(stats.recent.length, 4); assert.equal(stats.daily.at(-1).day, stats.today);

  // Mini-game dùng chung lượt quay: kết quả vẫn do máy chủ quyết định, chỉ ghi lại cách trình bày.
  const c2 = await createManagedCampaign({ repository, input: { name: `T2 ${tenant}`, status: "active", spend_per_spin_minor: 1000000 } });
  campaign2Id = c2.id;
  await createManagedPrize({ repository, campaignId: c2.id, input: { name: "Quà tặng", prize_type: "voucher", weight: 1 } });
  await joinRewardCampaign({ repository, tenant, campaignId: c2.id });
  for (const game of ["cards", "dice", "slot"]) {
    await repository.grantSpinEntitlement({ tenant, campaignId: c2.id, customerRef: "0901", sourceRef: `t:${game}` });
    const played = await spinRewardWorld({ repository, tenant, input: { campaign_id: c2.id, customer_ref: "0901", idempotency_key: `spin:${game}`, game } });
    assert.equal(played.result.game, game); assert.equal(played.result.status, "won");
  }

  let rewards = (await listCustomerRewards({ repository, tenant, customerRef: "0901" })).rewards;
  assert.equal(rewards.length, 4); assert.ok(rewards.every((r) => r.claim === null));
  await claimReward({ repository, tenant, resultId: spin.result.id, input: { claim_note: "ok" } });
  rewards = (await listCustomerRewards({ repository, tenant, customerRef: "0901" })).rewards;
  const claimedReward = rewards.find((r) => r.id === spin.result.id);
  assert.equal(claimedReward.status, "claimed"); assert.ok(claimedReward.claim.claimed_at);
  assert.equal(rewards.filter((r) => r.claim).length, 1);
});
