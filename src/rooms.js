const config = require('../config');

const rooms = new Map();
const hiddenRooms = new Map();
const eloData = new Map();

function getElo(userId) {
  if (!eloData.has(userId)) {
    return { elo: null, rank: 'Unranked', rankIndex: 0, ign: null };
  }
  const data = eloData.get(userId);
  let rankIndex = 0;
  for (let i = 0; i < config.RANK_TIERS.length; i++) {
    if (data.elo >= config.RANK_TIERS[i].minElo && data.elo <= config.RANK_TIERS[i].maxElo) {
      rankIndex = i;
      break;
    }
  }
  return { ...data, rankIndex };
}

function getRankFromElo(elo) {
  if (elo === null || elo === undefined) return 'Unranked';
  for (const tier of config.RANK_TIERS) {
    if (elo >= tier.minElo && elo < tier.maxElo) return tier.name;
  }
  return 'Unranked';
}

function updateElo(userId, newElo, ign) {
  const rank = getRankFromElo(newElo);
  const data = { elo: newElo, rank };
  if (ign !== undefined) data.ign = ign;
  else {
    const old = eloData.get(userId);
    if (old && old.ign) data.ign = old.ign;
  }
  eloData.set(userId, data);
  return data;
}

function registerIGN(userId, ign) {
  for (const [id, data] of eloData) {
    if (data.ign && data.ign.toLowerCase() === ign.toLowerCase() && id !== userId) {
      return { ok: false, reason: 'IGN này đã được đăng ký bởi người khác.' };
    }
  }
  const current = eloData.get(userId) || { elo: config.RANK_DEFAULT_ELO, rank: 'Unranked' };
  current.ign = ign;
  eloData.set(userId, current);
  return { ok: true };
}

function calculateNewElo(userElo, opponentElos, result, kda, userRankIndex) {
  if (!opponentElos || opponentElos.length === 0) return userElo;
  const currentElo = (userElo === null || userElo === undefined) ? config.RANK_DEFAULT_ELO : userElo;
  const avgOppElo = opponentElos.reduce((a, b) => a + b, 0) / opponentElos.length;
  const expected = 1 / (1 + Math.pow(10, (avgOppElo - currentElo) / 400));
  const S = result === 'win' ? 1 : 0;
  const K = config.RANK_K_FACTORS[userRankIndex] || 32;
  let rawChange = K * (S - expected);

  if (kda !== undefined && kda !== null) {
    const kdaValue = Math.min(kda, 10);
    let kdaFactor;
    if (kdaValue >= 4) kdaFactor = 1.5;
    else if (kdaValue >= 3) kdaFactor = 1.2;
    else if (kdaValue >= 2) kdaFactor = 1.0;
    else if (kdaValue >= 1) kdaFactor = 0.8;
    else kdaFactor = 0.5;
    if (S === 1) rawChange = rawChange * kdaFactor;
    else rawChange = rawChange * (1 / kdaFactor);
  }

  const newElo = currentElo + Math.round(rawChange);
  return Math.max(0, Math.min(3000, newElo));
}

