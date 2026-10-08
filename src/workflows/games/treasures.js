import { generateTreasureCode, normalizeCode, validateTreasure } from "../../domain/games.js";
import { LoyaltyConflictError, LoyaltyNotFoundError } from "../../domain/loyalty/errors.js";
import { requireNonEmpty } from "../../domain/loyalty/points.js";
import { assertRewardValid, grantReward, rewardOf } from "./rewards.js";

const isUnique = (error) => error?.code === "23505";

export const listTreasures = async ({ repository, tenant }) => ({ treasures: await repository.listTreasures(tenant) });

/** Tạo kho báu. Không truyền `code` thì tự sinh mã ngẫu nhiên (8 ký tự, bỏ chữ dễ nhầm). */
export async function createTreasure({ repository, tenant, input }) {
  const treasure = validateTreasure(input);
  await assertRewardValid({ repository, reward: treasure });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { return await repository.createTreasure(tenant, { ...treasure, code: treasure.code || generateTreasureCode() }); }
    catch (error) {
      if (!isUnique(error)) throw error;
      if (treasure.code) throw new LoyaltyConflictError("This code is already used by another treasure.");
    }
  }
  throw new LoyaltyConflictError("Could not generate a unique code. Please retry.");
}

export async function updateTreasure({ repository, tenant, treasureId, input }) {
  const current = await repository.getTreasure(tenant, treasureId);
  if (!current) throw new LoyaltyNotFoundError("Treasure was not found.");
  const patch = validateTreasure(input, { partial: true });
  const merged = { ...current, ...patch };
  if (["reward_type", "reward_points", "reward_campaign_id", "reward_label"].some((k) => patch[k] !== undefined)) await assertRewardValid({ repository, reward: merged });
  return repository.updateTreasure(tenant, treasureId, patch);
}

/** Khách nhập mã kho báu. Mỗi khách nhận mỗi kho báu một lần; còn suất khi `max_claims` > 0. */
export async function redeemTreasure({ repository, tenant, customerRef, code, now = () => new Date() }) {
  const ref = requireNonEmpty(customerRef, "customer_ref", 200);
  const normalized = normalizeCode(requireNonEmpty(code, "code", 60));
  const at = now();
  let treasure = await repository.findTreasureByCode(tenant, normalized);
  if (!treasure || treasure.status === "archived") throw new LoyaltyNotFoundError("Treasure code was not found.");

  let replayed = Boolean(await repository.findTreasureClaim(treasure.id, ref));
  if (!replayed) {
    if (treasure.status !== "active") throw new LoyaltyConflictError("This treasure is not active.");
    if (treasure.starts_at && new Date(treasure.starts_at) > at) throw new LoyaltyConflictError("This treasure hunt has not started yet.");
    if (treasure.ends_at && new Date(treasure.ends_at) < at) throw new LoyaltyConflictError("This treasure hunt has ended.");
    const claimed = await repository.claimTreasure({ tenant, treasureId: treasure.id, customerRef: ref });
    if (!claimed) {
      if (await repository.findTreasureClaim(treasure.id, ref)) replayed = true; // thua cuộc đua nhưng chính khách này đã nhận
      else {
        treasure = await repository.getTreasure(tenant, treasure.id);
        throw new LoyaltyConflictError(treasure.max_claims > 0 && treasure.claimed_count >= treasure.max_claims ? "This treasure has already been claimed by everyone it allows." : "This treasure can no longer be claimed.");
      }
    }
  }
  const reward = await grantReward({ repository, tenant, customerRef: ref, reward: rewardOf(treasure), key: `treasure:${treasure.id}:${ref}`, sourceType: "treasure", name: treasure.name, now: at });
  return { replayed, treasure: { id: treasure.id, name: treasure.name, hint: treasure.hint }, reward, balance: await repository.getBalance(tenant, ref) };
}

export async function listGifts({ repository, tenant, status }) {
  if (status && !["pending", "delivered"].includes(status)) status = undefined;
  return { gifts: await repository.listGifts(tenant, status) };
}

export async function deliverGift({ repository, tenant, giftId }) {
  const gift = await repository.deliverGift(tenant, giftId);
  if (!gift) throw new LoyaltyNotFoundError("Gift was not found.");
  return { gift };
}
