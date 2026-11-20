const COLS = "tenant, slug, name, enabled, created_at";
export function createStorePageRepository({ query, one }) {
  return {
    getStorePage: (tenant) => one(`SELECT ${COLS} FROM store_pages WHERE tenant = $1`, [tenant]),
    getEnabledStorePageBySlug: (slug) => one(`SELECT ${COLS} FROM store_pages WHERE slug = $1 AND enabled`, [slug]),
    // Tạo trang mặc định nếu chưa có (đua nhau thì giữ bản của yêu cầu thắng).
    async ensureStorePage({ tenant, slug, name }) {
      await query("INSERT INTO store_pages (tenant, slug, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [tenant, slug, name]);
      return one(`SELECT ${COLS} FROM store_pages WHERE tenant = $1`, [tenant]);
    },
    updateStorePage: (tenant, { slug, name, enabled }) => one(
      `UPDATE store_pages SET slug = COALESCE($2, slug), name = COALESCE($3, name), enabled = COALESCE($4, enabled)
       WHERE tenant = $1 RETURNING ${COLS}`, [tenant, slug ?? null, name ?? null, enabled ?? null]),
  };
}
