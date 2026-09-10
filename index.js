// Fix: ưu tiên IPv4
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
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
  // Rank exports
  eloData,
  getElo,
  updateElo,
  calculateNewElo,
  registerIGN,
  addRankRoomsToMode,
  removeRankRoom,
  getAllRankRooms,
  getRankRoomsByMode,
  // Filter functions
  getAllNormalRooms,
  getNormalRoomsByMode,
  // OCR helper
  extractAllKDAResult,
} = require('./src/rooms');
const { mainMenuEmbed, mainMenuRow, roomListRows, roomEmbed, roomActionRows, roomActionRowsEN } = require('./src/ui');
const persistence = require('./src/persistence');
const eloStore = require('./src/eloStore');
const { startKeepAliveServer, startSelfPing } = require('./src/keepalive');
const rankSessions = require('./src/rankSessions');

// ===== HOÀN TẤT PHIÊN RANK KHI ĐỦ ĐIỀU KIỆN =====
// - Bỏ qua hoàn toàn "người chơi" giả tạo bởi /test-fill-rank (đánh dấu isBot: true khi tạo).
//   Những người này KHÔNG BAO GIỜ được tính vào danh sách "phải gửi kết quả" và
//   KHÔNG BAO GIỜ nhận ELO.
// - Nếu có kdaMap (đọc được từ ảnh OCR của người gửi), chỉ cần MỘT người chơi THẬT
//   gửi kết quả là đủ: hệ thống sẽ tự suy ra thắng/thua + KDA cho những người thật
//   còn lại nếu tên họ cũng xuất hiện trong ảnh (dựa vào team so với người đã gửi:
//   cùng team = cùng kết quả, khác team = kết quả ngược lại; nếu không rõ team thì
//   mặc định lấy theo kết quả của người gửi). Ai không tìm thấy trong ảnh thì đơn
//   giản là không được tính ELO lần đó — không có gì để chặn cả phòng nữa.
// - Nếu KHÔNG có kdaMap (trường hợp /admin-submit-result nhập tay từng người), vẫn
//   giữ hành vi cũ là chờ đủ tất cả người THẬT (không tính bot) tự gửi.
async function finalizeRankSessionIfReady(session, room, roomId, kdaMap) {
  if (!session) return null;

  const realPlayers = session.players.filter(([, data]) => !data.isBot).map(([id]) => id);
  if (realPlayers.length === 0) return null;

  if (kdaMap) {
    const sampleEntry = Array.from(session.resultMap.entries()).find(([id]) => realPlayers.includes(id));
    if (sampleEntry) {
      const [sampleId, sampleData] = sampleEntry;
      const samplePlayerEntry = session.players.find(([id]) => id === sampleId);
      const sampleTeam = samplePlayerEntry ? samplePlayerEntry[1].team : null;

      for (const id of realPlayers) {
        if (session.resultMap.has(id)) continue; // đã tự gửi rồi, giữ nguyên
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
  if (!ready) return null;

  const finalSession = rankSessions.finalizeSession(session.id);
  if (!finalSession) return null;

  const eloUpdates = [];
  for (const [userId, resultData] of finalSession.resultMap) {
    if (!realPlayers.includes(userId)) continue; // an toàn: không bao giờ tính ELO cho bot giả
    const userEloObj = getElo(userId);
    const userElo = userEloObj.elo ?? config.RANK_DEFAULT_ELO;
    const opponentIds = realPlayers.filter(id => id !== userId);
    let opponentElos = opponentIds.map(id => {
      const e = getElo(id).elo;
      return e === null ? config.RANK_DEFAULT_ELO : e;
    });

    // Trường hợp phòng không có đối thủ thật nào khác (vd: phòng test chỉ
    // toàn bot giả từ /test-fill-rank). CHỈ áp dụng riêng cho tài khoản
    // ADMIN: coi như có 1 đối thủ ở mức ELO mặc định để vẫn tính điểm khi
    // admin tự test. Người chơi thường trong tình huống này vẫn giữ nguyên
    // hành vi cũ (KHÔNG cộng/trừ điểm), để tránh bị lợi dụng lập phòng toàn
    // bot nhằm ăn gian ELO. Khi có người chơi thật khác trong phòng (kể cả
    // khi admin cũng tham gia cùng), opponentElos đã có dữ liệu thật nên
    // nhánh này không kích hoạt -> vẫn tính như bình thường.
    if (opponentElos.length === 0) {
      const adminTesting = await isAdminUserId(userId).catch(() => false);
      if (adminTesting) {
        opponentElos = [config.RANK_DEFAULT_ELO];
        console.log(`ℹ️ ${userId} là admin và không có đối thủ thật trong phòng -> dùng ELO mặc định (${config.RANK_DEFAULT_ELO}) làm đối thủ giả định để vẫn tính điểm.`);
      }
    }

    const userRankIndex = userEloObj.rankIndex || 0;
    const newElo = calculateNewElo(userElo, opponentElos, resultData.result, resultData.kda, userRankIndex);
    updateElo(userId, newElo);
    const updatedData = getElo(userId);
    eloStore.upsertElo(userId, updatedData)
      .then(() => console.log(`✅ Đã cập nhật ELO cho ${userId} lên Supabase: ${newElo}`))
      .catch((err) => console.error(`❌ Lỗi upsert ELO cho ${userId}:`, err));
    eloUpdates.push({
      userId,
      oldElo: userElo,
      newElo,
      result: resultData.result,
      kda: resultData.kda,
    });
  }
  persistence.saveState(rooms, eloData);

  const resultChannelId = process.env.RANK_RESULT_CHANNEL_ID;
  if (resultChannelId) {
    const resultChannel = await client.channels.fetch(resultChannelId).catch(() => null);
    if (resultChannel) {
      let msg = `📊 **${room.label} (${roomId})** - KẾT QUẢ ELO (đã điều chỉnh KDA):\n`;
      for (const upd of eloUpdates) {
        const rank = getElo(upd.userId).rank;
        const kdaStr = typeof upd.kda === 'number' ? upd.kda.toFixed(2) : 'N/A';
        msg += `<@${upd.userId}>: ${upd.oldElo} → ${upd.newElo} (${upd.result}) | KDA: ${kdaStr} | Rank: ${rank}\n`;
      }
      await resultChannel.send(msg).catch(() => {});
    }
  }

  return eloUpdates;
}

// ===== COOLDOWN CHO NÚT BẤM =====
const cooldowns = new Map();
function checkCooldown(userId) {
  const now = Date.now();
  const last = cooldowns.get(userId) || 0;
  if (now - last < config.ACTION_COOLDOWN_MS) return false;
  cooldowns.set(userId, now);
  return true;
}

// ===== KHỞI TẠO CLIENT =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===== IMAGE HISTORY =====
const HISTORY_FILE = path.join(__dirname, 'data', 'image-history.json');

function loadImageHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch { return []; }
}

function saveImageHistory(history) {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function isImageUsedRecently(url, userId, days = 90) {
  const history = loadImageHistory();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return history.some(entry =>
    entry.url === url &&
    entry.userId === userId &&
    entry.submittedAt > cutoff
  );
}

function addImageHistory(url, userId, roomId) {
  const history = loadImageHistory();
  history.push({ url, userId, roomId, submittedAt: Date.now() });
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const filtered = history.filter(e => e.submittedAt > cutoff);
  saveImageHistory(filtered);
}

// ===== OCR HELPERS (OCR.space - upload file) =====
const OCR_API_KEY = process.env.OCR_API_KEY || config.OCR_API_KEY;

async function ocrImage(imageUrl) {
  if (!OCR_API_KEY) {
    console.error('❌ OCR_API_KEY chưa được cấu hình trong .env hoặc config.js');
    throw new Error('MISSING_OCR_API_KEY');
  }
  try {
    console.log(`📥 Đang tải ảnh từ: ${imageUrl}`);
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 15000,
    });
    const imageBuffer = Buffer.from(imageResponse.data, 'binary');
    console.log(`✅ Đã tải ảnh thành công (${imageBuffer.length} bytes)`);

    const formData = new FormData();
    formData.append('apikey', OCR_API_KEY);
    formData.append('file', imageBuffer, { filename: 'screenshot.png' });
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    formData.append('detectOrientation', 'true');
    formData.append('scale', 'true');

    console.log('📤 Đang gửi lên OCR.space...');
    const response = await axios.post('https://api.ocr.space/parse/image', formData, {
      headers: {
        ...formData.getHeaders(),
      },
      timeout: 30000,
    });

    const data = response.data;
    console.log('📡 OCR.space response:', JSON.stringify(data, null, 2));

    if (data.IsErroredOnProcessing) {
      console.error('❌ OCR.space error:', data.ErrorMessage);
      return '';
    }
    const text = data.ParsedResults?.[0]?.ParsedText || '';
    console.log(`✅ OCR thành công, nhận được ${text.length} ký tự`);
    return text;
  } catch (err) {
    console.error('❌ OCR.space request failed:', err.message, err.code ? `(code: ${err.code})` : '');
    if (err.response) {
      console.error('Response status:', err.response.status);
      console.error('Response data:', JSON.stringify(err.response.data, null, 2));
    }
    throw err;
  }
}

// ===== CÁC HÀM TIỆN ÍCH =====
function t(interaction, vi, en) {
  return interaction.locale === 'vi' ? vi : en;
}

function bi(vi, en) {
  return `${vi}\n🌐 ${en}`;
}

// ===== ANNOUNCEMENT FUNCTIONS (khi có người join phòng) =====
const ANNOUNCE_CHANNEL_ID = config.ANNOUNCE_CHANNEL_ID;

async function startAnnouncement(room) {
  if (!['3v3', '5v5'].includes(room.mode)) return;
  if (room.isRank) return; // KHÔNG BẬT CHO PHÒNG RANK
  if (room.timers.announceInterval) return;
  if (!ANNOUNCE_CHANNEL_ID) return;

  const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('❌ Không tìm thấy kênh thông báo với ID:', ANNOUNCE_CHANNEL_ID);
    return;
  }

  const msg = await channel.send('📢 **Nhanh tay đăng ký chơi cùng nhau nào anh em!**').catch(() => null);
  if (!msg) return;

  room.announceMessageId = msg.id;
  room.timers.announceInterval = setInterval(async () => {
    const ch = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
    if (ch) {
      ch.send('📢 **Nhanh tay đăng ký chơi cùng nhau nào anh em!**').catch(() => {});
    }
  }, 10 * 60 * 1000);

  console.log(`✅ Đã bắt đầu thông báo cho phòng ${room.id}`);
}

function stopAnnouncement(room) {
  if (room.timers.announceInterval) {
    clearInterval(room.timers.announceInterval);
    room.timers.announceInterval = null;
    room.announceMessageId = null;
    console.log(`✅ Đã dừng thông báo cho phòng ${room.id}`);
  }
}

// ===== RESET PHÒNG VÀ DỪNG THÔNG BÁO =====
function resetRoomWithCleanup(room) {
  if (!room) return;
  stopAnnouncement(room);
  resetRoom(room);
}

// ===== TỰ ĐỘNG THÔNG BÁO THEO GIỜ (20:00-22:00, mỗi 30 phút) =====
let lastScheduledAnnounce = 0;
let scheduledInterval = null;

async function sendScheduledAnnounce() {
  if (!ANNOUNCE_CHANNEL_ID) return;
  const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('❌ Không tìm thấy kênh thông báo ANNOUNCE_CHANNEL_ID');
    return;
  }
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();

  if (hours >= 20 && hours < 22) {
    if (Date.now() - lastScheduledAnnounce >= 30 * 60 * 1000) {
      await channel.send('📢 **Vào đăng ký chơi cùng nhau nào AE!**').catch(() => {});
      lastScheduledAnnounce = Date.now();
      console.log(`✅ Đã gửi thông báo định kỳ lúc ${hours}:${minutes}`);
    }
  } else {
    lastScheduledAnnounce = 0;
  }
}

