// Fix: ưu tiên IPv4
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} = require('discord.js');

const config = require('./config');
const {
  rooms,
  initRooms,
  getRoom,
  getAllRooms,
  getRoomsByMode,
  findRoomOfUser,
  clearRoomTimers,
  resetRoom,
  isFull,
  allReady,
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
  ensureRoom,
  addRoomsToMode,
  removeExtraRoom,
  restoreRooms,
  restoreEloData,
  clearElo,
  eloData,
  getElo,
  getFullElo,
  updateElo,
  calculateNewElo,
  registerIGN,
  estimateWinsToNextTier,
  addRankRoomsToMode,
  removeRankRoom,
  getAllRankRooms,
  getRankRoomsByMode,
  getAllNormalRooms,
  getNormalRoomsByMode,
  extractAllKDAResult,
} = require('./src/rooms');
const { mainMenuEmbed, mainMenuRow, roomListRows, roomEmbed, roomActionRows, roomActionRowsEN } = require('./src/ui');
const persistence = require('./src/persistence');
const eloStore = require('./src/eloStore');
const { startKeepAliveServer, startSelfPing } = require('./src/keepalive');
const rankSessions = require('./src/rankSessions');

// ===== AUTO-BALANCE TEAM CHO PHÒNG RANK =====
// Ghép team theo ELO sao cho tổng ELO 2 team chênh lệch nhỏ nhất.
// Chỉ áp dụng cho phòng rank (room.isRank === true). Số người tối đa
// là 10 -> C(10,5) = 252 tổ hợp, duyệt hết vẫn nhanh trong vài ms.
// Trả về true nếu đã gán team thành công.
function autoBalanceRankTeams(room) {
  if (!room || !room.isRank) return false;
  const entries = Array.from(room.players.entries());
  if (entries.length === 0) return false;

  // Chỉ 1 người -> cho vào Team 1 luôn, khỏi tính toán.
  if (entries.length === 1) {
    entries[0][1].team = 1;
    return true;
  }

  const n = entries.length;
  const team1Size = Math.floor(n / 2); // team1 nhỏ hơn hoặc bằng team2

  const players = entries.map(([id, data]) => ({
    id,
    data,
    elo: getElo(id, room.mode).elo ?? config.RANK_DEFAULT_ELO,
  }));

  // Sinh tất cả tổ hợp chọn team1Size người trong n người.
  const combos = [];
  (function gen(start, cur) {
    if (cur.length === team1Size) { combos.push([...cur]); return; }
    for (let i = start; i < n; i++) {
      cur.push(i);
      gen(i + 1, cur);
      cur.pop();
    }
  })(0, []);

  const totalElo = players.reduce((s, p) => s + p.elo, 0);
  let bestDiff = Infinity;
  let bestCombo = combos[0] || [];

  for (const combo of combos) {
    const sum1 = combo.reduce((s, i) => s + players[i].elo, 0);
    const diff = Math.abs(totalElo - 2 * sum1);
    if (diff < bestDiff) { bestDiff = diff; bestCombo = combo; }
  }

  const t1 = new Set(bestCombo);
  players.forEach((p, i) => { p.data.team = t1.has(i) ? 1 : 2; });
  return true;
}

// ===== HOÀN TẤT PHIÊN RANK =====
async function finalizeRankSessionIfReady(session, room, roomId, kdaMap) {
  if (!session) { console.warn('⚠️ finalizeRankSessionIfReady: session rỗng, bỏ qua.'); return null; }

  const realPlayers = session.players.filter(([, data]) => !data.isBot).map(([id]) => id);
  if (realPlayers.length === 0) { console.warn(`⚠️ finalizeRankSessionIfReady [${roomId}]: không có người chơi thật (toàn bot) -> bỏ qua, KHÔNG gửi thông báo.`); return null; }

  if (kdaMap) {
    const sampleEntry = Array.from(session.resultMap.entries()).find(([id]) => realPlayers.includes(id));
    if (sampleEntry) {
      const [sampleId, sampleData] = sampleEntry;
      const samplePlayerEntry = session.players.find(([id]) => id === sampleId);
      const sampleTeam = samplePlayerEntry ? samplePlayerEntry[1].team : null;

      for (const id of realPlayers) {
        if (session.resultMap.has(id)) continue;
        const playerEntry = session.players.find(([pid]) => pid === id);
        const playerData = playerEntry ? playerEntry[1] : null;
        const kda = kdaMap.get(id);

        let inferredResult = sampleData.result;
        if (sampleTeam && playerData && playerData.team) {
          inferredResult = playerData.team === sampleTeam
            ? sampleData.result
            : (sampleData.result === 'win' ? 'loss' : 'win');
        }

        rankSessions.addResult(session.id, id, {
          result: inferredResult,
          kill: kda ? kda.kill : null,
          death: kda ? kda.death : null,
          assist: kda ? kda.assist : null,
          kda: kda ? (kda.death === 0 ? kda.kill + kda.assist : (kda.kill + kda.assist) / kda.death) : undefined,
          imageUrl: sampleData.imageUrl || null,
          inferred: true,
        });
      }
    }
  }

  const submittedReal = Array.from(session.resultMap.keys()).filter(id => realPlayers.includes(id));
  const ready = kdaMap ? submittedReal.length > 0 : realPlayers.every(id => submittedReal.includes(id));
  if (!ready) {
    console.log(`ℹ️ finalizeRankSessionIfReady [${roomId}]: chưa đủ kết quả để chốt (đã nộp ${submittedReal.length}/${realPlayers.length}) -> chưa gửi thông báo.`);
    return null;
  }

  const finalSession = rankSessions.finalizeSession(session.id);
  if (!finalSession) { console.warn(`⚠️ finalizeRankSessionIfReady [${roomId}]: session đã bị finalize/xoá trước đó (có thể do double-call) -> bỏ qua.`); return null; }
  console.log(`✅ finalizeRankSessionIfReady [${roomId}]: đủ điều kiện chốt kết quả, đang tính ELO cho ${realPlayers.length} người chơi thật.`);

  const eloUpdates = [];
  for (const [userId, resultData] of finalSession.resultMap) {
    if (!realPlayers.includes(userId)) continue;
    const userEloObj = getElo(userId, room.mode);
    const userElo = userEloObj.elo ?? config.RANK_DEFAULT_ELO;
    const opponentIds = realPlayers.filter(id => id !== userId);
    let opponentElos = opponentIds.map(id => {
      const e = getElo(id, room.mode).elo;
      return e === null ? config.RANK_DEFAULT_ELO : e;
    });

    if (opponentElos.length === 0) {
      const adminTesting = await isAdminUserId(userId).catch(() => false);
      if (adminTesting) {
        opponentElos = [config.RANK_DEFAULT_ELO];
        console.log(`ℹ️ ${userId} là admin, dùng ELO mặc định làm đối thủ.`);
      }
    }

    const userRankIndex = userEloObj.rankIndex || 0;
    const newElo = calculateNewElo(userElo, opponentElos, resultData.result, resultData.kda, userRankIndex);
    const updatedData = updateElo(userId, room.mode, newElo, resultData.result === 'win');
    eloStore.upsertElo(userId, getFullElo(userId))
      .then(() => console.log(`✅ Đã cập nhật ELO [${room.mode}] cho ${userId}: ${newElo}`))
      .catch((err) => console.error(`❌ Lỗi upsert ELO cho ${userId}:`, err));

    const playerEntry = finalSession.players.find(([id]) => id === userId);
    const discordUsername = playerEntry ? playerEntry[1].username : 'Unknown';

    eloUpdates.push({
      userId,
      username: discordUsername,
      oldElo: userElo,
      newElo,
      result: resultData.result,
      kda: resultData.kda,
      wins: updatedData.wins,
      losses: updatedData.losses,
    });
  }
  persistence.saveState(rooms, eloData);

  // ===== Kết quả ELO chỉ gửi vào kênh SẢNH CHUNG (PUBLIC_RESULT_CHANNEL_ID) =====
  const publicChannelId = process.env.PUBLIC_RESULT_CHANNEL_ID;
  console.log(`ℹ️ [${roomId}] PUBLIC_RESULT_CHANNEL_ID = ${publicChannelId || '(chưa set)'}`);
  if (publicChannelId) {
    const publicChannel = await client.channels.fetch(publicChannelId).catch((err) => {
      console.error(`❌ [${roomId}] Không fetch được kênh sảnh chung (${publicChannelId}):`, err.message);
      return null;
    });
    if (publicChannel) {
      const winners = eloUpdates.filter(u => u.result === 'win');
      const losers  = eloUpdates.filter(u => u.result === 'loss');

      let mvpId = null;
      let bestKda = -1;
      for (const u of eloUpdates) {
        const k = (typeof u.kda === 'number' && !isNaN(u.kda)) ? u.kda : -1;
        if (k > bestKda) { bestKda = k; mvpId = u.userId; }
      }

      const getDisplayName = (upd) => {
        const eloObj = getElo(upd.userId, room.mode);
        return eloObj.ign || upd.username || `User_${upd.userId.slice(-4)}`;
      };

      winners.sort((a, b) => (b.newElo - b.oldElo) - (a.newElo - a.oldElo));
      losers.sort((a, b) => (b.newElo - b.oldElo) - (a.newElo - a.oldElo));

      const MEDALS = ['🥇', '🥈', '🥉'];
      const formatEntry = (upd, idx) => {
        const delta = upd.newElo - upd.oldElo;
        const sign = delta >= 0 ? '+' : '';
        const isMvp = upd.userId === mvpId;
        const medal = isMvp ? '👑' : (MEDALS[idx] || '▫️');
        const mvpTag = isMvp ? ' · **MVP**' : '';
        const name = getDisplayName(upd);
        const kdaStr = typeof upd.kda === 'number' ? upd.kda.toFixed(2) : '—';
        const total = (upd.wins || 0) + (upd.losses || 0);
        const wr = total > 0 ? Math.round(100 * upd.wins / total) + '%' : '—';
        const est = estimateWinsToNextTier(upd.userId, room.mode);
        const estStr = est.isMax
          ? '🏆 MAX tier'
          : `🎯 ~${est.estimatedWins} win → ${est.nextTierName}`;

        return (
          `> ${medal} **${name}**${mvpTag}\n` +
          `> \`${upd.oldElo} → ${upd.newElo}\` **(${sign}${delta})**\n` +
          `> KDA ${kdaStr} · W/L ${upd.wins}-${upd.losses} (${wr})\n` +
          `> ${estStr}`
        );
      };

      const victoryText = winners.length > 0
        ? winners.map((u, i) => formatEntry(u, i)).join('\n\n')
        : '> _Không có ai_';
      const defeatText = losers.length > 0
        ? losers.map((u, i) => formatEntry(u, i)).join('\n\n')
        : '> _Không có ai_';

      const trim = (s) => s.length > 1024 ? s.slice(0, 1020) + '\n> ...' : s;

      let mvpAvatarUrl = null;
      if (mvpId) {
        try {
          const mvpUser = await client.users.fetch(mvpId);
          mvpAvatarUrl = mvpUser.displayAvatarURL({ size: 256 });
        } catch (err) {}
      }

      const embed = new EmbedBuilder()
        .setAuthor({ name: `Kết quả trận ${room.mode.toUpperCase()} Rank`, iconURL: client.user.displayAvatarURL() })
        .setTitle(`📊 ${room.label}`)
        .setDescription(`🏆 **${winners.length} thắng** · ⚔️ **${losers.length} thua** · ${eloUpdates.length} người chơi`)
        .addFields(
          { name: `🏆 VICTORY (${winners.length})`, value: trim(victoryText) },
          { name: `⚔️ DEFEAT (${losers.length})`,  value: trim(defeatText) }
        )
        .setColor(winners.length >= losers.length ? 0x57f287 : 0xed4245)
        .setFooter({ text: `${room.mode.toUpperCase()} Rank · ${new Date().toLocaleString('vi-VN')}` })
        .setTimestamp();

      if (mvpAvatarUrl) embed.setThumbnail(mvpAvatarUrl);

      await publicChannel.send({ embeds: [embed] })
        .then(() => console.log(`✅ [${roomId}] Đã gửi thông báo kết quả vào kênh sảnh chung.`))
        .catch((err) => console.error(`❌ [${roomId}] Gửi thông báo kết quả vào sảnh chung THẤT BẠI (có thể do bot thiếu quyền View Channel/Send Messages/Embed Links trong kênh đó):`, err.message));
    } else {
      console.warn(`⚠️ Không tìm thấy kênh sảnh chung: ${publicChannelId} (kiểm tra lại ID kênh, và bot đã được add vào kênh/server đó chưa).`);
    }
  } else {
    console.warn('⚠️ Chưa set PUBLIC_RESULT_CHANNEL_ID — kết quả ELO sẽ không được đăng.');
  }

  return eloUpdates;
}

