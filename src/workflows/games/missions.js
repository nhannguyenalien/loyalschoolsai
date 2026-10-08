import { validateMission, vnDate } from "../../domain/games.js";
import { LoyaltyConflictError, LoyaltyNotFoundError, LoyaltyValidationError } from "../../domain/loyalty/errors.js";
import { requireNonEmpty } from "../../domain/loyalty/points.js";

const currentValue = (mission, progress) => ({ checkin: progress.checkin, receipts: progress.receipts, spend: progress.spend })[mission.kind];

async function assertRewardValid({ repository, input }) {
  if (input.reward_type === "points" && !(Number(input.reward_points) > 0)) throw new LoyaltyValidationError("reward_points must be greater than 0 for a points reward.");
  if (input.reward_type === "spin") {
    if (!input.reward_campaign_id) throw new LoyaltyValidationError("reward_campaign_id is required for a spin reward.");
    if (!await repository.getRewardCampaign(input.reward_campaign_id)) throw new LoyaltyNotFoundError("Reward campaign was not found.");
  }
}

export const listMissionsAdmin = async ({ repository, tenant }) => ({ missions: await repository.listMissions(tenant) });

export async function createMission({ repository, tenant, input }) {
  const mission = validateMission(input);
  if (mission.kind === "checkin") mission.target = 1;
  await assertRewardValid({ repository, input: mission });
  return repository.createMission(tenant, mission);
}

export async function updateMission({ repository, tenant, missionId, input }) {
  const current = await repository.getMission(tenant, missionId);
  if (!current) throw new LoyaltyNotFoundError("Mission was not found.");
  const patch = validateMission(input, { partial: true });
  const merged = { ...current, ...patch };
  if (merged.kind === "checkin") patch.target = 1;
  if (patch.reward_type !== undefined || patch.reward_points !== undefined || patch.reward_campaign_id !== undefined) await assertRewardValid({ repository, input: merged });
  return repository.updateMission(tenant, missionId, patch);
}

/** Nhiệm vụ đang bật kèm tiến độ hôm nay của khách. */
export async function getMissionBoard({ repository, tenant, customerRef, now = () => new Date() }) {
  const ref = requireNonEmpty(customerRef, "customer_ref", 200);
  const today = vnDate(now());
  const [missions, progress, claims] = await Promise.all([
    repository.listMissions(tenant), repository.missionProgress(tenant, ref, today), repository.listMissionClaims(tenant, ref, today),
  ]);
  const claimed = new Set(claims.map((c) => c.mission_id));
  return {
    customer_ref: ref, day: today,
    missions: missions.filter((m) => m.status === "active").map((m) => {
      const current = currentValue(m, progress);
      return { ...m, current: Math.min(current, Number(m.target)), completed: current >= Number(m.target), claimed: claimed.has(m.id) };
    }),
  };
}

/** Nhận thưởng nhiệm vụ hôm nay. Idempotent: nhận lần hai chỉ trả lại kết quả cũ. */
export async function claimMission({ repository, tenant, missionId, customerRef, now = () => new Date() }) {
  const ref = requireNonEmpty(customerRef, "customer_ref", 200);
  const at = now();
  const today = vnDate(at);
  const mission = await repository.getMission(tenant, missionId);
  if (!mission || mission.status === "archived") throw new LoyaltyNotFoundError("Mission was not found.");
  if (mission.status !== "active") throw new LoyaltyConflictError("Mission is not active.");

  let claim = await repository.findMissionClaim(tenant, mission.id, ref, today);
  let replayed = Boolean(claim);
  if (!claim) {
    const progress = await repository.missionProgress(tenant, ref, today);
    if (currentValue(mission, progress) < Number(mission.target)) throw new LoyaltyConflictError("Mission is not completed yet.");
    const created = await repository.insertMissionClaim({ tenant, mission_id: mission.id, customer_ref: ref, day: today, reward_type: mission.reward_type, reward_points: Number(mission.reward_points) });
    claim = created ? { id: created.id } : await repository.findMissionClaim(tenant, mission.id, ref, today);
    replayed = !created;
  }

  // Trao thưởng (idempotent, nên gọi lại sẽ "vá" nếu lần trước đứt giữa chừng).
  let reward;
  if (mission.reward_type === "points") {
    await repository.grantBonusPoints({ tenant, customerRef: ref, points: Number(mission.reward_points), key: `mission:${mission.id}:${ref}:${today}`, note: mission.name, now: at });
    reward = { type: "points", points: Number(mission.reward_points) };
  } else {
    await repository.grantSpinEntitlement({ tenant, campaignId: mission.reward_campaign_id, customerRef: ref, sourceRef: `${mission.id}:${ref}:${today}`, now: at });
    reward = { type: "spin", campaign_id: mission.reward_campaign_id, spins: 1 };
  }
  return { replayed, mission_id: mission.id, day: today, reward, balance: await repository.getBalance(tenant, ref) };
}
