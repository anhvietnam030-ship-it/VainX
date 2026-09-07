// Fix: ưu tiên IPv4
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const axios = require('axios');
const FormData = require('form-data');
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
  // Rank exports
  eloData,
  getElo,
  updateElo,
  calculateNewElo,
  addRankRoomsToMode,
  removeRankRoom,
  getAllRankRooms,
  getRankRoomsByMode,
  // Filter functions
  getAllNormalRooms,
  getNormalRoomsByMode,
} = require('./src/rooms');
const { mainMenuEmbed, mainMenuRow, roomListRows, roomEmbed, roomActionRows, roomActionRowsEN } = require('./src/ui');
const persistence = require('./src/persistence');
const { startKeepAliveServer, startSelfPing } = require('./src/keepalive');

// ===== OCR HELPERS (OCR.space - upload file) =====
const OCR_API_KEY = process.env.OCR_API_KEY || config.OCR_API_KEY;

async function ocrImage(imageUrl) {
  if (!OCR_API_KEY) {
    console.error('❌ OCR_API_KEY chưa được cấu hình trong .env hoặc config.js');
    return '';
  }
  try {
    // Bước 1: Tải ảnh từ Discord về dưới dạng buffer
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

    // Bước 2: Gửi lên OCR.space dưới dạng file upload
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
    if (data.IsErroredOnProcessing) {
      console.error('❌ OCR.space error:', data.ErrorMessage);
      return '';
    }
    const text = data.ParsedResults?.[0]?.ParsedText || '';
    console.log(`✅ OCR thành công, nhận được ${text.length} ký tự`);
    return text;
  } catch (err) {
    console.error('❌ OCR.space request failed:', err.message);
    if (err.response) {
      console.error('Response status:', err.response.status);
      console.error('Response data:', err.response.data);
    }
    return '';
  }
}

function extractKDAResult(text) {
  // Tìm KDA dạng kill/death/assist
  const kdaMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
  let kda = null;
  let kill, death, assist;
  if (kdaMatch) {
    kill = parseInt(kdaMatch[1], 10);
    death = parseInt(kdaMatch[2], 10);
    assist = parseInt(kdaMatch[3], 10);
    kda = death === 0 ? kill + assist : (kill + assist) / death;
  }
  // Tìm kết quả: VICTORY / DEFEAT
  const resultMatch = text.match(/(VICTORY|DEFEAT|victory|defeat)/);
  let result = null;
  if (resultMatch) {
    result = resultMatch[1].toLowerCase();
    if (result === 'victory') result = 'win';
    else if (result === 'defeat') result = 'loss';
  }
  return { kda, kill, death, assist, result };
}

// ===== CÁC HÀM TIỆN ÍCH =====
function t(interaction, vi, en) {
  return interaction.locale === 'vi' ? vi : en;
}

function bi(vi, en) {
  return `${vi}\n🌐 ${en}`;
}

startKeepAliveServer();
startSelfPing();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
initRooms();

// Khôi phục state
const loadedState = persistence.loadState();
loadedState.rooms.forEach((data, id) => {
  let room = getRoom(id);
  if (!room) {
    const match = /^(3v3|5v5)-(\d+)$/.exec(id);
    if (match) room = ensureRoom(match[1], parseInt(match[2], 10));
  }
  if (!room) return;
  room.status = data.status || 'waiting';
  room.code = data.code || null;
  room.revealedAt = data.revealedAt || null;
  room.firstJoinAt = data.firstJoinAt || null;
  room.fullAt = data.fullAt || null;
  room.panelChannelId = data.panelChannelId || null;
  room.panelMessageId = data.panelMessageId || null;
  room.timeoutMs = data.timeoutMs || config.DEFAULT_ROOM_TIMEOUT_MS;
  room.players = new Map(
    (data.players || []).map((p) => [p.id, { username: p.username, team: p.team, ready: p.ready }])
  );
  room.bannedUsers = new Set(data.bannedUsers || []);
  if (data.isRank) {
    room.isRank = true;
    room.resultMap = new Map(data.resultMap || []);
    room.resultWindowEnd = data.resultWindowEnd || null;
  }
});
loadedState.eloData.forEach((data, userId) => {
  eloData.set(userId, data);
});