// ===== COOLDOWN =====
const cooldowns = new Map();
function checkCooldown(userId) {
  const now = Date.now();
  const last = cooldowns.get(userId) || 0;
  if (now - last < config.ACTION_COOLDOWN_MS) return false;
  cooldowns.set(userId, now);
  return true;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===== IMAGE HISTORY =====
const HISTORY_FILE = path.join(__dirname, 'data', 'image-history.json');

function loadImageHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch { return []; }
}

function saveImageHistory(history) {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function hashImageBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isImageHashUsedRecently(hash, userId, days = 90) {
  const history = loadImageHistory();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return history.some(entry => entry.hash === hash && entry.userId === userId && entry.submittedAt > cutoff);
}

function addImageHistory(hash, url, userId, roomId) {
  const history = loadImageHistory();
  history.push({ hash, url, userId, roomId, submittedAt: Date.now() });
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  saveImageHistory(history.filter(e => e.submittedAt > cutoff));
}

// ===== OCR =====
const OCR_API_KEY = process.env.OCR_API_KEY || config.OCR_API_KEY;

async function downloadImageBuffer(imageUrl) {
  console.log(`📥 Đang tải ảnh từ: ${imageUrl}`);
  const imageResponse = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 15000,
  });
  const imageBuffer = Buffer.from(imageResponse.data, 'binary');
  console.log(`✅ Đã tải ảnh (${imageBuffer.length} bytes)`);
  return imageBuffer;
}

async function ocrImageBuffer(imageBuffer) {
  if (!OCR_API_KEY) throw new Error('MISSING_OCR_API_KEY');
  try {
    const postOnce = () => {
      const formData = new FormData();
      formData.append('apikey', OCR_API_KEY);
      formData.append('file', imageBuffer, { filename: 'screenshot.png' });
      formData.append('language', 'eng');
      // ✅ Bật overlay để lấy toạ độ (Top) của từng dòng. ParsedText thuần
      // không đảm bảo đúng thứ tự theo chiều dọc của ảnh khi giao diện có
      // nhiều icon/nút xen giữa các cột -> dùng toạ độ Top để đối chiếu
      // tên người chơi với đúng dòng K/D/A của họ, tránh map nhầm sang
      // hàng bên cạnh (VD: NaNi bị gán nhầm KDA của Peckkk).
      formData.append('isOverlayRequired', 'true');
      formData.append('detectOrientation', 'true');
      formData.append('scale', 'true');
      return axios.post('https://api.ocr.space/parse/image', formData, {
        headers: { ...formData.getHeaders() },
        timeout: 60000,
      });
    };

    console.log('📤 Đang gửi OCR.space...');
    let response;
    try { response = await postOnce(); }
    catch (err) {
      const retryable = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || (err.response && err.response.status >= 500);
      if (!retryable) throw err;
      response = await postOnce();
    }

    const data = response.data;
    if (data.IsErroredOnProcessing) { console.error('OCR error:', data.ErrorMessage); return { text: '', overlayLines: [] }; }
    const text = data.ParsedResults?.[0]?.ParsedText || '';
    const overlayLines = data.ParsedResults?.[0]?.TextOverlay?.Lines || [];
    console.log(`✅ OCR: ${text.length} ký tự, ${overlayLines.length} dòng overlay`);
    return { text, overlayLines };
  } catch (err) {
    console.error('❌ OCR failed:', err.message);
    throw err;
  }
}

// ===== HELPERS =====
function t(interaction, vi, en) { return interaction.locale === 'vi' ? vi : en; }
function bi(vi, en) { return `${vi}\n🌐 ${en}`; }

function parseMatchResult(ocrText) {
  const resultMatch = ocrText.match(
    /\b(VICTORY|DEFEAT|WIN|LOSE|Chiến\s*thắng|Thắng\s*trận|Thất\s*bại|Bại\s*trận|Đầu\s*hàng|Thắng|Bại|Thua|Chien\s*thang|Thang\s*tran|That\s*bai|Bai\s*tran|Dau\s*hang)\b/i
  );
  if (!resultMatch) return null;
  const raw = resultMatch[1].toLowerCase();
  if (raw.includes('đầu') || raw.includes('dau')) return 'surrender';
  if (raw.includes('victory') || raw === 'win' || raw.includes('chiến') || raw.includes('chien') || raw.includes('thắng') || raw.includes('thang')) return 'win';
  if (raw.includes('defeat') || raw === 'lose' || raw.includes('thất') || raw.includes('that') || raw.includes('bại') || raw.includes('bai') || raw === 'thua') return 'loss';
  return null;
}

// ===== ANNOUNCEMENT =====
const ANNOUNCE_CHANNEL_ID = config.ANNOUNCE_CHANNEL_ID;

async function startAnnouncement(room) {
  if (!['3v3', '5v5'].includes(room.mode)) return;
  if (room.isRank) return;
  if (room.timers.announceInterval) return;
  if (!ANNOUNCE_CHANNEL_ID) return;

  const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const msg = await channel.send('📢 **Nhanh tay đăng ký chơi cùng nhau nào anh em!**').catch(() => null);
  if (!msg) return;

  room.announceMessageId = msg.id;
  room.timers.announceInterval = setInterval(async () => {
    const ch = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
    if (ch) ch.send('📢 **Nhanh tay đăng ký chơi cùng nhau nào anh em!**').catch(() => {});
  }, 10 * 60 * 1000);
}

function stopAnnouncement(room) {
  if (room.timers.announceInterval) {
    clearInterval(room.timers.announceInterval);
    room.timers.announceInterval = null;
    room.announceMessageId = null;
  }
}

function resetRoomWithCleanup(room) {
  if (!room) return;
  stopAnnouncement(room);
  resetRoom(room);
}

// ===== SCHEDULED ANNOUNCE =====
let lastScheduledAnnounce = 0;
let scheduledInterval = null;

async function sendScheduledAnnounce() {
  if (!ANNOUNCE_CHANNEL_ID) return;
  const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
  if (!channel) return;
  const now = new Date();
  const hours = now.getHours();

  if (hours >= 20 && hours < 22) {
    if (Date.now() - lastScheduledAnnounce >= 30 * 60 * 1000) {
      await channel.send('📢 **Vào đăng ký chơi cùng nhau nào AE!**').catch(() => {});
      lastScheduledAnnounce = Date.now();
    }
  } else {
    lastScheduledAnnounce = 0;
  }
}

// ===== ADMIN/RENDER =====
function isAdmin(interaction) {
  if (!interaction.member) return false;
  if (interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (config.ADMIN_ROLE_ID && interaction.member.roles?.cache?.has(config.ADMIN_ROLE_ID)) return true;
  return false;
}

async function isAdminAnywhere(interaction) {
  if (interaction.member) return isAdmin(interaction);
  return isAdminUserId(interaction.user.id);
}

async function isAdminUserId(userId) {
  const guildIds = config.GUILD_ID ? [config.GUILD_ID] : Array.from(client.guilds.cache.keys());
  for (const guildId of guildIds) {
    const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) continue;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (config.ADMIN_ROLE_ID && member.roles?.cache?.has(config.ADMIN_ROLE_ID)) return true;
  }
  return false;
}

function sanitizeRoomId(raw) { return String(raw ?? '').replace(/`/g, '').trim(); }

async function logAdmin(text) {
  if (!config.LOG_CHANNEL_ID) return;
  const ch = await client.channels.fetch(config.LOG_CHANNEL_ID).catch(() => null);
  if (ch) await ch.send(text).catch(() => {});
}

async function renderHiddenRoom(room) {
  const embed = roomEmbed(room);
  const rowsUi = roomActionRows(room);
  for (const target of room.panelTargets) {
    try {
      const ch = await client.channels.fetch(target.channelId).catch(() => null);
      if (!ch) continue;
      if (target.messageId) {
        const msg = await ch.messages.fetch(target.messageId).catch(() => null);
        if (msg) {
          try {
            await msg.edit({ embeds: [embed], components: rowsUi });
            continue;
          } catch (editErr) {
            // Message đã bị xoá trước khi edit xong (Unknown Message 10008)
            // -> reset ID để gửi panel mới thay vì báo lỗi.
            if (editErr.code === 10008) {
              target.messageId = null;
            } else {
              throw editErr;
            }
          }
        }
      }
      const sent = await ch.send({ embeds: [embed], components: rowsUi });
      target.messageId = sent.id;
    } catch (err) { console.error(`Lỗi render ẩn ${room.id}:`, err); }
  }
}

async function renderRoom(room, channel) {
  if (room.hidden) return renderHiddenRoom(room);
  const embed = roomEmbed(room);
  const rowsUi = roomActionRows(room);
  try {
    if (room.panelMessageId && room.panelChannelId) {
      const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null);
        if (msg) {
          try {
            await msg.edit({ embeds: [embed], components: rowsUi });
            persistence.saveState(rooms, eloData);
            return msg;
          } catch (editErr) {
            // Message đã bị xoá trước khi edit xong (Unknown Message 10008)
            // -> reset ID để gửi panel mới thay vì báo lỗi.
            if (editErr.code === 10008) {
              room.panelChannelId = null;
              room.panelMessageId = null;
            } else {
              throw editErr;
            }
          }
        }
      }
    }
    const msg = await channel.send({ embeds: [embed], components: rowsUi });
    room.panelChannelId = channel.id;
    room.panelMessageId = msg.id;
    persistence.saveState(rooms, eloData);
    return msg;
  } catch (err) { console.error(`Lỗi render ${room.id}:`, err); return null; }
}

const FLASH_COLORS = [0xffffff, 0xffd700, 0xff69b4, 0x00ffff, 0xff4500, 0x9b59b6];

function startWaitingBlink(room, channel) {
  if (room.timers.blink) return;
  room._rainbowIndex = 0;
  room.timers.blink = setInterval(() => {
    room._blinkOn = !room._blinkOn;
    room._rainbowIndex = (room._rainbowIndex ?? 0) + 1;
    if (room._blinkOn) room._flashColor = FLASH_COLORS[Math.floor(Math.random() * FLASH_COLORS.length)];
    renderRoom(room, channel).catch(() => {});
  }, config.BLINK_INTERVAL_MS);
}

function scheduleInactivityTimeout(room, channel, customMs) {
  if (room.timers.inactivity) clearTimeout(room.timers.inactivity);
  const ms = customMs ?? room.timeoutMs;
  room.timers.inactivity = setTimeout(async () => {
    if (room.status !== 'revealed') {
      const invitedIds = room.hidden ? room.panelTargets.map((t) => t.userId) : [];
      resetRoomWithCleanup(room);
      await renderRoom(room, channel);
      if (room.hidden) {
        for (const id of invitedIds) {
          client.users.fetch(id).then((user) => user.send(`⏰ **${room.label}** đã tự động reset.`)).catch(() => {});
        }
        return;
      }
      await channel.send(bi(
        `⏰ **${room.label}** đã tự động reset vì quá thời gian chờ.`,
        `**${room.label}** was auto-reset.`
      )).catch(() => {});
    }
  }, ms);
}

async function announceRoomFull(room, channel) {
  const ids = Array.from(room.players.keys());
  const readyMinutes = Math.round(config.READY_COUNTDOWN_MS / 60000);
  if (room.hidden) {
    for (const id of ids) {
      client.users.fetch(id).then((user) =>
        user.send(`✅ **${room.label}** đã đủ người! Bấm Sẵn sàng trong ${readyMinutes} phút.`)
      ).catch(() => {});
    }
    return;
  }
  const mentions = ids.map((id) => `<@${id}>`).join(' ');
  await channel.send(bi(
    `✅ **${room.label}** đã đủ người! ${mentions}\nBấm **Sẵn sàng** trong ${readyMinutes} phút.`,
    `**${room.label}** is now full! ${mentions}\nHit Ready within ${readyMinutes} minutes.`
  )).catch(() => {});
  for (const id of ids) {
    client.users.fetch(id).then((user) =>
      user.send(bi(
        `✅ **${room.label}** đã đủ người! Vào <#${channel.id}> bấm Sẵn sàng trong ${readyMinutes} phút.`,
        `**${room.label}** is full! Go to <#${channel.id}> and hit Ready.`
      ))
    ).catch(() => {});
  }
}

