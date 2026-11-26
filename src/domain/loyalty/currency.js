import { LoyaltyValidationError } from "./errors.js";

/** Tiền tệ hỗ trợ và số chữ số thập phân: amount_minor = số tiền × 10^decimals. */
export const CURRENCIES = { VND: 0, USD: 2 };

export function requireCurrency(value) {
  const currency = String(value || "").trim().toUpperCase();
  if (!Object.hasOwn(CURRENCIES, currency)) throw new LoyaltyValidationError(`currency must be one of: ${Object.keys(CURRENCIES).join(", ")}.`);
  return currency;
}
