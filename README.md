# Loyal SchoolsAI

Hệ thống tích điểm, chăm sóc khách hàng và quà tặng — tách ra từ dashboard SchoolsAI.

- **Frontend**: static (Tabler + JS thuần), không cần build.
- **API**: Cloudflare Pages Functions (`functions/api/v1/[[path]].js`), cùng origin với frontend.
- **Dữ liệu**: Postgres trên Neon (`schema.sql`). Sổ cái chỉ ghi thêm, số dư = `SUM(points_delta)`.
- **Đăng nhập**: Firebase Auth (email/mật khẩu + Google). Function xác thực Firebase ID token; mỗi tài khoản là một cửa hàng (`tenant = uid`). Project Firebase: `loyalschoolsai`.

## Trang
| File | Chức năng |
|---|---|
| `index.html` | Đăng nhập / đăng ký (email, Google) |
| `overview.html` | Tổng quan: số liệu, biểu đồ 14 ngày, giao dịch gần đây, bắt đầu nhanh |
| `customers.html` | Cộng điểm theo hóa đơn, trừ điểm, tra cứu khách |
| `rewards.html` | Quay thưởng với 4 trò chơi dùng chung lượt chơi: Vòng quay, Thẻ bí mật (Pick a Card), Xúc xắc (Lucky Dice), Slot Machine; đếm lượt của khách, giao thưởng |
| `checkin.html` | Điểm danh hằng ngày + chuỗi liên tiếp (7/14/30 ngày), cấu hình điểm và mốc thưởng |
| `missions.html` | Nhiệm vụ hằng ngày (điểm danh / số hóa đơn / chi tiêu) → thưởng điểm hoặc lượt quay |
| `draws.html` | Quay số may mắn: phát vé theo hóa đơn, cấp vé thủ công, rút thăm có hiệu ứng, giao thưởng |
| `settings.html` | Luật tích điểm (có phiên bản, xem trước) |
| `integrations.html` | API key cho POS + hướng dẫn nhanh |
| `docs.html` | Tài liệu API công khai (không cần đăng nhập) |
| `admin.html` | Quản trị chương trình/giải thưởng chung (dùng `ADMIN_SECRET`) |

## API
`/api/v1/loyalty/*` (header `Authorization: Bearer <Firebase ID token>` hoặc `Bearer lsk_...`) và `/api/v1/admin/reward-world/*` (header `X-Admin-Secret`).
Giữ nguyên hợp đồng của API cũ để tích hợp POS sau này: `POST /sales`, `POST /redemptions`, `GET /account`, ...

## Game giữ chân & quay số (P0)
| Game | Cách hoạt động |
|---|---|
| Daily Check-in | Mỗi khách một lần/ngày (ngày theo giờ VN), nhận điểm cấu hình được. |
| Streak Rewards | Điểm danh liên tiếp chạm mốc (mặc định 7/14/30 ngày) được thưởng thêm, mỗi mốc một lần trong một chuỗi. Bỏ lỡ một ngày thì chuỗi về 1. |
| Daily Mission | Nhiệm vụ trong ngày (điểm danh, N hóa đơn, chi ≥ X ₫) → nhận điểm hoặc lượt quay của Reward World. |
| Lucky Draw | Hóa đơn tự sinh vé khi kỳ đang mở; cuối kỳ rút thăm ngẫu nhiên (CSPRNG), mỗi kỳ quay một lần, tuỳ chọn mỗi khách một giải. |

Điểm thưởng game ghi vào cùng sổ cái điểm (`transaction_type = 'bonus'`), idempotent theo ngày/mốc/nhiệm vụ. 
### Mini-game dùng chung lượt quay (Pick a Card · Lucky Dice · Slot Machine)
Cùng chương trình Reward World, cùng bộ giải thưởng và cùng lượt chơi với vòng quay. **Kết quả luôn do máy chủ quyết định** (`POST /reward-world/spins`, tham số `game`: `wheel|cards|dice|slot`); game chỉ là cách trình bày (`assets/js/minigames.js`), và được lưu ở `reward_spin_results.game`.
- **Thẻ bí mật**: khách chọn 1 trong 6 thẻ, thẻ đó lật ra giải; các thẻ còn lại lật mờ cho khách xem.
- **Xúc xắc**: 1 viên (≤ 6 giải) hoặc 2 viên (7–11 giải); mỗi mặt/tổng ứng với một giải.
- **Slot**: trúng = ba biểu tượng giống nhau của giải đó; không trúng = ba biểu tượng khác nhau.

Chưa làm: Lucky Number, Weekly Challenge, Treasure Hunt.

## Tích hợp POS
Tạo key ở trang **Luật tích điểm → API key cho POS** (key chỉ hiện một lần; DB chỉ lưu hash). Key gắn với một cửa hàng, nên không cần `X-Tenant`.
```
# Cộng điểm khi chốt đơn (gửi lại cùng idempotency_key khi mạng lỗi sẽ không cộng trùng)
curl -X POST https://<domain>/api/v1/loyalty/sales -H "Authorization: Bearer lsk_..." -H "Content-Type: application/json" \
  -d '{"idempotency_key":"pos:HD001","customer_ref":"0901234567","source_type":"pos","source_ref":"HD001","amount_minor":250000,"customer":{"name":"An","phone":"0901234567"}}'
# Xem điểm
curl "https://<domain>/api/v1/loyalty/account?customer_ref=0901234567" -H "Authorization: Bearer lsk_..."
# Đổi điểm
curl -X POST https://<domain>/api/v1/loyalty/redemptions -H "Authorization: Bearer lsk_..." -H "Content-Type: application/json" \
  -d '{"idempotency_key":"redeem:G1","customer_ref":"0901234567","source_ref":"G1","points":50}'
```
Key không tạo/thu hồi được key khác; việc đó chỉ làm được bằng phiên đăng nhập.

## Đăng nhập (Firebase)
Bật sẵn Email/Password và Google trong Firebase console. Mỗi tên miền dùng để đăng nhập phải nằm trong
**Authentication → Settings → Authorized domains** (đã có `localhost` và `loyalschoolsai.pages.dev`; thêm domain riêng nếu gắn).
Cấu hình web ở `assets/js/firebase-config.js` là thông tin công khai.

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
- Di chuyển dữ liệu cũ từ PocketBase sang Neon (`dashpoc/scripts/pb-loyalty-export.mjs` là điểm khởi đầu).
