# Loyal SchoolsAI

Hệ thống tích điểm, chăm sóc khách hàng và quà tặng — tách ra từ dashboard SchoolsAI.

- **Frontend**: static (Tabler + JS thuần), không cần build.
- **API**: Cloudflare Pages Functions (`functions/api/v1/[[path]].js`), cùng origin với frontend.
- **Dữ liệu**: Postgres trên Neon (`schema.sql`). Sổ cái chỉ ghi thêm, số dư = `SUM(points_delta)`.
- **Đăng nhập**: dùng lại tài khoản `tenants` của PocketBase (cùng tài khoản dashboard); function xác thực token qua PocketBase.

## Trang
| File | Chức năng |
|---|---|
| `index.html` | Đăng nhập |
| `customers.html` | Cộng điểm theo hóa đơn, trừ điểm, tra cứu khách |
| `rewards.html` | Tham gia Reward World, vòng quay, giao thưởng |
| `settings.html` | Luật tích điểm (có phiên bản) |
| `admin.html` | Quản trị chương trình/giải thưởng chung (dùng `ADMIN_SECRET`) |

## API
`/api/v1/loyalty/*` (header `Authorization: <PocketBase token>` + `X-Tenant`) và `/api/v1/admin/reward-world/*` (header `X-Admin-Secret`).
Giữ nguyên hợp đồng của API cũ để tích hợp POS sau này: `POST /sales`, `POST /redemptions`, `GET /account`, ...

## Chạy local
```
npm install
# tạo .dev.vars (đã gitignore):
#   DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require
#   ADMIN_SECRET=...
export DATABASE_URL=...; npm run db:init   # tạo bảng
npm run dev                                # http://localhost:8788
npm test                                   # test tích hợp trên DB (dùng tenant tạm, tự dọn)
```

## Deploy (Cloudflare Pages)
Build command để trống, output directory `/`. Đặt secret:
```
wrangler pages secret put DATABASE_URL
wrangler pages secret put ADMIN_SECRET
```

## Chưa làm
- API key cho POS gọi trực tiếp (hiện chỉ xác thực bằng phiên đăng nhập PocketBase).
- Di chuyển dữ liệu cũ từ PocketBase sang Neon (`dashpoc/scripts/pb-loyalty-export.mjs` là điểm khởi đầu).
- Đăng nhập Google.