// ===== ROOM FUNCTIONS =====
function buildInitialRoom(mode, index) {
  return {
    id: `${mode}-${index}`,
    mode,
    index,
    label: `Phòng ${mode.toUpperCase()} #${index}`,
    capacity: config.CAPACITY[mode],
    players: new Map(),
    bannedUsers: new Set(),
    status: 'waiting',
    code: null,
    revealedAt: null,
    firstJoinAt: null,
    fullAt: null,
    panelChannelId: null,
    panelMessageId: null,
    timers: {
      inactivity: null,
      readyCountdown: null,
      resetAfterCode: null,
      blink: null,
      resultWindow: null,
    },
    timeoutMs: config.DEFAULT_ROOM_TIMEOUT_MS,
    _blinkOn: false,
    isRank: false,
    resultMap: new Map(),
    resultWindowEnd: null,
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

function restoreRooms(savedRooms) {
  rooms.clear();
  for (const saved of savedRooms) {
    if (!saved || !saved.mode || !saved.index) continue;
    const room = saved.isRank
      ? buildRankRoom(saved.mode, saved.index)
      : buildInitialRoom(saved.mode, saved.index);
    room.status = saved.status || 'waiting';
    room.code = saved.code || null;
    room.revealedAt = saved.revealedAt || null;
    room.firstJoinAt = saved.firstJoinAt || null;
    room.fullAt = saved.fullAt || null;
    room.panelChannelId = saved.panelChannelId || null;
    room.panelMessageId = saved.panelMessageId || null;
    room.timeoutMs = saved.timeoutMs || config.DEFAULT_ROOM_TIMEOUT_MS;
    room.players = new Map((saved.players || []).map((p) => {
      const { id, ...rest } = p;
      return [id, rest];
    }));
    room.bannedUsers = new Set(saved.bannedUsers || []);
    if (room.isRank) {
      room.resultMap = new Map(saved.resultMap || []);
      room.resultWindowEnd = saved.resultWindowEnd || null;
    }
    rooms.set(room.id, room);
  }
  for (const mode of Object.keys(config.CAPACITY)) {
    for (let i = 1; i <= config.ROOMS_PER_MODE; i++) {
      const id = `${mode}-${i}`;
      if (!rooms.has(id)) rooms.set(id, buildInitialRoom(mode, i));
    }
  }
  return rooms;
}

function restoreEloData(savedEloMap) {
  eloData.clear();
  for (const [userId, data] of savedEloMap) eloData.set(userId, data);
  return eloData;
}

function clearElo(userId) { return eloData.delete(userId); }

function getRoom(roomId) { return rooms.get(roomId) || hiddenRooms.get(roomId); }

function ensureRoom(mode, index) {
  const id = `${mode}-${index}`;
  let room = rooms.get(id);
  if (!room) {
    room = buildInitialRoom(mode, index);
    rooms.set(id, room);
  }
  return room;
}

function addRoomsToMode(mode, count) {
  const existing = getRoomsByMode(mode);
  const maxAllowed = config.MAX_ROOMS_PER_MODE;
  const usedIndices = new Set(existing.map(r => r.index));
  const canAdd = Math.max(0, maxAllowed - existing.length);
  const toAdd = Math.min(count, canAdd);
  const created = [];
  let idx = 1;
  while (created.length < toAdd && idx <= maxAllowed) {
    if (!usedIndices.has(idx)) {
      const room = buildInitialRoom(mode, idx);
      rooms.set(room.id, room);
      created.push(room);
      usedIndices.add(idx);
    }
    idx++;
  }
  return { created, requested: count, capped: count > toAdd, currentTotal: existing.length + created.length, maxAllowed };
}

function removeExtraRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, reason: 'not_found' };
  if (room.index <= config.ROOMS_PER_MODE) return { ok: false, reason: 'protected', room };
  clearRoomTimers(room);
  rooms.delete(roomId);
  return { ok: true, room };
}

function getAllRooms() { return Array.from(rooms.values()); }
function getRoomsByMode(mode) { return getAllRooms().filter(r => r.mode === mode); }

function getAllNormalRooms() { return getAllRooms().filter(r => !r.isRank); }
function getNormalRoomsByMode(mode) { return getAllNormalRooms().filter(r => r.mode === mode); }
function getAllRankRooms() { return getAllRooms().filter(r => r.isRank); }
function getRankRoomsByMode(mode) { return getAllRankRooms().filter(r => r.mode === mode); }

function createHiddenRoom(mode) {
  const room = buildInitialRoom(mode, 0);
  room.id = `${mode}-an-${Date.now()}`;
  room.hidden = true;
  room.label = `Phòng ${mode.toUpperCase()} (Ẩn) #${room.id.slice(-4)}`;
  room.panelTargets = [];
  hiddenRooms.set(room.id, room);
  return room;
}
function getHiddenRoom(roomId) { return hiddenRooms.get(roomId); }
function getAllHiddenRooms() { return Array.from(hiddenRooms.values()); }
function deleteHiddenRoom(roomId) {
  const room = hiddenRooms.get(roomId);
  if (room) clearRoomTimers(room);
  hiddenRooms.delete(roomId);
  return !!room;
}

function buildRankRoom(mode, index) {
  const room = buildInitialRoom(mode, index);
  room.id = `${mode}-rank-${index}`;
  room.label = `Phòng ${mode.toUpperCase()} Rank #${index}`;
  room.isRank = true;
  room.status = 'waiting';
  room.resultMap = new Map();
  room.resultWindowEnd = null;
  room.timers.resultWindow = null;
  return room;
}

