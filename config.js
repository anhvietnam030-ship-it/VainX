require('dotenv').config();

module.exports = {
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID,
  ADMIN_ROLE_ID: process.env.ADMIN_ROLE_ID || null,

  // (Phương án 5) Role bắt buộc để được bấm "Gia nhập". Để trống = ai cũng vào được.
  JOIN_ROLE_ID: process.env.JOIN_ROLE_ID || null,

  // (Phương án 4) Kênh log riêng cho admin, ghi lại mỗi lần phát code. Để trống = không log.
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || null,

  // Số người tối đa mỗi phòng (3v3 = 6 người, 5v5 = 10 người)
  CAPACITY: {
    '3v3': 6,
    '5v5': 10,
  },

  // Bao nhiêu phòng cho mỗi chế độ
  ROOMS_PER_MODE: 4,

  // 1 tiếng không đủ người / không sẵn sàng xong -> tự reset (đổi được bằng lệnh /set-timeout,
  // hoặc gia hạn riêng 1 phòng đang chạy bằng /gia-han-phong)
  DEFAULT_ROOM_TIMEOUT_MS: 60 * 60 * 1000,

  // Khi phòng vừa đủ người: có 2 phút để TẤT CẢ bấm Sẵn sàng.
  // Hết giờ mà ai chưa sẵn sàng thì bị đá khỏi phòng, nhường slot cho người khác,
  // và đồng hồ 30 phút của phòng (cho những người còn lại) được tính lại từ đầu.
  READY_COUNTDOWN_MS: 2 * 60 * 1000,

  // 2 phút sau khi phát code -> tự reset phòng
  CODE_RESET_DELAY_MS: 2 * 60 * 1000,

  // Nhấp nháy nút Play Game / Sẵn sàng / Lấy code mỗi bao lâu (ms).
  // Lưu ý: để quá thấp (dưới ~1s) có thể bị Discord giới hạn tốc độ (rate limit) khi
  // nhiều phòng cùng nhấp nháy 1 lúc, vì mỗi lần nhấp nháy = 1 lần bot sửa lại tin nhắn.
  BLINK_INTERVAL_MS: 1500,

  // (Phương án 3) Bắt buộc cân bằng team nếu có người chọn team trong phòng.
  // true = nếu có ai chọn team, TẤT CẢ phải chọn team và 2 team phải bằng số (capacity/2 - capacity/2).
  // false = không kiểm tra, đủ người + sẵn sàng là phát code.
  ENFORCE_TEAM_BALANCE: false,

  // (Phương án 2) Cooldown chống spam nút Sẵn sàng / Team (ms)
  ACTION_COOLDOWN_MS: 2000,

  // (Phương án 1) File lưu trạng thái phòng để không mất dữ liệu khi bot restart
  STATE_FILE: require('path').join(__dirname, 'data', 'rooms-state.json'),

  // Link tải game
  IOS_STORE_URL: 'https://apps.apple.com/us/app/vainglory/id671464704',
  ANDROID_STORE_URL: 'https://play.google.com/store/apps/details?id=com.superevilmegacorp.game',

  // Custom URL scheme của app Vainglory để mở thẳng app đã cài (không phải link công khai chính thức,
  // dựa trên thực tế đã test — nếu sau này app đổi scheme thì cập nhật lại đây).
  APP_URL_SCHEME: 'vainglory://',

  // URL public của chính con bot (để tạo trang redirect /play mở app).
  // Trên Render sẽ tự có RENDER_EXTERNAL_URL, không cần khai tay; nếu domain khác thì set
  // biến môi trường PUBLIC_BASE_URL để ghi đè.
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://vainx.onrender.com',

  // (Tùy chọn - UI/UX) Ảnh/GIF banner riêng cho từng chế độ, hiện trong panel phòng.
  // Để trống (null) thì embed vẫn chạy bình thường, chỉ là không có hình minh họa.
  // Muốn có hiệu ứng hình (VD: 2 thanh kiếm lửa cho 3v3, dải màu rainbow cho 5v5):
  // dán URL ảnh/GIF công khai (https://...) vào biến môi trường BANNER_3V3_URL / BANNER_5V5_URL
  // trên Render — không cần sửa code, không cần deploy lại.
  MODE_BANNER_URL: {
    '3v3': process.env.BANNER_3V3_URL || null,
    '5v5': process.env.BANNER_5V5_URL || null,
  },
};