function scheduleReadyCountdown(room, channel) {
  if (room.timers.readyCountdown) clearTimeout(room.timers.readyCountdown);
  room.fullAt = Date.now();
  room.timers.readyCountdown = setTimeout(() => handleReadyCountdownExpire(room, channel), config.READY_COUNTDOWN_MS);
  startWaitingBlink(room, channel);
}

async function handleReadyCountdownExpire(room, channel) {
  room.timers.readyCountdown = null;
  if (room.status !== 'waiting') return;
  if (!isFull(room)) return;
  const check = canRevealCode(room);
  if (check.ok) return tryRevealCode(room, channel);

  const kicked = [];
  for (const [id, p] of room.players.entries()) {
    if (!p.ready) { kicked.push(id); room.players.delete(id); }
  }
  room.fullAt = null;
  if (room.timers.blink) { clearInterval(room.timers.blink); room.timers.blink = null; room._flashColor = null; }

  // ✅ Nếu là phòng rank: sau khi đá người không sẵn sàng, ghép lại team
  // theo ELO cho những người còn lại (nếu còn từ 1 người trở lên).
  if (room.isRank && room.players.size > 0) {
    autoBalanceRankTeams(room);
  }

  if (kicked.length === 0) {
    await channel.send(bi(
      `⚖️ **${room.label}**: mọi người đã sẵn sàng nhưng team chưa cân bằng.`,
      `**${room.label}**: everyone ready but teams aren't balanced.`
    )).catch(() => {});
    await renderRoom(room, channel);
    return;
  }

  const mentions = kicked.map((id) => `<@${id}>`).join(' ');
  const readyMinutes2 = Math.round(config.READY_COUNTDOWN_MS / 60000);
  await channel.send(bi(
    `⏱️ Hết ${readyMinutes2} phút chờ sẵn sàng tại **${room.label}** — đã đá ${mentions}.`,
    `⏱️ Ready window for **${room.label}** over — kicked ${mentions}.`
  )).catch(() => {});

  if (room.players.size === 0) resetRoomWithCleanup(room);
  else { room.firstJoinAt = Date.now(); scheduleInactivityTimeout(room, channel); }
  await renderRoom(room, channel);
}

// ===== REVEAL CODE =====
async function tryRevealCode(room, channel) {
  if (room.status === 'revealed') return;
  const check = canRevealCode(room);
  if (!check.ok) return;

  if (room.timers.inactivity) { clearTimeout(room.timers.inactivity); room.timers.inactivity = null; }
  if (room.timers.readyCountdown) { clearTimeout(room.timers.readyCountdown); room.timers.readyCountdown = null; }

  room.code = generateCode();
  room.status = 'revealed';
  room.revealedAt = Date.now();
  room._blinkOn = true;
  room._flashColor = null;

  if (room.timers.blink) { clearInterval(room.timers.blink); room.timers.blink = null; }

  await renderRoom(room, channel);
  await channel.send(bi(
    `🔑 **${room.label}** đã đủ người sẵn sàng! Code đã phát.`,
    `🔑 **${room.label}** is full and ready! Code revealed.`
  )).catch(() => {});

  const playerList = Array.from(room.players.values()).map((p) => `${p.username}${p.team ? ` (Team ${p.team})` : ''}`).join(', ');
  await logAdmin(`🔑 **${room.label}** phát code \`${room.code}\`\nNgười chơi: ${playerList}`);

  room.timers.blink = setInterval(() => {
    room._blinkOn = !room._blinkOn;
    renderRoom(room, channel).catch(() => {});
  }, config.BLINK_INTERVAL_MS);

  if (room.isRank) {
    const playersSnapshot = new Map(room.players);
    const sessionId = rankSessions.createSession(room.id, playersSnapshot, room.mode, room.code);
    console.log(`📝 Đã tạo session ${sessionId} cho ${room.label}`);

    const resultChannelId = process.env.RANK_RESULT_CHANNEL_ID;
    if (resultChannelId) {
      const resultChannel = await client.channels.fetch(resultChannelId).catch(() => null);
      if (resultChannel) {
        const playerMentions = Array.from(playersSnapshot.keys()).map(id => `<@${id}>`).join(' ');
        await resultChannel.send({
          content: `🎮 **${room.label}** [${room.mode}] đã bắt đầu!\nNgười chơi: ${playerMentions}\nGửi ảnh qua \`/submit-result phong:${room.id}\`. Hạn 45 phút.`
        });
      }
    }

    room.timers.resetAfterCode = setTimeout(async () => {
      clearRoomTimers(room);
      resetRoomWithCleanup(room);
      await renderRoom(room, channel);
      await channel.send(bi(`♻️ **${room.label}** đã reset.`, `**${room.label}** reset.`)).catch(() => {});
    }, config.CODE_RESET_DELAY_MS);
  } else {
    room.timers.resetAfterCode = setTimeout(async () => {
      clearRoomTimers(room);
      resetRoomWithCleanup(room);
      await renderRoom(room, channel);
      await channel.send(bi(`♻️ **${room.label}** đã reset.`, `**${room.label}** reset.`)).catch(() => {});
    }, config.CODE_RESET_DELAY_MS);
  }
}

// ===== AUTO HEAL PANELS =====
async function repostPanelsForChannel(channelId, roomList) {
  if (!channelId || roomList.length === 0) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) { console.error(`❌ Không tìm thấy kênh panel: ${channelId}`); return; }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter((m) => m.author.id === client.user.id);
    if (botMessages.size > 0) {
      await channel.bulkDelete(botMessages, true).catch(async () => {
        for (const msg of botMessages.values()) await msg.delete().catch(() => {});
      });
    }
  } catch (err) { console.error(`⚠️ Không dọn được panel cũ:`, err.message); }

  for (const room of roomList) {
    room.panelChannelId = null;
    room.panelMessageId = null;
    await renderRoom(room, channel);
  }
}

async function autoHealPanels() {
  for (const mode of Object.keys(config.CAPACITY)) {
    await repostPanelsForChannel(config.PANEL_CHANNELS.normal[mode], getNormalRoomsByMode(mode));
    await repostPanelsForChannel(config.PANEL_CHANNELS.rank[mode], getRankRoomsByMode(mode));
  }
  persistence.saveState(rooms, eloData);
  console.log('✅ Đã đăng lại toàn bộ panel phòng.');
}

// ===== CLIENT READY =====
client.once('ready', async () => {
  console.log(`Đã đăng nhập với tên ${client.user.tag}`);
  await autoHealPanels();

  for (const room of getAllRooms()) {
    if (room.players.size === 0 || !room.panelChannelId) continue;
    const channel = await client.channels.fetch(room.panelChannelId).catch(() => null);
    if (!channel) continue;

    // Nếu là phòng rank và còn người chơi (khôi phục sau restart) -> ghép
    // lại team theo ELO để đảm bảo tính cân bằng.
    if (room.isRank && room.players.size > 0) {
      autoBalanceRankTeams(room);
    }

    if (room.status === 'revealed' && room.revealedAt) {
      if (room.isRank) { resetRoomWithCleanup(room); await renderRoom(room, channel); }
      else {
        const remaining = config.CODE_RESET_DELAY_MS - (Date.now() - room.revealedAt);
        if (remaining <= 0) resetRoomWithCleanup(room);
        else {
          room._blinkOn = true;
          room.timers.blink = setInterval(() => { room._blinkOn = !room._blinkOn; renderRoom(room, channel).catch(() => {}); }, config.BLINK_INTERVAL_MS);
          room.timers.resetAfterCode = setTimeout(async () => {
            clearRoomTimers(room); resetRoomWithCleanup(room);
            await renderRoom(room, channel);
            await channel.send(bi(`♻️ **${room.label}** đã reset.`, `**${room.label}** reset.`)).catch(() => {});
          }, remaining);
        }
      }
    } else if (room.status === 'waiting') {
      if (isFull(room) && room.fullAt) {
        const remaining = config.READY_COUNTDOWN_MS - (Date.now() - room.fullAt);
        if (remaining <= 0) await handleReadyCountdownExpire(room, channel);
        else { room.timers.readyCountdown = setTimeout(() => handleReadyCountdownExpire(room, channel), remaining); startWaitingBlink(room, channel); }
      } else if (room.firstJoinAt) {
        const remaining = room.timeoutMs - (Date.now() - room.firstJoinAt);
        if (remaining <= 0) resetRoomWithCleanup(room);
        else scheduleInactivityTimeout(room, channel, remaining);
      }
    }
    await renderRoom(room, channel);
  }

  await sendScheduledAnnounce();
  scheduledInterval = setInterval(async () => { await sendScheduledAnnounce(); }, 60 * 1000);
  console.log('✅ Thông báo tự động 20:00-22:00, mỗi 30 phút.');
});

// ===== INTERACTION HANDLER =====
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await handleSlashCommand(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
    else if (interaction.isUserSelectMenu()) await handleUserSelectMenu(interaction);
    else if (interaction.isModalSubmit()) await handleModalSubmit(interaction);

    if (interaction.isRepliable() && interaction.replied && interaction.ephemeral) {
      setTimeout(() => interaction.deleteReply().catch(() => {}), 5 * 60 * 1000);
    }
  } catch (err) { console.error('❗ Lỗi interactionCreate:', err); }
});

const ADMIN_ONLY_COMMANDS = new Set([
  'set-timeout', 'ready', 'gia-han-phong', 'ban-phong', 'unban-phong',
  'kick-room', 'kick-group', 'setup-phong-an', 'moi-phong-an',
  'danh-sach-phong-an', 'xoa-phong-an', 'xoa-tat-ca-phong-an',
  'setup', 'setup-rank', 'admin-submit-result',
  'test-fill', 'test-fill-rank', 'test-fill-an',
  'xoa-setup-phong', 'don-rac', 'xoa-tin-nhan-bot',
  'xoa-phong-thuong', 'xoa-tat-ca-phong-thuong',
  'reset-tat-ca-phong', 'reset-room',
  'xoa-phong-rank', 'xoa-tat-ca-phong-rank',
]);

const ADMIN_MSG_AUTO_DELETE_MS = 2 * 60 * 1000;

function wrapAdminEphemeralAutoDelete(interaction) {
  const originalReply = interaction.reply.bind(interaction);
  interaction.reply = async (options) => {
    const result = await originalReply(options);
    setTimeout(() => interaction.deleteReply().catch(() => {}), ADMIN_MSG_AUTO_DELETE_MS);
    return result;
  };
  const originalFollowUp = interaction.followUp.bind(interaction);
  interaction.followUp = async (options) => {
    const msg = await originalFollowUp(options);
    setTimeout(() => { if (msg && typeof msg.delete === 'function') msg.delete().catch(() => {}); }, ADMIN_MSG_AUTO_DELETE_MS);
    return msg;
  };
}

