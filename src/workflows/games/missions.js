import { periodRange, validateMission, vnDate } from "../../domain/games.js";
import { LoyaltyConflictError, LoyaltyNotFoundError, LoyaltyValidationError } from "../../domain/loyalty/errors.js";
import { requireNonEmpty } from "../../domain/loyalty/points.js";
import { assertRewardValid, grantReward, rewardOf } from "./rewards.js";

const currentValue = (mission, progress) => ({ checkin: progress.checkin, receipts: progress.receipts, spend: progress.spend })[mission.kind];

/** Điểm danh: nhiệm vụ ngày luôn là 1; thử thách tuần là số ngày điểm danh (1–7). */
function normalizeTarget(mission) {
  if (mission.kind !== "checkin") return mission.target;
  if (mission.period === "week") {
    if (!(mission.target >= 1 && mission.target <= 7)) throw new LoyaltyValidationError("target must be between 1 and 7 days for a weekly check-in challenge.");
    return mission.target;
  }
  return 1;
}

export const listMissionsAdmin = async ({ repository, tenant, period = "day" }) => ({ missions: await repository.listMissions(tenant, { period }) });

/** Dùng cho cả nhiệm vụ hằng ngày (period = day) lẫn thử thách tuần (period = week). */
export async function createMission({ repository, tenant, input, period }) {
  const mission = validateMission(period ? { ...input, period } : input);
  mission.target = normalizeTarget(mission);
  await assertRewardValid({ repository, reward: mission });
  return repository.createMission(tenant, mission);
}

export async function updateMission({ repository, tenant, missionId, input, period }) {
  const current = await repository.getMission(tenant, missionId);
  if (!current || (period && current.period !== period)) throw new LoyaltyNotFoundError("Mission was not found.");
  const patch = validateMission(input, { partial: true });
  const merged = { ...current, ...patch };
  if (patch.kind !== undefined || patch.target !== undefined) patch.target = normalizeTarget(merged);
  if (["reward_type", "reward_points", "reward_campaign_id", "reward_label"].some((k) => patch[k] !== undefined)) await assertRewardValid({ repository, reward: merged });
  return repository.updateMission(tenant, missionId, patch);
}

/** Danh sách nhiệm vụ đang bật của kỳ hiện tại kèm tiến độ của khách. */
export async function getMissionBoard({ repository, tenant, customerRef, period = "day", now = () => new Date() }) {
  const ref = requireNonEmpty(customerRef, "customer_ref", 200);
  const today = vnDate(now());
  const range = periodRange(period, today);
  const [missions, progress, claims] = await Promise.all([
    repository.listMissions(tenant, { period }), repository.missionProgress(tenant, ref, range.start, range.end), repository.listMissionClaims(tenant, ref, range.start),
  ]);
  const claimed = new Set(claims.map((c) => c.mission_id));
  return {
    customer_ref: ref, period, day: today, period_start: range.start, period_end: range.end,
    missions: missions.filter((m) => m.status === "active").map((m) => {
      const current = currentValue(m, progress);
      return { ...m, current: Math.min(current, Number(m.target)), completed: current >= Number(m.target), claimed: claimed.has(m.id) };
    }),
  };
}

/** Nhận thưởng của kỳ hiện tại. Idempotent: nhận lần hai chỉ trả lại kết quả cũ (và vá phần thưởng nếu lần trước đứt giữa chừng). */
export async function claimMission({ repository, tenant, missionId, customerRef, period, now = () => new Date() }) {
  const ref = requireNonEmpty(customerRef, "customer_ref", 200);
  const at = now();
  const mission = await repository.getMission(tenant, missionId);
  if (!mission || mission.status === "archived" || (period && mission.period !== period)) throw new LoyaltyNotFoundError("Mission was not found.");
  if (mission.status !== "active") throw new LoyaltyConflictError("Mission is not active.");
  const range = periodRange(mission.period, vnDate(at));

  let claim = await repository.findMissionClaim(tenant, mission.id, ref, range.start);
  let replayed = Boolean(claim);
  if (!claim) {
    const progress = await repository.missionProgress(tenant, ref, range.start, range.end);
    if (currentValue(mission, progress) < Number(mission.target)) throw new LoyaltyConflictError("Mission is not completed yet.");
    const created = await repository.insertMissionClaim({ tenant, mission_id: mission.id, customer_ref: ref, day: range.start, reward_type: mission.reward_type, reward_points: Number(mission.reward_points) });
    claim = created ? { id: created.id } : await repository.findMissionClaim(tenant, mission.id, ref, range.start);
    replayed = !created;
  }

  const reward = await grantReward({ repository, tenant, customerRef: ref, reward: rewardOf(mission), key: `mission:${mission.id}:${ref}:${range.start}`, sourceType: mission.period === "week" ? "challenge" : "mission", name: mission.name, now: at });
  return { replayed, mission_id: mission.id, period: mission.period, day: range.start, reward, balance: await repository.getBalance(tenant, ref) };
}
