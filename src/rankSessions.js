// src/rankSessions.js
const sessions = new Map();
const finalizedSessions = new Map(); // Lưu session đã finalize để người khác trong team submit sau còn biết

function createSession(roomId, players, mode, code) {
  // Dọn session cũ (nếu còn) của CÙNG phòng này trước khi tạo mới.
  for (const [id, s] of sessions) {
    if (s.roomId === roomId) sessions.delete(id);
  }

  const sessionId = `${roomId}-${Date.now()}`;
  sessions.set(sessionId, {
    roomId,
    players: Array.from(players.entries()),
    mode,
    code: code || null,
    createdAt: Date.now(),
    resultMap: new Map(),
    expiresAt: Date.now() + 45 * 60 * 1000,
  });
  return sessionId;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function getActiveSessionByRoomId(roomId) {
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
  // Lưu vào lịch sử 1 giờ để người khác trong team submit sau còn biết
  finalizedSessions.set(sessionId, { ...session, finalizedAt: Date.now() });
  setTimeout(() => finalizedSessions.delete(sessionId), 60 * 60 * 1000);
  return session;
}

// ✅ Kiểm tra xem user có nằm trong session đã finalize của phòng này không
// → dùng để báo "team bạn đã được tính rồi" khi người khác submit sau
function wasRecentlyFinalized(roomId, userId) {
  for (const [id, s] of finalizedSessions) {
    if (s.roomId === roomId && s.players.some(([pid]) => pid === userId)) {
      return { id, ...s };
    }
  }
  return null;
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
  wasRecentlyFinalized,
};