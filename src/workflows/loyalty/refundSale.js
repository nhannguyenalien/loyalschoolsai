import { requireNonEmpty } from "../../domain/loyalty/points.js";
import { LoyaltyConflictError, LoyaltyNotFoundError } from "../../domain/loyalty/errors.js";

/**
 * Hoàn một hóa đơn đã cộng điểm (đơn bị hủy / trả hàng), toàn bộ:
 * ghi một dòng đảo trong sổ cái, thu hồi lượt quay CHƯA dùng và vé của kỳ CHƯA quay do hóa đơn đó sinh ra.
 * Số dư có thể âm nếu khách đã tiêu số điểm đó (khách không đổi thưởng được cho tới khi bù đủ).
 * Mỗi hóa đơn chỉ hoàn một lần; gọi lại trả `replayed: true`.
 */
export async function refundLoyaltySale({ repository, tenant, input, now = () => new Date() }) {
  const sourceType = requireNonEmpty(input.source_type || "api", "source_type", 30);
  const sourceRef = requireNonEmpty(input.source_ref, "order_id", 200);
  const earn = await repository.findLedgerBySource(tenant, sourceType, sourceRef);
  if (!earn || earn.transaction_type !== "earn") throw new LoyaltyNotFoundError("No credited receipt found for this order_id.");
  if (input.customer_ref && String(input.customer_ref).trim() !== earn.customer_ref) {
    throw new LoyaltyConflictError("This receipt belongs to another customer.");
  }
  const reversalRef = `${sourceType}:${sourceRef}`;
  let entry = await repository.findLedgerBySource(tenant, "refund", reversalRef);
  let replayed = Boolean(entry);
  if (!entry) {
    ({ entry, replayed } = await repository.appendReversal({
      tenant, customer_id: earn.customer_id, customer_ref: earn.customer_ref, transaction_type: "refund",
      points_delta: -Number(earn.points_delta), amount_minor: -Number(earn.amount_minor), currency: earn.currency,
      source_type: "refund", source_ref: reversalRef, rule_version: Number(earn.rule_version),
      idempotency_key: `refund:${reversalRef}`, occurred_at: now().toISOString(), reverses_entry_id: earn.id,
      metadata_json: JSON.stringify(input.metadata || {}),
    }));
  }
  // Thu hồi chạy cả khi replay để hoàn tất nếu lần trước bị ngắt giữa chừng.
  const revoked = await repository.revokeSaleRewards({ tenant, customerRef: earn.customer_ref, sourceRef });
  return { entry, replayed, spins_revoked: revoked.spins, tickets_revoked: revoked.tickets };
}