function addRankRoomsToMode(mode, count) {
  const existing = getRankRoomsByMode(mode);
  const maxAllowed = config.MAX_RANK_ROOMS_PER_MODE || config.MAX_ROOMS_PER_MODE;
  const usedIndices = new Set(existing.map(r => r.index));
  const canAdd = Math.max(0, maxAllowed - existing.length);
  const toAdd = Math.min(count, canAdd);
  const created = [];
  let idx = 1;
  while (created.length < toAdd && idx <= maxAllowed) {
    if (!usedIndices.has(idx)) {
      const room = buildRankRoom(mode, idx);
      rooms.set(room.id, room);
      created.push(room);
      usedIndices.add(idx);
    }
    idx++;
  }
  return { created, requested: count, capped: count > toAdd, currentTotal: existing.length + created.length, maxAllowed };
}

function removeRankRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.isRank) return { ok: false, reason: 'not_found' };
  clearRoomTimers(room);
  rooms.delete(roomId);
  return { ok: true, room };
}

function findRoomOfUser(userId) {
  for (const room of rooms.values()) if (room.players.has(userId)) return room;
  for (const room of hiddenRooms.values()) if (room.players.has(userId)) return room;
  return null;
}

function findRoomOfUserInMode(userId, mode) {
  for (const room of rooms.values()) if (room.mode === mode && room.players.has(userId)) return room;
  for (const room of hiddenRooms.values()) if (room.mode === mode && room.players.has(userId)) return room;
  return null;
}

function clearRoomTimers(room) {
  if (room.timers.inactivity) clearTimeout(room.timers.inactivity);
  if (room.timers.readyCountdown) clearTimeout(room.timers.readyCountdown);
  if (room.timers.resetAfterCode) clearTimeout(room.timers.resetAfterCode);
  if (room.timers.blink) clearInterval(room.timers.blink);
  if (room.timers.resultWindow) clearTimeout(room.timers.resultWindow);
  room.timers.inactivity = null;
  room.timers.readyCountdown = null;
  room.timers.resetAfterCode = null;
  room.timers.blink = null;
  room.timers.resultWindow = null;
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
  if (room.isRank) {
    room.resultMap.clear();
    room.resultWindowEnd = null;
  }
}

function isFull(room) { return room.players.size >= room.capacity; }
function allReady(room) {
  if (room.players.size === 0) return false;
  for (const p of room.players.values()) if (!p.ready) return false;
  return true;
}
function teamCounts(room) {
  let team1 = 0, team2 = 0, none = 0;
  for (const p of room.players.values()) {
    if (p.team === 1) team1++;
    else if (p.team === 2) team2++;
    else none++;
  }
  return { team1, team2, none };
}
function canRevealCode(room) {
  if (!isFull(room)) return { ok: false, reason: 'not_full' };
  if (!allReady(room)) return { ok: false, reason: 'not_all_ready' };
  if (!config.ENFORCE_TEAM_BALANCE) return { ok: true };
  const { team1, team2, none } = teamCounts(room);
  if (none === room.players.size) return { ok: true };
  if (none > 0) return { ok: false, reason: 'team_incomplete' };
  const half = room.capacity / 2;
  if (team1 !== half || team2 !== half) return { ok: false, reason: 'team_unbalanced' };
  return { ok: true };
}

function banUser(room, userId) {
  room.bannedUsers.add(userId);
  room.players.delete(userId);
}
function unbanUser(room, userId) { room.bannedUsers.delete(userId); }
function isBanned(room, userId) { return room.bannedUsers.has(userId); }
function generateCode() {
  let code;
  do {
    code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  } while (code === '0000');
  return code;
}
function formatPersonalCode(room, userId) {
  if (!room.code) return null;
  const player = room.players.get(userId);
  if (!player) return null;
  if (player.team) return `${room.code}-${player.team}_${player.username}`;
  return `${room.code}-${player.username}`;
}

