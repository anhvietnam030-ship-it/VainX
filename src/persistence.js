const fs = require('fs');
const path = require('path');
const config = require('../config');

function ensureDataDir() {
  const dir = path.dirname(config.STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Chuyển 1 room (object có Map + timer) thành dữ liệu thuần để ghi ra JSON
function serializeRoom(room) {
  return {
    id: room.id,
    status: room.status,
    code: room.code,
    revealedAt: room.revealedAt,
    firstJoinAt: room.firstJoinAt,
    fullAt: room.fullAt,
    panelChannelId: room.panelChannelId,
    panelMessageId: room.panelMessageId,
    timeoutMs: room.timeoutMs,
    players: Array.from(room.players.entries()).map(([id, p]) => ({ id, ...p })),
    bannedUsers: Array.from(room.bannedUsers || []),
  };
}

// Lưu toàn bộ rooms Map xuống file (bỏ qua timer vì không serialize được)
function saveState(rooms) {
  try {
    ensureDataDir();
    const data = Array.from(rooms.values()).map(serializeRoom);
    fs.writeFileSync(config.STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Không lưu được trạng thái phòng:', err);
  }
}

// Đọc file JSON, trả về Map<roomId, dữ liệu đã lưu> hoặc Map rỗng nếu chưa có file / lỗi
function loadState() {
  try {
    if (!fs.existsSync(config.STATE_FILE)) return new Map();
    const raw = fs.readFileSync(config.STATE_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    return new Map(arr.map((r) => [r.id, r]));
  } catch (err) {
    console.error('Không đọc được trạng thái phòng đã lưu, bỏ qua:', err);
    return new Map();
  }
}

module.exports = { saveState, loadState };
