// src/rankSessions.js
const sessions = new Map();

function createSession(roomId, players, mode, code) {
  // Dọn session cũ (nếu còn) của CÙNG phòng này trước khi tạo mới.
  // Tránh trường hợp phòng bị reset & phát code lại trong lúc session cũ
  // (45 phút) chưa hết hạn -> tồn tại 2 session trùng roomId cùng lúc,
  // khiến /submit-result tra nhầm vào session cũ (không có người chơi mới).
  for (const [id, s] of sessions) {
    if (s.roomId === roomId) sessions.delete(id);
  }

  const sessionId = `${roomId}-${Date.now()}`;
  sessions.set(sessionId, {
    roomId,
    players: Array.from(players.entries()), // [userId, playerData]
    mode,
    // Mã phòng RANDOM của ĐÚNG trận này, chốt cứng ngay lúc tạo session.
    // Bắt buộc dùng giá trị này (không đọc room.code "sống" lúc submit-result)
    // vì phòng có thể đã bị reset & phát code MỚI cho trận tiếp theo trong
    // lúc session cũ vẫn còn hạn 45 phút để nhận kết quả.
    code: code || null,
    createdAt: Date.now(),
    resultMap: new Map(),
    expiresAt: Date.now() + 45 * 60 * 1000, // 45 phút để gửi kết quả
  });
  return sessionId;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function getActiveSessionByRoomId(roomId) {
  // Phòng hờ: nếu vẫn có nhiều session trùng roomId còn hạn (không nên xảy ra
  // sau khi createSession đã dọn dẹp ở trên), luôn lấy session MỚI NHẤT
  // thay vì cái đầu tiên gặp trong Map (thứ tự chèn = cũ nhất trước).
  let latest = null;
  for (const [id, session] of sessions) {
    if (session.roomId === roomId && Date.now() < session.expiresAt) {
      if (!latest || session.createdAt > latest.createdAt) {
        latest = { id, ...session };
      }
    }
  }
  return latest;
}

function addResult(sessionId, userId, resultData) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (Date.now() > session.expiresAt) return false;
  session.resultMap.set(userId, resultData);
  return true;
}

function finalizeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  sessions.delete(sessionId);
  return session;
}

// Dọn dẹp session hết hạn mỗi 5 phút
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(id);
  }
}, 5 * 60 * 1000);

module.exports = {
  createSession,
  getSession,
  getActiveSessionByRoomId,
  addResult,
  finalizeSession,
};
