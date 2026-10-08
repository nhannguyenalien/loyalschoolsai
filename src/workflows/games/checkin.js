import { addDays, currentStreak, nextMilestone, validateGameSettings, vnDate } from "../../domain/games.js";
import { requireNonEmpty } from "../../domain/loyalty/points.js";

export const getGameSettings = ({ repository, tenant }) => repository.getGameSettings(tenant);

export async function saveGameSettings({ repository, tenant, input }) {
  return repository.saveGameSettings(tenant, validateGameSettings(input));
}

/** Trạng thái điểm danh của khách (không ghi gì). */
export async function getCheckinStatus({ repository, tenant, customerRef, now = () => new Date() }) {
  const ref = requireNonEmpty(customerRef, "customer_ref", 200);
  const today = vnDate(now());
  const [settings, last, days, total] = await Promise.all([
    repository.getGameSettings(tenant), repository.latestCheckin(tenant, ref),
    repository.listCheckinDays(tenant, ref, 45), repository.countCheckins(tenant, ref),
  ]);
  const streak = currentStreak(last, today);
  return {
    customer_ref: ref, today, checked_in_today: last?.day === today, streak, total_checkins: total,
    last_checkin: last?.day || null, recent_days: days,
    checkin_points: settings.checkin_points, next_milestone: nextMilestone(streak, settings.streak_milestones),
    milestones: settings.streak_milestones,
  };
}

/**
 * Điểm danh hôm nay (giờ VN). Toàn bộ thao tác là idempotent: gọi lại trong ngày chỉ trả về kết quả cũ
 * (và "vá" lại phần thưởng nếu lần trước bị gián đoạn giữa chừng).
 */
export async function checkIn({ repository, tenant, customerRef, now = () => new Date() }) {
  const ref = requireNonEmpty(customerRef, "customer_ref", 200);
  const at = now();
  const today = vnDate(at);
  const settings = await repository.getGameSettings(tenant);

  let checkin = await repository.findCheckin(tenant, ref, today);
  let replayed = Boolean(checkin);
  if (!checkin) {
    const previous = await repository.latestCheckinBefore(tenant, ref, today);
    const streak = previous?.day === addDays(today, -1) ? Number(previous.streak) + 1 : 1;
    checkin = await repository.insertCheckin({ tenant, customer_ref: ref, day: today, points: settings.checkin_points, streak });
    if (!checkin) { checkin = await repository.findCheckin(tenant, ref, today); replayed = true; } // thua cuộc đua: dùng bản ghi của yêu cầu thắng
  }

  // Điểm điểm danh (idempotent theo ngày).
  await repository.grantBonusPoints({ tenant, customerRef: ref, points: Number(checkin.points), key: `checkin:${ref}:${today}`, note: `Điểm danh ${today}`, now: at });

  // Thưởng mốc chuỗi: chỉ khi chạm đúng mốc, mỗi mốc một lần trong một chuỗi.
  const streak = Number(checkin.streak);
  const milestone = settings.streak_milestones.find((m) => m.days === streak) || null;
  let milestoneAwarded = null;
  if (milestone) {
    const start = addDays(today, -(streak - 1));
    const created = await repository.insertStreakReward({ tenant, customer_ref: ref, streak_start: start, days: milestone.days, points: milestone.points });
    await repository.grantBonusPoints({ tenant, customerRef: ref, points: milestone.points, key: `streak:${ref}:${start}:${milestone.days}`, note: `Chuỗi ${milestone.days} ngày`, now: at });
    if (created) milestoneAwarded = milestone;
  }

  return {
    replayed, day: today, points: Number(checkin.points), streak, milestone: milestoneAwarded,
    next_milestone: nextMilestone(streak, settings.streak_milestones), balance: await repository.getBalance(tenant, ref),
  };
}
