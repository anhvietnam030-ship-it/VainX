require('dotenv').config();

// Thư mục lưu dữ liệu bền vững. Nếu bạn gắn Persistent Disk trên Render (khuyến nghị),
// đặt biến môi trường DATA_DIR = đúng mount path của disk đó (vd. "/data").
// Nếu không set, sẽ dùng thư mục "data" ngay trong code -> sẽ MẤT sau mỗi lần deploy trên Render.
const DATA_DIR = process.env.DATA_DIR || require('path').join(__dirname, 'data');

module.exports = {
  // ----- DISCORD TOKEN & ID -----
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID,
  ADMIN_ROLE_ID: (process.env.ADMIN_ROLE_ID || '').trim() || null,

  // ----- CẤU HÌNH MẶC ĐỊNH -----
  // .trim() vì một số panel host (vd wispbyte) dễ dính khoảng trắng/newline
  // thừa khi copy-paste ID vào ô env -> so sánh ID bị sai lệch âm thầm.
  JOIN_ROLE_ID: (process.env.JOIN_ROLE_ID || '').trim() || null,
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || null,
  ANNOUNCE_CHANNEL_ID: process.env.ANNOUNCE_CHANNEL_ID || null,

  PANEL_CHANNELS: {
    normal: {
      '3v3': process.env.PANEL_CHANNEL_3V3 || null,
      '5v5': process.env.PANEL_CHANNEL_5V5 || null,
    },
    rank: {
      '3v3': process.env.PANEL_CHANNEL_RANK_3V3 || null,
      '5v5': process.env.PANEL_CHANNEL_RANK_5V5 || null,
    },
  },

  CAPACITY: {
    '3v3': 6,
    '5v5': 10,
  },

  ROOMS_PER_MODE: 2,
  DEFAULT_RANK_ROOMS_PER_MODE: 2,
  MAX_ROOMS_PER_MODE: 10,
  MAX_RANK_ROOMS_PER_MODE: 10,

  DEFAULT_ROOM_TIMEOUT_MS: 60 * 60 * 1000,  // 1 giờ
  READY_COUNTDOWN_MS: 2 * 60 * 1000,        // 2 phút
  CODE_RESET_DELAY_MS: 2 * 60 * 1000,       // 2 phút sau phát code
  RANK_RESULT_WINDOW_MS: 45 * 60 * 1000,    // 45 phút cho phòng rank

  BLINK_INTERVAL_MS: 1500,
  ENFORCE_TEAM_BALANCE: false,
  ACTION_COOLDOWN_MS: 2000,

  STATE_FILE: require('path').join(DATA_DIR, 'rooms-state.json'),

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
  // Ngưỡng ELO mỗi tier: 300 ELO / bậc.
  // Mỗi tier chia 3 mức con: 0-99 Đồng · 100-199 Bạc · 200-299 Vàng.
  RANK_TIERS: [
    { name: 'Unranked',            minElo: 0,    maxElo: 299 },
    { name: 'Working on It',       minElo: 300,  maxElo: 599 },
    { name: 'Getting There',       minElo: 600,  maxElo: 899 },
    { name: 'Not Bad',             minElo: 900,  maxElo: 1199 },
    { name: 'Decent-ish',          minElo: 1200, maxElo: 1499 },
    { name: 'Pretty Good',         minElo: 1500, maxElo: 1799 },
    { name: 'The Hotness',         minElo: 1800, maxElo: 2099 },
    { name: 'Simply Amazing',      minElo: 2100, maxElo: 2399 },
    { name: 'Pinnacle of Awesome', minElo: 2400, maxElo: 2699 },
    { name: 'Vainglorious',        minElo: 2700, maxElo: 3000 },
  ],

  // K-factor — cấu hình để:
  //   Tier 0-2: ~4 ván/tier  (K = 150)
  //   Tier 3-5: ~5 ván/tier  (K = 120)
  //   Tier 6-8: ~7 ván/tier  (K = 85)
  //   Tier 9:   ~9 ván/tier  (K = 65)
  // Thua dùng nửa K → không sốc. KDA cao khi thua còn bớt mất điểm.
  RANK_K_FACTORS: {
    0: 150,  // Unranked
    1: 150,  // Working on It
    2: 150,  // Getting There
    3: 120,  // Not Bad
    4: 120,  // Decent-ish
    5: 120,  // Pretty Good
    6: 85,   // The Hotness
    7: 85,   // Simply Amazing
    8: 85,   // Pinnacle of Awesome
    9: 65,   // Vainglorious
  },

  RANK_DEFAULT_ELO: 0,
  RANK_RESULT_WINDOW_MS: 45 * 60 * 1000,
  MAX_RANK_ROOMS_PER_MODE: 10,

  RANK_MEDALS: ['🥉', '🥈', '🥇'],
  RANK_COLORS: ['#CD7F32', '#C0C0C0', '#FFD700'],

  // =============================================
  // ====== API OCR ==============================
  // =============================================
  OCR_API_KEY: process.env.OCR_API_KEY || null,
};