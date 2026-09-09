// src/rankSessions.js
const sessions = new Map();

function createSession(roomId, players, mode) {
  const sessionId = `${roomId}-${Date.now()}`;
  sessions.set(sessionId, {
    roomId,
    players: Array.from(players.entries()), // [userId, playerData]
    mode,
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
  for (const [id, session] of sessions) {
    if (session.roomId === roomId && Date.now() < session.expiresAt) {
      return { id, ...session };
    }
  }
  return null;
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