// ===== SLASH COMMANDS =====
async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (ADMIN_ONLY_COMMANDS.has(commandName)) wrapAdminEphemeralAutoDelete(interaction);

  if (commandName === 'lobby') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    const statsFor = (mode) => {
      const list = getRoomsByMode(mode);
      return { current: list.reduce((s, r) => s + r.players.size, 0), total: list.reduce((s, r) => s + r.capacity, 0), roomCount: list.length };
    };
    const stats = { '3v3': statsFor('3v3'), '5v5': statsFor('5v5') };
    await interaction.channel.send({ embeds: [mainMenuEmbed(stats)], components: [mainMenuRow()] });
    return interaction.reply({ content: '✅ Đã đăng bảng chọn phòng.', ephemeral: true });
  }

  if (commandName === 'rank-stats') {
    const target = interaction.options.getUser('user') || interaction.user;
    const eloObj3 = getElo(target.id, '3v3');
    const eloObj5 = getElo(target.id, '5v5');
    const ign = eloObj3.ign || eloObj5.ign || '(chưa đăng ký)';

    const formatLine = (mode, e) => {
      const elo = e.elo ?? 0;
      const wins = e.wins || 0;
      const losses = e.losses || 0;
      const total = wins + losses;
      const wr = total > 0 ? Math.round(100 * wins / total) + '%' : '—';
      const est = estimateWinsToNextTier(target.id, mode);
      let estStr;
      if (est.isMax) estStr = '🏆 Đã đạt tier cao nhất';
      else if (est.estimatedWins === 0) estStr = `⚡ Đủ điểm lên **${est.nextTierName}**`;
      else estStr = `🎯 Cần ~**${est.estimatedWins}** win nữa tới **${est.nextTierName}** (+${est.needElo} ELO)`;
      return `**${mode.toUpperCase()}** — \`${elo} ELO\` · **${e.rank}**\n> 🏆 **${wins}W - ${losses}L** (${wr} trên ${total} trận)\n> ${estStr}`;
    };

    const embed = new EmbedBuilder()
      .setTitle(`📊 Rank Stats — ${target.username}`)
      .setDescription(`**IGN:** ${ign}\n\n${formatLine('3v3', eloObj3)}\n\n${formatLine('5v5', eloObj5)}`)
      .setColor(0x5865f2)
      .setThumbnail(target.displayAvatarURL({ size: 128 }))
      .setFooter({ text: '* Ước tính gần đúng — thay đổi theo tier (K-factor) và KDA' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (commandName === 'set-timeout') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const minutes = interaction.options.getInteger('phut', true);
    const scope = interaction.options.getString('pham_vi') || 'all';
    const ms = minutes * 60 * 1000;
    const targets = scope === 'all' ? [...getRoomsByMode('3v3'), ...getRoomsByMode('5v5')] : getRoomsByMode(scope);
    for (const room of targets) {
      room.timeoutMs = ms;
      if (room.status === 'waiting' && room.players.size > 0 && !isFull(room) && room.panelChannelId) {
        const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
        if (ch) { room.firstJoinAt = Date.now(); scheduleInactivityTimeout(room, ch); await renderRoom(room, ch); }
      }
    }
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã đặt timeout = **${minutes} phút** cho ${scope === 'all' ? 'tất cả phòng' : `phòng ${scope}`}.`, ephemeral: true });
  }

  if (commandName === 'ready') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const trangThai = interaction.options.getString('trang_thai', true);
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    const player = room.players.get(targetUser.id);
    if (!player) return interaction.reply({ content: `❌ <@${targetUser.id}> không ở trong **${room.label}**.`, ephemeral: true });
    player.ready = trangThai === 'ready';
    const channel = (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) || interaction.channel;
    await renderRoom(room, channel);
    if (player.ready) { const check = canRevealCode(room); if (check.ok) await tryRevealCode(room, channel); }
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã đặt <@${targetUser.id}> thành **${player.ready ? 'Sẵn sàng' : 'Chưa sẵn sàng'}**.`, ephemeral: true });
  }

  if (commandName === 'gia-han-phong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const phut = interaction.options.getInteger('phut', true);
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    if (!room.firstJoinAt || room.status === 'revealed') return interaction.reply({ content: 'ℹ️ Phòng đang trống hoặc đã phát code.', ephemeral: true });
    room.timeoutMs += phut * 60 * 1000;
    const remaining = Math.max(room.timeoutMs - (Date.now() - room.firstJoinAt), 1000);
    const channel = (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) || interaction.channel;
    scheduleInactivityTimeout(room, channel, remaining);
    await renderRoom(room, channel);
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã gia hạn thêm **${phut} phút** cho **${room.label}**.`, ephemeral: true });
  }

  if (commandName === 'moi-ban') {
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('ban', true);
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    if (room.status === 'revealed') return interaction.reply({ content: '❌ Phòng đã phát code.', ephemeral: true });
    if (isFull(room)) return interaction.reply({ content: '❌ Phòng đã đầy.', ephemeral: true });
    if (isBanned(room, targetUser.id)) return interaction.reply({ content: `❌ <@${targetUser.id}> đang bị cấm.`, ephemeral: true });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`join_${room.id}`).setLabel('Tham gia ngay').setStyle(ButtonStyle.Success).setEmoji('➕')
    );
    await interaction.channel.send({
      content: `📨 <@${interaction.user.id}> mời <@${targetUser.id}> vào **${room.label}** (${room.players.size}/${room.capacity})!`,
      components: [row],
    });
    return interaction.reply({ content: `✅ Đã gửi lời mời.`, ephemeral: true });
  }

  if (commandName === 'ban-phong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    const wasInRoom = room.players.has(targetUser.id);
    banUser(room, targetUser.id);
    persistence.saveState(rooms, eloData);
    if (wasInRoom) {
      const channel = (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) || interaction.channel;
      await renderRoom(room, channel);
    }
    return interaction.reply({ content: `✅ Đã cấm <@${targetUser.id}> khỏi **${room.label}**${wasInRoom ? ' (đã đá luôn)' : ''}.`, ephemeral: true });
  }

  if (commandName === 'unban-phong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    unbanUser(room, targetUser.id);
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã bỏ cấm <@${targetUser.id}> khỏi **${room.label}**.`, ephemeral: true });
  }

  if (commandName === 'kick-room') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    if (!room.players.has(targetUser.id)) return interaction.reply({ content: `ℹ️ <@${targetUser.id}> không ở trong **${room.label}**.`, ephemeral: true });
    room.players.delete(targetUser.id);
    // Phòng rank: ghép lại team theo ELO cho người còn lại.
    if (room.isRank && room.players.size > 0) autoBalanceRankTeams(room);
    persistence.saveState(rooms, eloData);
    const channel = (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) || interaction.channel;
    await renderRoom(room, channel);
    if (room.hidden) client.users.fetch(targetUser.id).then((u) => u.send(`⚠️ Bạn đã bị admin đá khỏi **${room.label}**.`)).catch(() => {});
    return interaction.reply({ content: `✅ Đã đá <@${targetUser.id}> khỏi **${room.label}**.`, ephemeral: true });
  }

  if (commandName === 'kick-group') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const room = getHiddenRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng ẩn "${roomId}".`, ephemeral: true });
    room.players.delete(targetUser.id);
    if (room.isRank && room.players.size > 0) autoBalanceRankTeams(room);
    const targetIdx = room.panelTargets.findIndex((t) => t.userId === targetUser.id);
    if (targetIdx === -1) return interaction.reply({ content: `ℹ️ <@${targetUser.id}> chưa từng được mời.`, ephemeral: true });
    const [target] = room.panelTargets.splice(targetIdx, 1);
    try {
      const ch = await client.channels.fetch(target.channelId).catch(() => null);
      if (ch && target.messageId) {
        const msg = await ch.messages.fetch(target.messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    } catch (err) { console.error('Lỗi xoá panel:', err); }
    client.users.fetch(targetUser.id).then((u) => u.send(`🚫 Bạn đã bị xoá khỏi nhóm **${room.label}**.`)).catch(() => {});
    await renderRoom(room, interaction.channel);
    return interaction.reply({ content: `✅ Đã xoá <@${targetUser.id}> khỏi nhóm.`, ephemeral: true });
  }

  if (commandName === 'setup-phong-an') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const mode = interaction.options.getString('che_do', true);
    const room = createHiddenRoom(mode);
    let dmNote = '';
    try { await sendHiddenRoomDM(room, interaction.user, `👑 Bạn vừa tạo phòng ẩn: **${room.label}**.`); }
    catch (err) { dmNote = '\n⚠️ Không DM được panel.'; }
    return interaction.reply({ content: `✅ Đã tạo **${room.label}** (ID: \`${room.id}\`).${dmNote}`, ephemeral: true });
  }

  if (commandName === 'moi-phong-an') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    if (!interaction.guild) return interaction.reply({ content: '⚠️ Lệnh này phải chạy trong kênh server.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getHiddenRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng ẩn "${roomId}".`, ephemeral: true });
    const select = new UserSelectMenuBuilder()
      .setCustomId(`hiddeninvite_${room.id}`)
      .setPlaceholder(`Chọn người muốn mời vào ${room.label}`)
      .setMinValues(1).setMaxValues(25);
    return interaction.reply({ content: `📨 Chọn người muốn mời vào **${room.label}**:`, components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
  }

  if (commandName === 'danh-sach-phong-an') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const list = getAllHiddenRooms();
    if (list.length === 0) return interaction.reply({ content: 'ℹ️ Chưa có phòng ẩn nào.', ephemeral: true });
    const lines = list.map((r) => `• \`${r.id}\` — ${r.label} — ${r.players.size}/${r.capacity} người — đã mời ${r.panelTargets.length}`);
    return interaction.reply({ content: `📋 Danh sách:\n${lines.join('\n')}`, ephemeral: true });
  }

  if (commandName === 'xoa-phong-an') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getHiddenRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng ẩn "${roomId}".`, ephemeral: true });
    for (const target of room.panelTargets) {
      const ch = await client.channels.fetch(target.channelId).catch(() => null);
      if (ch) {
        const msg = target.messageId ? await ch.messages.fetch(target.messageId).catch(() => null) : null;
        if (msg) await msg.edit({ content: `🚫 **${room.label}** đã bị admin đóng.`, embeds: [], components: [] }).catch(() => {});
      }
    }
    deleteHiddenRoom(roomId);
    return interaction.reply({ content: `✅ Đã xóa **${room.label}**.`, ephemeral: true });
  }

  if (commandName === 'xoa-tat-ca-phong-an') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const allHidden = getAllHiddenRooms();
    if (allHidden.length === 0) return interaction.reply({ content: 'ℹ️ Chưa có phòng ẩn nào.', ephemeral: true });
    await interaction.reply({ content: `🗑️ Đang xóa **${allHidden.length}** phòng ẩn...`, ephemeral: true });
    for (const room of allHidden) {
      for (const target of room.panelTargets) {
        const ch = await client.channels.fetch(target.channelId).catch(() => null);
        if (ch) {
          const msg = target.messageId ? await ch.messages.fetch(target.messageId).catch(() => null) : null;
          if (msg) await msg.edit({ content: `🚫 **${room.label}** đã đóng.`, embeds: [], components: [] }).catch(() => {});
        }
      }
      deleteHiddenRoom(room.id);
    }
    return interaction.followUp({ content: `✅ Đã xóa **${allHidden.length}** phòng ẩn.`, ephemeral: true });
  }

  if (commandName === 'setup') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const mode = interaction.options.getString('che_do', true);
    const soLuong = interaction.options.getInteger('so_luong');
    let note = '';
    if (soLuong) {
      const { created, capped, currentTotal, maxAllowed } = addRoomsToMode(mode, soLuong);
      if (created.length > 0) note += `\n✅ Tạo thêm **${created.length}** phòng: ${created.map((r) => `\`${r.id}\``).join(', ')} (tổng: **${currentTotal}/${maxAllowed}**).`;
      if (capped) note += `\n⚠️ Chỉ tạo được ${created.length} vì đã chạm giới hạn.`;
    }
    const roomsOfMode = getRoomsByMode(mode);
    if (roomsOfMode.length === 0) return interaction.reply({ content: `❌ Chế độ **${mode.toUpperCase()}** chưa có phòng nào.`, ephemeral: true });
    await interaction.reply({ content: `✅ Đang đăng ${roomsOfMode.length} panel **${mode.toUpperCase()}**...${note}`, ephemeral: true });
    for (const room of roomsOfMode) { room.panelChannelId = null; room.panelMessageId = null; await renderRoom(room, interaction.channel); }
    persistence.saveState(rooms, eloData);
    return;
  }

  if (commandName === 'setup-rank') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng.', ephemeral: true });
    const mode = interaction.options.getString('che_do', true);
    const soLuong = interaction.options.getInteger('so_luong');
    let note = '';
    if (soLuong) {
      const { created, capped, currentTotal, maxAllowed } = addRankRoomsToMode(mode, soLuong);
      if (created.length > 0) note += `\n✅ Tạo thêm **${created.length}** phòng rank: ${created.map((r) => `\`${r.id}\``).join(', ')} (tổng: **${currentTotal}/${maxAllowed}**).`;
      if (capped) note += `\n⚠️ Chỉ tạo được ${created.length} vì đã chạm giới hạn.`;
    }
    const roomsOfMode = getRankRoomsByMode(mode);
    if (roomsOfMode.length === 0) return interaction.reply({ content: `❌ Chế độ **${mode.toUpperCase()} Rank** chưa có phòng nào.`, ephemeral: true });
    await interaction.reply({ content: `✅ Đang đăng ${roomsOfMode.length} panel rank **${mode.toUpperCase()}**...${note}`, ephemeral: true });
    for (const room of roomsOfMode) { room.panelChannelId = null; room.panelMessageId = null; await renderRoom(room, interaction.channel); }
    persistence.saveState(rooms, eloData);
    return;
  }

  if (commandName === 'register-ign') {
    const ign = interaction.options.getString('ign', true).trim();
    if (ign.length < 2 || ign.length > 20) return interaction.reply({ content: '❌ Tên IGN phải từ 2-20 ký tự.', ephemeral: true });
    if (!/^[a-zA-Z0-9_\- ]+$/.test(ign)) return interaction.reply({ content: '❌ IGN chỉ được chứa chữ cái, số, gạch dưới, gạch ngang, khoảng trắng.', ephemeral: true });
    const result = registerIGN(interaction.user.id, ign);
    if (!result.ok) return interaction.reply({ content: `❌ ${result.reason}`, ephemeral: true });
    eloStore.upsertElo(interaction.user.id, getFullElo(interaction.user.id)).catch(() => {});
    persistence.saveState(rooms, eloData);

    const publicMsg = `📝 <@${interaction.user.id}> vừa đăng ký IGN thành công: **${ign}**`;
    if (ANNOUNCE_CHANNEL_ID) {
      const announceCh = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
      if (announceCh) announceCh.send(publicMsg).catch(() => {});
    }
    if (interaction.channel && interaction.channel.id !== ANNOUNCE_CHANNEL_ID) interaction.channel.send(publicMsg).catch(() => {});

    const adminPing = config.ADMIN_ROLE_ID ? `<@&${config.ADMIN_ROLE_ID}> ` : '';
    logAdmin(`${adminPing}📝 **Đăng ký IGN mới**\n• <@${interaction.user.id}> — \`${interaction.user.tag}\`\n• IGN: **${ign}**\n• <t:${Math.floor(Date.now()/1000)}:F>`).catch(() => {});

    return interaction.reply({ content: `✅ Đã đăng ký IGN thành công: **${ign}**`, ephemeral: true });
  }

  if (commandName === 'set-elo') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const targetUser = interaction.options.getUser('user', true);
    const mode = interaction.options.getString('che_do', true);
    const diem = interaction.options.getInteger('diem', true);
    const clamped = Math.max(0, Math.min(3000, diem));
    const data = updateElo(targetUser.id, mode, clamped);
    eloStore.upsertElo(targetUser.id, getFullElo(targetUser.id)).catch(() => {});
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã đặt ELO **${mode}** của <@${targetUser.id}> thành **${clamped}** (${data.rank}).`, ephemeral: true });
  }

  if (commandName === 'them-elo') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const targetUser = interaction.options.getUser('user', true);
    const mode = interaction.options.getString('che_do', true);
    const diem = interaction.options.getInteger('diem', true);
    const currentElo = getElo(targetUser.id, mode).elo ?? config.RANK_DEFAULT_ELO;
    const newElo = Math.max(0, Math.min(3000, currentElo + diem));
    const data = updateElo(targetUser.id, mode, newElo);
    eloStore.upsertElo(targetUser.id, getFullElo(targetUser.id)).catch(() => {});
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã ${diem >= 0 ? 'cộng' : 'trừ'} **${Math.abs(diem)}** ELO **${mode}** cho <@${targetUser.id}>. ${currentElo} → **${newElo}** (${data.rank}).`, ephemeral: true });
  }

  if (commandName === 'xoa-elo') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin mới dùng được.', ephemeral: true });
    const targetUser = interaction.options.getUser('user', true);
    const mode = interaction.options.getString('che_do');
    clearElo(targetUser.id, mode);
    eloStore.deleteElo(targetUser.id, mode).catch(() => {});
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: mode ? `✅ Đã xóa ELO **${mode}** của <@${targetUser.id}>.` : `✅ Đã xóa ELO **cả 2 chế độ** của <@${targetUser.id}>.`, ephemeral: true });
  }

  if (commandName === 'submit-result') {
    console.log(`✅ /submit-result từ ${interaction.user.tag}`);
    try { await interaction.deferReply({ ephemeral: true }); }
    catch (err) {
      try { await interaction.reply({ content: '⚠️ Bot quá tải.', ephemeral: true }); } catch (_) {}
      return;
    }

    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || !room.isRank) return interaction.editReply({ content: '❌ Phòng không phải rank.' });

    const session = rankSessions.getActiveSessionByRoomId(roomId);
    if (!session) return interaction.editReply({ content: '❌ Phiên đã hết hạn.' });
    if (!session.players.some(([id]) => id === interaction.user.id)) return interaction.editReply({ content: '❌ Bạn không ở trong phiên.' });
    if (session.resultMap.has(interaction.user.id)) return interaction.editReply({ content: 'ℹ️ Bạn đã gửi rồi.' });

    const attachment = interaction.options.getAttachment('hinhanh', true);
    if (!attachment || !attachment.contentType || !attachment.contentType.startsWith('image/')) return interaction.editReply({ content: '❌ File không phải ảnh.' });

    let imageBuffer;
    try { imageBuffer = await downloadImageBuffer(attachment.url); }
    catch (err) { return interaction.editReply({ content: '❌ Không tải được ảnh.' }); }
    const imageHash = hashImageBuffer(imageBuffer);
    const submitterIsAdmin = await isAdminUserId(interaction.user.id).catch(() => false);

    if (!submitterIsAdmin && isImageHashUsedRecently(imageHash, interaction.user.id)) {
      return interaction.editReply({ content: '❌ Ảnh này đã dùng trong 90 ngày qua.' });
    }

    if (config.LOG_CHANNEL_ID) {
      try {
        const logChannel = await client.channels.fetch(config.LOG_CHANNEL_ID);
        if (logChannel) {
          await logChannel.send({ content: `📸 **${interaction.user.tag}** gửi ảnh cho **${room.id}** (${room.label})`, files: [attachment.url] });
        }
      } catch (err) {}
    }

    if (!submitterIsAdmin) addImageHistory(imageHash, attachment.url, interaction.user.id, room.id);

    let ocrText = '';
    let overlayLines = [];
    try {
      const ocrResult = await ocrImageBuffer(imageBuffer);
      ocrText = ocrResult.text;
      overlayLines = ocrResult.overlayLines;
    } catch (err) {
      if (err.message === 'MISSING_OCR_API_KEY') return interaction.editReply({ content: '❌ Bot chưa có OCR key.' });
      return interaction.editReply({ content: '❌ Lỗi OCR.' });
    }
    if (!ocrText) return interaction.editReply({ content: '❌ Không đọc được ảnh.' });

    const fakeRoom = { players: new Map(session.players), code: session.code };
    const kdaMap = extractAllKDAResult(ocrText, fakeRoom, { skipCodeCheck: submitterIsAdmin, overlayLines });
    if (submitterIsAdmin) console.warn(`🧪 skipCodeCheck cho admin ${interaction.user.id}`);
    if (kdaMap.size === 0) return interaction.editReply({ content: '❌ Không tìm thấy KDA.' });

    const result = parseMatchResult(ocrText);
    if (!result) return interaction.editReply({ content: '❌ Không tìm thấy kết quả trận (Chiến thắng/Bại trận/VICTORY/DEFEAT).' });
    if (result === 'surrender') return interaction.editReply({ content: '⚠️ Trận này kết thúc bằng **ĐẦU HÀNG** — bot **không tính ELO**. Không cần làm gì thêm.' });

    const senderId = interaction.user.id;
    const senderKDA = kdaMap.get(senderId);
    if (!senderKDA) return interaction.editReply({ content: `⚠️ Không tìm thấy IGN của bạn trong ảnh. Đăng ký bằng \`/register-ign\`.` });

    const saved = rankSessions.addResult(session.id, senderId, {
      result,
      kill: senderKDA.kill, death: senderKDA.death, assist: senderKDA.assist,
      kda: senderKDA.death === 0 ? senderKDA.kill + senderKDA.assist : (senderKDA.kill + senderKDA.assist) / senderKDA.death,
      imageUrl: attachment.url,
    });
    if (!saved) return interaction.editReply({ content: '❌ Không lưu được kết quả.' });

    await finalizeRankSessionIfReady(session, room, roomId, kdaMap);
    persistence.saveState(rooms, eloData);
    return interaction.editReply({ content: `✅ Đã ghi nhận kết quả **${result === 'win' ? 'Thắng' : 'Thua'}**.` });
  }

  if (commandName === 'admin-submit-result') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const result = interaction.options.getString('ketqua', true);
    const kdaStr = interaction.options.getString('kda', true);
    const imageUrl = interaction.options.getString('hinhanh') || null;
    const room = getRoom(roomId);
    if (!room || !room.isRank) return interaction.reply({ content: '❌ Phòng không phải rank.', ephemeral: true });
    const session = rankSessions.getActiveSessionByRoomId(roomId);
    if (!session) return interaction.reply({ content: '❌ Phiên đã hết hạn.', ephemeral: true });
    if (!session.players.some(([id]) => id === targetUser.id)) return interaction.reply({ content: `❌ <@${targetUser.id}> không ở trong phiên.`, ephemeral: true });
    const parts = kdaStr.split('/').map(s => parseInt(s.trim(), 10));
    if (parts.length !== 3 || parts.some(isNaN)) return interaction.reply({ content: '❌ KDA phải dạng k/d/a.', ephemeral: true });
    const [kill, death, assist] = parts;
    const kda = death === 0 ? kill + assist : (kill + assist) / death;
    const saved = rankSessions.addResult(session.id, targetUser.id, { result, kill, death, assist, kda, imageUrl });
    if (!saved) return interaction.reply({ content: '❌ Không lưu được.', ephemeral: true });
    await finalizeRankSessionIfReady(session, room, roomId, null);
    return interaction.reply({ content: `✅ Ghi nhận **${result === 'win' ? 'Thắng' : 'Thua'}** cho <@${targetUser.id}>, KDA ${kill}/${death}/${assist}.`, ephemeral: true });
  }

  if (commandName === 'xoa-phong-rank') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || !room.isRank) return interaction.reply({ content: `❌ Không tìm thấy phòng rank "${roomId}".`, ephemeral: true });
    if (room.panelChannelId && room.panelMessageId) {
      const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
      if (ch) { const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null); if (msg) await msg.delete().catch(() => {}); }
    }
    const result = removeRankRoom(roomId);
    if (!result.ok) return interaction.reply({ content: `❌ ${result.reason}`, ephemeral: true });
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã xóa **${result.room.label}**.`, ephemeral: true });
  }

  if (commandName === 'xoa-tat-ca-phong-rank') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const mode = interaction.options.getString('che_do');
    const targetRooms = mode ? getRankRoomsByMode(mode) : getAllRankRooms();
    if (targetRooms.length === 0) return interaction.reply({ content: 'ℹ️ Không có phòng rank.', ephemeral: true });
    await interaction.reply({ content: `🗑️ Đang xóa ${targetRooms.length} phòng rank...`, ephemeral: true });
    for (const room of targetRooms) {
      if (room.panelChannelId && room.panelMessageId) {
        const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
        if (ch) { const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null); if (msg) await msg.delete().catch(() => {}); }
      }
      clearRoomTimers(room); resetRoomWithCleanup(room); rooms.delete(room.id);
    }
    persistence.saveState(rooms, eloData);
    return interaction.followUp({ content: `✅ Đã xóa ${targetRooms.length} phòng rank.`, ephemeral: true });
  }

  if (commandName === 'test-fill') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || room.isRank) return interaction.reply({ content: `❌ Không tìm thấy phòng thường "${roomId}".`, ephemeral: true });
    if (room.status === 'revealed') return interaction.reply({ content: '❌ Phòng đã phát code.', ephemeral: true });
    const soNguoiInput = interaction.options.getInteger('so_nguoi');
    const cho_trong = room.capacity - room.players.size;
    const needed = Math.max(0, Math.min(soNguoiInput ?? cho_trong, cho_trong));
    if (needed <= 0) return interaction.reply({ content: 'ℹ️ Phòng đã đủ.', ephemeral: true });
    const wasEmpty = room.players.size === 0;
    for (let i = 1; i <= needed; i++) {
      const fakeId = `9${Date.now()}${i}`.slice(0, 18);
      room.players.set(fakeId, { username: `TestBot${i}`, team: null, ready: true, isBot: true });
    }
    const channel = interaction.channel;
    if (wasEmpty) { room.firstJoinAt = Date.now(); scheduleInactivityTimeout(room, channel); }
    await renderRoom(room, channel);
    if (isFull(room)) { await announceRoomFull(room, channel); scheduleReadyCountdown(room, channel); await tryRevealCode(room, channel); }
    return interaction.reply({ content: `✅ Đã thêm **${needed}** người giả vào **${room.label}**.`, ephemeral: true });
  }

  if (commandName === 'test-fill-rank') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || !room.isRank) return interaction.reply({ content: `❌ Không tìm thấy phòng rank "${roomId}".`, ephemeral: true });
    if (room.status === 'revealed') return interaction.reply({ content: '❌ Phòng đã phát code.', ephemeral: true });
    const soNguoiInput = interaction.options.getInteger('so_nguoi');
    const cho_trong = room.capacity - room.players.size;
    const needed = Math.max(0, Math.min(soNguoiInput ?? cho_trong, cho_trong));
    if (needed <= 0) return interaction.reply({ content: 'ℹ️ Phòng đã đủ.', ephemeral: true });
    const wasEmpty = room.players.size === 0;
    for (let i = 1; i <= needed; i++) {
      const fakeId = `9${Date.now()}${i}`.slice(0, 18);
      room.players.set(fakeId, { username: `TestBot${i}`, team: null, ready: true, isBot: true });
    }
    // Phòng rank: ghép lại team theo ELO (bot dùng ELO mặc định).
    autoBalanceRankTeams(room);
    const channel = interaction.channel;
    if (wasEmpty) { room.firstJoinAt = Date.now(); scheduleInactivityTimeout(room, channel); }
    await renderRoom(room, channel);
    if (isFull(room)) { await announceRoomFull(room, channel); scheduleReadyCountdown(room, channel); await tryRevealCode(room, channel); }
    return interaction.reply({ content: `✅ Đã thêm **${needed}** người giả vào **${room.label}** (rank).`, ephemeral: true });
  }

  if (commandName === 'test-fill-an') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getHiddenRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng ẩn "${roomId}".`, ephemeral: true });
    if (room.status === 'revealed') return interaction.reply({ content: '❌ Phòng đã phát code.', ephemeral: true });
    const soNguoiInput = interaction.options.getInteger('so_nguoi');
    const cho_trong = room.capacity - room.players.size;
    const needed = Math.max(0, Math.min(soNguoiInput ?? cho_trong, cho_trong));
    if (needed <= 0) return interaction.reply({ content: 'ℹ️ Phòng đã đủ.', ephemeral: true });
    const wasEmpty = room.players.size === 0;
    for (let i = 1; i <= needed; i++) {
      const fakeId = `9${Date.now()}${i}`.slice(0, 18);
      room.players.set(fakeId, { username: `TestBot${i}`, team: null, ready: true, isBot: true });
    }
    if (room.isRank) autoBalanceRankTeams(room);
    const channel = interaction.channel;
    if (wasEmpty) { room.firstJoinAt = Date.now(); scheduleInactivityTimeout(room, channel); }
    await renderRoom(room, channel);
    if (isFull(room)) { await announceRoomFull(room, channel); scheduleReadyCountdown(room, channel); await tryRevealCode(room, channel); }
    return interaction.reply({ content: `✅ Đã thêm **${needed}** người giả vào **${room.label}** (ẩn).`, ephemeral: true });
  }

  if (commandName === 'xoa-setup-phong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const mode = interaction.options.getString('che_do');
    const targetRooms = mode ? getNormalRoomsByMode(mode) : getAllNormalRooms();
    await interaction.reply({ content: `🗑️ Đang xóa panel ${targetRooms.length} phòng thường...`, ephemeral: true });
    let deletedCount = 0;
    for (const room of targetRooms) {
      if (room.panelChannelId && room.panelMessageId) {
        const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
        if (ch) {
          const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null);
          if (msg) { await msg.delete().catch(() => {}); deletedCount++; }
        }
      }
      resetRoomWithCleanup(room); room.panelChannelId = null; room.panelMessageId = null;
    }
    persistence.saveState(rooms, eloData);
    return interaction.followUp({ content: `✅ Đã xóa **${deletedCount}** panel, reset **${targetRooms.length}** phòng.`, ephemeral: true });
  }

  if (commandName === 'don-rac') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const soLuong = interaction.options.getInteger('so_luong') || 50;
    const channel = interaction.channel;
    await interaction.reply({ content: `🧹 Đang dọn tối đa ${soLuong} tin nhắn...`, ephemeral: true });
    try {
      const protectedPanelIds = new Set(getAllRooms().filter((r) => r.panelChannelId === channel.id && r.panelMessageId).map((r) => r.panelMessageId));
      const batch = await channel.messages.fetch({ limit: soLuong });
      const toDelete = batch.filter((m) => !protectedPanelIds.has(m.id));
      const skippedPanels = batch.size - toDelete.size;
      let deletedCount = 0;
      if (toDelete.size === 1) { await toDelete.first().delete().catch(() => {}); deletedCount = 1; }
      else if (toDelete.size > 1) { const deleted = await channel.bulkDelete(toDelete, true); deletedCount = deleted.size; }
      return interaction.followUp({ content: `✅ Đã xóa **${deletedCount}** tin nhắn.` + (skippedPanels > 0 ? `\n🛡️ Bỏ qua **${skippedPanels}** panel.` : ''), ephemeral: true });
    } catch (err) {
      return interaction.followUp({ content: '⚠️ Không xóa được.', ephemeral: true });
    }
  }

  if (commandName === 'xoa-tin-nhan-bot') {
    const allowed = await isAdminAnywhere(interaction);
    if (!allowed) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const soLuong = interaction.options.getInteger('so_luong');
    const channel = interaction.channel;
    const isDM = !interaction.guild;
    const noiChung = isDM ? 'trong DM này' : 'trong kênh này';
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
    const protectedPanelIds = isDM ? new Set() : new Set(getAllRooms().filter((r) => r.panelChannelId === channel.id && r.panelMessageId).map((r) => r.panelMessageId));
    let skippedPanels = 0;
    await interaction.reply({ content: soLuong ? `🧹 Đang xóa tối đa **${soLuong}** tin Bot ${noiChung}...` : `🧹 Đang xóa TẤT CẢ tin Bot ${noiChung}...`, ephemeral: true });
    let totalDeleted = 0, lastId;
    try {
      while (true) {
        if (soLuong && totalDeleted >= soLuong) break;
        const batch = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
        if (batch.size === 0) break;
        lastId = batch.last().id;
        let botMsgs = Array.from(batch.filter((m) => m.author.id === client.user.id).values());
        const beforePanelFilter = botMsgs.length;
        botMsgs = botMsgs.filter((m) => !protectedPanelIds.has(m.id));
        skippedPanels += beforePanelFilter - botMsgs.length;
        if (soLuong && botMsgs.length > soLuong - totalDeleted) botMsgs = botMsgs.slice(0, soLuong - totalDeleted);
        if (botMsgs.length > 0) {
          if (isDM) { for (const msg of botMsgs) { await msg.delete().catch(() => {}); totalDeleted += 1; await new Promise((r) => setTimeout(r, 350)); } }
          else {
            const now = Date.now();
            const recent = botMsgs.filter((m) => now - m.createdTimestamp < TWO_WEEKS_MS);
            const old = botMsgs.filter((m) => now - m.createdTimestamp >= TWO_WEEKS_MS);
            if (recent.length === 1) { await recent[0].delete().catch(() => {}); totalDeleted += 1; }
            else if (recent.length > 1) { const deleted = await channel.bulkDelete(recent, true).catch(() => new Map()); totalDeleted += deleted.size; }
            for (const msg of old) { await msg.delete().catch(() => {}); totalDeleted += 1; }
          }
        }
        if (batch.size < 100) break;
      }
    } catch (err) { console.error('Lỗi xoa-tin-nhan-bot:', err); }
    return interaction.followUp({ content: `✅ Đã xóa **${totalDeleted}** tin Bot ${noiChung}.` + (skippedPanels > 0 ? `\n🛡️ Bỏ qua **${skippedPanels}** panel.` : ''), ephemeral: true });
  }

  if (commandName === 'xoa-phong-thuong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || room.hidden) return interaction.reply({ content: `❌ Không tìm thấy phòng thường "${roomId}".`, ephemeral: true });
    if (room.panelChannelId && room.panelMessageId) {
      const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
      if (ch) { const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null); if (msg) await msg.delete().catch(() => {}); }
    }
    const result = removeExtraRoom(roomId);
    if (!result.ok) {
      if (result.reason === 'protected') return interaction.reply({ content: `❌ **${room.label}** là phòng gốc, không xóa được — dùng /reset-room.`, ephemeral: true });
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã xóa **${result.room.label}**.`, ephemeral: true });
  }

  if (commandName === 'xoa-tat-ca-phong-thuong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const mode = interaction.options.getString('che_do');
    const targetRooms = mode ? getNormalRoomsByMode(mode) : getAllNormalRooms();
    if (targetRooms.length === 0) return interaction.reply({ content: mode ? `ℹ️ Không có phòng thường ${mode.toUpperCase()}.` : 'ℹ️ Không có phòng thường.', ephemeral: true });
    await interaction.reply({ content: `🗑️ Đang xóa **${targetRooms.length}** phòng thường...`, ephemeral: true });
    let deletedCount = 0;
    for (const room of targetRooms) {
      if (room.panelChannelId && room.panelMessageId) {
        const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
        if (ch) { const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null); if (msg) await msg.delete().catch(() => {}); }
      }
      clearRoomTimers(room); resetRoomWithCleanup(room); rooms.delete(room.id); deletedCount += 1;
    }
    persistence.saveState(rooms, eloData);
    return interaction.followUp({ content: `✅ Đã xóa hẳn **${deletedCount}** phòng thường${mode ? ` (${mode.toUpperCase()})` : ''}.`, ephemeral: true });
  }

  if (commandName === 'reset-tat-ca-phong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const allRoomsNow = getAllNormalRooms();
    await interaction.reply({ content: `♻️ Đang reset ${allRoomsNow.length} phòng thường...`, ephemeral: true });
    for (const room of allRoomsNow) {
      resetRoomWithCleanup(room);
      const channel = (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) || interaction.channel;
      await renderRoom(room, channel);
    }
    persistence.saveState(rooms, eloData);
    return interaction.followUp({ content: `✅ Đã reset ${allRoomsNow.length} phòng thường.`, ephemeral: true });
  }

  if (commandName === 'reset-room') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    resetRoomWithCleanup(room);
    const channel = (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) || interaction.channel;
    await renderRoom(room, channel);
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã ép reset **${room.label}**.`, ephemeral: true });
  }
}

