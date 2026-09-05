const config = require('../config');

// roomId dạng "3v3-1", "3v3-2", ... "5v5-4"
const rooms = new Map();

function buildInitialRoom(mode, index) {
  return {
    id: `${mode}-${index}`,
    mode, // '3v3' | '5v5'
    index, // 1..4
    label: `Phòng ${mode.toUpperCase()} #${index}`,
    capacity: config.CAPACITY[mode],
    // players: Map<userId, { username, team: 1|2|null, ready: boolean }>
    players: new Map(),
    // Danh sách userId bị cấm tham gia RIÊNG phòng này (không ảnh hưởng phòng khác)
    bannedUsers: new Set(),
    status: 'waiting', // waiting | revealed
    code: null, // mã 4 số của phòng (chung), không phải 0000
    revealedAt: null,
    firstJoinAt: null, // mốc thời gian người đầu tiên vào -> tính đồng hồ 30 phút
    fullAt: null, // mốc thời gian phòng vừa đủ người -> tính đếm ngược 2 phút sẵn sàng
    // Tham chiếu tin nhắn panel để bot tự edit lại
    panelChannelId: null,
    panelMessageId: null,
    // Các timer đang chạy cho phòng này
    timers: {
      inactivity: null, // setTimeout 30' (đổi được)
      readyCountdown: null, // setTimeout 2' chờ mọi người sẵn sàng khi phòng đủ người
      resetAfterCode: null, // setTimeout 2' sau khi phát code
      blink: null, // setInterval nhấp nháy nút play
    },
    // Thời gian timeout hiện tại của phòng (có thể admin chỉnh riêng)
    timeoutMs: config.DEFAULT_ROOM_TIMEOUT_MS,
    _blinkOn: false,
  };
}

function initRooms() {
  for (const mode of Object.keys(config.CAPACITY)) {
    for (let i = 1; i <= config.ROOMS_PER_MODE; i++) {
      const room = buildInitialRoom(mode, i);
      rooms.set(room.id, room);
    }
  }
  return rooms;
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function getAllRooms() {
  return Array.from(rooms.values());
}

function getRoomsByMode(mode) {
  return getAllRooms().filter((r) => r.mode === mode);
}

// Tìm xem 1 user đang ở phòng nào trong TẤT CẢ các phòng (mọi chế độ)
function findRoomOfUser(userId) {
  for (const room of rooms.values()) {
    if (room.players.has(userId)) return room;
  }
  return null;
}

// Mỗi người được ở tối đa 1 phòng 3v3 VÀ 1 phòng 5v5 CÙNG LÚC (không được 2 phòng cùng chế độ)
function findRoomOfUserInMode(userId, mode) {
  for (const room of rooms.values()) {
    if (room.mode === mode && room.players.has(userId)) return room;
  }
  return null;
}

function clearRoomTimers(room) {
  if (room.timers.inactivity) clearTimeout(room.timers.inactivity);
  if (room.timers.readyCountdown) clearTimeout(room.timers.readyCountdown);
  if (room.timers.resetAfterCode) clearTimeout(room.timers.resetAfterCode);
  if (room.timers.blink) clearInterval(room.timers.blink);
  room.timers.inactivity = null;
  room.timers.readyCountdown = null;
  room.timers.resetAfterCode = null;
  room.timers.blink = null;
}

function resetRoom(room) {
  clearRoomTimers(room);
  room.players.clear();
  room.status = 'waiting';
  room.code = null;
  room.revealedAt = null;
  room.firstJoinAt = null;
  room.fullAt = null;
  room._blinkOn = false;
}

function isFull(room) {
  return room.players.size >= room.capacity;
}

function allReady(room) {
  if (room.players.size === 0) return false;
  for (const p of room.players.values()) {
    if (!p.ready) return false;
  }
  return true;
}

// (Phương án 3) Đếm số người mỗi team
function teamCounts(room) {
  let team1 = 0;
  let team2 = 0;
  let none = 0;
  for (const p of room.players.values()) {
    if (p.team === 1) team1++;
    else if (p.team === 2) team2++;
    else none++;
  }
  return { team1, team2, none };
}

// Kiểm tra phòng có đủ điều kiện phát code không (đủ người, sẵn sàng hết, và
// nếu bật ENFORCE_TEAM_BALANCE thì team phải cân bằng hoặc không ai chọn team)
function canRevealCode(room) {
  if (!isFull(room)) return { ok: false, reason: 'not_full' };
  if (!allReady(room)) return { ok: false, reason: 'not_all_ready' };
  if (!config.ENFORCE_TEAM_BALANCE) return { ok: true };

  const { team1, team2, none } = teamCounts(room);
  if (none === room.players.size) return { ok: true }; // không ai chọn team -> bỏ qua kiểm tra
  if (none > 0) return { ok: false, reason: 'team_incomplete' }; // có người chọn, có người chưa chọn
  const half = room.capacity / 2;
  if (team1 !== half || team2 !== half) return { ok: false, reason: 'team_unbalanced' };
  return { ok: true };
}

// (Cấm theo phòng) Cấm 1 user khỏi 1 phòng cụ thể — tự đá luôn nếu đang ở trong phòng đó
function banUser(room, userId) {
  room.bannedUsers.add(userId);
  room.players.delete(userId);
}

function unbanUser(room, userId) {
  room.bannedUsers.delete(userId);
}

function isBanned(room, userId) {
  return room.bannedUsers.has(userId);
}

// Sinh mã 4 số ngẫu nhiên, không được là "0000"
function generateCode() {
  let code;
  do {
    code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  } while (code === '0000');
  return code;
}

// Định dạng code hiển thị riêng cho từng người theo team họ chọn
// Không chọn team -> "<code>-<username>"
// Chọn team 1/2   -> "<code>-<team>_<username>"
function formatPersonalCode(room, userId) {
  if (!room.code) return null;
  const player = room.players.get(userId);
  if (!player) return null;
  if (player.team) {
    return `${room.code}-${player.team}_${player.username}`;
  }
  return `${room.code}-${player.username}`;
}

module.exports = {
  rooms,
  initRooms,
  getRoom,
  getAllRooms,
  getRoomsByMode,
  findRoomOfUser,
  findRoomOfUserInMode,
  clearRoomTimers,
  resetRoom,
  isFull,
  allReady,
  teamCounts,
  canRevealCode,
  generateCode,
  formatPersonalCode,
  banUser,
  unbanUser,
  isBanned,
};
