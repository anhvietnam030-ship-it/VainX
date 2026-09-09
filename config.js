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
  ANNOUNCE_CHANNEL_ID: process.env.ANNOUNCE_CHANNEL_ID || null, // Kênh thông báo tự động

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
    { name: 'Unranked', minElo: 0, maxElo: 299 },
    { name: 'Working on It', minElo: 300, maxElo: 599 },
    { name: 'Getting There', minElo: 600, maxElo: 899 },
    { name: 'Not Bad', minElo: 900, maxElo: 1199 },
    { name: 'Decent-ish', minElo: 1200, maxElo: 1499 },
    { name: 'Pretty Good', minElo: 1500, maxElo: 1799 },
    { name: 'The Hotness', minElo: 1800, maxElo: 2099 },
    { name: 'Simply Amazing', minElo: 2100, maxElo: 2399 },
    { name: 'Pinnacle of Awesome', minElo: 2400, maxElo: 2699 },
    { name: 'Vainglorious', minElo: 2700, maxElo: 3000 },
  ],

  RANK_K_FACTORS: {
    0: 44,  // Unranked
    1: 44,  // Working on It
    2: 44,  // Getting There
    3: 40,  // Not Bad
    4: 40,  // Decent-ish
    5: 36,  // Pretty Good
    6: 36,  // The Hotness
    7: 33,  // Simply Amazing
    8: 33,  // Pinnacle of Awesome
    9: 30,  // Vainglorious
  },

  RANK_DEFAULT_ELO: 0,
  RANK_RESULT_WINDOW_MS: 45 * 60 * 1000,  // 45 phút
  MAX_RANK_ROOMS_PER_MODE: 10,

  // Biểu tượng và màu cho các bậc (Đồng, Bạc, Vàng)
  RANK_MEDALS: ['🥉', '🥈', '🥇'],
  RANK_COLORS: ['#CD7F32', '#C0C0C0', '#FFD700'],

  // =============================================
  // ====== API OCR ==============================
  // =============================================
  // Lấy key từ biến môi trường .env
  OCR_API_KEY: process.env.OCR_API_KEY || null,
};