// ===== CÁC HÀM ADMIN, RENDER, TIMER =====
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

function sanitizeRoomId(raw) {
  return String(raw ?? '').replace(/`/g, '').trim();
}

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
          await msg.edit({ embeds: [embed], components: rowsUi });
          continue;
        }
      }
      const sent = await ch.send({ embeds: [embed], components: rowsUi });
      target.messageId = sent.id;
    } catch (err) {
      console.error(`Lỗi render phòng ẩn ${room.id} cho DM ${target.channelId}:`, err);
    }
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
          await msg.edit({ embeds: [embed], components: rowsUi });
          persistence.saveState(rooms, eloData);
          return msg;
        }
      }
    }
    const msg = await channel.send({ embeds: [embed], components: rowsUi });
    room.panelChannelId = channel.id;
    room.panelMessageId = msg.id;
    persistence.saveState(rooms, eloData);
    return msg;
  } catch (err) {
    console.error(`Lỗi render phòng ${room.id}:`, err);
    return null;
  }
}

const FLASH_COLORS = [0xffffff, 0xffd700, 0xff69b4, 0x00ffff, 0xff4500, 0x9b59b6];

function startWaitingBlink(room, channel) {
  if (room.timers.blink) return;
  room._rainbowIndex = 0;
  room.timers.blink = setInterval(() => {
    room._blinkOn = !room._blinkOn;
    room._rainbowIndex = (room._rainbowIndex ?? 0) + 1;
    if (room._blinkOn) {
      room._flashColor = FLASH_COLORS[Math.floor(Math.random() * FLASH_COLORS.length)];
    }
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
          client.users
            .fetch(id)
            .then((user) => user.send(`⏰ **${room.label}** đã tự động reset vì quá thời gian chờ.`))
            .catch(() => {});
        }
        return;
      }
      await channel
        .send(
          bi(
            `⏰ **${room.label}** đã tự động reset vì quá thời gian chờ mà chưa đủ người / chưa sẵn sàng.`,
            `**${room.label}** was auto-reset because it wasn't full / everyone ready in time.`
          )
        )
        .catch(() => {});
    }
  }, ms);
}

async function announceRoomFull(room, channel) {
  const ids = Array.from(room.players.keys());
  const readyMinutes = Math.round(config.READY_COUNTDOWN_MS / 60000);
  if (room.hidden) {
    for (const id of ids) {
      client.users
        .fetch(id)
        .then((user) =>
          user.send(
            `✅ **${room.label}** đã **đủ người**!\n` +
              `Bấm **Sẵn sàng** ngay trong tin nhắn phòng phía trên trong vòng ${readyMinutes} phút, nếu không bạn sẽ bị đá khỏi phòng để nhường chỗ cho người khác.`
          )
        )
        .catch(() => {});
    }
    return;
  }
  const mentions = ids.map((id) => `<@${id}>`).join(' ');
  await channel
    .send(
      bi(
        `✅ **${room.label}** đã đủ người! ${mentions}\nHãy bấm **Sẵn sàng** trong vòng ${readyMinutes} phút, nếu không sẽ bị đá khỏi phòng.`,
        `**${room.label}** is now full! ${mentions}\nPlease hit **Ready** within ${readyMinutes} minutes, or you'll be kicked from the room.`
      )
    )
    .catch(() => {});
  for (const id of ids) {
    client.users
      .fetch(id)
      .then((user) =>
        user.send(
          bi(
            `✅ **${room.label}** mà bạn đăng ký đã **đủ người**!\n` +
              `Vào kênh <#${channel.id}> và bấm **Sẵn sàng** trong vòng ${readyMinutes} phút, nếu không bạn sẽ bị đá khỏi phòng để nhường chỗ cho người khác.`,
            `**${room.label}** you signed up for is now **full**!\n` +
              `Go to <#${channel.id}> and hit **Ready** within ${readyMinutes} minutes, or you'll be kicked to make room for someone else.`
          )
        )
      )
      .catch(() => {});
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
    if (!p.ready) {
      kicked.push(id);
      room.players.delete(id);
    }
  }
  room.fullAt = null;
  if (room.timers.blink) {
    clearInterval(room.timers.blink);
    room.timers.blink = null;
    room._flashColor = null;
  }

  if (kicked.length === 0) {
    await channel
      .send(
        bi(
          `⚖️ **${room.label}**: mọi người đã sẵn sàng nhưng team chưa cân bằng nên chưa phát được code. Hãy tự đổi team hoặc rời phòng.`,
          `**${room.label}**: everyone is ready but teams aren't balanced yet, so the code hasn't been revealed. Please change team or leave the room.`
        )
      )
      .catch(() => {});
    await renderRoom(room, channel);
    return;
  }

  const mentions = kicked.map((id) => `<@${id}>`).join(' ');
  const readyMinutes2 = Math.round(config.READY_COUNTDOWN_MS / 60000);
  await channel
    .send(
      bi(
        `⏱️ Hết ${readyMinutes2} phút chờ sẵn sàng tại **${room.label}** — đã đá ${mentions} ra khỏi phòng để nhường chỗ. Bấm **Gia nhập** để đăng ký lại.`,
        `⏱️ The ${readyMinutes2}-minute ready window for **${room.label}** is over — kicked ${mentions} to free up their spots. Hit **Join** to sign up again.`
      )
    )
    .catch(() => {});

  if (room.players.size === 0) {
    resetRoomWithCleanup(room);
  } else {
    room.firstJoinAt = Date.now();
    scheduleInactivityTimeout(room, channel);
  }
  await renderRoom(room, channel);
}

// ===== PHÁT CODE =====
async function tryRevealCode(room, channel) {
  if (room.status === 'revealed') return;
  const check = canRevealCode(room);
  if (!check.ok) return;

  if (room.timers.inactivity) {
    clearTimeout(room.timers.inactivity);
    room.timers.inactivity = null;
  }
  if (room.timers.readyCountdown) {
    clearTimeout(room.timers.readyCountdown);
    room.timers.readyCountdown = null;
  }

  room.code = generateCode();
  room.status = 'revealed';
  room.revealedAt = Date.now();
  room._blinkOn = true;
  room._flashColor = null;

  if (room.timers.blink) {
    clearInterval(room.timers.blink);
    room.timers.blink = null;
  }

  await renderRoom(room, channel);
  await channel
    .send(
      bi(
        `🔑 **${room.label}** đã đủ người sẵn sàng! Code phòng đã được phát — mỗi người bấm nút **"Lấy code của tôi"** trên panel để nhận mã riêng.`,
        `🔑 **${room.label}** is full and ready! The room code has been revealed — everyone tap **"Get my code"** on the panel to get your own copy.`
      )
    )
    .catch(() => {});

  const playerList = Array.from(room.players.values())
    .map((p) => `${p.username}${p.team ? ` (Team ${p.team})` : ''}`)
    .join(', ');
  await logAdmin(
    `🔑 [${new Date().toLocaleString('vi-VN')}] **${room.label}** phát code \`${room.code}\`\nNgười chơi: ${playerList}`
  );

  room.timers.blink = setInterval(() => {
    room._blinkOn = !room._blinkOn;
    renderRoom(room, channel).catch(() => {});
  }, config.BLINK_INTERVAL_MS);

  // ===== XỬ LÝ RANK: TẠO SESSION TRƯỚC, VẪN GIỮ CODE 2 PHÚT =====
  if (room.isRank) {
    const playersSnapshot = new Map(room.players);
    const sessionId = rankSessions.createSession(room.id, playersSnapshot, room.mode);
    console.log(`📝 Đã tạo session ${sessionId} cho ${room.label}`);

    const resultChannelId = process.env.RANK_RESULT_CHANNEL_ID;
    if (resultChannelId) {
      const resultChannel = await client.channels.fetch(resultChannelId).catch(() => null);
      if (resultChannel) {
        const playerMentions = Array.from(playersSnapshot.keys()).map(id => `<@${id}>`).join(' ');
        await resultChannel.send({
          content: `🎮 **${room.label}** đã bắt đầu!\n` +
                   `Người chơi: ${playerMentions}\n` +
                   `Sau khi chơi xong, hãy gửi ảnh kết quả (VICTORY/DEFEAT + KDA) qua lệnh \`/submit-result phong:${room.id}\` (hoặc nút trên panel).\n` +
                   `⏰ Hạn gửi kết quả: 45 phút.`
        });
      } else {
        console.warn('⚠️ Không tìm thấy kênh RANK_RESULT_CHANNEL_ID, kết quả sẽ không được thu thập.');
      }
    }

    room.timers.resetAfterCode = setTimeout(async () => {
      clearRoomTimers(room);
      resetRoomWithCleanup(room);
      await renderRoom(room, channel);
      await channel
        .send(
          bi(
            `♻️ **${room.label}** đã được reset, mời mọi người đăng ký lại.`,
            `**${room.label}** has been reset, everyone is welcome to sign up again.`
          )
        )
        .catch(() => {});
    }, config.CODE_RESET_DELAY_MS);

  } else {
    room.timers.resetAfterCode = setTimeout(async () => {
      clearRoomTimers(room);
      resetRoomWithCleanup(room);
      await renderRoom(room, channel);
      await channel
        .send(
          bi(
            `♻️ **${room.label}** đã được reset, mời mọi người đăng ký lại.`,
            `**${room.label}** has been reset, everyone is welcome to sign up again.`
          )
        )
        .catch(() => {});
    }, config.CODE_RESET_DELAY_MS);
  }
}

// ===== TỰ ĐỘNG DỌN PANEL CŨ & ĐĂNG LẠI PANEL MỚI =====
async function repostPanelsForChannel(channelId, roomList) {
  if (!channelId || roomList.length === 0) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.error(`❌ Không tìm thấy kênh panel với ID: ${channelId} (kiểm tra lại biến môi trường PANEL_CHANNEL_*).`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter((m) => m.author.id === client.user.id);
    if (botMessages.size > 0) {
      await channel.bulkDelete(botMessages, true).catch(async () => {
        for (const msg of botMessages.values()) {
          await msg.delete().catch(() => {});
        }
      });
    }
  } catch (err) {
    console.error(`⚠️ Không dọn được panel cũ trong kênh ${channelId}:`, err.message);
  }

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
  console.log('✅ Đã tự động đăng lại toàn bộ panel phòng.');
}

// ===== CLIENT READY =====
client.once('ready', async () => {
  console.log(`Đã đăng nhập với tên ${client.user.tag}`);

  await autoHealPanels();

  for (const room of getAllRooms()) {
    if (room.players.size === 0 || !room.panelChannelId) continue;
    const channel = await client.channels.fetch(room.panelChannelId).catch(() => null);
    if (!channel) continue;

    if (room.status === 'revealed' && room.revealedAt) {
      if (room.isRank) {
        resetRoomWithCleanup(room);
        await renderRoom(room, channel);
      } else {
        const remaining = config.CODE_RESET_DELAY_MS - (Date.now() - room.revealedAt);
        if (remaining <= 0) {
          resetRoomWithCleanup(room);
        } else {
          room._blinkOn = true;
          room.timers.blink = setInterval(() => {
            room._blinkOn = !room._blinkOn;
            renderRoom(room, channel).catch(() => {});
          }, config.BLINK_INTERVAL_MS);
          room.timers.resetAfterCode = setTimeout(async () => {
            clearRoomTimers(room);
            resetRoomWithCleanup(room);
            await renderRoom(room, channel);
            await channel
              .send(
                bi(
                  `♻️ **${room.label}** đã được reset, mời mọi người đăng ký lại.`,
                  `**${room.label}** has been reset, everyone is welcome to sign up again.`
                )
              )
              .catch(() => {});
          }, remaining);
        }
      }
    } else if (room.status === 'waiting') {
      if (isFull(room) && room.fullAt) {
        const remaining = config.READY_COUNTDOWN_MS - (Date.now() - room.fullAt);
        if (remaining <= 0) {
          await handleReadyCountdownExpire(room, channel);
        } else {
          room.timers.readyCountdown = setTimeout(() => handleReadyCountdownExpire(room, channel), remaining);
          startWaitingBlink(room, channel);
        }
      } else if (room.firstJoinAt) {
        const remaining = room.timeoutMs - (Date.now() - room.firstJoinAt);
        if (remaining <= 0) {
          resetRoomWithCleanup(room);
        } else {
          scheduleInactivityTimeout(room, channel, remaining);
        }
      }
    }
    await renderRoom(room, channel);
  }

  await sendScheduledAnnounce();
  scheduledInterval = setInterval(async () => {
    await sendScheduledAnnounce();
  }, 60 * 1000);
  console.log('✅ Đã bật thông báo tự động từ 20:00 đến 22:00, mỗi 30 phút.');
});

