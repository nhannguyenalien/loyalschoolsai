import { LoyaltyNotFoundError, LoyaltyValidationError } from "../../domain/loyalty/errors.js";

/** Kiểm tra cấu hình phần thưởng (dùng chung cho nhiệm vụ / thử thách / kho báu). */
export async function assertRewardValid({ repository, reward }) {
  if (reward.reward_type === "points" && !(Number(reward.reward_points) > 0)) throw new LoyaltyValidationError("reward_points must be greater than 0 for a points reward.");
  if (reward.reward_type === "gift" && !String(reward.reward_label || "").trim()) throw new LoyaltyValidationError("reward_label is required for a gift reward.");
  if (reward.reward_type === "spin") {
    if (!reward.reward_campaign_id) throw new LoyaltyValidationError("reward_campaign_id is required for a spin reward.");
    if (!await repository.getRewardCampaign(reward.reward_campaign_id)) throw new LoyaltyNotFoundError("Reward campaign was not found.");
  }
}

/**
 * Trao thưởng. Idempotent theo `key` nên gọi lại là an toàn (dùng để "vá" khi lần trước đứt giữa chừng):
 *   - points: cộng điểm vào sổ cái;  - spin: cấp 1 lượt chơi (lượt quay);  - gift: tạo phiếu quà chờ nhân viên giao.
 */
export async function grantReward({ repository, tenant, customerRef, reward, key, sourceType, name, now }) {
  if (reward.type === "points") {
    await repository.grantBonusPoints({ tenant, customerRef, points: Number(reward.points), key, note: name, now });
    return { type: "points", points: Number(reward.points) };
  }
  if (reward.type === "spin") {
    await repository.grantSpinEntitlement({ tenant, campaignId: reward.campaign_id, customerRef, sourceRef: key, now });
    return { type: "spin", campaign_id: reward.campaign_id, spins: 1 };
  }
  const gift = await repository.grantGift({ tenant, customerRef, sourceType, sourceRef: key, label: reward.label || name });
  return { type: "gift", label: gift.label, gift_id: gift.id };
}

export const rewardOf = (row) => ({ type: row.reward_type, points: Number(row.reward_points), campaign_id: row.reward_campaign_id, label: row.reward_label });
