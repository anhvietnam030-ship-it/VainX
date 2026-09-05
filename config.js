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

  // 30 phút không đủ người / không sẵn sàng xong -> tự reset (đổi được bằng lệnh /set-timeout)
  DEFAULT_ROOM_TIMEOUT_MS: 30 * 60 * 1000,

  // Khi phòng vừa đủ người: có 2 phút để TẤT CẢ bấm Sẵn sàng.
  // Hết giờ mà ai chưa sẵn sàng thì bị đá khỏi phòng, nhường slot cho người khác,
  // và đồng hồ 30 phút của phòng (cho những người còn lại) được tính lại từ đầu.
  READY_COUNTDOWN_MS: 2 * 60 * 1000,

  // 2 phút sau khi phát code -> tự reset phòng
  CODE_RESET_DELAY_MS: 2 * 60 * 1000,

  // Nhấp nháy nút Play Game mỗi bao lâu (ms)
  BLINK_INTERVAL_MS: 4000,

  // (Phương án 3) Bắt buộc cân bằng team nếu có người chọn team trong phòng.
  // true = nếu có ai chọn team, TẤT CẢ phải chọn team và 2 team phải bằng số (capacity/2 - capacity/2).
  // false = không kiểm tra, đủ người + sẵn sàng là phát code.
  ENFORCE_TEAM_BALANCE: true,

  // (Phương án 2) Cooldown chống spam nút Sẵn sàng / Team (ms)
  ACTION_COOLDOWN_MS: 2000,

  // (Phương án 1) File lưu trạng thái phòng để không mất dữ liệu khi bot restart
  STATE_FILE: require('path').join(__dirname, 'data', 'rooms-state.json'),

  // Link tải game
  IOS_STORE_URL: 'https://apps.apple.com/us/app/vainglory/id671464704',
  ANDROID_STORE_URL: 'https://play.google.com/store/apps/details?id=com.superevilmegacorp.game',
};
