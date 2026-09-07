// config.js
require('dotenv').config();

module.exports = {
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID,
  ADMIN_ROLE_ID: process.env.ADMIN_ROLE_ID || null,

  JOIN_ROLE_ID: process.env.JOIN_ROLE_ID || null,
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || null,

  CAPACITY: {
    '3v3': 6,
    '5v5': 10,
  },

  ROOMS_PER_MODE: 0,
  MAX_ROOMS_PER_MODE: 10,
  DEFAULT_ROOM_TIMEOUT_MS: 60 * 60 * 1000,
  READY_COUNTDOWN_MS: 2 * 60 * 1000,
  CODE_RESET_DELAY_MS: 2 * 60 * 1000,
  BLINK_INTERVAL_MS: 1500,
  ENFORCE_TEAM_BALANCE: false,
  ACTION_COOLDOWN_MS: 2000,

  STATE_FILE: require('path').join(__dirname, 'data', 'rooms-state.json'),

  IOS_STORE_URL: 'https://apps.apple.com/us/app/vainglory/id671464704',
  ANDROID_STORE_URL: 'https://play.google.com/store/apps/details?id=com.superevilmegacorp.game',
  APP_URL_SCHEME: 'vainglory://',

  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://vainx.onrender.com',

  MODE_BANNER_URL: {
    '3v3': process.env.BANNER_3V3_URL || null,
    '5v5': process.env.BANNER_5V5_URL || null,
  },

  // ===== RANK SETTINGS =====
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
  RANK_K_FACTOR: 32,
  RANK_DEFAULT_ELO: 900,
  RANK_RESULT_WINDOW_MS: 45 * 60 * 1000, // 45 phút
  MAX_RANK_ROOMS_PER_MODE: 10,
};