// ===== MODAL SUBMIT =====
async function handleModalSubmit(interaction) {
  if (!interaction.customId.startsWith('submitresult_')) return;
  const roomId = interaction.customId.replace('submitresult_', '');
  const room = getRoom(roomId);
  if (!room || !room.isRank) {
    try { return await interaction.reply({ content: '❌ Phòng không phải rank.', ephemeral: true }); } catch (e) { return; }
  }
  const imageUrl = interaction.fields.getTextInputValue('image');
  if (!imageUrl) { try { return await interaction.reply({ content: '❌ Chưa nhập link ảnh.', ephemeral: true }); } catch (e) { return; } }

  try { await interaction.deferReply({ ephemeral: true }); }
  catch (err) { return; }

  let imageBuffer;
  try { imageBuffer = await downloadImageBuffer(imageUrl); }
  catch (err) { return interaction.editReply({ content: '❌ Không tải được ảnh.' }); }
  const imageHash = hashImageBuffer(imageBuffer);
  const submitterIsAdmin = await isAdminUserId(interaction.user.id).catch(() => false);

  if (!submitterIsAdmin && isImageHashUsedRecently(imageHash, interaction.user.id)) {
    return interaction.editReply({ content: '❌ Ảnh này đã dùng trong 90 ngày qua.' });
  }

  if (config.LOG_CHANNEL_ID) {
    try {
      const logChannel = await client.channels.fetch(config.LOG_CHANNEL_ID);
      if (logChannel) await logChannel.send({ content: `📸 **${interaction.user.tag}** gửi ảnh qua modal cho **${room.id}**`, files: [imageUrl] });
    } catch (err) {}
  }
  if (!submitterIsAdmin) addImageHistory(imageHash, imageUrl, interaction.user.id, room.id);

  let ocrText = '';
  let overlayLines = [];
  try {
    const ocrResult = await ocrImageBuffer(imageBuffer);
    ocrText = ocrResult.text;
    overlayLines = ocrResult.overlayLines;
  } catch (err) {
    if (err.message === 'MISSING_OCR_API_KEY') return interaction.editReply({ content: '❌ Bot chưa có OCR key.' });
    return interaction.editReply({ content: '❌ Lỗi OCR.' });
  }
  if (!ocrText) return interaction.editReply({ content: '❌ Không đọc được ảnh.' });

  const session = rankSessions.getActiveSessionByRoomId(roomId);
  if (!session) return interaction.editReply({ content: '❌ Phiên đã hết hạn.' });

  const fakeRoom = { players: new Map(session.players), code: session.code };
  const kdaMap = extractAllKDAResult(ocrText, fakeRoom, { skipCodeCheck: submitterIsAdmin, overlayLines });
  if (kdaMap.size === 0) return interaction.editReply({ content: '❌ Không tìm thấy KDA.' });

  const result = parseMatchResult(ocrText);
  if (!result) return interaction.editReply({ content: '❌ Không tìm thấy kết quả trận.' });
  if (result === 'surrender') return interaction.editReply({ content: '⚠️ Trận này kết thúc bằng **ĐẦU HÀNG** — bot **không tính ELO**. Không cần làm gì thêm.' });

  const senderId = interaction.user.id;
  const senderKDA = kdaMap.get(senderId);
  if (!senderKDA) return interaction.editReply({ content: `⚠️ Không tìm thấy IGN của bạn trong ảnh.` });

  const saved = rankSessions.addResult(session.id, senderId, {
    result, kill: senderKDA.kill, death: senderKDA.death, assist: senderKDA.assist,
    kda: senderKDA.death === 0 ? senderKDA.kill + senderKDA.assist : (senderKDA.kill + senderKDA.assist) / senderKDA.death,
    imageUrl,
  });
  if (!saved) return interaction.editReply({ content: '❌ Không lưu được.' });

  await finalizeRankSessionIfReady(session, room, roomId, kdaMap);
  persistence.saveState(rooms, eloData);
  await interaction.editReply({ content: `✅ Đã ghi nhận kết quả **${result === 'win' ? 'Thắng' : 'Thua'}**.` });
}

