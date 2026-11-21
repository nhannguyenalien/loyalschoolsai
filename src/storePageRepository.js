const COLS = "tenant, slug, name, enabled, require_pin, created_at";
export function createStorePageRepository({ query, one }) {
  return {
    getStorePage: (tenant) => one(`SELECT ${COLS} FROM store_pages WHERE tenant = $1`, [tenant]),
    getEnabledStorePageBySlug: (slug) => one(`SELECT ${COLS} FROM store_pages WHERE slug = $1 AND enabled`, [slug]),
    // Tạo trang mặc định nếu chưa có (đua nhau thì giữ bản của yêu cầu thắng).
    async ensureStorePage({ tenant, slug, name }) {
      await query("INSERT INTO store_pages (tenant, slug, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [tenant, slug, name]);
      return one(`SELECT ${COLS} FROM store_pages WHERE tenant = $1`, [tenant]);
    },
    updateStorePage: (tenant, { slug, name, enabled, require_pin }) => one(
      `UPDATE store_pages SET slug = COALESCE($2, slug), name = COALESCE($3, name), enabled = COALESCE($4, enabled), require_pin = COALESCE($5, require_pin)
       WHERE tenant = $1 RETURNING ${COLS}`, [tenant, slug ?? null, name ?? null, enabled ?? null, require_pin ?? null]),

    // ---- PIN khách
    getCustomerPin: (tenant, ref) => one("SELECT pin_hash, salt, failed_attempts, locked_until FROM customer_pins WHERE tenant = $1 AND customer_ref = $2", [tenant, ref]),
    // Tạo PIN lần đầu; đã có thì không ghi đè (trả null).
    createCustomerPin: (tenant, ref, hash, salt) => one(
      "INSERT INTO customer_pins (tenant, customer_ref, pin_hash, salt) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING customer_ref", [tenant, ref, hash, salt]),
    // Đặt/đổi PIN (đồng thời xóa bộ đếm sai + khóa).
    upsertCustomerPin: (tenant, ref, hash, salt) => query(
      `INSERT INTO customer_pins (tenant, customer_ref, pin_hash, salt) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant, customer_ref) DO UPDATE SET pin_hash = $3, salt = $4, failed_attempts = 0, locked_until = NULL, updated_at = now()`, [tenant, ref, hash, salt]),
    deleteCustomerPin: async (tenant, ref) => (await query("DELETE FROM customer_pins WHERE tenant = $1 AND customer_ref = $2 RETURNING 1", [tenant, ref])).length > 0,
    // Giữ một lượt thử (nguyên tử). Trả null nếu chưa có PIN hoặc đang bị khóa. Đủ `max` lần sai thì đặt khóa `lockMinutes` phút.
    reserveCustomerPinAttempt: (tenant, ref, max, lockMinutes) => one(
      `UPDATE customer_pins SET
         failed_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_attempts + 1 END,
         locked_until = CASE WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_attempts + 1 END) >= $3
                             THEN now() + make_interval(mins => $4::int) ELSE NULL END
       WHERE tenant = $1 AND customer_ref = $2 AND (locked_until IS NULL OR locked_until <= now())
       RETURNING pin_hash, salt, failed_attempts, locked_until`, [tenant, ref, max, lockMinutes]),
    resetCustomerPinAttempts: (tenant, ref) => query("UPDATE customer_pins SET failed_attempts = 0, locked_until = NULL WHERE tenant = $1 AND customer_ref = $2", [tenant, ref]),
  };
}
