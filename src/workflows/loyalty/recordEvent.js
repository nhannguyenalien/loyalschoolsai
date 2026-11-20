import { recordLoyaltySale } from "./recordSale.js";
import { redeemLoyaltyPoints } from "./redeemPoints.js";
import { checkIn } from "../games/checkin.js";
import { requireNonEmpty } from "../../domain/loyalty/points.js";
import { LoyaltyValidationError } from "../../domain/loyalty/errors.js";

export const EVENT_TYPES = ["purchase", "redeem", "checkin"];

/**
 * Cổng sự kiện duy nhất cho tích hợp: một lời gọi → điểm, lượt quay, vé, điểm danh, tiến độ nhiệm vụ.
 * Nhiệm vụ/thử thách tính tiến độ từ dữ liệu thật nên tự cập nhật, không cần gọi riêng.
 * Khóa chống trùng: header Idempotency-Key, hoặc `idempotency_key`, hoặc mặc định `<type>:<order_id>`.
 */
export async function recordLoyaltyEvent({ repository, tenant, input, idempotencyKey }) {
  const type = String(input?.type || "").trim();
  if (!EVENT_TYPES.includes(type)) throw new LoyaltyValidationError(`type must be one of: ${EVENT_TYPES.join(", ")}.`);
  const customerRef = requireNonEmpty(input.customer_ref, "customer_ref", 200);
  const orderId = String(input.order_id || "").trim();
  const key = String(idempotencyKey || input.idempotency_key || (orderId ? `${type}:${orderId}` : "")).trim();

  let result;
  if (type === "purchase") {
    const source = requireNonEmpty(input.source_type || "api", "source_type", 30);
    result = await recordLoyaltySale({ repository, tenant, input: {
      idempotency_key: requireNonEmpty(key, "Idempotency-Key (or order_id)", 200), customer_ref: customerRef,
      source_type: source, source_ref: requireNonEmpty(orderId, "order_id", 200), amount_minor: input.amount_minor,
      customer: input.customer, metadata: input.metadata,
    } });
  } else if (type === "redeem") {
    result = await redeemLoyaltyPoints({ repository, tenant, input: {
      idempotency_key: requireNonEmpty(key, "Idempotency-Key (or order_id)", 200), customer_ref: customerRef,
      source_ref: requireNonEmpty(orderId, "order_id", 200), points: input.points, note: input.note, metadata: input.metadata,
    } });
  } else {
    result = await checkIn({ repository, tenant, customerRef });
  }

  const balance = Number(await repository.getBalance(tenant, customerRef));
  return {
    type, customer_ref: customerRef, replayed: Boolean(result.replayed), balance,
    points_delta: result.entry ? Number(result.entry.points_delta) : Number(result.points || 0),
    spins_earned: result.entitlements?.length || 0,
    tickets_earned: result.tickets?.length || 0,
    detail: result,
  };
}