// Cooldown
const lastActionAt = new Map();
function checkCooldown(userId) {
  const now = Date.now();
  const last = lastActionAt.get(userId) || 0;
  if (now - last < config.ACTION_COOLDOWN_MS) return false;
  lastActionAt.set(userId, now);
  return true;
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
      resetRoom(room);
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
    resetRoom(room);
  } else {
    room.firstJoinAt = Date.now();
    scheduleInactivityTimeout(room, channel);
  }
  await renderRoom(room, channel);
}

// ===== XỬ LÝ KẾT THÚC CỬA SỔ 45 PHÚT (RANK) =====
async function handleResultWindowEnd(room) {
  if (!room.isRank) return;
  if (room.status !== 'revealed') return;

  const channel = (room.panelChannelId && await client.channels.fetch(room.panelChannelId).catch(() => null)) || null;
  const players = Array.from(room.players.keys());
  const results = room.resultMap;

  const eloUpdates = [];
  for (const userId of players) {
    const resultData = results.get(userId);
    if (!resultData) continue;

    const userEloObj = getElo(userId);
    const userElo = userEloObj.elo;
    const opponentIds = players.filter(id => id !== userId);
    const opponentElos = opponentIds.map(id => {
      const e = getElo(id).elo;
      return e === null ? config.RANK_DEFAULT_ELO : e;
    });
    const newElo = calculateNewElo(userElo, opponentElos, resultData.result, resultData.kda);
    updateElo(userId, newElo);
    eloUpdates.push({
      userId,
      oldElo: userElo === null ? config.RANK_DEFAULT_ELO : userElo,
      newElo,
      result: resultData.result,
      kda: resultData.kda,
    });
  }

  persistence.saveState(rooms, eloData);

  if (channel) {
    let msg = `📊 **${room.label}** đã kết thúc! Kết quả Elo (có điều chỉnh KDA):\n`;
    for (const upd of eloUpdates) {
      const rank = getElo(upd.userId).rank;
      msg += `<@${upd.userId}>: ${upd.oldElo} → ${upd.newElo} (${upd.result}) | KDA: ${upd.kda.toFixed(2)} | Rank: ${rank}\n`;
    }
    if (eloUpdates.length === 0) msg += 'Không có kết quả nào được gửi.';
    await channel.send(msg).catch(() => {});
  }

  resetRoom(room);
  if (channel) {
    await renderRoom(room, channel);
    await channel.send(`♻️ **${room.label}** đã được reset, mời mọi người đăng ký lại.`).catch(() => {});
  }
  persistence.saveState(rooms, eloData);
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

  if (room.isRank) {
    room.resultWindowEnd = Date.now() + config.RANK_RESULT_WINDOW_MS;
    persistence.saveState(rooms, eloData);
    room.timers.resultWindow = setTimeout(() => handleResultWindowEnd(room), config.RANK_RESULT_WINDOW_MS);
  } else {
    room.timers.resetAfterCode = setTimeout(async () => {
      clearRoomTimers(room);
      resetRoom(room);
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

// ===== CLIENT READY =====
client.once('ready', async () => {
  console.log(`Đã đăng nhập với tên ${client.user.tag}`);

  for (const room of getAllRooms()) {
    if (room.players.size === 0 || !room.panelChannelId) continue;
    const channel = await client.channels.fetch(room.panelChannelId).catch(() => null);
    if (!channel) continue;

    if (room.status === 'revealed' && room.revealedAt) {
      if (room.isRank) {
        const remaining = config.RANK_RESULT_WINDOW_MS - (Date.now() - room.revealedAt);
        if (remaining <= 0) {
          await handleResultWindowEnd(room);
        } else {
          room._blinkOn = true;
          room.timers.blink = setInterval(() => {
            room._blinkOn = !room._blinkOn;
            renderRoom(room, channel).catch(() => {});
          }, config.BLINK_INTERVAL_MS);
          room.timers.resultWindow = setTimeout(() => handleResultWindowEnd(room), remaining);
        }
      } else {
        const remaining = config.CODE_RESET_DELAY_MS - (Date.now() - room.revealedAt);
        if (remaining <= 0) {
          resetRoom(room);
        } else {
          room._blinkOn = true;
          room.timers.blink = setInterval(() => {
            room._blinkOn = !room._blinkOn;
            renderRoom(room, channel).catch(() => {});
          }, config.BLINK_INTERVAL_MS);
          room.timers.resetAfterCode = setTimeout(async () => {
            clearRoomTimers(room);
            resetRoom(room);
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
          resetRoom(room);
        } else {
          scheduleInactivityTimeout(room, channel, remaining);
        }
      }
    }
    await renderRoom(room, channel);
  }
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
    console.error(err);
    const payload = { content: '⚠️ Có lỗi xảy ra, vui lòng thử lại.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
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

  // ---- SUBMIT-RESULT ----
  if (commandName === 'submit-result') {
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || !room.isRank) {
      return interaction.reply({ content: '❌ Phòng không tồn tại hoặc không phải rank.', ephemeral: true });
    }
    if (room.status !== 'revealed') {
      return interaction.reply({ content: '❌ Phòng chưa phát code hoặc đã kết thúc.', ephemeral: true });
    }
    if (!room.players.has(interaction.user.id)) {
      return interaction.reply({ content: '❌ Bạn không ở trong phòng này.', ephemeral: true });
    }
    if (Date.now() > room.resultWindowEnd) {
      return interaction.reply({ content: '❌ Đã quá hạn 45 phút.', ephemeral: true });
    }
    if (room.resultMap.has(interaction.user.id)) {
      return interaction.reply({ content: 'ℹ️ Bạn đã gửi kết quả rồi.', ephemeral: true });
    }

    const attachment = interaction.options.getAttachment('hinhanh', true);
    if (!attachment || !attachment.contentType || !attachment.contentType.startsWith('image/')) {
      return interaction.reply({ content: '❌ File đính kèm không phải là ảnh hợp lệ.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    let ocrText = '';
    try {
      ocrText = await ocrImage(attachment.url);
    } catch (err) {
      console.error('OCR error:', err);
    }

    if (!ocrText) {
      return interaction.editReply({
        content: '❌ Không thể đọc được ảnh. Vui lòng chụp rõ hơn hoặc nhờ admin gửi thay (dùng /admin-submit-result).',
      });
    }

    const { kda, kill, death, assist, result } = extractKDAResult(ocrText);
    if (!kda || !result) {
      return interaction.editReply({
        content: '❌ Không tìm thấy KDA hoặc kết quả trong ảnh. Vui lòng kiểm tra ảnh hoặc nhờ admin gửi thay.',
      });
    }

    if (Date.now() > room.resultWindowEnd) {
      return interaction.editReply({ content: '❌ Đã quá hạn 45 phút.' });
    }
    if (room.resultMap.has(interaction.user.id)) {
      return interaction.editReply({ content: 'ℹ️ Bạn đã gửi kết quả rồi.' });
    }

    room.resultMap.set(interaction.user.id, {
      result: result,
      imageUrl: attachment.url,
      submittedAt: Date.now(),
      kda: kda,
      kill: kill,
      death: death,
      assist: assist,
    });
    persistence.saveState(rooms, eloData);

    return interaction.editReply({
      content: `✅ Đã ghi nhận kết quả **${result === 'win' ? 'Thắng' : 'Thua'}**, KDA ${kill}/${death}/${assist} (${kda.toFixed(2)}) cho ${room.label}. (OCR tự động)`,
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
    if (room.status !== 'revealed') {
      return interaction.reply({ content: '❌ Phòng chưa phát code hoặc đã kết thúc.', ephemeral: true });
    }
    if (!room.players.has(targetUser.id)) {
      return interaction.reply({ content: `❌ <@${targetUser.id}> không ở trong phòng này.`, ephemeral: true });
    }
    if (Date.now() > room.resultWindowEnd) {
      return interaction.reply({ content: '❌ Đã quá hạn 45 phút.', ephemeral: true });
    }

    const parts = kdaStr.split('/').map(s => parseInt(s.trim(), 10));
    if (parts.length !== 3 || parts.some(isNaN)) {
      return interaction.reply({ content: '❌ KDA không đúng định dạng. Vui lòng nhập kill/death/assist (ví dụ: 5/2/8).', ephemeral: true });
    }
    const [kill, death, assist] = parts;
    const kda = death === 0 ? kill + assist : (kill + assist) / death;

    room.resultMap.set(targetUser.id, {
      result: result,
      imageUrl: imageUrl,
      submittedAt: Date.now(),
      kda: kda,
      kill, death, assist
    });
    persistence.saveState(rooms, eloData);

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
      rooms.delete(room.id);
    }
    persistence.saveState(rooms, eloData);
    return interaction.followUp({ content: `✅ Đã xóa ${targetRooms.length} phòng rank.`, ephemeral: true });
  }

  // ---- TEST-FILL (phòng thường) ----
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
      room.players.set(fakeId, { username: `TestBot${i}`, team: null, ready: true });
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
      room.players.set(fakeId, { username: `TestBot${i}`, team: null, ready: true });
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
      room.players.set(fakeId, { username: `TestBot${i}`, team: null, ready: true });
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
      resetRoom(room);
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
      resetRoom(room);
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
    resetRoom(room);
    const channel =
      (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) ||
      interaction.channel;
    await renderRoom(room, channel);
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã ép reset **${room.label}**.`, ephemeral: true });
  }
}

// ===== MODAL SUBMIT (OCR) =====
async function handleModalSubmit(interaction) {
  if (!interaction.customId.startsWith('submitresult_')) return;

  const roomId = interaction.customId.replace('submitresult_', '');
  const room = getRoom(roomId);
  if (!room || !room.isRank) {
    return interaction.reply({ content: '❌ Phòng không tồn tại hoặc không phải rank.', ephemeral: true });
  }

  const imageUrl = interaction.fields.getTextInputValue('image');
  if (!imageUrl) {
    return interaction.reply({ content: '❌ Bạn chưa nhập link ảnh.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  let ocrText = '';
  try {
    ocrText = await ocrImage(imageUrl);
  } catch (err) {
    console.error('OCR error:', err);
  }

  if (!ocrText) {
    return interaction.editReply({
      content: '❌ Không thể đọc được ảnh. Vui lòng kiểm tra link ảnh hoặc nhờ admin gửi thay (dùng /admin-submit-result).',
    });
  }

  const { kda, kill, death, assist, result } = extractKDAResult(ocrText);
  if (!kda || !result) {
    return interaction.editReply({
      content: '❌ Không tìm thấy KDA hoặc kết quả trong ảnh. Vui lòng kiểm tra ảnh hoặc nhờ admin gửi thay.',
    });
  }

  if (!room.players.has(interaction.user.id)) {
    return interaction.editReply({ content: '❌ Bạn không ở trong phòng này.' });
  }
  if (Date.now() > room.resultWindowEnd) {
    return interaction.editReply({ content: '❌ Đã quá hạn 45 phút.' });
  }
  if (room.resultMap.has(interaction.user.id)) {
    return interaction.editReply({ content: 'ℹ️ Bạn đã gửi kết quả rồi.' });
  }

  room.resultMap.set(interaction.user.id, {
    result: result,
    imageUrl: imageUrl,
    submittedAt: Date.now(),
    kda: kda,
    kill: kill,
    death: death,
    assist: assist,
  });
  persistence.saveState(rooms, eloData);

  await interaction.editReply({
    content: `✅ Đã ghi nhận kết quả **${result === 'win' ? 'Thắng' : 'Thua'}**, KDA ${kill}/${death}/${assist} (${kda.toFixed(2)}) cho ${room.label}. (OCR tự động)`,
  });
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

  // Nút "Gửi kết quả" trên panel rank
  if (customId.startsWith('submit_result_')) {
    const roomId = customId.replace('submit_result_', '');
    const room = getRoom(roomId);
    if (!room || !room.isRank) {
      return interaction.reply({ content: '❌ Phòng không tồn tại hoặc không phải rank.', ephemeral: true });
    }
    if (room.status !== 'revealed') {
      return interaction.reply({ content: '❌ Phòng chưa phát code hoặc đã kết thúc.', ephemeral: true });
    }
    if (!room.players.has(interaction.user.id)) {
      return interaction.reply({ content: '❌ Bạn không ở trong phòng này.', ephemeral: true });
    }
    if (Date.now() > room.resultWindowEnd) {
      return interaction.reply({ content: '❌ Đã quá hạn 45 phút.', ephemeral: true });
    }
    if (room.resultMap.has(interaction.user.id)) {
      return interaction.reply({ content: 'ℹ️ Bạn đã gửi kết quả rồi.', ephemeral: true });
    }

    return interaction.reply({
      content: `📷 Dùng lệnh \`/submit-result phong:${room.id}\` và đính kèm luôn ảnh chụp kết quả vào lệnh (Discord sẽ hiện ô "hinhanh" để bạn chọn file) — không cần dán link.`,
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
    resetRoom(room);
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

// ===== LOGIN =====
client.login(config.TOKEN)
  .then(() => console.log(`=== BOT DISCORD ĐÃ ONLINE THÀNH CÔNG: ${client.user.tag} ===`))
  .catch((err) => console.error('=== LỖI ĐĂNG NHẬP DISCORD ===', err));

process.on('unhandledRejection', (err) => console.error('=== UNHANDLED REJECTION ===', err));