// ===== MAIN INTERACTION HANDLER =====
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isUserSelectMenu()) {
      await handleUserSelectMenu(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    }

    if (interaction.isRepliable() && interaction.replied && interaction.ephemeral) {
      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, 5 * 60 * 1000);
    }
  } catch (err) {
    console.error('❗ Lỗi trong interactionCreate:', err);
  }
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
    setTimeout(() => {
      if (msg && typeof msg.delete === 'function') msg.delete().catch(() => {});
    }, ADMIN_MSG_AUTO_DELETE_MS);
    return msg;
  };
}

// ===== SLASH COMMANDS =====
async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (ADMIN_ONLY_COMMANDS.has(commandName)) {
    wrapAdminEphemeralAutoDelete(interaction);
  }

  // ---- LOBBY ----
  if (commandName === 'lobby') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const statsFor = (mode) => {
      const list = getRoomsByMode(mode);
      return {
        current: list.reduce((sum, r) => sum + r.players.size, 0),
        total: list.reduce((sum, r) => sum + r.capacity, 0),
        roomCount: list.length,
      };
    };
    const stats = { '3v3': statsFor('3v3'), '5v5': statsFor('5v5') };
    await interaction.channel.send({ embeds: [mainMenuEmbed(stats)], components: [mainMenuRow()] });
    return interaction.reply({ content: '✅ Đã đăng bảng chọn phòng.', ephemeral: true });
  }

  // ---- SET-TIMEOUT ----
  if (commandName === 'set-timeout') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới đổi được thời gian reset phòng.', ephemeral: true });
    }
    const minutes = interaction.options.getInteger('phut', true);
    const scope = interaction.options.getString('pham_vi') || 'all';
    const ms = minutes * 60 * 1000;

    const targets = scope === 'all' ? [...getRoomsByMode('3v3'), ...getRoomsByMode('5v5')] : getRoomsByMode(scope);

    for (const room of targets) {
      room.timeoutMs = ms;
      if (room.status === 'waiting' && room.players.size > 0 && !isFull(room) && room.panelChannelId) {
        const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
        if (ch) {
          room.firstJoinAt = Date.now();
          scheduleInactivityTimeout(room, ch);
          await renderRoom(room, ch);
        }
      }
    }
    persistence.saveState(rooms, eloData);

    return interaction.reply({
      content: `✅ Đã đặt thời gian tự reset = **${minutes} phút** cho ${
        scope === 'all' ? 'tất cả phòng' : `phòng ${scope}`
      }.`,
      ephemeral: true,
    });
  }

  // ---- READY ----
  if (commandName === 'ready') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const trangThai = interaction.options.getString('trang_thai', true);
    const room = getRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }
    const player = room.players.get(targetUser.id);
    if (!player) {
      return interaction.reply({
        content: `❌ <@${targetUser.id}> hiện không ở trong **${room.label}**.`,
        ephemeral: true,
      });
    }

    player.ready = trangThai === 'ready';

    const channel =
      (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) ||
      interaction.channel;
    await renderRoom(room, channel);

    if (player.ready) {
      const check = canRevealCode(room);
      if (check.ok) await tryRevealCode(room, channel);
    }

    persistence.saveState(rooms, eloData);
    return interaction.reply({
      content: `✅ Đã đặt <@${targetUser.id}> thành **${player.ready ? 'Sẵn sàng' : 'Chưa sẵn sàng'}** trong **${room.label}**.`,
      ephemeral: true,
    });
  }

  // ---- GIA-HAN-PHONG ----
  if (commandName === 'gia-han-phong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const phut = interaction.options.getInteger('phut', true);
    const room = getRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }
    if (!room.firstJoinAt || room.status === 'revealed') {
      return interaction.reply({
        content: 'ℹ️ Phòng này hiện đang trống hoặc đã phát code, không có đồng hồ nào đang chạy để gia hạn.',
        ephemeral: true,
      });
    }

    room.timeoutMs += phut * 60 * 1000;
    const remaining = Math.max(room.timeoutMs - (Date.now() - room.firstJoinAt), 1000);

    const channel =
      (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) ||
      interaction.channel;
    scheduleInactivityTimeout(room, channel, remaining);
    await renderRoom(room, channel);
    persistence.saveState(rooms, eloData);

    return interaction.reply({
      content: `✅ Đã gia hạn thêm **${phut} phút** cho **${room.label}** trước khi tự reset.`,
      ephemeral: true,
    });
  }

  // ---- MOI-BAN ----
  if (commandName === 'moi-ban') {
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('ban', true);
    const room = getRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }
    if (room.status === 'revealed') {
      return interaction.reply({ content: '❌ Phòng đã phát code, không mời thêm được nữa.', ephemeral: true });
    }
    if (isFull(room)) {
      return interaction.reply({ content: '❌ Phòng đã đầy rồi.', ephemeral: true });
    }
    if (isBanned(room, targetUser.id)) {
      return interaction.reply({
        content: `❌ <@${targetUser.id}> đang bị cấm khỏi **${room.label}**, không mời được.`,
        ephemeral: true,
      });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`join_${room.id}`)
        .setLabel('Tham gia ngay')
        .setStyle(ButtonStyle.Success)
        .setEmoji('➕')
    );

    await interaction.channel.send({
      content: `📨 <@${interaction.user.id}> mời <@${targetUser.id}> vào **${room.label}** (${room.players.size}/${room.capacity})!`,
      components: [row],
    });

    return interaction.reply({ content: `✅ Đã gửi lời mời cho <@${targetUser.id}>.`, ephemeral: true });
  }

  // ---- BAN-PHONG ----
  if (commandName === 'ban-phong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const room = getRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }

    const wasInRoom = room.players.has(targetUser.id);
    banUser(room, targetUser.id);
    persistence.saveState(rooms, eloData);

    if (wasInRoom) {
      const channel =
        (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) ||
        interaction.channel;
      await renderRoom(room, channel);
    }

    return interaction.reply({
      content: `✅ Đã cấm <@${targetUser.id}> tham gia **${room.label}**${
        wasInRoom ? ' (đã bị đá khỏi phòng luôn)' : ''
      }. Các phòng khác không bị ảnh hưởng.`,
      ephemeral: true,
    });
  }

  // ---- UNBAN-PHONG ----
  if (commandName === 'unban-phong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const room = getRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }

    unbanUser(room, targetUser.id);
    persistence.saveState(rooms, eloData);

    return interaction.reply({
      content: `✅ Đã bỏ cấm <@${targetUser.id}> khỏi **${room.label}**.`,
      ephemeral: true,
    });
  }

  // ---- KICK-ROOM ----
  if (commandName === 'kick-room') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const room = getRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }
    if (!room.players.has(targetUser.id)) {
      return interaction.reply({
        content: `ℹ️ <@${targetUser.id}> hiện không ở trong **${room.label}** (có thể đã rời trước đó).`,
        ephemeral: true,
      });
    }

    room.players.delete(targetUser.id);
    persistence.saveState(rooms, eloData);

    const channel =
      (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) ||
      interaction.channel;
    await renderRoom(room, channel);

    if (room.hidden) {
      client.users
        .fetch(targetUser.id)
        .then((user) => user.send(`⚠️ Bạn đã bị admin đá khỏi trận đang diễn ra tại **${room.label}**. Bạn vẫn có thể bấm **Gia nhập** lại trên panel để tham gia trận sau.`))
        .catch(() => {});
    }

    return interaction.reply({
      content: `✅ Đã đá <@${targetUser.id}> khỏi trận tại **${room.label}** (chưa cấm — họ vào lại được).`,
      ephemeral: true,
    });
  }

  // ---- KICK-GROUP ----
  if (commandName === 'kick-group') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const room = getHiddenRoom(roomId);
    if (!room) {
      return interaction.reply({
        content: `❌ Không tìm thấy phòng ẩn "${roomId}" (lệnh này chỉ dùng cho phòng ẩn — xem ID đúng bằng \`/danh-sach-phong-an\`).`,
        ephemeral: true,
      });
    }

    room.players.delete(targetUser.id);

    const targetIdx = room.panelTargets.findIndex((t) => t.userId === targetUser.id);
    if (targetIdx === -1) {
      return interaction.reply({
        content: `ℹ️ <@${targetUser.id}> chưa từng được mời vào **${room.label}**, không có gì để xoá.`,
        ephemeral: true,
      });
    }
    const [target] = room.panelTargets.splice(targetIdx, 1);

    try {
      const ch = await client.channels.fetch(target.channelId).catch(() => null);
      if (ch && target.messageId) {
        const msg = await ch.messages.fetch(target.messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    } catch (err) {
      console.error(`Không xoá được tin nhắn panel phòng ẩn cho ${targetUser.id}:`, err);
    }

    client.users
      .fetch(targetUser.id)
      .then((user) => user.send(`🚫 Bạn đã bị admin xoá khỏi nhóm phòng ẩn **${room.label}** — không còn quyền xem/tham gia phòng này nữa.`))
      .catch(() => {});

    await renderRoom(room, interaction.channel);

    return interaction.reply({
      content: `✅ Đã xoá <@${targetUser.id}> khỏi nhóm **${room.label}** (đã xoá luôn panel DM của họ).`,
      ephemeral: true,
    });
  }

  // ---- SETUP-PHONG-AN ----
  if (commandName === 'setup-phong-an') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const mode = interaction.options.getString('che_do', true);
    const room = createHiddenRoom(mode);

    let dmNote = '';
    try {
      await sendHiddenRoomDM(room, interaction.user, `👑 Bạn (admin) vừa tạo phòng ẩn: **${room.label}**.`);
    } catch (err) {
      console.error('Không DM được panel phòng ẩn cho admin:', err);
      dmNote = '\n⚠️ Không DM được panel cho bạn (có thể bạn đang tắt DM từ thành viên server) — bật lên rồi thử lại.';
    }

    return interaction.reply({
      content:
        `✅ Đã tạo **${room.label}** (ID: \`${room.id}\`) và gửi panel vào DM của bạn.\n` +
        `Dùng \`/moi-phong-an phong:${room.id}\` để mời thêm người khác (họ sẽ nhận panel qua DM riêng, không ai khác thấy).` +
        dmNote,
      ephemeral: true,
    });
  }

  // ---- MOI-PHONG-AN ----
  if (commandName === 'moi-phong-an') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    if (!interaction.guild) {
      return interaction.reply({
        content: '⚠️ Lệnh này phải chạy trong 1 kênh của server (không dùng được từ DM), vì DM không hiện đủ danh sách thành viên để chọn.',
        ephemeral: true,
      });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getHiddenRoom(roomId);
    if (!room) {
      return interaction.reply({
        content: `❌ Không tìm thấy phòng ẩn "${roomId}" — dùng \`/danh-sach-phong-an\` để xem ID chính xác.`,
        ephemeral: true,
      });
    }

    const select = new UserSelectMenuBuilder()
      .setCustomId(`hiddeninvite_${room.id}`)
      .setPlaceholder(`Chọn người muốn mời vào ${room.label}`)
      .setMinValues(1)
      .setMaxValues(25);

    return interaction.reply({
      content: `📨 Chọn (nhiều) người muốn mời riêng vào **${room.label}** (tối đa 25 người/lần — chạy lại lệnh này nếu cần mời thêm):`,
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
  }

  // ---- DANH-SACH-PHONG-AN ----
  if (commandName === 'danh-sach-phong-an') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const list = getAllHiddenRooms();
    if (list.length === 0) {
      return interaction.reply({ content: 'ℹ️ Hiện chưa có phòng ẩn nào.', ephemeral: true });
    }
    const lines = list.map(
      (r) => `• \`${r.id}\` — ${r.label} — ${r.players.size}/${r.capacity} người — đã mời ${r.panelTargets.length} người`
    );
    return interaction.reply({ content: `📋 Danh sách phòng ẩn:\n${lines.join('\n')}`, ephemeral: true });
  }

  // ---- XOA-PHONG-AN ----
  if (commandName === 'xoa-phong-an') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getHiddenRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng ẩn "${roomId}".`, ephemeral: true });
    }

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

  // ---- XOA-TAT-CA-PHONG-AN ----
  if (commandName === 'xoa-tat-ca-phong-an') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const allHidden = getAllHiddenRooms();
    if (allHidden.length === 0) {
      return interaction.reply({ content: 'ℹ️ Hiện không có phòng ẩn nào để xóa.', ephemeral: true });
    }

    await interaction.reply({ content: `🗑️ Đang xóa toàn bộ **${allHidden.length}** phòng ẩn...`, ephemeral: true });

    for (const room of allHidden) {
      for (const target of room.panelTargets) {
        const ch = await client.channels.fetch(target.channelId).catch(() => null);
        if (ch) {
          const msg = target.messageId ? await ch.messages.fetch(target.messageId).catch(() => null) : null;
          if (msg) await msg.edit({ content: `🚫 **${room.label}** đã bị admin đóng.`, embeds: [], components: [] }).catch(() => {});
        }
      }
      deleteHiddenRoom(room.id);
    }

    return interaction.followUp({ content: `✅ Đã xóa toàn bộ **${allHidden.length}** phòng ẩn.`, ephemeral: true });
  }

  // ---- SETUP (phòng thường) ----
  if (commandName === 'setup') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const mode = interaction.options.getString('che_do', true);
    const soLuong = interaction.options.getInteger('so_luong');

    let note = '';
    if (soLuong) {
      const { created, capped, currentTotal, maxAllowed } = addRoomsToMode(mode, soLuong);
      if (created.length > 0) {
        note += `\n✅ Đã tạo thêm **${created.length}** phòng mới: ${created.map((r) => `\`${r.id}\``).join(', ')} (tổng hiện tại: **${currentTotal}/${maxAllowed}** phòng).`;
      }
      if (capped) {
        note += `\n⚠️ Bạn xin thêm ${soLuong} phòng nhưng chỉ tạo được ${created.length} vì đã chạm giới hạn tối đa ${maxAllowed} phòng/chế độ.`;
      }
    }

    const roomsOfMode = getRoomsByMode(mode);

    if (roomsOfMode.length === 0) {
      return interaction.reply({
        content: `❌ Chế độ **${mode.toUpperCase()}** hiện chưa có phòng nào. Gõ \`/setup che_do:${mode} so_luong:<số phòng muốn tạo>\` để tạo phòng trước.`,
        ephemeral: true,
      });
    }

    await interaction.reply({
      content: `✅ Đang đăng ${roomsOfMode.length} panel phòng **${mode.toUpperCase()}** vào kênh này...${note}`,
      ephemeral: true,
    });

    for (const room of roomsOfMode) {
      room.panelChannelId = null;
      room.panelMessageId = null;
      await renderRoom(room, interaction.channel);
    }
    persistence.saveState(rooms, eloData);
    return;
  }

  // ---- SETUP-RANK ----
  if (commandName === 'setup-rank') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng.', ephemeral: true });
    }
    const mode = interaction.options.getString('che_do', true);
    const soLuong = interaction.options.getInteger('so_luong');

    let note = '';
    if (soLuong) {
      const { created, capped, currentTotal, maxAllowed } = addRankRoomsToMode(mode, soLuong);
      if (created.length > 0) {
        note += `\n✅ Đã tạo thêm **${created.length}** phòng rank mới: ${created.map((r) => `\`${r.id}\``).join(', ')} (tổng hiện tại: **${currentTotal}/${maxAllowed}** phòng).`;
      }
      if (capped) {
        note += `\n⚠️ Bạn xin thêm ${soLuong} phòng nhưng chỉ tạo được ${created.length} vì đã chạm giới hạn tối đa ${maxAllowed} phòng/chế độ.`;
      }
    }

    const roomsOfMode = getRankRoomsByMode(mode);
    if (roomsOfMode.length === 0) {
      return interaction.reply({
        content: `❌ Chế độ **${mode.toUpperCase()} Rank** hiện chưa có phòng nào. Gõ \`/setup-rank che_do:${mode} so_luong:<số phòng>\` để tạo.`,
        ephemeral: true,
      });
    }

    await interaction.reply({
      content: `✅ Đang đăng ${roomsOfMode.length} panel phòng rank **${mode.toUpperCase()}** vào kênh này...${note}`,
      ephemeral: true,
    });

    for (const room of roomsOfMode) {
      room.panelChannelId = null;
      room.panelMessageId = null;
      await renderRoom(room, interaction.channel);
    }
    persistence.saveState(rooms, eloData);
    return;
  }

  // ---- REGISTER-IGN ----
  if (commandName === 'register-ign') {
    const ign = interaction.options.getString('ign', true).trim();
    if (ign.length < 2 || ign.length > 20) {
      return interaction.reply({ content: '❌ Tên IGN phải từ 2-20 ký tự.', ephemeral: true });
    }
    if (!/^[a-zA-Z0-9_\- ]+$/.test(ign)) {
      return interaction.reply({ content: '❌ IGN chỉ được chứa chữ cái, số, dấu gạch dưới, gạch ngang và khoảng trắng.', ephemeral: true });
    }
    const result = registerIGN(interaction.user.id, ign);
    if (!result.ok) {
      return interaction.reply({ content: `❌ ${result.reason}`, ephemeral: true });
    }
    eloStore.upsertElo(interaction.user.id, getElo(interaction.user.id)).catch(() => {});
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã đăng ký IGN thành công: **${ign}**\nBot sẽ dùng IGN này để tìm KDA của bạn trong ảnh.`, ephemeral: true });
  }

  // ---- SET-ELO ----
  if (commandName === 'set-elo') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const targetUser = interaction.options.getUser('user', true);
    const diem = interaction.options.getInteger('diem', true);
    const clamped = Math.max(0, Math.min(3000, diem));
    const data = updateElo(targetUser.id, clamped);
    eloStore.upsertElo(targetUser.id, getElo(targetUser.id)).catch(() => {});
    persistence.saveState(rooms, eloData);
    return interaction.reply({
      content: `✅ Đã đặt ELO của <@${targetUser.id}> thành **${clamped}** (${data.rank}).`,
      ephemeral: true,
    });
  }

  // ---- THEM-ELO ----
  if (commandName === 'them-elo') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const targetUser = interaction.options.getUser('user', true);
    const diem = interaction.options.getInteger('diem', true);
    const currentElo = getElo(targetUser.id).elo ?? config.RANK_DEFAULT_ELO;
    const newElo = Math.max(0, Math.min(3000, currentElo + diem));
    const data = updateElo(targetUser.id, newElo);
    eloStore.upsertElo(targetUser.id, getElo(targetUser.id)).catch(() => {});
    persistence.saveState(rooms, eloData);
    return interaction.reply({
      content: `✅ Đã ${diem >= 0 ? 'cộng' : 'trừ'} **${Math.abs(diem)}** điểm cho <@${targetUser.id}>. ELO: ${currentElo} → **${newElo}** (${data.rank}).`,
      ephemeral: true,
    });
  }

  // ---- XOA-ELO ----
  if (commandName === 'xoa-elo') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const targetUser = interaction.options.getUser('user', true);
    clearElo(targetUser.id);
    eloStore.deleteElo(targetUser.id).catch(() => {});
    persistence.saveState(rooms, eloData);
    return interaction.reply({
      content: `✅ Đã xóa ELO của <@${targetUser.id}>, trở về **Unranked**.`,
      ephemeral: true,
    });
  }

  // ---- SUBMIT-RESULT ----
  if (commandName === 'submit-result') {
    console.log(`✅ Nhận lệnh /submit-result từ ${interaction.user.tag}`);

    try {
      await interaction.deferReply({ ephemeral: true });
      console.log('✅ Defer reply thành công');
    } catch (err) {
      console.error('❌ Lỗi defer reply:', err);
      try {
        await interaction.reply({ content: '⚠️ Bot quá tải, vui lòng thử lại sau.', ephemeral: true });
      } catch (_) {}
      return;
    }

    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || !room.isRank) {
      return interaction.editReply({ content: '❌ Phòng không tồn tại hoặc không phải rank.' });
    }

    const session = rankSessions.getActiveSessionByRoomId(roomId);
    if (!session) {
      return interaction.editReply({ content: '❌ Phiên chơi này đã hết hạn hoặc không tồn tại.' });
    }
    if (!session.players.some(([id]) => id === interaction.user.id)) {
      return interaction.editReply({ content: '❌ Bạn không có trong phiên chơi này.' });
    }
    if (session.resultMap.has(interaction.user.id)) {
      return interaction.editReply({ content: 'ℹ️ Bạn đã gửi kết quả rồi.' });
    }

    const attachment = interaction.options.getAttachment('hinhanh', true);
    if (!attachment || !attachment.contentType || !attachment.contentType.startsWith('image/')) {
      return interaction.editReply({ content: '❌ File đính kèm không phải là ảnh hợp lệ.' });
    }

    if (isImageUsedRecently(attachment.url, interaction.user.id)) {
      return interaction.editReply({
        content: '❌ Ảnh này đã được sử dụng trong vòng 90 ngày qua. Vui lòng chụp ảnh mới!'
      });
    }

    if (config.LOG_CHANNEL_ID) {
      try {
        const logChannel = await client.channels.fetch(config.LOG_CHANNEL_ID);
        if (logChannel) {
          await logChannel.send({
            content: `📸 **${interaction.user.tag}** (<@${interaction.user.id}>) gửi ảnh cho phòng **${room.id}** (${room.label}) tại <t:${Math.floor(Date.now()/1000)}>`,
            files: [attachment.url],
          });
          console.log('✅ Đã forward ảnh vào kênh log');
        }
      } catch (err) {
        console.error('❌ Không thể forward ảnh vào kênh log:', err.message);
      }
    }

    addImageHistory(attachment.url, interaction.user.id, room.id);

    console.log(`🔍 Bắt đầu OCR cho file: ${attachment.name} (${attachment.contentType}, ${attachment.size} bytes)`);

    let ocrText = '';
    try {
      ocrText = await ocrImage(attachment.url);
    } catch (err) {
      console.error('❌ Lỗi khi gọi OCR:', err.message, err.code ? `(code: ${err.code})` : '', err.response ? `(status: ${err.response.status})` : '');
      if (err.message === 'MISSING_OCR_API_KEY') {
        return interaction.editReply({ content: '❌ Bot chưa được cấu hình OCR. Vui lòng báo admin thêm API key.' });
      }
      return interaction.editReply({ content: '❌ Lỗi khi xử lý ảnh. Vui lòng thử lại sau hoặc dùng /admin-submit-result.' });
    }

    if (!ocrText) {
      console.log('⚠️ OCR trả về text rỗng.');
      return interaction.editReply({
        content: '❌ Không thể đọc được ảnh. Vui lòng chụp rõ hơn hoặc nhờ admin gửi thay (dùng /admin-submit-result).',
      });
    }

    const fakeRoom = { players: new Map(session.players) };
    const kdaMap = extractAllKDAResult(ocrText, fakeRoom);

    if (kdaMap.size === 0) {
      return interaction.editReply({
        content: '❌ Không tìm thấy KDA của bất kỳ ai trong ảnh. Vui lòng kiểm tra ảnh hoặc nhờ admin gửi thay.',
      });
    }

    let result = null;
    const resultMatch = ocrText.match(/(VICTORY|DEFEAT|victory|defeat|Chiến thắng|Thất bại|CHIẾN THẮNG|THẤT BẠI|WIN|LOSE)/);
    if (resultMatch) {
      const raw = resultMatch[1].toLowerCase();
      if (raw.includes('victory') || raw.includes('chiến thắng') || raw === 'win') result = 'win';
      else if (raw.includes('defeat') || raw.includes('thất bại') || raw === 'lose') result = 'loss';
    }
    if (!result) {
      return interaction.editReply({
        content: '❌ Không tìm thấy kết quả trận đấu (VICTORY/DEFEAT) trong ảnh.',
      });
    }

    const senderId = interaction.user.id;
    const senderKDA = kdaMap.get(senderId);
    if (!senderKDA) {
      return interaction.editReply({
        content: `⚠️ Không tìm thấy IGN của bạn (${interaction.user.username}) trong ảnh. Vui lòng kiểm tra IGN đã đăng ký khớp với tên trong ảnh chưa.\nĐể đăng ký IGN, dùng \`/register-ign <tên_game>\`.`,
      });
    }

    const saved = rankSessions.addResult(session.id, senderId, {
      result,
      kill: senderKDA.kill,
      death: senderKDA.death,
      assist: senderKDA.assist,
      kda: senderKDA.death === 0 ? senderKDA.kill + senderKDA.assist : (senderKDA.kill + senderKDA.assist) / senderKDA.death,
      imageUrl: attachment.url,
    });
    if (!saved) {
      return interaction.editReply({ content: '❌ Không thể lưu kết quả (session có thể đã hết hạn).' });
    }

    await finalizeRankSessionIfReady(session, room, roomId, kdaMap);

    persistence.saveState(rooms, eloData);

    return interaction.editReply({
      content: `✅ Đã ghi nhận kết quả **${result === 'win' ? 'Thắng' : 'Thua'}** cho bạn.`,
    });
  }

  // ---- ADMIN-SUBMIT-RESULT ----
  if (commandName === 'admin-submit-result') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const result = interaction.options.getString('ketqua', true);
    const kdaStr = interaction.options.getString('kda', true);
    const imageUrl = interaction.options.getString('hinhanh') || null;

    const room = getRoom(roomId);
    if (!room || !room.isRank) {
      return interaction.reply({ content: '❌ Phòng không tồn tại hoặc không phải rank.', ephemeral: true });
    }

    const session = rankSessions.getActiveSessionByRoomId(roomId);
    if (!session) {
      return interaction.reply({ content: '❌ Phiên chơi này đã hết hạn hoặc không tồn tại.', ephemeral: true });
    }
    if (!session.players.some(([id]) => id === targetUser.id)) {
      return interaction.reply({ content: `❌ <@${targetUser.id}> không có trong phiên chơi này.`, ephemeral: true });
    }

    const parts = kdaStr.split('/').map(s => parseInt(s.trim(), 10));
    if (parts.length !== 3 || parts.some(isNaN)) {
      return interaction.reply({ content: '❌ KDA không đúng định dạng. Vui lòng nhập kill/death/assist (ví dụ: 5/2/8).', ephemeral: true });
    }
    const [kill, death, assist] = parts;
    const kda = death === 0 ? kill + assist : (kill + assist) / death;

    const saved = rankSessions.addResult(session.id, targetUser.id, {
      result,
      kill,
      death,
      assist,
      kda,
      imageUrl,
    });
    if (!saved) {
      return interaction.reply({ content: '❌ Không thể lưu kết quả (session có thể đã hết hạn).', ephemeral: true });
    }

    await finalizeRankSessionIfReady(session, room, roomId, null);

    return interaction.reply({
      content: `✅ Admin đã ghi nhận kết quả **${result === 'win' ? 'Thắng' : 'Thua'}**, KDA ${kill}/${death}/${assist} (${kda.toFixed(2)}) cho <@${targetUser.id}> trong ${room.label}.`,
      ephemeral: true,
    });
  }

  // ---- XOA-PHONG-RANK ----
  if (commandName === 'xoa-phong-rank') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || !room.isRank) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng rank "${roomId}".`, ephemeral: true });
    }
    if (room.panelChannelId && room.panelMessageId) {
      const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    }
    const result = removeRankRoom(roomId);
    if (!result.ok) {
      return interaction.reply({ content: `❌ Không xóa được: ${result.reason}`, ephemeral: true });
    }
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã xóa hẳn **${result.room.label}**.`, ephemeral: true });
  }

  // ---- XOA-TAT-CA-PHONG-RANK ----
  if (commandName === 'xoa-tat-ca-phong-rank') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng.', ephemeral: true });
    }
    const mode = interaction.options.getString('che_do');
    const targetRooms = mode ? getRankRoomsByMode(mode) : getAllRankRooms();
    if (targetRooms.length === 0) {
      return interaction.reply({ content: 'ℹ️ Không có phòng rank nào để xóa.', ephemeral: true });
    }
    await interaction.reply({ content: `🗑️ Đang xóa ${targetRooms.length} phòng rank...`, ephemeral: true });
    for (const room of targetRooms) {
      if (room.panelChannelId && room.panelMessageId) {
        const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
        if (ch) {
          const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        }
      }
      clearRoomTimers(room);
      resetRoomWithCleanup(room);
      rooms.delete(room.id);
    }
    persistence.saveState(rooms, eloData);
    return interaction.followUp({ content: `✅ Đã xóa ${targetRooms.length} phòng rank.`, ephemeral: true });
  }

  // ---- TEST-FILL ----
  if (commandName === 'test-fill') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng lệnh test này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || room.isRank) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng thường "${roomId}".`, ephemeral: true });
    }
    if (room.status === 'revealed') {
      return interaction.reply({
        content: '❌ Phòng đang ở trạng thái đã phát code. Dùng /reset-room trước rồi thử lại.',
        ephemeral: true,
      });
    }

    const soNguoiInput = interaction.options.getInteger('so_nguoi');
    const cho_trong = room.capacity - room.players.size;
    const needed = Math.max(0, Math.min(soNguoiInput ?? cho_trong, cho_trong));

    if (needed <= 0) {
      return interaction.reply({ content: 'ℹ️ Phòng đã đủ người rồi (hoặc bạn xin thêm 0 người).', ephemeral: true });
    }

    const wasEmpty = room.players.size === 0;

    for (let i = 1; i <= needed; i++) {
      const fakeId = `9${Date.now()}${i}`.slice(0, 18);
      room.players.set(fakeId, { username: `TestBot${i}`, team: null, ready: true, isBot: true });
    }

    const channel = interaction.channel;
    if (wasEmpty) {
      room.firstJoinAt = Date.now();
      scheduleInactivityTimeout(room, channel);
    }

    await renderRoom(room, channel);

    if (isFull(room)) {
      await announceRoomFull(room, channel);
      scheduleReadyCountdown(room, channel);
      await tryRevealCode(room, channel);
    }

    return interaction.reply({
      content:
        `✅ Đã thêm **${needed}** người giả (auto Sẵn sàng) vào **${room.label}**.\n` +
        `Giờ bạn chỉ cần tự bấm **Gia nhập** (nếu chưa) và **Sẵn sàng** phần của mình để phòng tự phát code.`,
      ephemeral: true,
    });
  }

  // ---- TEST-FILL-RANK ----
  if (commandName === 'test-fill-rank') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng lệnh test này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || !room.isRank) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng rank "${roomId}".`, ephemeral: true });
    }
    if (room.status === 'revealed') {
      return interaction.reply({
        content: '❌ Phòng đang ở trạng thái đã phát code. Dùng /reset-room trước rồi thử lại.',
        ephemeral: true,
      });
    }

    const soNguoiInput = interaction.options.getInteger('so_nguoi');
    const cho_trong = room.capacity - room.players.size;
    const needed = Math.max(0, Math.min(soNguoiInput ?? cho_trong, cho_trong));

    if (needed <= 0) {
      return interaction.reply({ content: 'ℹ️ Phòng đã đủ người rồi (hoặc bạn xin thêm 0 người).', ephemeral: true });
    }

    const wasEmpty = room.players.size === 0;

    for (let i = 1; i <= needed; i++) {
      const fakeId = `9${Date.now()}${i}`.slice(0, 18);
      room.players.set(fakeId, { username: `TestBot${i}`, team: null, ready: true, isBot: true });
    }

    const channel = interaction.channel;
    if (wasEmpty) {
      room.firstJoinAt = Date.now();
      scheduleInactivityTimeout(room, channel);
    }

    await renderRoom(room, channel);

    if (isFull(room)) {
      await announceRoomFull(room, channel);
      scheduleReadyCountdown(room, channel);
      await tryRevealCode(room, channel);
    }

    return interaction.reply({
      content:
        `✅ Đã thêm **${needed}** người giả (auto Sẵn sàng) vào **${room.label}** (phòng rank).\n` +
        `Giờ bạn chỉ cần tự bấm **Gia nhập** (nếu chưa) và **Sẵn sàng** phần của mình để phòng tự phát code.`,
      ephemeral: true,
    });
  }

  // ---- TEST-FILL-AN ----
  if (commandName === 'test-fill-an') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng lệnh test này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getHiddenRoom(roomId);
    if (!room) {
      return interaction.reply({
        content: `❌ Không tìm thấy phòng ẩn "${roomId}" — dùng \`/danh-sach-phong-an\` để xem ID chính xác.`,
        ephemeral: true,
      });
    }
    if (room.status === 'revealed') {
      return interaction.reply({
        content: '❌ Phòng đang ở trạng thái đã phát code. Dùng /reset-room trước rồi thử lại.',
        ephemeral: true,
      });
    }

    const soNguoiInput = interaction.options.getInteger('so_nguoi');
    const cho_trong = room.capacity - room.players.size;
    const needed = Math.max(0, Math.min(soNguoiInput ?? cho_trong, cho_trong));

    if (needed <= 0) {
      return interaction.reply({ content: 'ℹ️ Phòng đã đủ người rồi (hoặc bạn xin thêm 0 người).', ephemeral: true });
    }

    const wasEmpty = room.players.size === 0;

    for (let i = 1; i <= needed; i++) {
      const fakeId = `9${Date.now()}${i}`.slice(0, 18);
      room.players.set(fakeId, { username: `TestBot${i}`, team: null, ready: true, isBot: true });
    }

    const channel = interaction.channel;
    if (wasEmpty) {
      room.firstJoinAt = Date.now();
      scheduleInactivityTimeout(room, channel);
    }

    await renderRoom(room, channel);

    if (isFull(room)) {
      await announceRoomFull(room, channel);
      scheduleReadyCountdown(room, channel);
      await tryRevealCode(room, channel);
    }

    return interaction.reply({
      content:
        `✅ Đã thêm **${needed}** người giả (auto Sẵn sàng) vào **${room.label}** (phòng ẩn).\n` +
        `Giờ bạn chỉ cần tự bấm **Gia nhập** (nếu chưa) và **Sẵn sàng** phần của mình để phòng tự phát code.`,
      ephemeral: true,
    });
  }

  // ---- XOA-SETUP-PHONG ----
  if (commandName === 'xoa-setup-phong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng.', ephemeral: true });
    }
    const mode = interaction.options.getString('che_do');
    const targetRooms = mode ? getNormalRoomsByMode(mode) : getAllNormalRooms();

    await interaction.reply({
      content: `🗑️ Đang xóa panel của ${targetRooms.length} phòng thường...`,
      ephemeral: true,
    });

    let deletedCount = 0;
    for (const room of targetRooms) {
      if (room.panelChannelId && room.panelMessageId) {
        const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
        if (ch) {
          const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null);
          if (msg) {
            await msg.delete().catch(() => {});
            deletedCount++;
          }
        }
      }
      resetRoomWithCleanup(room);
      room.panelChannelId = null;
      room.panelMessageId = null;
    }
    persistence.saveState(rooms, eloData);

    return interaction.followUp({
      content: `✅ Đã xóa **${deletedCount}** panel và reset **${targetRooms.length}** phòng thường. Dùng /setup để đăng lại.`,
      ephemeral: true,
    });
  }

  // ---- DON-RAC ----
  if (commandName === 'don-rac') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng.', ephemeral: true });
    }
    const soLuong = interaction.options.getInteger('so_luong') || 50;
    const channel = interaction.channel;

    await interaction.reply({
      content: `🧹 Đang dọn tối đa ${soLuong} tin nhắn gần nhất (tự bỏ qua panel phòng đang hoạt động trong kênh này)...`,
      ephemeral: true,
    });

    try {
      const protectedPanelIds = new Set(
        getAllRooms()
          .filter((r) => r.panelChannelId === channel.id && r.panelMessageId)
          .map((r) => r.panelMessageId)
      );

      const batch = await channel.messages.fetch({ limit: soLuong });
      const toDelete = batch.filter((m) => !protectedPanelIds.has(m.id));
      const skippedPanels = batch.size - toDelete.size;

      let deletedCount = 0;
      if (toDelete.size === 1) {
        await toDelete.first().delete().catch(() => {});
        deletedCount = 1;
      } else if (toDelete.size > 1) {
        const deleted = await channel.bulkDelete(toDelete, true);
        deletedCount = deleted.size;
      }

      return interaction.followUp({
        content:
          `✅ Đã xóa **${deletedCount}** tin nhắn (Discord chỉ cho xóa hàng loạt tin nhắn dưới 14 ngày tuổi, tin cũ hơn sẽ bị bỏ qua).` +
          (skippedPanels > 0 ? `\n🛡️ Đã bỏ qua **${skippedPanels}** panel phòng đang hoạt động để không bị mất.` : ''),
        ephemeral: true,
      });
    } catch (err) {
      console.error('Lỗi don-rac:', err);
      return interaction.followUp({
        content: '⚠️ Không xóa được — có thể bot thiếu quyền **Manage Messages** trong kênh này, hoặc tin nhắn quá cũ.',
        ephemeral: true,
      });
    }
  }

  // ---- XOA-TIN-NHAN-BOT ----
  if (commandName === 'xoa-tin-nhan-bot') {
    const allowed = await isAdminAnywhere(interaction);
    if (!allowed) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng.', ephemeral: true });
    }
    const soLuong = interaction.options.getInteger('so_luong');
    const channel = interaction.channel;
    const isDM = !interaction.guild;
    const noiChung = isDM ? 'trong DM này' : 'trong kênh này';
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

    const protectedPanelIds = isDM
      ? new Set()
      : new Set(
          getAllRooms()
            .filter((r) => r.panelChannelId === channel.id && r.panelMessageId)
            .map((r) => r.panelMessageId)
        );
    let skippedPanels = 0;

    await interaction.reply({
      content: soLuong
        ? `🧹 Đang xóa tối đa **${soLuong}** tin nhắn của Bot ${noiChung}...`
        : `🧹 Đang xóa **TẤT CẢ** tin nhắn của Bot ${noiChung} (có thể mất một lúc nếu nhiều tin cũ)...`,
      ephemeral: true,
    });

    let totalDeleted = 0;
    let lastId;
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
        if (soLuong && botMsgs.length > soLuong - totalDeleted) {
          botMsgs = botMsgs.slice(0, soLuong - totalDeleted);
        }

        if (botMsgs.length > 0) {
          if (isDM) {
            for (const msg of botMsgs) {
              await msg.delete().catch(() => {});
              totalDeleted += 1;
              await new Promise((resolve) => setTimeout(resolve, 350));
            }
          } else {
            const now = Date.now();
            const recent = botMsgs.filter((m) => now - m.createdTimestamp < TWO_WEEKS_MS);
            const old = botMsgs.filter((m) => now - m.createdTimestamp >= TWO_WEEKS_MS);

            if (recent.length === 1) {
              await recent[0].delete().catch(() => {});
              totalDeleted += 1;
            } else if (recent.length > 1) {
              const deleted = await channel.bulkDelete(recent, true).catch(() => new Map());
              totalDeleted += deleted.size;
            }
            for (const msg of old) {
              await msg.delete().catch(() => {});
              totalDeleted += 1;
            }
          }
        }

        if (batch.size < 100) break;
      }
    } catch (err) {
      console.error('Lỗi xoa-tin-nhan-bot:', err);
    }

    return interaction.followUp({
      content:
        `✅ Đã xóa **${totalDeleted}** tin nhắn của Bot ${noiChung}.` +
        (skippedPanels > 0 ? `\n🛡️ Đã bỏ qua **${skippedPanels}** panel phòng đang hoạt động để không bị mất.` : ''),
      ephemeral: true,
    });
  }

  // ---- XOA-PHONG-THUONG ----
  if (commandName === 'xoa-phong-thuong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || room.hidden) {
      return interaction.reply({
        content: `❌ Không tìm thấy phòng thường "${roomId}".`,
        ephemeral: true,
      });
    }

    if (room.panelChannelId && room.panelMessageId) {
      const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    }

    const result = removeExtraRoom(roomId);
    if (!result.ok) {
      if (result.reason === 'protected') {
        return interaction.reply({
          content: `❌ **${room.label}** nằm trong ${config.ROOMS_PER_MODE} phòng gốc (mặc định), không xóa hẳn được — dùng \`/reset-room\` nếu chỉ muốn đưa phòng về trạng thái trống.`,
          ephemeral: true,
        });
      }
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }

    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã xóa hẳn **${result.room.label}** (\`${result.room.id}\`).`, ephemeral: true });
  }

  // ---- XOA-TAT-CA-PHONG-THUONG ----
  if (commandName === 'xoa-tat-ca-phong-thuong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng.', ephemeral: true });
    }
    const mode = interaction.options.getString('che_do');
    const targetRooms = mode ? getNormalRoomsByMode(mode) : getAllNormalRooms();
    if (targetRooms.length === 0) {
      return interaction.reply({
        content: mode ? `ℹ️ Chế độ **${mode.toUpperCase()}** hiện không có phòng thường nào.` : 'ℹ️ Hiện không có phòng thường nào để xóa.',
        ephemeral: true,
      });
    }

    await interaction.reply({ content: `🗑️ Đang xóa toàn bộ **${targetRooms.length}** phòng thường...`, ephemeral: true });

    let deletedCount = 0;
    for (const room of targetRooms) {
      if (room.panelChannelId && room.panelMessageId) {
        const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
        if (ch) {
          const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        }
      }
      clearRoomTimers(room);
      resetRoomWithCleanup(room);
      rooms.delete(room.id);
      deletedCount += 1;
    }

    persistence.saveState(rooms, eloData);
    return interaction.followUp({
      content: `✅ Đã xóa hẳn **${deletedCount}** phòng thường${mode ? ` (chế độ ${mode.toUpperCase()})` : ' (cả 3v3 lẫn 5v5)'}. Dùng \`/setup\` để tạo phòng mới khi cần.`,
      ephemeral: true,
    });
  }

  // ---- RESET-TAT-CA-PHONG ----
  if (commandName === 'reset-tat-ca-phong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng.', ephemeral: true });
    }

    const allRoomsNow = getAllNormalRooms();
    await interaction.reply({ content: `♻️ Đang reset toàn bộ ${allRoomsNow.length} phòng thường...`, ephemeral: true });

    for (const room of allRoomsNow) {
      resetRoomWithCleanup(room);
      const channel =
        (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) ||
        interaction.channel;
      await renderRoom(room, channel);
    }
    persistence.saveState(rooms, eloData);

    return interaction.followUp({ content: `✅ Đã reset toàn bộ ${allRoomsNow.length} phòng thường.`, ephemeral: true });
  }

  // ---- RESET-ROOM ----
  if (commandName === 'reset-room') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới ép reset phòng được.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }
    resetRoomWithCleanup(room);
    const channel =
      (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) ||
      interaction.channel;
    await renderRoom(room, channel);
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã ép reset **${room.label}**.`, ephemeral: true });
  }
}

// ===== MODAL SUBMIT =====
async function handleModalSubmit(interaction) {
  if (!interaction.customId.startsWith('submitresult_')) return;

  console.log('🔍 Modal submit received for room:', interaction.customId);

  const roomId = interaction.customId.replace('submitresult_', '');
  const room = getRoom(roomId);
  if (!room || !room.isRank) {
    try {
      return await interaction.reply({ content: '❌ Phòng không tồn tại hoặc không phải rank.', ephemeral: true });
    } catch (e) {
      console.error('❌ Lỗi reply khi room không tồn tại:', e);
      return;
    }
  }

  const imageUrl = interaction.fields.getTextInputValue('image');
  if (!imageUrl) {
    try {
      return await interaction.reply({ content: '❌ Bạn chưa nhập link ảnh.', ephemeral: true });
    } catch (e) {
      console.error('❌ Lỗi reply khi thiếu ảnh:', e);
      return;
    }
  }

  if (isImageUsedRecently(imageUrl, interaction.user.id)) {
    return interaction.reply({
      content: '❌ Ảnh này đã được sử dụng trong vòng 90 ngày qua. Vui lòng chụp ảnh mới!',
      ephemeral: true,
    });
  }

  try {
    await interaction.deferReply({ ephemeral: true });
    console.log('✅ Defer thành công, bắt đầu OCR...');
  } catch (err) {
    console.error('❌ Defer reply lỗi:', err);
    try {
      await interaction.reply({
        content: '⚠️ Bot đã quá thời gian xử lý. Vui lòng thử lại ngay (mở modal và gửi nhanh trong vòng vài phút).',
        ephemeral: true,
      });
    } catch (e2) {
      console.error('❌ Không thể gửi phản hồi:', e2);
    }
    return;
  }

  if (config.LOG_CHANNEL_ID) {
    try {
      const logChannel = await client.channels.fetch(config.LOG_CHANNEL_ID);
      if (logChannel) {
        await logChannel.send({
          content: `📸 **${interaction.user.tag}** (<@${interaction.user.id}>) gửi ảnh qua modal cho phòng **${room.id}** (${room.label}) tại <t:${Math.floor(Date.now()/1000)}>`,
          files: [imageUrl],
        });
        console.log('✅ Đã forward ảnh vào kênh log');
      }
    } catch (err) {
      console.error('❌ Không thể forward ảnh vào kênh log:', err.message);
    }
  }

  addImageHistory(imageUrl, interaction.user.id, room.id);

  let ocrText = '';
  try {
    console.log('📥 Gọi OCR.space...');
    ocrText = await ocrImage(imageUrl);
    console.log('✅ OCR nhận được text dài:', ocrText ? ocrText.length : 0);
  } catch (err) {
    console.error('❌ OCR error:', err.message, err.code ? `(code: ${err.code})` : '', err.response ? `(status: ${err.response.status})` : '');
    if (err.message === 'MISSING_OCR_API_KEY') {
      return interaction.editReply({ content: '❌ Bot chưa được cấu hình OCR. Vui lòng báo admin thêm API key.' });
    }
    return interaction.editReply({
      content: '❌ Lỗi khi xử lý ảnh. Vui lòng thử lại hoặc dùng /admin-submit-result.',
    });
  }

  if (!ocrText) {
    return interaction.editReply({
      content: '❌ Không thể đọc được ảnh. Vui lòng kiểm tra link ảnh (phải là link trực tiếp, ví dụ: https://i.postimg.cc/xxx/... ) hoặc nhờ admin gửi thay (dùng /admin-submit-result).',
    });
  }

  const session = rankSessions.getActiveSessionByRoomId(roomId);
  if (!session) {
    return interaction.editReply({ content: '❌ Phiên chơi này đã hết hạn hoặc không tồn tại.' });
  }

  const fakeRoom = { players: new Map(session.players) };
  const kdaMap = extractAllKDAResult(ocrText, fakeRoom);
  if (kdaMap.size === 0) {
    return interaction.editReply({
      content: '❌ Không tìm thấy KDA của bất kỳ ai trong ảnh. Vui lòng kiểm tra ảnh hoặc nhờ admin gửi thay.',
    });
  }

  let result = null;
  const resultMatch = ocrText.match(/(VICTORY|DEFEAT|victory|defeat|Chiến thắng|Thất bại|CHIẾN THẮNG|THẤT BẠI|WIN|LOSE)/);
  if (resultMatch) {
    const raw = resultMatch[1].toLowerCase();
    if (raw.includes('victory') || raw.includes('chiến thắng') || raw === 'win') result = 'win';
    else if (raw.includes('defeat') || raw.includes('thất bại') || raw === 'lose') result = 'loss';
  }
  if (!result) {
    return interaction.editReply({
      content: '❌ Không tìm thấy kết quả trận đấu (VICTORY/DEFEAT) trong ảnh.',
    });
  }

  const senderId = interaction.user.id;
  const senderKDA = kdaMap.get(senderId);
  if (!senderKDA) {
    return interaction.editReply({
      content: `⚠️ Không tìm thấy IGN của bạn (${interaction.user.username}) trong ảnh. Đã lưu KDA cho người khác. Vui lòng kiểm tra IGN đã đăng ký khớp với tên trong ảnh chưa.\nĐể đăng ký IGN, dùng \`/register-ign <tên_game>\`.`,
    });
  }

  const saved = rankSessions.addResult(session.id, senderId, {
    result,
    kill: senderKDA.kill,
    death: senderKDA.death,
    assist: senderKDA.assist,
    kda: senderKDA.death === 0 ? senderKDA.kill + senderKDA.assist : (senderKDA.kill + senderKDA.assist) / senderKDA.death,
    imageUrl,
  });
  if (!saved) {
    return interaction.editReply({ content: '❌ Không thể lưu kết quả (session có thể đã hết hạn).' });
  }

  await finalizeRankSessionIfReady(session, room, roomId, kdaMap);

  persistence.saveState(rooms, eloData);

  await interaction.editReply({
    content: `✅ Đã ghi nhận kết quả **${result === 'win' ? 'Thắng' : 'Thua'}** cho bạn.`,
  });
  console.log('✅ Kết quả đã lưu cho user', interaction.user.id);
}

