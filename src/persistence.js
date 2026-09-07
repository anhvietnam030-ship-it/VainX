const fs = require('fs');
const path = require('path');
const config = require('../config');

function ensureDataDir() {
  const dir = path.dirname(config.STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function serializeRoom(room) {
  const obj = {
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
    isRank: room.isRank || false,
    resultMap: room.isRank ? Array.from(room.resultMap.entries()) : [],
    resultWindowEnd: room.isRank ? room.resultWindowEnd : null,
  };
  return obj;
}

function saveState(rooms, eloData) {
  try {
    ensureDataDir();
    const roomData = Array.from(rooms.values()).map(serializeRoom);
    const eloDataObj = Object.fromEntries(
      Array.from(eloData.entries()).map(([userId, data]) => [userId, data])
    );
    const payload = { rooms: roomData, eloData: eloDataObj };
    fs.writeFileSync(config.STATE_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    console.error('Không lưu được trạng thái:', err);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(config.STATE_FILE)) return { rooms: new Map(), eloData: new Map() };
    const raw = fs.readFileSync(config.STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const roomsMap = new Map(parsed.rooms.map(r => [r.id, r]));
    const eloMap = new Map(Object.entries(parsed.eloData || {}).map(([id, data]) => [id, data]));
    return { rooms: roomsMap, eloData: eloMap };
  } catch (err) {
    console.error('Không đọc được state, bỏ qua:', err);
    return { rooms: new Map(), eloData: new Map() };
  }
}

module.exports = { saveState, loadState };