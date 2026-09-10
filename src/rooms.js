const config = require('../config');

const rooms = new Map();
const hiddenRooms = new Map();

// Map<userId, { ign, '3v3': { elo, rank, wins, losses }, '5v5': { elo, rank, wins, losses } }>
const eloData = new Map();

const MODES = ['3v3', '5v5'];

function emptyEloEntry(ign = null) {
  return {
    ign,
    '3v3': { elo: null, rank: 'Unranked', wins: 0, losses: 0 },
    '5v5': { elo: null, rank: 'Unranked', wins: 0, losses: 0 },
  };
}

function getRankFromElo(elo) {
  if (elo === null || elo === undefined) return 'Unranked';
  for (const tier of config.RANK_TIERS) {
    if (elo >= tier.minElo && elo < tier.maxElo) return tier.name;
  }
  return 'Unranked';
}

function getRankIndex(elo) {
  if (elo === null || elo === undefined) return 0;
  for (let i = 0; i < config.RANK_TIERS.length; i++) {
    if (elo >= config.RANK_TIERS[i].minElo && elo <= config.RANK_TIERS[i].maxElo) {
      return i;
    }
  }
  return 0;
}

function getElo(userId, mode) {
  if (!MODES.includes(mode)) mode = '5v5';
  const entry = eloData.get(userId);
  if (!entry) {
    return { elo: null, rank: 'Unranked', rankIndex: 0, ign: null, wins: 0, losses: 0 };
  }
  const modeData = entry[mode] || { elo: null, rank: 'Unranked', wins: 0, losses: 0 };
  const rankIndex = getRankIndex(modeData.elo);
  return {
    elo: modeData.elo,
    rank: modeData.rank || getRankFromElo(modeData.elo),
    rankIndex,
    ign: entry.ign || null,
    wins: modeData.wins || 0,
    losses: modeData.losses || 0,
  };
}

function getFullElo(userId) {
  const entry = eloData.get(userId);
  if (!entry) return emptyEloEntry();
  return {
    ign: entry.ign || null,
    '3v3': { ...entry['3v3'] },
    '5v5': { ...entry['5v5'] },
  };
}

// isWin: true = tăng wins, false = tăng losses, undefined = không đổi
function updateElo(userId, mode, newElo, isWin) {
  if (!MODES.includes(mode)) throw new Error(`Mode không hợp lệ: ${mode}`);
  const entry = eloData.get(userId) || emptyEloEntry();
  const rank = getRankFromElo(newElo);
  const cur = entry[mode] || { elo: null, rank: 'Unranked', wins: 0, losses: 0 };
  const wins = cur.wins || 0;
  const losses = cur.losses || 0;
  entry[mode] = {
    elo: newElo,
    rank,
    wins: isWin === true ? wins + 1 : wins,
    losses: isWin === false ? losses + 1 : losses,
  };
  eloData.set(userId, entry);
  return { elo: newElo, rank, wins: entry[mode].wins, losses: entry[mode].losses };
}

function registerIGN(userId, ign) {
  for (const [id, entry] of eloData) {
    if (entry.ign && entry.ign.toLowerCase() === ign.toLowerCase() && id !== userId) {
      return { ok: false, reason: 'IGN này đã được đăng ký bởi người khác.' };
    }
  }
  const entry = eloData.get(userId) || emptyEloEntry();
  entry.ign = ign;
  eloData.set(userId, entry);
  return { ok: true };
}

// Reset ELO về 0, GIỮ NGUYÊN IGN.
function clearElo(userId, mode) {
  const entry = eloData.get(userId);
  if (!entry) return false;

  if (!mode) {
    entry['3v3'] = { elo: null, rank: 'Unranked', wins: 0, losses: 0 };
    entry['5v5'] = { elo: null, rank: 'Unranked', wins: 0, losses: 0 };
    eloData.set(userId, entry);
    return true;
  }

  if (!MODES.includes(mode)) return false;
  entry[mode] = { elo: null, rank: 'Unranked', wins: 0, losses: 0 };
  eloData.set(userId, entry);
  return true;
}