// ===== BUTTON =====
async function handleButton(interaction) {
  const { customId } = interaction;

  if (customId === 'menu_3v3' || customId === 'menu_5v5') {
    const mode = customId.split('_')[1];
    const roomsOfMode = getRoomsByMode(mode);
    if (roomsOfMode.length === 0) {
      return interaction.reply({
        content: t(interaction,
          `⚠️ Hiện chưa có phòng **${mode.toUpperCase()}** nào — chờ admin tạo phòng bằng \`/setup\`.`,
          `⚠️ There are no **${mode.toUpperCase()}** rooms yet — wait for an admin to create some with \`/setup\`.`
        ),
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: t(interaction,
        `Chọn 1 trong ${roomsOfMode.length} phòng **${mode.toUpperCase()}** để tham gia:`,
        `Pick one of the ${roomsOfMode.length} **${mode.toUpperCase()}** rooms to join:`
      ),
      components: roomListRows(roomsOfMode),
      ephemeral: true,
    });
  }

  if (customId.startsWith('openroom_')) {
    return joinRoom(interaction, customId.replace('openroom_', ''));
  }
  if (customId.startsWith('join_')) {
    return joinRoom(interaction, customId.replace('join_', ''));
  }
  if (customId.startsWith('leave_')) {
    return leaveRoom(interaction, customId.replace('leave_', ''));
  }
  if (customId.startsWith('ready_')) {
    return toggleReady(interaction, customId.replace('ready_', ''));
  }
  if (customId.startsWith('team1_') || customId.startsWith('team2_') || customId.startsWith('teamnone_')) {
    const [tag, roomId] = splitTeamCustomId(customId);
    return setTeam(interaction, roomId, tag);
  }
  if (customId.startsWith('copycode_')) {
    return giveCode(interaction, customId.replace('copycode_', ''));
  }
  if (customId.startsWith('translate_')) {
    const roomId = customId.replace('translate_', '');
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ This room does not exist.'), ephemeral: true });
    return interaction.reply({
      content: '🌐 English buttons (only visible to you):',
      components: roomActionRowsEN(room),
      ephemeral: true,
    });
  }
  if (customId.startsWith('hiddeninvitebtn_')) {
    const roomId = customId.replace('hiddeninvitebtn_', '');
    const room = getHiddenRoom(roomId);
    if (!room) return interaction.reply({ content: '❌ Phòng ẩn này không tồn tại (có thể đã bị xóa).', ephemeral: true });
    const isAdminNow = await isAdminUserId(interaction.user.id);
    if (!isAdminNow) {
      return interaction.reply({ content: '❌ Chỉ admin mới mời thêm người vào phòng ẩn được.', ephemeral: true });
    }
    if (!interaction.guild) {
      return interaction.reply({
        content:
          '⚠️ Không thể hiện đủ danh sách thành viên khi mời từ trong DM (Discord giới hạn khiến menu chọn người ở đây chỉ thấy được vài người, không phải cả server).\n' +
          `👉 Vào **1 kênh trong server** và gõ \`/moi-phong-an phong:${room.id}\` — lệnh đó sẽ hiện menu chọn được đầy đủ, tìm kiếm được, tối đa 25 người mỗi lần (đủ dùng nhiều lần nếu cần mời hơn 25 người).`,
        ephemeral: true,
      });
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(`hiddeninvite_${room.id}`)
      .setPlaceholder(`Chọn người muốn mời vào ${room.label}`)
      .setMinValues(1)
      .setMaxValues(25);
    return interaction.reply({
      content: `📨 Chọn (nhiều) người muốn mời riêng vào **${room.label}** (tối đa 25 người/lần — chạy lại nút này nếu cần mời thêm):`,
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
  }
  if (customId.startsWith('invite_')) {
    const roomId = customId.replace('invite_', '');
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ This room does not exist.'), ephemeral: true });
    if (room.status === 'revealed') {
      return interaction.reply({
        content: t(interaction, '❌ Phòng đã phát code, không mời thêm được nữa.', "❌ The code has been revealed, you can't invite anyone else now."),
        ephemeral: true,
      });
    }
    if (isFull(room)) {
      return interaction.reply({ content: t(interaction, '❌ Phòng đã đầy rồi.', '❌ This room is full.'), ephemeral: true });
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(`inviteselect_${room.id}`)
      .setPlaceholder(t(interaction, 'Chọn (nhiều) bạn muốn mời vào phòng này', 'Pick friends to invite to this room'))
      .setMinValues(1)
      .setMaxValues(25);
    return interaction.reply({
      content: t(interaction, `📨 Chọn người bạn muốn mời vào **${room.label}**:`, `📨 Pick a friend to invite to **${room.label}**:`),
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
  }

  // ===== NÚT GỬI KẾT QUẢ (CẢI TIẾN UX) =====
  if (customId.startsWith('submit_result_')) {
    const roomId = customId.replace('submit_result_', '');
    const room = getRoom(roomId);
    if (!room || !room.isRank) {
      return interaction.reply({ content: '❌ Phòng không tồn tại hoặc không phải rank.', ephemeral: true });
    }
    const session = rankSessions.getActiveSessionByRoomId(roomId);
    if (!session) {
      return interaction.reply({ content: '❌ Phiên chơi này đã hết hạn hoặc không tồn tại.', ephemeral: true });
    }
    if (!session.players.some(([id]) => id === interaction.user.id)) {
      return interaction.reply({ content: '❌ Bạn không có trong phiên chơi này.', ephemeral: true });
    }
    if (session.resultMap.has(interaction.user.id)) {
      return interaction.reply({ content: 'ℹ️ Bạn đã gửi kết quả rồi.', ephemeral: true });
    }

    const command = `/submit-result phong:${room.id}`;
    const helpMessage = 
      `📷 **Gửi kết quả trận đấu**\n` +
      `Sao chép lệnh bên dưới và gửi vào kênh này, **kèm theo ảnh chụp màn hình kết quả (VICTORY/DEFEAT + KDA)**:\n\n` +
      `\`\`\`${command}\`\`\`\n` +
      `Sau đó, nhấp vào ô **"hinhanh"** và chọn file ảnh từ máy tính.`;

    return interaction.reply({
      content: helpMessage,
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
    if (!room) {
      return interaction.update({ content: '❌ Phòng ẩn này không tồn tại (có thể đã bị xóa).', components: [] });
    }
    const isAdminNow = await isAdminUserId(interaction.user.id);
    if (!isAdminNow) {
      return interaction.update({ content: '❌ Chỉ admin mới mời thêm người vào phòng ẩn được.', components: [] });
    }
    const targets = interaction.users;
    if (!targets || targets.size === 0) {
      return interaction.update({ content: '❌ Chưa chọn ai cả.', components: [] });
    }
    const invited = [];
    const failed = [];
    for (const targetUser of targets.values()) {
      const already = room.panelTargets.some((t) => t.userId === targetUser.id);
      if (already) {
        invited.push(targetUser.id);
        continue;
      }
      try {
        await sendHiddenRoomDM(
          room,
          targetUser,
          `📨 Bạn được **admin mời riêng** vào một phòng ẩn: **${room.label}** — chỉ bạn và những người được mời mới thấy phòng này.`
        );
        invited.push(targetUser.id);
      } catch (err) {
        console.error('Không DM được cho', targetUser.id, err);
        failed.push(targetUser.id);
      }
    }
    let summary = invited.length
      ? `✅ Đã gửi lời mời phòng ẩn **${room.label}** cho ${invited.length} người: ${invited.map((id) => `<@${id}>`).join(' ')}.`
      : '';
    if (failed.length) {
      summary += `${summary ? '\n' : ''}⚠️ Không DM được cho: ${failed.map((id) => `<@${id}>`).join(' ')} (có thể họ tắt DM từ thành viên server).`;
    }
    return interaction.update({ content: summary || '❌ Không mời được ai cả.', components: [] });
  }

  if (!customId.startsWith('inviteselect_')) return;

  const roomId = customId.replace('inviteselect_', '');
  const room = getRoom(roomId);
  if (!room) return interaction.update({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ This room does not exist.'), components: [] });

  const targets = interaction.users;
  if (!targets || targets.size === 0) {
    return interaction.update({ content: t(interaction, '❌ Chưa chọn ai cả.', "❌ You didn't pick anyone."), components: [] });
  }
  if (room.status === 'revealed') {
    return interaction.update({
      content: t(interaction, '❌ Phòng đã phát code, không mời thêm được nữa.', "❌ The code has been revealed, you can't invite anyone else now."),
      components: [],
    });
  }
  if (isFull(room)) {
    return interaction.update({ content: t(interaction, '❌ Phòng đã đầy rồi.', '❌ This room is full.'), components: [] });
  }

  const invitedIds = [];
  const skipped = [];
  for (const targetUser of targets.values()) {
    if (targetUser.id === interaction.user.id) {
      skipped.push(t(interaction, `<@${targetUser.id}> (chính bạn)`, `<@${targetUser.id}> (yourself)`));
      continue;
    }
    if (isBanned(room, targetUser.id)) {
      skipped.push(
        t(interaction, `<@${targetUser.id}> (đang bị cấm khỏi phòng)`, `<@${targetUser.id}> (banned from this room)`)
      );
      continue;
    }
    invitedIds.push(targetUser.id);
  }

  if (invitedIds.length === 0) {
    return interaction.update({
      content:
        t(interaction, '❌ Không mời được ai cả.', '❌ Could not invite anyone.') +
        (skipped.length ? `\n${t(interaction, 'Bỏ qua', 'Skipped')}: ${skipped.join(', ')}` : ''),
      components: [],
    });
  }

  const joinRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_${room.id}`)
      .setLabel('Tham gia ngay')
      .setStyle(ButtonStyle.Success)
      .setEmoji('➕')
  );

  const mentionList = invitedIds.map((id) => `<@${id}>`).join(' ');
  await interaction.channel.send({
    content: t(
      interaction,
      `📨 <@${interaction.user.id}> mời ${mentionList} vào **${room.label}** (${room.players.size}/${room.capacity})!`,
      `📨 <@${interaction.user.id}> invited ${mentionList} to **${room.label}** (${room.players.size}/${room.capacity})!`
    ),
    components: [joinRow],
  });

  let summary = t(
    interaction,
    `✅ Đã mời **${invitedIds.length}** người: ${mentionList}.`,
    `✅ Invited **${invitedIds.length}** people: ${mentionList}.`
  );
  if (skipped.length) {
    summary += `\n⚠️ ${t(interaction, 'Bỏ qua', 'Skipped')}: ${skipped.join(', ')}`;
  }

  return interaction.update({ content: summary, components: [] });
}

// ===== CÁC HÀM PHỤ TRỢ =====
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
  if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ This room does not exist.'), ephemeral: true });
  if (isBanned(room, interaction.user.id)) {
    return interaction.reply({
      content: t(interaction,
        `❌ Bạn đã bị cấm tham gia **${room.label}** (vẫn vào được các phòng khác bình thường).`,
        `❌ You're banned from **${room.label}** (you can still join other rooms).`
      ),
      ephemeral: true,
    });
  }
  if (interaction.member && config.JOIN_ROLE_ID && !interaction.member.roles?.cache?.has(config.JOIN_ROLE_ID)) {
    return interaction.reply({
      content: t(interaction,
        `❌ Bạn cần role <@&${config.JOIN_ROLE_ID}> mới được tham gia phòng.`,
        `❌ You need the <@&${config.JOIN_ROLE_ID}> role to join a room.`
      ),
      ephemeral: true,
    });
  }
  const existing = findRoomOfUser(interaction.user.id);
  if (existing && existing.id !== room.id) {
    return interaction.reply({
      content: t(interaction,
        `⚠️ Bạn đang ở **${existing.label}** rồi. Hãy rời phòng đó trước khi vào phòng khác.`,
        `⚠️ You're already in **${existing.label}**. Leave that room first before joining another one.`
      ),
      ephemeral: true,
    });
  }
  if (existing && existing.id === room.id) {
    return interaction.reply({ content: t(interaction, 'ℹ️ Bạn đã ở trong phòng này rồi.', 'ℹ️ You are already in this room.'), ephemeral: true });
  }
  if (isFull(room)) {
    return interaction.reply({ content: t(interaction, '❌ Phòng đã đủ người.', '❌ This room is full.'), ephemeral: true });
  }
  if (room.status === 'revealed') {
    return interaction.reply({
      content: t(interaction,
        '❌ Phòng đang chuẩn bị vào game, không thể tham gia lúc này.',
        "❌ This room is about to start the game, you can't join right now."
      ),
      ephemeral: true,
    });
  }

  const wasEmpty = room.players.size === 0;
  room.players.set(interaction.user.id, {
    username: interaction.member?.displayName || interaction.user.username,
    team: null,
    ready: false,
  });

  const channel = interaction.channel;
  if (wasEmpty) {
    room.firstJoinAt = Date.now();
    scheduleInactivityTimeout(room, channel);
  }

  await renderRoom(room, channel);

  if (['3v3', '5v5'].includes(room.mode) && !room.isRank) {
    startAnnouncement(room);
  }

  if (isFull(room)) {
    await announceRoomFull(room, channel);
    scheduleReadyCountdown(room, channel);
  }

  return interaction.reply({
    content: t(interaction, `✅ Bạn đã gia nhập **${room.label}**.`, `✅ You joined **${room.label}**.`),
    ephemeral: true,
  });
}

async function leaveRoom(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ This room does not exist.'), ephemeral: true });
  if (!room.players.has(interaction.user.id)) {
    return interaction.reply({ content: t(interaction, 'ℹ️ Bạn không ở trong phòng này.', 'ℹ️ You are not in this room.'), ephemeral: true });
  }
  if (room.status === 'revealed') {
    return interaction.reply({
      content: t(interaction,
        '❌ Phòng đã phát code, không thể rời lúc này. Chờ phòng tự reset nhé.',
        "❌ The code has already been revealed, you can't leave right now. Wait for the room to reset."
      ),
      ephemeral: true,
    });
  }

  room.players.delete(interaction.user.id);
  const channel = interaction.channel;

  if (room.timers.readyCountdown && !isFull(room)) {
    clearTimeout(room.timers.readyCountdown);
    room.timers.readyCountdown = null;
    room.fullAt = null;
    if (room.timers.blink) {
      clearInterval(room.timers.blink);
      room.timers.blink = null;
      room._flashColor = null;
    }
  }

  if (room.players.size === 0) {
    stopAnnouncement(room);
    resetRoomWithCleanup(room);
  }

  await renderRoom(room, channel);
  return interaction.reply({
    content: t(interaction, `✅ Bạn đã rời **${room.label}**.`, `✅ You left **${room.label}**.`),
    ephemeral: true,
  });
}

async function toggleReady(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ This room does not exist.'), ephemeral: true });
  const player = room.players.get(interaction.user.id);
  if (!player) {
    return interaction.reply({
      content: t(interaction, '⚠️ Bạn cần **Gia nhập** phòng trước khi bấm Sẵn sàng.', '⚠️ You need to **Join** the room before hitting Ready.'),
      ephemeral: true,
    });
  }
  if (room.status === 'revealed') {
    return interaction.reply({
      content: t(interaction, 'ℹ️ Phòng đã phát code rồi, chờ vòng sau nhé.', 'ℹ️ The code has already been revealed, wait for the next round.'),
      ephemeral: true,
    });
  }
  if (!isFull(room)) {
    return interaction.reply({
      content: t(interaction,
        `⚠️ Phòng chưa đủ người (${room.players.size}/${room.capacity}) — chưa thể bấm Sẵn sàng.`,
        `⚠️ Room isn't full yet (${room.players.size}/${room.capacity}) — you can't hit Ready.`
      ),
      ephemeral: true,
    });
  }
  if (!checkCooldown(interaction.user.id)) {
    return interaction.reply({
      content: t(interaction, '⏳ Bạn thao tác hơi nhanh, đợi 1-2 giây rồi thử lại.', "⏳ You're clicking too fast, wait 1-2 seconds and try again."),
      ephemeral: true,
    });
  }

  player.ready = !player.ready;
  const channel = interaction.channel;
  await renderRoom(room, channel);
  await tryRevealCode(room, channel);

  let extra = t(interaction, '', '');
  if (room.status === 'waiting' && isFull(room) && allReady(room)) {
    extra = t(interaction,
      '\n⚖️ Team hiện chưa cân bằng nên code chưa được phát — tự đổi team hoặc chờ người khác đổi.',
      "\n⚖️ Teams aren't balanced yet so the code hasn't been revealed — change team yourself or wait for someone else to."
    );
  }

  return interaction.reply({
    content: t(interaction, player.ready ? '✅ Bạn đã sẵn sàng.' : '↩️ Bạn đã bỏ trạng thái sẵn sàng.', player.ready ? '✅ You are ready.' : '↩️ You are no longer ready.') + extra,
    ephemeral: true,
  });
}

async function setTeam(interaction, roomId, team) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ This room does not exist.'), ephemeral: true });
  const player = room.players.get(interaction.user.id);
  if (!player) {
    return interaction.reply({
      content: t(interaction, '⚠️ Bạn cần **Gia nhập** phòng trước khi chọn team.', '⚠️ You need to **Join** the room before picking a team.'),
      ephemeral: true,
    });
  }
  if (room.status === 'revealed') {
    return interaction.reply({
      content: t(interaction, 'ℹ️ Phòng đã phát code rồi, không đổi team được nữa.', "ℹ️ The code has already been revealed, you can't change team anymore."),
      ephemeral: true,
    });
  }
  if (!checkCooldown(interaction.user.id)) {
    return interaction.reply({
      content: t(interaction, '⏳ Bạn thao tác hơi nhanh, đợi 1-2 giây rồi thử lại.', "⏳ You're clicking too fast, wait 1-2 seconds and try again."),
      ephemeral: true,
    });
  }

  player.team = team;
  const channel = interaction.channel;
  await renderRoom(room, channel);
  await tryRevealCode(room, channel);

  return interaction.reply({
    content: team
      ? t(interaction, `✅ Bạn đã chọn **Team ${team}**.`, `✅ You picked **Team ${team}**.`)
      : t(interaction, '✅ Bạn chọn không phân team.', "✅ You cleared your team selection."),
    ephemeral: true,
  });
}

async function giveCode(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ This room does not exist.'), ephemeral: true });
  if (room.status !== 'revealed' || !room.code) {
    return interaction.reply({ content: t(interaction, 'ℹ️ Phòng chưa có code.', "ℹ️ This room doesn't have a code yet."), ephemeral: true });
  }
  const personal = formatPersonalCode(room, interaction.user.id);
  if (!personal) {
    return interaction.reply({ content: t(interaction, '⚠️ Bạn không nằm trong phòng này.', '⚠️ You are not in this room.'), ephemeral: true });
  }
  await interaction.reply({
    content: t(interaction,
      '🔑 Code của bạn (tin nhắn ngay bên dưới, bấm giữ để copy):',
      '🔑 Your code (message right below, tap and hold to copy):'
    ),
    ephemeral: true,
  });
  return interaction.followUp({
    content: personal,
    ephemeral: true,
  });
}

// ===== KEEP-ALIVE HTTP SERVER =====
startKeepAliveServer();
startSelfPing();

// ===== KHỞI TẠO PHÒNG + KHÔI PHỤC ELO TỪ SUPABASE =====
async function bootstrap() {
  initRooms();
  const rankDefault = config.DEFAULT_RANK_ROOMS_PER_MODE || 0;
  if (rankDefault > 0) {
    for (const mode of Object.keys(config.CAPACITY)) {
      addRankRoomsToMode(mode, rankDefault);
    }
  }
  console.log(`ℹ️ Đã khởi tạo ${rooms.size} phòng (${rankDefault > 0 ? 'gồm cả rank' : 'chỉ phòng thường'}).`);

  const eloMap = await eloStore.loadAllElo();
  if (eloStore.isEnabled()) {
    console.log(`✅ Đã kết nối Supabase (${eloMap.size} người chơi có ELO đã lưu).`);
    if (eloMap.size > 0) restoreEloData(eloMap);
  } else {
    console.warn('⚠️ Supabase chưa được cấu hình — ELO sẽ KHÔNG được lưu bền vững qua deploy.');
  }

  await client.login(config.TOKEN);
  console.log(`=== BOT DISCORD ĐÃ ONLINE THÀNH CÔNG: ${client.user.tag} ===`);
}

bootstrap().catch((err) => console.error('=== LỖI KHỞI ĐỘNG BOT ===', err));

process.on('unhandledRejection', (err) => {
  console.error('=== UNHANDLED REJECTION ===', err);
});