// ============================================================
// ===== HÀM MAP KDA DỰA TRÊN TỌA ĐỘ Y CỦA OCR BOUNDING BOX =====
// ============================================================
function extractAllKDAResult(rawText, room, ocrOverlay = null) {
  const resultMap = new Map();
  const players = Array.from(room.players.entries());

  console.log('👥 Players cần tìm:', players.map(([id, p]) => `${p.username} (${id})`).join(', '));

  const kdaRegex = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/;

  function parseKDA(value) {
    const match = String(value || '').match(kdaRegex);
    if (!match) return null;
    return {
      kill: parseInt(match[1], 10),
      death: parseInt(match[2], 10),
      assist: parseInt(match[3], 10),
    };
  }

  // 1. Xử lý chính: Dùng Bounding Box từ OCR Overlay để so khớp theo hàng ngang (Tọa độ Y)
  if (Array.isArray(ocrOverlay?.Lines) && ocrOverlay.Lines.length > 0) {
    const detectedNames = [];
    const detectedKDAs = [];

    for (const line of ocrOverlay.Lines) {
      const lineText = String(line.LineText || '').trim();
      const words = Array.isArray(line.Words) ? line.Words : [];
      if (words.length === 0) continue;

      const topY = Number(words[0].Top) || 0;
      const height = Number(words[0].Height) || 0;
      const centerY = topY + height / 2;

      // Quét nếu dòng có định dạng KDA (ví dụ 7/1/6)
      const kdaMatch = parseKDA(lineText);
      if (kdaMatch) {
        detectedKDAs.push({ kda: kdaMatch, centerY, text: lineText });
      }

      // Trích xuất các từ làm Tên hiển thị
      for (const w of words) {
        const wordText = String(w.WordText || w.Text || '').trim();
        if (wordText) {
          detectedNames.push({
            text: wordText,
            centerY: (Number(w.Top) || 0) + (Number(w.Height) || 0) / 2,
          });
        }
      }
    }

    // Ghép từng Player với KDA có khoảng cách Y nhỏ nhất (nằm trên cùng hàng ngang)
    for (const [userId, playerData] of players) {
      const eloObj = getElo(userId);
      const searchName = String(eloObj.ign || playerData.username || '').trim();
      if (!searchName) continue;

      const escapedName = searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameRegex = new RegExp(escapedName, 'i');

      const matchedNameObj = detectedNames.find((n) => nameRegex.test(n.text));

      if (matchedNameObj && detectedKDAs.length > 0) {
        let closestKDA = null;
        let minDiffY = Infinity;

        // Tìm KDA có độ chênh lệch Y nhỏ nhất đối với Tên người chơi
        for (const kItem of detectedKDAs) {
          const diffY = Math.abs(kItem.centerY - matchedNameObj.centerY);
          if (diffY < minDiffY && diffY <= 60) { // Sai số Y tối đa cho phép 60px
            minDiffY = diffY;
            closestKDA = kItem.kda;
          }
        }

        if (closestKDA) {
          resultMap.set(userId, closestKDA);
          console.log(`✅ [Tọa độ Y] Map thành công cho ${searchName}: ${closestKDA.kill}/${closestKDA.death}/${closestKDA.assist}`);
          continue;
        }
      }
    }
  }

  // 2. Dự phòng: Quét dòng TXT thô nếu ocrOverlay không khả dụng
  if (resultMap.size === 0) {
    const lines = String(rawText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    
    for (const [userId, playerData] of players) {
      const eloObj = getElo(userId);
      const searchName = String(eloObj.ign || playerData.username || '').trim();
      if (!searchName) continue;

      const escapedName = searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameRegex = new RegExp(escapedName, 'i');

      for (let i = 0; i < lines.length; i++) {
        if (nameRegex.test(lines[i])) {
          const sameLine = parseKDA(lines[i]);
          if (sameLine) {
            resultMap.set(userId, sameLine);
            break;
          }
        }
      }
    }
  }

  console.log('📊 Kết quả Map KDA hoàn tất:', Array.from(resultMap.entries()));
  return resultMap;
}

module.exports = {
  rooms,
  eloData,
  initRooms,
  restoreRooms,
  restoreEloData,
  getRoom,
  getAllRooms,
  getRoomsByMode,
  ensureRoom,
  addRoomsToMode,
  removeExtraRoom,
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
  createHiddenRoom,
  getHiddenRoom,
  getAllHiddenRooms,
  deleteHiddenRoom,
  getElo,
  getRankFromElo,
  updateElo,
  clearElo,
  calculateNewElo,
  registerIGN,
  buildRankRoom,
  addRankRoomsToMode,
  removeRankRoom,
  getAllRankRooms,
  getRankRoomsByMode,
  getAllNormalRooms,
  getNormalRoomsByMode,
  extractAllKDAResult,
};