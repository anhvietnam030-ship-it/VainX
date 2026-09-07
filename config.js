require('dotenv').config();

module.exports = {
  // ----- DISCORD TOKEN & ID -----
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID,
  ADMIN_ROLE_ID: process.env.ADMIN_ROLE_ID || null,

  // ----- CẤU HÌNH MẶC ĐỊNH -----
  JOIN_ROLE_ID: process.env.JOIN_ROLE_ID || null,
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || null,

  CAPACITY: {
    '3v3': 6,
    '5v5': 10,
  },

  ROOMS_PER_MODE: 0,              // Không tạo sẵn phòng mặc định
  MAX_ROOMS_PER_MODE: 10,         // Số phòng thường tối đa mỗi chế độ
  MAX_RANK_ROOMS_PER_MODE: 10,    // Số phòng rank tối đa mỗi chế độ

  DEFAULT_ROOM_TIMEOUT_MS: 60 * 60 * 1000,  // 1 giờ
  READY_COUNTDOWN_MS: 2 * 60 * 1000,        // 2 phút
  CODE_RESET_DELAY_MS: 2 * 60 * 1000,       // 2 phút sau phát code
  RANK_RESULT_WINDOW_MS: 45 * 60 * 1000,    // 45 phút cho phòng rank

  BLINK_INTERVAL_MS: 1500,
  ENFORCE_TEAM_BALANCE: false,
  ACTION_COOLDOWN_MS: 2000,

  STATE_FILE: require('path').join(__dirname, 'data', 'rooms-state.json'),

  // ----- CỬA HÀNG APP -----
  IOS_STORE_URL: 'https://apps.apple.com/us/app/vainglory/id671464704',
  ANDROID_STORE_URL: 'https://play.google.com/store/apps/details?id=com.superevilmegacorp.game',
  APP_URL_SCHEME: 'vainglory://',

  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://vainx.onrender.com',

  // ----- BANNER ẢNH PHÒNG -----
  MODE_BANNER_URL: {
    '3v3': process.env.BANNER_3V3_URL || null,
    '5v5': process.env.BANNER_5V5_URL || null,
  },

  // =============================================
  // ====== CẤU HÌNH HỆ THỐNG RANK ==============
  // =============================================
  RANK_TIERS: [
    { name: 'Unranked', minElo: 0, maxElo: 999 },
    { name: 'Working on It', minElo: 1000, maxElo: 1099 },
    { name: 'Getting There', minElo: 1100, maxElo: 1199 },
    { name: 'Not Bad', minElo: 1200, maxElo: 1299 },
    { name: 'Decent-ish', minElo: 1300, maxElo: 1399 },
    { name: 'Pretty Good', minElo: 1400, maxElo: 1499 },
    { name: 'The Hotness', minElo: 1500, maxElo: 1599 },
    { name: 'Simply Amazing', minElo: 1600, maxElo: 1699 },
    { name: 'Pinnacle of Awesome', minElo: 1700, maxElo: 1899 },
    { name: 'Vainglorious', minElo: 1900, maxElo: Infinity },
  ],

  RANK_K_FACTOR: 32,                // Hệ số K – càng lớn thay đổi càng nhanh
  RANK_DEFAULT_ELO: 900,            // Elo ban đầu cho người chơi mới (sẽ thuộc Unranked)

  // =============================================
  // ====== API OCR ==============================
  // =============================================
  // Lấy key từ biến môi trường .env
  OCR_API_KEY: process.env.OCR_API_KEY || null,
};