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

## Deploy lên Render (hoặc host kiểu "Web Service" tương tự)

Bot đã tự mở sẵn 1 server HTTP nhỏ (`src/keepalive.js`) lắng nghe cổng `process.env.PORT`, dùng để Render port-check không bị timeout. Khi tạo service trên Render:

- **Build Command**: `npm install`
- **Start Command**: `npm start`
- Khai đủ biến môi trường (`DISCORD_TOKEN`, `CLIENT_ID`, ...) trong tab **Environment** của Render, KHÔNG dùng file `.env` (Render không đọc file này).
- Nếu vẫn báo lỗi, kiểm tra log xem có phải bot bị crash trước khi kịp mở cổng không (ví dụ thiếu `DISCORD_TOKEN`) — server HTTP chỉ mở được nếu `node index.js` không bị throw lỗi ở phần load `discord.js`/`config.js` phía trên.
- Lưu ý: Render Free/Starter Web Service có thể "ngủ" hoặc bị restart định kỳ nếu không có traffic HTTP — nếu bot hay bị rớt kết nối Discord một cách khó hiểu, cân nhắc dùng loại dịch vụ **Background Worker** (không cần mở cổng, không bị áp lực "phải có traffic") thay vì Web Service, hoặc dùng 1 uptime-pinger gọi vào URL Render mỗi vài phút để giữ instance không ngủ.
- Dữ liệu phòng lưu ở `data/rooms-state.json` (đĩa cục bộ của Render) sẽ **mất khi Render deploy lại / redeploy** nếu chưa gắn Persistent Disk — với quy mô bot này thường không ảnh hưởng nhiều, nhưng nếu cần giữ qua redeploy thì phải thêm Render Disk và trỏ `STATE_FILE` trong `config.js` vào đường dẫn disk đó.

### Chống bị "ngủ" 15 phút (Render Free Web Service)

Render Free tự spin-down khi 15 phút không có request nào gọi vào, và cấp 750 giờ máy miễn phí/tháng/workspace (chạy 24/7 một service ~720 giờ/tháng vẫn nằm trong hạn mức đó cho 1 service). Đây **không phải hành vi lỗi**, và cách "chống ngủ" dưới đây là mẹo lách, không phải giải pháp Render chính thức hỗ trợ:

1. **Tự ping (đã có sẵn trong code)** — bot tự động gọi vào URL public của chính nó mỗi 10 phút (`src/keepalive.js`). Trên Render, biến `RENDER_EXTERNAL_URL` được tự cấp sẵn nên không cần cấu hình gì thêm, cứ deploy lên là chạy.
2. **Dùng thêm uptime-pinger ngoài (khuyên dùng, đáng tin hơn)** — đăng ký free 1 trong các dịch vụ như UptimeRobot, cron-job.org, Freshping... rồi trỏ nó gọi HTTP GET vào URL Render của bạn mỗi 5–10 phút. Cách này không phụ thuộc vào việc bot có tự ping được hay không.
3. **Cách chắc chắn 100%** — nâng lên gói **Starter** trả phí (~7 USD/tháng) của Render, loại này không bao giờ bị spin-down.

⚠️ Vì filesystem của Render Free là tạm thời, dù chống ngủ thành công thì `data/rooms-state.json` vẫn có thể mất mỗi khi Render tự khởi động lại instance (không chỉ lúc "ngủ dậy"). Muốn giữ file này qua các lần restart thì phải gắn Render Persistent Disk (chỉ có ở gói trả phí).

## Cập nhật code lên GitHub bằng 1 cú click

File **`update-github.bat`** (chỉ chạy trên Windows) giúp bạn khỏi gõ `git add / commit / push` từng lệnh:

1. **Chỉ làm 1 lần duy nhất** để nối thư mục này với repo GitHub của bạn — mở Command Prompt/PowerShell tại thư mục bot rồi gõ:
   ```bash
   git init
   git remote add origin https://github.com/TEN-BAN/TEN-REPO.git
   git branch -M main
   git add -A
   git commit -m "Init"
   git push -u origin main
   ```
   (Thay `TEN-BAN/TEN-REPO` bằng repo GitHub thật của bạn. Lần đầu push, Windows/Git có thể hiện popup đăng nhập GitHub — đăng nhập 1 lần là xong.)

2. **Từ lần sau**, mỗi khi sửa code xong, chỉ cần **double-click vào `update-github.bat`** — nó sẽ tự `git add`, hỏi bạn nội dung commit (Enter để dùng mặc định), rồi tự `git push` lên GitHub luôn. Cửa sổ đen sẽ hiện log, xong thì bấm phím bất kỳ để đóng.

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

## Giao diện (UI/UX)

- **Progress bar** trực quan cho số người trong phòng (🟩🟩🟩⬜⬜⬜), màu embed đổi theo trạng thái: xám (trống) → xanh dương (đang vào) → vàng (đủ người) → cam (đủ người nhưng team lệch) → xanh lá (đã phát code).
- **Team hiển thị theo cột** (Team 1 / Team 2 / Chưa chọn) thay vì 1 danh sách dài, dễ nhìn ai đang ở team nào, ai đã sẵn sàng (✅/⌛).
- **Đồng hồ đếm ngược thật** dùng định dạng thời gian của Discord (`<t:...:R>`) cho cả 3 mốc: hạn bấm Sẵn sàng, hạn tự reset khi ế người, và hạn tự reset sau khi phát code — Discord tự tick “còn 1 phút”, “còn 30 giây”... không cần bot sửa tin liên tục.
- **Danh sách phòng** (khi bấm 3v3/5v5) dùng số emoji 1️⃣2️⃣3️⃣4️⃣ + đổi màu nút theo còn chỗ/hết chỗ/đang chơi.
- **Bảng chọn chế độ chính** hiển thị luôn số người đang chờ ở mỗi chế độ tại thời điểm đăng bảng.

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