// ===== BUTTON =====
async function handleButton(interaction) {
  const { customId } = interaction;

  if (customId === 'menu_3v3' || customId === 'menu_5v5') {
    const mode = customId.split('_')[1];
    const roomsOfMode = getRoomsByMode(mode);
    if (roomsOfMode.length === 0) return interaction.reply({ content: t(interaction, `⚠️ Chưa có phòng **${mode.toUpperCase()}**.`, `⚠️ No **${mode.toUpperCase()}** rooms.`), ephemeral: true });
    return interaction.reply({ content: t(interaction, `Chọn 1 trong ${roomsOfMode.length} phòng **${mode.toUpperCase()}**:`, `Pick a **${mode.toUpperCase()}** room:`), components: roomListRows(roomsOfMode), ephemeral: true });
  }
  if (customId.startsWith('openroom_')) return joinRoom(interaction, customId.replace('openroom_', ''));
  if (customId.startsWith('join_')) return joinRoom(interaction, customId.replace('join_', ''));
  if (customId.startsWith('leave_')) return leaveRoom(interaction, customId.replace('leave_', ''));
  if (customId.startsWith('ready_')) return toggleReady(interaction, customId.replace('ready_', ''));
  if (customId.startsWith('team1_') || customId.startsWith('team2_') || customId.startsWith('teamnone_')) {
    const [tag, roomId] = splitTeamCustomId(customId);
    return setTeam(interaction, roomId, tag);
  }
  if (customId.startsWith('copycode_')) return giveCode(interaction, customId.replace('copycode_', ''));
  if (customId.startsWith('translate_')) {
    const roomId = customId.replace('translate_', '');
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ Room not found.'), ephemeral: true });
    return interaction.reply({ content: '🌐 English buttons:', components: roomActionRowsEN(room), ephemeral: true });
  }
  if (customId.startsWith('hiddeninvitebtn_')) {
    const roomId = customId.replace('hiddeninvitebtn_', '');
    const room = getHiddenRoom(roomId);
    if (!room) return interaction.reply({ content: '❌ Phòng ẩn không tồn tại.', ephemeral: true });
    const isAdminNow = await isAdminUserId(interaction.user.id);
    if (!isAdminNow) return interaction.reply({ content: '❌ Chỉ admin mới mời được.', ephemeral: true });
    if (!interaction.guild) return interaction.reply({ content: `⚠️ Vào kênh server dùng \`/moi-phong-an phong:${room.id}\`.`, ephemeral: true });
    const select = new UserSelectMenuBuilder().setCustomId(`hiddeninvite_${room.id}`).setPlaceholder(`Chọn người mời vào ${room.label}`).setMinValues(1).setMaxValues(25);
    return interaction.reply({ content: `📨 Chọn người mời vào **${room.label}**:`, components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
  }
  if (customId.startsWith('invite_')) {
    const roomId = customId.replace('invite_', '');
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ Room not found.'), ephemeral: true });
    if (room.status === 'revealed') return interaction.reply({ content: t(interaction, '❌ Phòng đã phát code.', '❌ Code revealed.'), ephemeral: true });
    if (isFull(room)) return interaction.reply({ content: t(interaction, '❌ Phòng đã đầy.', '❌ Room full.'), ephemeral: true });
    const select = new UserSelectMenuBuilder().setCustomId(`inviteselect_${room.id}`).setPlaceholder(t(interaction, 'Chọn bạn muốn mời', 'Pick friends')).setMinValues(1).setMaxValues(25);
    return interaction.reply({ content: t(interaction, `📨 Chọn người mời vào **${room.label}**:`, `📨 Invite to **${room.label}**:`), components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
  }
  if (customId.startsWith('submit_result_')) {
    const roomId = customId.replace('submit_result_', '');
    const room = getRoom(roomId);
    if (!room || !room.isRank) return interaction.reply({ content: '❌ Phòng không phải rank.', ephemeral: true });
    const session = rankSessions.getActiveSessionByRoomId(roomId);
    if (!session) return interaction.reply({ content: '❌ Phiên đã hết hạn.', ephemeral: true });
    if (!session.players.some(([id]) => id === interaction.user.id)) return interaction.reply({ content: '❌ Bạn không ở trong phiên.', ephemeral: true });
    if (session.resultMap.has(interaction.user.id)) return interaction.reply({ content: 'ℹ️ Bạn đã gửi rồi.', ephemeral: true });
    return interaction.reply({
      content: `📷 **Gửi kết quả**\nDùng lệnh kèm ảnh:\n\`\`\`/submit-result phong:${room.id}\`\`\`\nNhấp vào ô **"hinhanh"** và chọn ảnh.`,
      ephemeral: true,
    });
  }
}

// ===== USER SELECT MENU =====
async function handleUserSelectMenu(interaction) {
  const { customId } = interaction;
  if (customId.startsWith('hiddeninvite_')) {
    const roomId = customId.replace('hiddeninvite_', '');
    const room = getHiddenRoom(roomId);
    if (!room) return interaction.update({ content: '❌ Phòng ẩn không tồn tại.', components: [] });
    const isAdminNow = await isAdminUserId(interaction.user.id);
    if (!isAdminNow) return interaction.update({ content: '❌ Chỉ admin.', components: [] });
    const targets = interaction.users;
    if (!targets || targets.size === 0) return interaction.update({ content: '❌ Chưa chọn ai.', components: [] });
    const invited = [], failed = [];
    for (const targetUser of targets.values()) {
      const already = room.panelTargets.some((t) => t.userId === targetUser.id);
      if (already) { invited.push(targetUser.id); continue; }
      try {
        await sendHiddenRoomDM(room, targetUser, `📨 Bạn được mời riêng vào phòng ẩn: **${room.label}**.`);
        invited.push(targetUser.id);
      } catch (err) { failed.push(targetUser.id); }
    }
    let summary = invited.length ? `✅ Đã mời ${invited.length} người: ${invited.map((id) => `<@${id}>`).join(' ')}.` : '';
    if (failed.length) summary += `${summary ? '\n' : ''}⚠️ Không DM được: ${failed.map((id) => `<@${id}>`).join(' ')}.`;
    return interaction.update({ content: summary || '❌ Không mời được ai.', components: [] });
  }

  if (!customId.startsWith('inviteselect_')) return;
  const roomId = customId.replace('inviteselect_', '');
  const room = getRoom(roomId);
  if (!room) return interaction.update({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ Room not found.'), components: [] });
  const targets = interaction.users;
  if (!targets || targets.size === 0) return interaction.update({ content: t(interaction, '❌ Chưa chọn ai.', "❌ Nobody picked."), components: [] });
  if (room.status === 'revealed') return interaction.update({ content: t(interaction, '❌ Phòng đã phát code.', '❌ Code revealed.'), components: [] });
  if (isFull(room)) return interaction.update({ content: t(interaction, '❌ Phòng đã đầy.', '❌ Room full.'), components: [] });

  const invitedIds = [], skipped = [];
  for (const targetUser of targets.values()) {
    if (targetUser.id === interaction.user.id) { skipped.push(t(interaction, `<@${targetUser.id}> (chính bạn)`, `<@${targetUser.id}> (yourself)`)); continue; }
    if (isBanned(room, targetUser.id)) { skipped.push(t(interaction, `<@${targetUser.id}> (bị cấm)`, `<@${targetUser.id}> (banned)`)); continue; }
    invitedIds.push(targetUser.id);
  }
  if (invitedIds.length === 0) return interaction.update({ content: t(interaction, '❌ Không mời được ai.', '❌ Could not invite.') + (skipped.length ? `\n${t(interaction, 'Bỏ qua', 'Skipped')}: ${skipped.join(', ')}` : ''), components: [] });

  const joinRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`join_${room.id}`).setLabel('Tham gia ngay').setStyle(ButtonStyle.Success).setEmoji('➕')
  );
  const mentionList = invitedIds.map((id) => `<@${id}>`).join(' ');
  await interaction.channel.send({
    content: t(interaction,
      `📨 <@${interaction.user.id}> mời ${mentionList} vào **${room.label}** (${room.players.size}/${room.capacity})!`,
      `📨 <@${interaction.user.id}> invited ${mentionList} to **${room.label}**!`
    ),
    components: [joinRow],
  });
  let summary = t(interaction, `✅ Đã mời **${invitedIds.length}** người.`, `✅ Invited **${invitedIds.length}** people.`);
  if (skipped.length) summary += `\n⚠️ ${t(interaction, 'Bỏ qua', 'Skipped')}: ${skipped.join(', ')}`;
  return interaction.update({ content: summary, components: [] });
}

// ===== HELPERS =====
async function sendHiddenRoomDM(room, targetUser, introText) {
  const dm = await targetUser.createDM();
  const embed = roomEmbed(room);
  const rowsUi = roomActionRows(room);
  const sent = await dm.send({ content: introText, embeds: [embed], components: rowsUi });
  room.panelTargets.push({ userId: targetUser.id, channelId: dm.id, messageId: sent.id });
  return sent;
}

function splitTeamCustomId(customId) {
  if (customId.startsWith('team1_')) return [1, customId.replace('team1_', '')];
  if (customId.startsWith('team2_')) return [2, customId.replace('team2_', '')];
  return [null, customId.replace('teamnone_', '')];
}

async function joinRoom(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ Room not found.'), ephemeral: true });
  if (isBanned(room, interaction.user.id)) return interaction.reply({ content: t(interaction, `❌ Bạn bị cấm khỏi **${room.label}**.`, `❌ You're banned from **${room.label}**.`), ephemeral: true });
  if (interaction.member && config.JOIN_ROLE_ID && !interaction.member.roles?.cache?.has(config.JOIN_ROLE_ID)) {
    return interaction.reply({ content: t(interaction, `❌ Cần role <@&${config.JOIN_ROLE_ID}>.`, `❌ Need <@&${config.JOIN_ROLE_ID}> role.`), ephemeral: true });
  }
  const existing = findRoomOfUser(interaction.user.id);
  if (existing && existing.id !== room.id) return interaction.reply({ content: t(interaction, `⚠️ Bạn đang ở **${existing.label}**.`, `⚠️ You're in **${existing.label}**.`), ephemeral: true });
  if (existing && existing.id === room.id) return interaction.reply({ content: t(interaction, 'ℹ️ Bạn đã ở trong phòng này.', 'ℹ️ Already in room.'), ephemeral: true });
  if (isFull(room)) return interaction.reply({ content: t(interaction, '❌ Phòng đã đầy.', '❌ Room full.'), ephemeral: true });
  if (room.status === 'revealed') return interaction.reply({ content: t(interaction, '❌ Phòng đã bắt đầu.', '❌ Room started.'), ephemeral: true });

  const wasEmpty = room.players.size === 0;
  room.players.set(interaction.user.id, {
    username: interaction.member?.displayName || interaction.user.username,
    team: null,
    ready: false,
  });
  // ✅ Phòng rank: tự động ghép lại team theo ELO mỗi khi có người join.
  // Điều này giúp team luôn cân bằng theo ELO hiện tại (thay vì để user
  // tự chọn Team 1 / Team 2 / Bỏ team như phòng thường).
  if (room.isRank) {
    autoBalanceRankTeams(room);
  }
  const channel = interaction.channel;
  if (wasEmpty) { room.firstJoinAt = Date.now(); scheduleInactivityTimeout(room, channel); }
  await renderRoom(room, channel);
  if (['3v3', '5v5'].includes(room.mode) && !room.isRank) startAnnouncement(room);
  if (isFull(room)) { await announceRoomFull(room, channel); scheduleReadyCountdown(room, channel); }
  return interaction.reply({ content: t(interaction, `✅ Đã gia nhập **${room.label}**.`, `✅ Joined **${room.label}**.`), ephemeral: true });
}

async function leaveRoom(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ Room not found.'), ephemeral: true });
  if (!room.players.has(interaction.user.id)) return interaction.reply({ content: t(interaction, 'ℹ️ Bạn không ở trong phòng.', 'ℹ️ Not in room.'), ephemeral: true });
  if (room.status === 'revealed') return interaction.reply({ content: t(interaction, '❌ Phòng đã phát code, không thể rời.', '❌ Code revealed, cannot leave.'), ephemeral: true });

  room.players.delete(interaction.user.id);
  // ✅ Phòng rank: ghép lại team theo ELO cho những người còn lại.
  if (room.isRank && room.players.size > 0) {
    autoBalanceRankTeams(room);
  }
  const channel = interaction.channel;
  if (room.timers.readyCountdown && !isFull(room)) {
    clearTimeout(room.timers.readyCountdown); room.timers.readyCountdown = null; room.fullAt = null;
    if (room.timers.blink) { clearInterval(room.timers.blink); room.timers.blink = null; room._flashColor = null; }
  }
  if (room.players.size === 0) { stopAnnouncement(room); resetRoomWithCleanup(room); }
  await renderRoom(room, channel);
  return interaction.reply({ content: t(interaction, `✅ Đã rời **${room.label}**.`, `✅ Left **${room.label}**.`), ephemeral: true });
}

async function toggleReady(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ Room not found.'), ephemeral: true });
  const player = room.players.get(interaction.user.id);
  if (!player) return interaction.reply({ content: t(interaction, '⚠️ Cần Gia nhập trước.', '⚠️ Join first.'), ephemeral: true });
  if (room.status === 'revealed') return interaction.reply({ content: t(interaction, 'ℹ️ Đã phát code.', 'ℹ️ Code revealed.'), ephemeral: true });
  if (!isFull(room)) return interaction.reply({ content: t(interaction, `⚠️ Chưa đủ người (${room.players.size}/${room.capacity}).`, `⚠️ Not full yet (${room.players.size}/${room.capacity}).`), ephemeral: true });
  if (!checkCooldown(interaction.user.id)) return interaction.reply({ content: t(interaction, '⏳ Đợi 1-2 giây.', '⏳ Wait 1-2 seconds.'), ephemeral: true });

  // ✅ Ack ngay trong 3s đầu tiên, TRƯỚC khi làm renderRoom/tryRevealCode —
  // 2 hàm này có thể gọi nhiều API Discord/Supabase liên tiếp (edit panel,
  // channel.send, logAdmin, tạo rank session, gửi kênh kết quả...), cộng dồn
  // dễ vượt 3s -> interaction.reply() cuối cùng bị Discord từ chối với lỗi
  // "Unknown interaction" (10062) vì token đã hết hạn. Defer trước rồi
  // editReply sau thì có tới 15 phút để hoàn tất, không còn bị lỗi này.
  try { await interaction.deferReply({ ephemeral: true }); }
  catch (err) {
    console.error('❗ toggleReady: deferReply thất bại (token có thể đã hết hạn):', err.message);
    return;
  }

  player.ready = !player.ready;
  const channel = interaction.channel;
  await renderRoom(room, channel);
  await tryRevealCode(room, channel);
  let extra = t(interaction, '', '');
  if (room.status === 'waiting' && isFull(room) && allReady(room)) extra = t(interaction, '\n⚖️ Team chưa cân bằng.', "\n⚖️ Teams aren't balanced.");
  return interaction.editReply({ content: t(interaction, player.ready ? '✅ Bạn đã sẵn sàng.' : '↩️ Bạn bỏ sẵn sàng.', player.ready ? '✅ Ready.' : '↩️ No longer ready.') + extra }).catch((err) => {
    console.error('❗ toggleReady: editReply thất bại:', err.message);
  });
}

async function setTeam(interaction, roomId, team) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ Room not found.'), ephemeral: true });

  // ✅ Phòng RANK: hệ thống tự ghép team cân bằng theo ELO. Non-admin
  // KHÔNG được phép đổi team bằng tay; chỉ admin mới override được.
  if (room.isRank) {
    const allowed = await isAdminAnywhere(interaction);
    if (!allowed) {
      return interaction.reply({
        content: t(interaction,
          '🔒 **Phòng Rank tự động ghép team cân bằng theo ELO.**\n' +
          'Bạn không cần (và không thể) chọn team bằng tay.\n' +
          'Chỉ **admin** mới đổi team thủ công khi cần.',
          '🔒 **Rank rooms auto-balance teams by ELO.**\n' +
          'You don\'t need (and can\'t) pick a team manually.\n' +
          'Only **admins** can override teams.'),
        ephemeral: true,
      });
    }
  }

  const player = room.players.get(interaction.user.id);
  if (!player) return interaction.reply({ content: t(interaction, '⚠️ Cần Gia nhập trước.', '⚠️ Join first.'), ephemeral: true });
  if (room.status === 'revealed') return interaction.reply({ content: t(interaction, 'ℹ️ Đã phát code, không đổi team.', 'ℹ️ Code revealed, cannot change team.'), ephemeral: true });
  if (!checkCooldown(interaction.user.id)) return interaction.reply({ content: t(interaction, '⏳ Đợi 1-2 giây.', '⏳ Wait 1-2 seconds.'), ephemeral: true });

  // ✅ Cùng lý do như toggleReady(): defer trước khi làm renderRoom/tryRevealCode
  // để tránh lỗi "Unknown interaction" (10062) nếu chọn team này vừa khớp làm
  // team cân bằng -> kích hoạt phát code (chuỗi việc tốn thời gian).
  try { await interaction.deferReply({ ephemeral: true }); }
  catch (err) {
    console.error('❗ setTeam: deferReply thất bại (token có thể đã hết hạn):', err.message);
    return;
  }

  player.team = team;
  const channel = interaction.channel;
  await renderRoom(room, channel);
  await tryRevealCode(room, channel);
  return interaction.editReply({ content: team ? t(interaction, `✅ Đã chọn **Team ${team}**.`, `✅ Picked **Team ${team}**.`) : t(interaction, '✅ Bỏ chọn team.', '✅ Cleared team.') }).catch((err) => {
    console.error('❗ setTeam: editReply thất bại:', err.message);
  });
}

async function giveCode(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ Room not found.'), ephemeral: true });
  if (room.status !== 'revealed' || !room.code) return interaction.reply({ content: t(interaction, 'ℹ️ Chưa có code.', 'ℹ️ No code yet.'), ephemeral: true });
  const personal = formatPersonalCode(room, interaction.user.id);
  if (!personal) return interaction.reply({ content: t(interaction, '⚠️ Bạn không ở trong phòng.', '⚠️ Not in room.'), ephemeral: true });
  await interaction.reply({ content: t(interaction, '🔑 Code của bạn (bấm giữ để copy):', '🔑 Your code (tap and hold to copy):'), ephemeral: true });
  return interaction.followUp({ content: personal, ephemeral: true });
}

// ===== KEEP-ALIVE + BOOTSTRAP =====
startKeepAliveServer();
startSelfPing();

async function bootstrap() {
  initRooms();
  const rankDefault = config.DEFAULT_RANK_ROOMS_PER_MODE || 0;
  if (rankDefault > 0) {
    for (const mode of Object.keys(config.CAPACITY)) addRankRoomsToMode(mode, rankDefault);
  }
  console.log(`ℹ️ Đã khởi tạo ${rooms.size} phòng.`);

  const eloMap = await eloStore.loadAllElo();
  if (eloStore.isEnabled()) {
    console.log(`✅ Đã kết nối Supabase (${eloMap.size} người có ELO).`);
    if (eloMap.size > 0) restoreEloData(eloMap);
  } else {
    console.warn('⚠️ Supabase chưa cấu hình.');
  }

  await client.login(config.TOKEN);
  console.log(`=== BOT DISCORD ĐÃ ONLINE THÀNH CÔNG: ${client.user.tag} ===`);
}

bootstrap().catch((err) => console.error('=== LỖI KHỞI ĐỘNG BOT ===', err));

process.on('unhandledRejection', (err) => {
  console.error('=== UNHANDLED REJECTION ===', err);
});