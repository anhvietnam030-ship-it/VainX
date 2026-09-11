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
    mode: room.mode,
    index: room.index,
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

function buildPayload(rooms, eloData) {
  const roomData = Array.from(rooms.values()).map(serializeRoom);
  const eloDataObj = {};
  for (const [userId, entry] of eloData.entries()) {
    eloDataObj[userId] = entry;
  }
  return { rooms: roomData, eloData: eloDataObj };
}

// ===== GHI FILE BẤT ĐỒNG BỘ + DEBOUNCE =====
// Trước đây saveState() dùng writeFileSync và bị gọi mỗi lần renderRoom()
// (kể cả từ blink interval mỗi 1.5s/phòng) -> chặn event loop liên tục
// khi có nhiều phòng nhấp nháy cùng lúc -> bot phản hồi chậm/"ngáo".
// Giờ: mỗi lần gọi chỉ ghi nhận state mới nhất vào bộ nhớ, và lên lịch
// ghi xuống đĩa (bất đồng bộ) tối đa 1 lần mỗi SAVE_DEBOUNCE_MS.
const SAVE_DEBOUNCE_MS = 3000;
let pendingPayload = null;
let saveTimer = null;
let writing = false;

function writeNow(payload) {
  try {
    ensureDataDir();
  } catch (err) {
    console.error('Không tạo được thư mục dữ liệu:', err);
    return;
  }
  writing = true;
  fs.writeFile(config.STATE_FILE, JSON.stringify(payload), 'utf-8', (err) => {
    writing = false;
    if (err) {
      console.error('Không lưu được trạng thái:', err);
      return;
    }
    // Nếu trong lúc ghi có state mới hơn được lên lịch, ghi tiếp luôn.
    if (pendingPayload) {
      const next = pendingPayload;
      pendingPayload = null;
      writeNow(next);
    }
  });
}

function saveState(rooms, eloData) {
  const payload = buildPayload(rooms, eloData);

  if (saveTimer) {
    // Đã có lịch ghi sắp chạy -> chỉ cần cập nhật payload mới nhất, không đặt thêm timer.
    pendingPayload = payload;
    return;
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    const toWrite = pendingPayload || payload;
    pendingPayload = null;
    if (writing) {
      // Đang ghi dở lần trước (hiếm khi xảy ra) -> để lần ghi đó tự chain tiếp.
      pendingPayload = toWrite;
      return;
    }
    writeNow(toWrite);
  }, SAVE_DEBOUNCE_MS);
}

// Ghi NGAY LẬP TỨC, đồng bộ — chỉ dùng khi bot sắp tắt (SIGTERM/SIGINT)
// để không mất dữ liệu của lần ghi debounce còn đang chờ.
function flushState(rooms, eloData) {
  try {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const payload = pendingPayload || (rooms && eloData ? buildPayload(rooms, eloData) : null);
    pendingPayload = null;
    if (!payload) return;
    ensureDataDir();
    fs.writeFileSync(config.STATE_FILE, JSON.stringify(payload), 'utf-8');
    console.log('✅ Đã flush state trước khi tắt.');
  } catch (err) {
    console.error('❌ Lỗi flush state khi tắt:', err.message);
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

module.exports = { saveState, loadState, flushState };