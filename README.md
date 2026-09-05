# Vainglory Lobby Bot

Bot Discord quản lý 8 phòng ghép đội Vainglory (4 phòng 3v3, 4 phòng 5v5).

## Cài đặt

1. Tạo application + bot tại https://discord.com/developers/applications
   - Vào tab **Bot** → bật **Reset Token**, copy token.
   - Copy **Application ID** ở tab General Information (đó là CLIENT_ID).
   - Mời bot vào server với quyền: Send Messages, Embed Links, Manage Messages (tùy chọn), Read Message History.

2. Cài Node.js >= 18, sau đó:
   ```bash
   npm install
   cp .env.example .env
   # điền DISCORD_TOKEN, CLIENT_ID, GUILD_ID (id server để deploy lệnh nhanh) vào .env
   ```

3. Đăng ký slash command:
   ```bash
   npm run deploy
   ```

4. Chạy bot:
   ```bash
   npm start
   ```

5. Trong Discord, admin gõ `/lobby` ở kênh muốn đặt bảng chọn phòng.

## Luồng hoạt động

- `/lobby` → hiện 2 nút **3v3** / **5v5** → bấm vào hiện 4 nút phòng (kèm số người hiện tại).
- Bấm vào 1 phòng → tự gia nhập phòng đó. Mỗi người **chỉ được ở 1 phòng cùng lúc** (1 là 3v3, 2 là 5v5, không được cả hai cùng lúc).
- Panel của phòng có các nút: **Gia nhập, Rời đi, Sẵn sàng, Team 1, Team 2, Không chọn team**, và 2 nút link **Chơi (iOS/Android)**.
- Khi phòng đủ người (6 với 3v3, 10 với 5v5) → bot thông báo trong kênh (tag tất cả) **và gửi thêm tin nhắn riêng (DM) cho từng người** trong phòng, rồi bắt đầu đếm ngược **2 phút** để mọi người bấm Sẵn sàng.
  - Hết 2 phút mà ai **chưa** Sẵn sàng → **bị đá khỏi phòng**, nhường slot cho người khác. Đồng hồ tự-reset 30 phút của những người còn lại được **tính lại từ đầu**.
  - Nếu sau đó có người mới vào lấp slot trống, quy trình lặp lại đúng như trên (đủ người → đếm ngược 2 phút → đá người chưa sẵn sàng nếu hết giờ...).
- Khi **tất cả** đã bấm Sẵn sàng (nút chuyển xanh có tích ✅) **và** phòng đủ người → bot random code 4 số (không phải "0000") và hiện nút **"Lấy code của tôi"**.
  - Mỗi người bấm nút đó sẽ nhận (ephemeral, chỉ mình thấy) mã riêng dạng:
    - Không chọn team: `1234_TenUser`
    - Có chọn Team 1: `1234-1-TenUser` (Team 2 tương tự `1234-2-...`)
- Cùng lúc đó, 2 nút Chơi game (iOS/Android) sáng lên và nhấp nháy (đổi label mỗi ~4 giây) trong suốt 2 phút.
- Sau 2 phút kể từ lúc phát code → phòng tự reset về trạng thái trống để người khác đăng ký.
- Nếu phòng không đủ người / chưa sẵn sàng hết trong **30 phút** (mặc định) kể từ lúc có người đầu tiên vào → tự reset.
- Admin dùng `/set-timeout phut:<số phút> pham_vi:<all|3v3|5v5>` để đổi thời gian timeout này.
- Admin dùng `/reset-room phong:<id>` (ví dụ `3v3-2`) để ép reset 1 phòng ngay.
- Quyền admin: tài khoản có quyền Discord "Administrator", hoặc có role trùng `ADMIN_ROLE_ID` khai trong `.env`.

## 6 phương án đã được thêm vào

1. **Lưu trạng thái qua restart** — mỗi lần panel đổi, bot ghi trạng thái phòng xuống `data/rooms-state.json`. Khi bot khởi động lại, nó đọc file này, khôi phục người chơi/trạng thái/mốc thời gian và **tính lại chính xác thời gian còn lại** của từng timer (đếm ngược sẵn sàng, timeout 30', reset sau code) dựa trên mốc thời gian đã lưu — không bị "restart lại từ đầu".
2. **Cooldown chống spam** — nút Sẵn sàng và Team có cooldown `ACTION_COOLDOWN_MS` (mặc định 2 giây/người) để tránh bấm liên tục gây rate-limit.
3. **Cân bằng team** — bật bằng `ENFORCE_TEAM_BALANCE` trong `config.js` (mặc định `true`). Nếu có người trong phòng chọn team, bot yêu cầu **tất cả** cùng chọn và 2 team phải bằng số (VD 3-3, 5-5) mới phát code; nếu không ai chọn team thì bỏ qua kiểm tra này.
4. **Kênh log cho admin** — khai `LOG_CHANNEL_ID` trong `.env`, mỗi lần phát code bot sẽ gửi thêm 1 dòng log (phòng, thời gian, danh sách người + team, mã code) vào kênh đó.
5. **Giới hạn role được Gia nhập** — khai `JOIN_ROLE_ID` trong `.env`; ai không có role đó bấm Gia nhập sẽ bị từ chối. Để trống nếu muốn ai cũng vào được.
6. **Chặn rời phòng sau khi có code** — nút Rời đi bị chặn khi phòng đã ở trạng thái "đã phát code", tránh 1 người rời giữa lúc cả team đã cầm code chuẩn bị vào game.

## Giới hạn cần biết

- **Dữ liệu lưu trong RAM**: nếu bot restart/crash, toàn bộ phòng đang chờ sẽ mất trạng thái. Nếu cần bền vững qua restart, nên lưu `rooms` xuống SQLite/JSON định kỳ.
- **"Nhấp nháy"** nút Play chỉ là đổi label/emoji mỗi vài giây (Discord không cho phép animation thật trên button), nên nó sẽ "chớp" chứ không mượt như animation web.
- **Deep link mở app trực tiếp** (mở thẳng vào game/trận) không làm được vì Vainglory không có universal link công khai cho việc này — bot chỉ mở trang App Store / Google Play.
- Code phòng là **một mã chung cho cả phòng**, chỉ khác phần hậu tố theo tên + team của từng người khi hiển thị.

## Vài ý tưởng mở rộng tiếp theo (nếu cần)

- Lệnh `/room-status` để user tự tra xem mình đang ở phòng nào.
- Hiển thị đếm ngược trực tiếp trong embed (hiện tại chỉ ghi "còn X phút" tĩnh, không tick từng giây).
- Đổi từ file JSON sang SQLite nếu số lượng phòng/lịch sử tăng lên nhiều.

Nếu cần mình bổ sung cái nào, cứ nói cụ thể để mình code tiếp.