function restoreEloData(saved) {
  eloData.clear();
  for (const [userId, data] of saved) {
    if (data && typeof data === 'object' && (data['3v3'] || data['5v5'])) {
      eloData.set(userId, {
        ign: data.ign || null,
        '3v3': {
          elo: data['3v3']?.elo ?? null,
          rank: data['3v3']?.rank || 'Unranked',
          wins: data['3v3']?.wins || 0,
          losses: data['3v3']?.losses || 0,
        },
        '5v5': {
          elo: data['5v5']?.elo ?? null,
          rank: data['5v5']?.rank || 'Unranked',
          wins: data['5v5']?.wins || 0,
          losses: data['5v5']?.losses || 0,
        },
      });
    } else if (data && typeof data.elo !== 'undefined') {
      const eloVal = data.elo ?? null;
      const rankVal = data.rank || getRankFromElo(eloVal);
      eloData.set(userId, {
        ign: data.ign || null,
        '3v3': { elo: eloVal, rank: rankVal, wins: 0, losses: 0 },
        '5v5': { elo: eloVal, rank: rankVal, wins: 0, losses: 0 },
      });
    }
  }
  return eloData;
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

// Ước lượng số win còn lại để lên tier kế tiếp.
// Coi ELO null = 0 (tier 0, đang ở Unranked) → next tier là tier kế tiếp.
function estimateWinsToNextTier(userId, mode) {
  const cur = getElo(userId, mode);
  const tiers = config.RANK_TIERS;

  const eloVal = (cur.elo === null || cur.elo === undefined) ? 0 : cur.elo;
  const currentIdx = getRankIndex(eloVal);

  if (currentIdx >= tiers.length - 1) {
    return { needElo: 0, estimatedWins: 0, nextTierName: null, isMax: true };
  }

  const nextTier = tiers[currentIdx + 1];
  const needElo = Math.max(0, nextTier.minElo - eloVal);
  const avgPerWin = currentIdx <= 2 ? 70 : (currentIdx <= 4 ? 52 : (currentIdx <= 6 ? 35 : 25));
  const estimatedWins = needElo > 0 ? Math.max(1, Math.ceil(needElo / avgPerWin)) : 0;
  return { needElo, estimatedWins, nextTierName: nextTier.name, isMax: false };
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

function getRoom(roomId) {
  return rooms.get(roomId) || hiddenRooms.get(roomId);
}

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

function getAllRooms() {
  return Array.from(rooms.values());
}

function getRoomsByMode(mode) {
  return getAllRooms().filter(r => r.mode === mode);
}

function getAllNormalRooms() {
  return getAllRooms().filter(r => !r.isRank);
}
function getNormalRoomsByMode(mode) {
  return getAllNormalRooms().filter(r => r.mode === mode);
}
function getAllRankRooms() {
  return getAllRooms().filter(r => r.isRank);
}
function getRankRoomsByMode(mode) {
  return getAllRankRooms().filter(r => r.mode === mode);
}

function createHiddenRoom(mode) {
  const room = buildInitialRoom(mode, 0);
  room.id = `${mode}-an-${Date.now()}`;
  room.hidden = true;
  room.label = `Phòng ${mode.toUpperCase()} (Ẩn) #${room.id.slice(-4)}`;
  room.panelTargets = [];
  hiddenRooms.set(room.id, room);
  return room;
}
function getHiddenRoom(roomId) {
  return hiddenRooms.get(roomId);
}
function getAllHiddenRooms() {
  return Array.from(hiddenRooms.values());
}
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
  for (const room of rooms.values()) {
    if (room.players.has(userId)) return room;
  }
  for (const room of hiddenRooms.values()) {
    if (room.players.has(userId)) return room;
  }
  return null;
}
function findRoomOfUserInMode(userId, mode) {
  for (const room of rooms.values()) {
    if (room.mode === mode && room.players.has(userId)) return room;
  }
  for (const room of hiddenRooms.values()) {
    if (room.mode === mode && room.players.has(userId)) return room;
  }
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
function unbanUser(room, userId) {
  room.bannedUsers.delete(userId);
}
function isBanned(room, userId) {
  return room.bannedUsers.has(userId);
}
function generateCode() {
  // Chữ số đầu tiên luôn >= 3 (3-9), 3 số sau random 0-9.
  const firstDigit = Math.floor(Math.random() * 7) + 3; // 3..9
  const rest = String(Math.floor(Math.random() * 1000)).padStart(3, '0'); // 000..999
  return `${firstDigit}${rest}`;
}
function formatPersonalCode(room, userId) {
  if (!room.code) return null;
  const player = room.players.get(userId);
  if (!player) return null;
  if (player.team) {
    return `${room.code}-${player.team}_${player.username}`;
  }
  return `${room.code}-${player.username}`;
}

// ============================================================
// ===== HÀM OCR =============================================
// ============================================================
function extractAllKDAResult(text, room, opts = {}) {
  const skipCodeCheck = !!opts.skipCodeCheck;
  // Dòng overlay (toạ độ) trả về từ OCR.space (isOverlayRequired=true).
  // Dùng để đối chiếu theo VỊ TRÍ DỌC (Top) thực tế trong ảnh, vì thứ tự
  // của ParsedText thuần không đáng tin khi giao diện có icon/nút xen giữa
  // các cột (tên & KDA có thể "gần nhau" trong text nhưng khác hàng trong ảnh).
  const overlayLines = Array.isArray(opts.overlayLines) ? opts.overlayLines : [];
  const resultMap = new Map();
  const players = Array.from(room.players.entries());
  const roomCode = room.code || null;
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const SEP = '[\\s\\-_]{0,3}';

  // Gom KDA + toạ độ Top từ overlay (mỗi dòng overlay có thể chứa 1 KDA).
  const overlayKdaCandidates = [];
  if (overlayLines.length > 0) {
    const kdaLineRe = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/;
    for (const line of overlayLines) {
      const lineText = line && line.LineText;
      if (!lineText) continue;
      const m = kdaLineRe.exec(lineText);
      if (!m) continue;
      const top = typeof line.MinTop === 'number'
        ? line.MinTop
        : (line.Words && line.Words[0] ? line.Words[0].Top : null);
      if (top == null) continue;
      overlayKdaCandidates.push({
        kill: parseInt(m[1], 10),
        death: parseInt(m[2], 10),
        assist: parseInt(m[3], 10),
        top,
      });
    }
  }

  // Ngưỡng khoảng cách Top hợp lệ, tính động theo khoảng cách trung bình
  // giữa các hàng KDA phát hiện được (thay vì số cố định), để không phụ
  // thuộc vào độ phân giải ảnh.
  let maxTopDist = 60;
  if (overlayKdaCandidates.length >= 2) {
    const sortedTops = overlayKdaCandidates.map(c => c.top).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < sortedTops.length; i++) gaps.push(sortedTops[i] - sortedTops[i - 1]);
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (avgGap > 0) maxTopDist = Math.max(30, avgGap * 0.6);
  }

  function findOverlayTopForName(nameRegex) {
    for (const line of overlayLines) {
      const lineText = line && line.LineText;
      if (!lineText) continue;
      if (nameRegex.test(lineText)) {
        return typeof line.MinTop === 'number'
          ? line.MinTop
          : (line.Words && line.Words[0] ? line.Words[0].Top : null);
      }
    }
    return null;
  }

  console.log('📝 OCR Text:', text);

  // Log danh sách người chơi kèm TÊN (ưu tiên IGN > username Discord) — thay
  // vì chỉ in userId khiến log khó đọc.
  console.log('👥 Players:', players.map(([id, p]) => {
    const ign = getElo(id, room.mode).ign;
    return ign && ign !== p.username ? `${ign} (${p.username}) [${id}]` : `${p.username} [${id}]`;
  }).join(', '));

  if (skipCodeCheck) {
    console.warn('🧪 extractAllKDAResult: ADMIN TESTING MODE — bỏ qua xác thực mã phòng.');
  } else if (!roomCode) {
    console.warn('⚠️ extractAllKDAResult: không có room.code để đối chiếu.');
  }

  let lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

  for (let i = 0; i < lines.length - 1; i++) {
    const onlyPrefix = /^\d+[\s\-_]+\d+[\s\-_]*$/.test(lines[i]);
    const nextStartsWithLetter = /^[A-Za-z]/.test(lines[i + 1]);
    if (onlyPrefix && nextStartsWithLetter) {
      lines[i] = lines[i] + lines[i + 1];
      lines.splice(i + 1, 1);
    }
  }

  text = lines.join('\n');

  const kdaRegex = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/g;

  const anchors = [];
  for (const [userId, playerData] of players) {
    const eloObj = getElo(userId, room.mode);
    const searchName = eloObj.ign || playerData.username;
    const nameEsc = escapeRe(searchName);

    let nameRegex;
    if (roomCode && !skipCodeCheck) {
      const codeEsc = escapeRe(roomCode);
      nameRegex = playerData.team
        ? new RegExp(`${codeEsc}${SEP}${escapeRe(playerData.team)}${SEP}${nameEsc}`, 'i')
        : new RegExp(`${codeEsc}${SEP}${nameEsc}`, 'i');
    } else {
      nameRegex = new RegExp(nameEsc, 'i');
    }

    let foundLine = null;
    for (let i = 0; i < lines.length; i++) {
      if (nameRegex.test(lines[i])) { foundLine = lines[i]; break; }
    }
    const linePos = foundLine ? text.indexOf(foundLine) : -1;
    anchors.push({ userId, searchName, foundLine, linePos, nameRegex });
  }

  const foundAnchors = anchors.filter(a => a.linePos !== -1).sort((a, b) => a.linePos - b.linePos);

  const slotPrefixRegex = (roomCode && !skipCodeCheck)
    ? new RegExp(`^${escapeRe(roomCode)}${SEP}\\d+_`)
    : /^\d+[\-_][A-Za-z0-9]/;
  const pureKdaLineRegex = /^\d+\s*\/\s*\d+\s*\/\s*\d+$/;

  for (const anchor of anchors) {
    const { userId, searchName, foundLine, linePos, nameRegex } = anchor;
    console.log(`🔎 Tìm IGN: "${searchName}"`);

    if (!foundLine || linePos === -1) {
      console.warn(`⚠️ Không tìm thấy dòng nào chứa tên "${searchName}"`);
      continue;
    }

    kdaRegex.lastIndex = 0;
    const sameLineMatch = kdaRegex.exec(foundLine);
    if (sameLineMatch) {
      const kill = parseInt(sameLineMatch[1], 10);
      const death = parseInt(sameLineMatch[2], 10);
      const assist = parseInt(sameLineMatch[3], 10);
      resultMap.set(userId, { kill, death, assist });
      console.log(`✅ Map KDA cho ${searchName}: ${kill}/${death}/${assist}`);
      continue;
    }

    const foundLineIdx = lines.indexOf(foundLine);
    let slotLineIdx = -1;
    if (foundLineIdx !== -1) {
      if (slotPrefixRegex.test(lines[foundLineIdx])) {
        slotLineIdx = foundLineIdx;
      } else if (foundLineIdx > 0 && slotPrefixRegex.test(lines[foundLineIdx - 1])) {
        slotLineIdx = foundLineIdx - 1;
      }
    }

    if (slotLineIdx !== -1) {
      const slotLines = [];
      for (let i = 0; i < lines.length; i++) {
        if (slotPrefixRegex.test(lines[i])) slotLines.push(i);
      }
      const lastSlotIdx = slotLines[slotLines.length - 1];
      let blockStart = -1;
      for (let i = lastSlotIdx + 1; i < lines.length; i++) {
        if (pureKdaLineRegex.test(lines[i])) { blockStart = i; break; }
        if (slotPrefixRegex.test(lines[i])) break;
      }
      let contiguousBlock = [];
      if (blockStart !== -1) {
        for (let i = blockStart; i < lines.length && pureKdaLineRegex.test(lines[i]); i++) {
          contiguousBlock.push(i);
        }
      }
      const slotRank = slotLines.indexOf(slotLineIdx);
      if (slotRank !== -1 && contiguousBlock.length >= slotLines.length && slotRank < contiguousBlock.length) {
        kdaRegex.lastIndex = 0;
        const kdaLineText = lines[contiguousBlock[slotRank]];
        const slotMatch = kdaRegex.exec(kdaLineText);
        if (slotMatch) {
          const kill = parseInt(slotMatch[1], 10);
          const death = parseInt(slotMatch[2], 10);
          const assist = parseInt(slotMatch[3], 10);
          resultMap.set(userId, { kill, death, assist });
          console.log(`✅ Map KDA (cột, hạng ${slotRank}) cho ${searchName}: ${kill}/${death}/${assist}`);
          continue;
        }
      }
    }

    // ✅ Ưu tiên đối chiếu theo toạ độ Top thực tế (overlay OCR) trước khi
    // dùng heuristic "gần theo vị trí ký tự trong text", vì text order có
    // thể không khớp với thứ tự hàng trong ảnh khi có icon/nút xen giữa.
    if (overlayKdaCandidates.length > 0) {
      const nameOverlayTop = findOverlayTopForName(nameRegex);
      if (nameOverlayTop != null) {
        const best = overlayKdaCandidates.reduce((closest, kda) => {
          const dist = Math.abs(kda.top - nameOverlayTop);
          const closestDist = closest ? Math.abs(closest.top - nameOverlayTop) : Infinity;
          return dist < closestDist ? kda : closest;
        }, null);
        // Chỉ chấp nhận nếu đủ gần theo chiều dọc (tránh vơ đại dòng xa
        // nhất trong toàn ảnh khi có nhiều hàng người chơi).
        if (best && Math.abs(best.top - nameOverlayTop) <= maxTopDist) {
          resultMap.set(userId, { kill: best.kill, death: best.death, assist: best.assist });
          console.log(`✅ Map KDA (overlay Top) cho ${searchName}: ${best.kill}/${best.death}/${best.assist}`);
          continue;
        }
        console.warn(`⚠️ Overlay Top cho "${searchName}" không tìm được KDA đủ gần (top=${nameOverlayTop}).`);
      }
    }

    const ownIndex = foundAnchors.findIndex(a => a.userId === userId);
    const windowStart = linePos;
    const windowEnd = (ownIndex !== -1 && ownIndex + 1 < foundAnchors.length)
      ? foundAnchors[ownIndex + 1].linePos
      : text.length;

    console.log(`ℹ️ Fallback window cho "${searchName}" [${windowStart}, ${windowEnd})`);

    const windowKda = [];
    const windowRegex = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/g;
    const windowText = text.slice(windowStart, windowEnd);
    let wm;
    while ((wm = windowRegex.exec(windowText)) !== null) {
      windowKda.push({
        kill: parseInt(wm[1], 10),
        death: parseInt(wm[2], 10),
        assist: parseInt(wm[3], 10),
        index: windowStart + wm.index,
      });
    }

    if (windowKda.length > 0) {
      const best = windowKda.reduce((closest, kda) => {
        const dist = Math.abs(kda.index - linePos);
        const closestDist = Math.abs(closest.index - linePos);
        return dist < closestDist ? kda : closest;
      });
      resultMap.set(userId, { kill: best.kill, death: best.death, assist: best.assist });
      console.log(`✅ Map KDA (window) cho ${searchName}: ${best.kill}/${best.death}/${best.assist}`);
      continue;
    }

    console.warn(`⚠️ Không tìm thấy KDA nào cho "${searchName}".`);
  }

  // In KDA kèm TÊN người chơi (ưu tiên IGN > username Discord) thay vì chỉ userId.
  const playersLookup = new Map(players);
  const kdaEntries = Array.from(resultMap.entries()).map(([id, k]) => {
    const p = playersLookup.get(id);
    const ign = getElo(id, room.mode).ign;
    const userTag = p ? p.username : null;
    let label;
    if (ign && userTag && ign !== userTag) label = `${ign} (${userTag})`;
    else if (ign) label = ign;
    else if (userTag) label = userTag;
    else label = 'Unknown';
    return `${label} [${id}] → ${k.kill}/${k.death}/${k.assist}`;
  });
  console.log(
    `📊 Kết quả map KDA (${kdaEntries.length}/${players.length} người):\n  ` +
    (kdaEntries.length ? kdaEntries.join('\n  ') : '(trống — không match được ai)')
  );

  return resultMap;
}

module.exports = {
  rooms,
  eloData,
  MODES,
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
  // ELO
  getElo,
  getFullElo,
  getRankFromElo,
  updateElo,
  clearElo,
  calculateNewElo,
  registerIGN,
  estimateWinsToNextTier,
  // Rank rooms
  buildRankRoom,
  addRankRoomsToMode,
  removeRankRoom,
  getAllRankRooms,
  getRankRoomsByMode,
  // Filter
  getAllNormalRooms,
  getNormalRoomsByMode,
  // OCR
  extractAllKDAResult,
};