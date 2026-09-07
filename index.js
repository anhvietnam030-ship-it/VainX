// Fix: ưu tiên IPv4
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const axios = require('axios');
const Tesseract = require('tesseract.js');

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
  getRankFromElo,
  updateElo,
  calculateNewElo,
  addRankRoomsToMode,
  getRankRoomsByMode,
  getAllRankRooms,
  removeRankRoom,
  // Hàm lọc mới
  getAllNormalRooms,
  getNormalRoomsByMode,
} = require('./src/rooms');
const { mainMenuEmbed, mainMenuRow, roomListRows, roomEmbed, roomActionRows, roomActionRowsEN } = require('./src/ui');
const persistence = require('./src/persistence');
const { startKeepAliveServer, startSelfPing } = require('./src/keepalive');

// ===== OCR HELPERS =====
async function ocrImage(imageUrl) {
  try {
    const worker = await Tesseract.createWorker();
    const { data: { text } } = await worker.recognize(imageUrl);
    await worker.terminate();
    return text;
  } catch (err) {
    console.error('OCR error:', err);
    return '';
  }
}

function extractKDAResult(text) {
  // Tìm KDA dạng kill/death/assist, ví dụ 5/2/8
  const kdaMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
  let kda = null;
  let kill, death, assist;
  if (kdaMatch) {
    kill = parseInt(kdaMatch[1], 10);
    death = parseInt(kdaMatch[2], 10);
    assist = parseInt(kdaMatch[3], 10);
    kda = death === 0 ? kill + assist : (kill + assist) / death;
  }
  // Tìm kết quả: VICTORY hoặc DEFEAT
  const resultMatch = text.match(/(VICTORY|DEFEAT|victory|defeat)/);
  let result = null;
  if (resultMatch) {
    result = resultMatch[1].toLowerCase();
    if (result === 'victory') result = 'win';
    else if (result === 'defeat') result = 'loss';
  }
  return { kda, kill, death, assist, result };
}

// ===== CÁC HÀM CŨ =====
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

// ===== HELPER ADMIN =====
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

// ===== RENDER =====
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

// ===== TIMERS & FLASH =====
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

// ===== READY =====
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

// ===== LIST ADMIN COMMANDS =====
const ADMIN_ONLY_COMMANDS = new Set([
  'set-timeout',
  'ready',
  'gia-han-phong',
  'ban-phong',
  'unban-phong',
  'kick-room',
  'kick-group',
  'setup-phong-an',
  'moi-phong-an',
  'danh-sach-phong-an',
  'xoa-phong-an',
  'xoa-tat-ca-phong-an',
  'setup',
  'setup-rank',
  'admin-submit-result',
  'test-fill',
  'test-fill-an',
  'xoa-setup-phong',
  'don-rac',
  'xoa-tin-nhan-bot',
  'xoa-phong-thuong',
  'xoa-tat-ca-phong-thuong',
  'reset-tat-ca-phong',
  'reset-room',
  'xoa-phong-rank',
  'xoa-tat-ca-phong-rank',
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

// ===== XỬ LÝ SLASH COMMANDS =====
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
      const list = getNormalRoomsByMode(mode); // Chỉ phòng thường
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
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const minutes = interaction.options.getInteger('phut', true);
    const scope = interaction.options.getString('pham_vi') || 'all';
    const ms = minutes * 60 * 1000;

    const targets = scope === 'all' ? [...getNormalRoomsByMode('3v3'), ...getNormalRoomsByMode('5v5')] : getNormalRoomsByMode(scope);

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
      content: `✅ Đã đặt thời gian tự reset = **${minutes} phút** cho ${scope === 'all' ? 'tất cả phòng thường' : `phòng ${scope}`}.`,
      ephemeral: true,
    });
  }

  // ---- READY ----
  if (commandName === 'ready') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const trangThai = interaction.options.getString('trang_thai', true);
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    const player = room.players.get(targetUser.id);
    if (!player) return interaction.reply({ content: `❌ <@${targetUser.id}> không ở trong **${room.label}**.`, ephemeral: true });

    player.ready = trangThai === 'ready';
    const channel = (room.panelChannelId && await client.channels.fetch(room.panelChannelId).catch(() => null)) || interaction.channel;
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
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const phut = interaction.options.getInteger('phut', true);
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    if (!room.firstJoinAt || room.status === 'revealed') {
      return interaction.reply({ content: 'ℹ️ Phòng hiện đang trống hoặc đã phát code.', ephemeral: true });
    }

    room.timeoutMs += phut * 60 * 1000;
    const remaining = Math.max(room.timeoutMs - (Date.now() - room.firstJoinAt), 1000);
    const channel = (room.panelChannelId && await client.channels.fetch(room.panelChannelId).catch(() => null)) || interaction.channel;
    scheduleInactivityTimeout(room, channel, remaining);
    await renderRoom(room, channel);
    persistence.saveState(rooms, eloData);
    return interaction.reply({
      content: `✅ Đã gia hạn thêm **${phut} phút** cho **${room.label}**.`,
      ephemeral: true,
    });
  }

  // ---- MOI-BAN ----
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

  // ---- BAN-PHONG ----
  if (commandName === 'ban-phong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });

    const wasInRoom = room.players.has(targetUser.id);
    banUser(room, targetUser.id);
    persistence.saveState(rooms, eloData);
    if (wasInRoom) {
      const channel = (room.panelChannelId && await client.channels.fetch(room.panelChannelId).catch(() => null)) || interaction.channel;
      await renderRoom(room, channel);
    }
    return interaction.reply({
      content: `✅ Đã cấm <@${targetUser.id}> tham gia **${room.label}**${wasInRoom ? ' (đã đá)' : ''}.`,
      ephemeral: true,
    });
  }

  // ---- UNBAN-PHONG ----
  if (commandName === 'unban-phong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });

    unbanUser(room, targetUser.id);
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã bỏ cấm <@${targetUser.id}>.`, ephemeral: true });
  }

  // ---- KICK-ROOM ----
  if (commandName === 'kick-room') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    if (!room.players.has(targetUser.id)) return interaction.reply({ content: `ℹ️ <@${targetUser.id}> không ở trong phòng.`, ephemeral: true });

    room.players.delete(targetUser.id);
    persistence.saveState(rooms, eloData);
    const channel = (room.panelChannelId && await client.channels.fetch(room.panelChannelId).catch(() => null)) || interaction.channel;
    await renderRoom(room, channel);
    return interaction.reply({ content: `✅ Đã đá <@${targetUser.id}> khỏi trận tại **${room.label}**.`, ephemeral: true });
  }

  // ---- KICK-GROUP ----
  if (commandName === 'kick-group') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const room = getHiddenRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng ẩn "${roomId}".`, ephemeral: true });

    room.players.delete(targetUser.id);
    const targetIdx = room.panelTargets.findIndex((t) => t.userId === targetUser.id);
    if (targetIdx === -1) return interaction.reply({ content: `ℹ️ <@${targetUser.id}> chưa được mời.`, ephemeral: true });
    const [target] = room.panelTargets.splice(targetIdx, 1);

    try {
      const ch = await client.channels.fetch(target.channelId).catch(() => null);
      if (ch && target.messageId) {
        const msg = await ch.messages.fetch(target.messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    } catch (err) {}
    await renderRoom(room, interaction.channel);
    return interaction.reply({ content: `✅ Đã xoá <@${targetUser.id}> khỏi nhóm **${room.label}**.`, ephemeral: true });
  }

  // ---- SETUP-PHONG-AN ----
  if (commandName === 'setup-phong-an') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const mode = interaction.options.getString('che_do', true);
    const room = createHiddenRoom(mode);
    let dmNote = '';
    try {
      await sendHiddenRoomDM(room, interaction.user, `👑 Bạn (admin) vừa tạo phòng ẩn: **${room.label}**.`);
    } catch (err) {
      dmNote = '\n⚠️ Không DM được panel cho bạn (có thể bạn tắt DM) — bật lên rồi thử lại.';
    }
    return interaction.reply({
      content: `✅ Đã tạo **${room.label}** (ID: \`${room.id}\`) và gửi panel vào DM của bạn.\nDùng \`/moi-phong-an phong:${room.id}\` để mời thêm.${dmNote}`,
      ephemeral: true,
    });
  }

  // ---- MOI-PHONG-AN ----
  if (commandName === 'moi-phong-an') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    if (!interaction.guild) return interaction.reply({ content: '⚠️ Lệnh này phải chạy trong server, không dùng được từ DM.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getHiddenRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng ẩn "${roomId}".`, ephemeral: true });

    const select = new UserSelectMenuBuilder()
      .setCustomId(`hiddeninvite_${room.id}`)
      .setPlaceholder(`Chọn người muốn mời vào ${room.label}`)
      .setMinValues(1)
      .setMaxValues(25);
    return interaction.reply({
      content: `📨 Chọn (nhiều) người muốn mời riêng vào **${room.label}** (tối đa 25 người/lần):`,
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
  }

  // ---- DANH-SACH-PHONG-AN ----
  if (commandName === 'danh-sach-phong-an') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const list = getAllHiddenRooms();
    if (list.length === 0) return interaction.reply({ content: 'ℹ️ Hiện chưa có phòng ẩn nào.', ephemeral: true });
    const lines = list.map((r) => `• \`${r.id}\` — ${r.label} — ${r.players.size}/${r.capacity} người — đã mời ${r.panelTargets.length} người`);
    return interaction.reply({ content: `📋 Danh sách phòng ẩn:\n${lines.join('\n')}`, ephemeral: true });
  }

  // ---- XOA-PHONG-AN ----
  if (commandName === 'xoa-phong-an') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
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

  // ---- XOA-TAT-CA-PHONG-AN ----
  if (commandName === 'xoa-tat-ca-phong-an') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const allHidden = getAllHiddenRooms();
    if (allHidden.length === 0) return interaction.reply({ content: 'ℹ️ Không có phòng ẩn nào.', ephemeral: true });

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

  // ---- SETUP (thường) ----
  if (commandName === 'setup') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const mode = interaction.options.getString('che_do', true);
    const soLuong = interaction.options.getInteger('so_luong');

    let note = '';
    if (soLuong) {
      const { created, capped, currentTotal, maxAllowed } = addRoomsToMode(mode, soLuong);
      if (created.length > 0) {
        note += `\n✅ Đã tạo thêm **${created.length}** phòng mới: ${created.map((r) => `\`${r.id}\``).join(', ')} (tổng: **${currentTotal}/${maxAllowed}**).`;
      }
      if (capped) note += `\n⚠️ Chỉ tạo được ${created.length} vì đã chạm giới hạn ${maxAllowed}.`;
    }

    const roomsOfMode = getNormalRoomsByMode(mode); // Chỉ thường
    if (roomsOfMode.length === 0) {
      return interaction.reply({
        content: `❌ Chế độ **${mode.toUpperCase()}** hiện chưa có phòng thường nào. Gõ \`/setup che_do:${mode} so_luong:<số>\` để tạo.`,
        ephemeral: true,
      });
    }

    await interaction.reply({ content: `✅ Đang đăng ${roomsOfMode.length} panel phòng thường **${mode.toUpperCase()}**...${note}`, ephemeral: true });
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
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const mode = interaction.options.getString('che_do', true);
    const soLuong = interaction.options.getInteger('so_luong');

    let note = '';
    if (soLuong) {
      const { created, capped, currentTotal, maxAllowed } = addRankRoomsToMode(mode, soLuong);
      if (created.length > 0) {
        note += `\n✅ Đã tạo thêm **${created.length}** phòng rank mới: ${created.map((r) => `\`${r.id}\``).join(', ')} (tổng: **${currentTotal}/${maxAllowed}**).`;
      }
      if (capped) note += `\n⚠️ Chỉ tạo được ${created.length} vì đã chạm giới hạn ${maxAllowed}.`;
    }

    const roomsOfMode = getRankRoomsByMode(mode);
    if (roomsOfMode.length === 0) {
      return interaction.reply({
        content: `❌ Chế độ **${mode.toUpperCase()} Rank** hiện chưa có phòng nào. Gõ \`/setup-rank che_do:${mode} so_luong:<số>\` để tạo.`,
        ephemeral: true,
      });
    }

    await interaction.reply({ content: `✅ Đang đăng ${roomsOfMode.length} panel phòng rank **${mode.toUpperCase()}**...${note}`, ephemeral: true });
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
    if (!room || !room.isRank) return interaction.reply({ content: '❌ Phòng không tồn tại hoặc không phải rank.', ephemeral: true });
    if (room.status !== 'revealed') return interaction.reply({ content: '❌ Phòng chưa phát code hoặc đã kết thúc.', ephemeral: true });
    if (!room.players.has(interaction.user.id)) return interaction.reply({ content: '❌ Bạn không ở trong phòng này.', ephemeral: true });
    if (Date.now() > room.resultWindowEnd) return interaction.reply({ content: '❌ Đã quá hạn 45 phút.', ephemeral: true });
    if (room.resultMap.has(interaction.user.id)) return interaction.reply({ content: 'ℹ️ Bạn đã gửi kết quả rồi.', ephemeral: true });

    const modal = new ModalBuilder()
      .setCustomId(`submitresult_${room.id}`)
      .setTitle(`Gửi kết quả ${room.label}`);

    const imageInput = new TextInputBuilder()
      .setCustomId('image')
      .setLabel('Link ảnh (bắt buộc, phải có KDA và kết quả)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('Dán link ảnh chụp màn hình kết quả trận đấu');

    const row = new ActionRowBuilder().addComponents(imageInput);
    modal.addComponents(row);
    await interaction.showModal(modal);
  }

  // ---- ADMIN-SUBMIT-RESULT ----
  if (commandName === 'admin-submit-result') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const targetUser = interaction.options.getUser('user', true);
    const result = interaction.options.getString('ketqua', true);
    const kdaStr = interaction.options.getString('kda', true);
    const imageUrl = interaction.options.getString('hinhanh') || null;

    const room = getRoom(roomId);
    if (!room || !room.isRank) return interaction.reply({ content: '❌ Phòng không tồn tại hoặc không phải rank.', ephemeral: true });
    if (room.status !== 'revealed') return interaction.reply({ content: '❌ Phòng chưa phát code hoặc đã kết thúc.', ephemeral: true });
    if (!room.players.has(targetUser.id)) return interaction.reply({ content: `❌ <@${targetUser.id}> không ở trong phòng.`, ephemeral: true });
    if (Date.now() > room.resultWindowEnd) return interaction.reply({ content: '❌ Đã quá hạn 45 phút.', ephemeral: true });

    const parts = kdaStr.split('/').map(s => parseInt(s.trim(), 10));
    if (parts.length !== 3 || parts.some(isNaN)) return interaction.reply({ content: '❌ KDA không đúng định dạng.', ephemeral: true });
    const [kill, death, assist] = parts;
    const kda = death === 0 ? kill + assist : (kill + assist) / death;

    room.resultMap.set(targetUser.id, {
      result, imageUrl, submittedAt: Date.now(), kda, kill, death, assist
    });
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Admin đã ghi nhận kết quả **${result === 'win' ? 'Thắng' : 'Thua'}**, KDA ${kill}/${death}/${assist} (${kda.toFixed(2)}) cho <@${targetUser.id}>.`, ephemeral: true });
  }

  // ---- XOA-PHONG-RANK ----
  if (commandName === 'xoa-phong-rank') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || !room.isRank) return interaction.reply({ content: `❌ Không tìm thấy phòng rank "${roomId}".`, ephemeral: true });
    if (room.panelChannelId && room.panelMessageId) {
      const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    }
    const result = removeRankRoom(roomId);
    if (!result.ok) return interaction.reply({ content: `❌ Không xóa được: ${result.reason}`, ephemeral: true });
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã xóa hẳn **${result.room.label}**.`, ephemeral: true });
  }

  // ---- XOA-TAT-CA-PHONG-RANK ----
  if (commandName === 'xoa-tat-ca-phong-rank') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const mode = interaction.options.getString('che_do');
    const targetRooms = mode ? getRankRoomsByMode(mode) : getAllRankRooms();
    if (targetRooms.length === 0) return interaction.reply({ content: 'ℹ️ Không có phòng rank nào.', ephemeral: true });
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

  // ---- XOA-SETUP-PHONG (chỉ phòng thường) ----
  if (commandName === 'xoa-setup-phong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const mode = interaction.options.getString('che_do');
    const targetRooms = mode ? getNormalRoomsByMode(mode) : getAllNormalRooms();

    await interaction.reply({ content: `🗑️ Đang xóa panel của ${targetRooms.length} phòng thường...`, ephemeral: true });
    let deletedCount = 0;
    for (const room of targetRooms) {
      if (room.panelChannelId && room.panelMessageId) {
        const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
        if (ch) {
          const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null);
          if (msg) { await msg.delete().catch(() => {}); deletedCount++; }
        }
      }
      resetRoom(room);
      room.panelChannelId = null;
      room.panelMessageId = null;
    }
    persistence.saveState(rooms, eloData);
    return interaction.followUp({ content: `✅ Đã xóa **${deletedCount}** panel và reset **${targetRooms.length}** phòng thường. Dùng /setup để đăng lại.`, ephemeral: true });
  }

  // ---- RESET-TAT-CA-PHONG (chỉ phòng thường) ----
  if (commandName === 'reset-tat-ca-phong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const allRoomsNow = getAllNormalRooms();
    await interaction.reply({ content: `♻️ Đang reset toàn bộ ${allRoomsNow.length} phòng thường...`, ephemeral: true });
    for (const room of allRoomsNow) {
      resetRoom(room);
      const channel = (room.panelChannelId && await client.channels.fetch(room.panelChannelId).catch(() => null)) || interaction.channel;
      await renderRoom(room, channel);
    }
    persistence.saveState(rooms, eloData);
    return interaction.followUp({ content: `✅ Đã reset toàn bộ ${allRoomsNow.length} phòng thường.`, ephemeral: true });
  }

  // ---- XOA-PHONG-THUONG ----
  if (commandName === 'xoa-phong-thuong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || room.hidden || room.isRank) return interaction.reply({ content: `❌ Không tìm thấy phòng thường "${roomId}".`, ephemeral: true });

    if (room.panelChannelId && room.panelMessageId) {
      const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    }
    const result = removeExtraRoom(roomId);
    if (!result.ok) {
      if (result.reason === 'protected') return interaction.reply({
        content: `❌ **${room.label}** là phòng gốc, không xóa hẳn được — dùng /reset-room nếu muốn reset.`,
        ephemeral: true,
      });
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã xóa hẳn **${result.room.label}**.`, ephemeral: true });
  }

  // ---- XOA-TAT-CA-PHONG-THUONG ----
  if (commandName === 'xoa-tat-ca-phong-thuong') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const mode = interaction.options.getString('che_do');
    const targetRooms = mode ? getNormalRoomsByMode(mode) : getAllNormalRooms();
    if (targetRooms.length === 0) return interaction.reply({ content: 'ℹ️ Không có phòng thường nào.', ephemeral: true });
    await interaction.reply({ content: `🗑️ Đang xóa toàn bộ **${targetRooms.length}** phòng thường...`, ephemeral: true });
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
    return interaction.followUp({ content: `✅ Đã xóa hẳn **${targetRooms.length}** phòng thường.`, ephemeral: true });
  }

  // ---- TEST-FILL ----
  if (commandName === 'test-fill') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    if (room.status === 'revealed') return interaction.reply({ content: '❌ Phòng đã phát code.', ephemeral: true });

    const soNguoiInput = interaction.options.getInteger('so_nguoi');
    const cho_trong = room.capacity - room.players.size;
    const needed = Math.max(0, Math.min(soNguoiInput ?? cho_trong, cho_trong));
    if (needed <= 0) return interaction.reply({ content: 'ℹ️ Phòng đã đủ.', ephemeral: true });

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
    return interaction.reply({ content: `✅ Đã thêm **${needed}** người giả vào **${room.label}**.`, ephemeral: true });
  }

  // ---- TEST-FILL-AN ----
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
    return interaction.reply({ content: `✅ Đã thêm **${needed}** người giả vào phòng ẩn **${room.label}**.`, ephemeral: true });
  }

  // ---- DON-RAC ----
  if (commandName === 'don-rac') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const soLuong = interaction.options.getInteger('so_luong') || 50;
    const channel = interaction.channel;

    await interaction.reply({ content: `🧹 Đang dọn tối đa ${soLuong} tin nhắn...`, ephemeral: true });
    try {
      const protectedPanelIds = new Set(
        getAllRooms() // Bảo vệ cả panel thường và rank
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
        content: `✅ Đã xóa **${deletedCount}** tin nhắn.` +
          (skippedPanels > 0 ? `\n🛡️ Đã bỏ qua **${skippedPanels}** panel phòng đang hoạt động.` : ''),
        ephemeral: true,
      });
    } catch (err) {
      console.error('Lỗi don-rac:', err);
      return interaction.followUp({ content: '⚠️ Không xóa được — có thể thiếu quyền Manage Messages hoặc tin nhắn quá cũ.', ephemeral: true });
    }
  }

  // ---- XOA-TIN-NHAN-BOT ----
  if (commandName === 'xoa-tin-nhan-bot') {
    const allowed = await isAdminAnywhere(interaction);
    if (!allowed) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const soLuong = interaction.options.getInteger('so_luong');
    const channel = interaction.channel;
    const isDM = !interaction.guild;
    const noiChung = isDM ? 'trong DM này' : 'trong kênh này';
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

    const protectedPanelIds = isDM
      ? new Set()
      : new Set(getAllRooms().filter((r) => r.panelChannelId === channel.id && r.panelMessageId).map((r) => r.panelMessageId));
    let skippedPanels = 0;

    await interaction.reply({
      content: soLuong ? `🧹 Đang xóa tối đa **${soLuong}** tin nhắn của Bot ${noiChung}...` : `🧹 Đang xóa **TẤT CẢ** tin nhắn của Bot ${noiChung}...`,
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
      content: `✅ Đã xóa **${totalDeleted}** tin nhắn của Bot ${noiChung}.` +
        (skippedPanels > 0 ? `\n🛡️ Đã bỏ qua **${skippedPanels}** panel phòng đang hoạt động.` : ''),
      ephemeral: true,
    });
  }

  // ---- RESET-ROOM (áp dụng cho mọi loại) ----
  if (commandName === 'reset-room') {
    if (!isAdmin(interaction)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    resetRoom(room);
    const channel = (room.panelChannelId && await client.channels.fetch(room.panelChannelId).catch(() => null)) || interaction.channel;
    await renderRoom(room, channel);
    persistence.saveState(rooms, eloData);
    return interaction.reply({ content: `✅ Đã ép reset **${room.label}**.`, ephemeral: true });
  }
}

// ===== XỬ LÝ MODAL SUBMIT (OCR) =====
async function handleModalSubmit(interaction) {
  if (!interaction.customId.startsWith('submitresult_')) return;

  const roomId = interaction.customId.replace('submitresult_', '');
  const room = getRoom(roomId);
  if (!room || !room.isRank) {
    return interaction.reply({ content: '❌ Phòng không tồn tại hoặc không phải rank.', ephemeral: true });
  }

  const imageUrl = interaction.fields.getTextInputValue('image');
  if (!imageUrl) return interaction.reply({ content: '❌ Bạn chưa nhập link ảnh.', ephemeral: true });

  let ocrText = '';
  try {
    ocrText = await ocrImage(imageUrl);
  } catch (err) {
    console.error('OCR error:', err);
  }

  if (!ocrText) {
    return interaction.reply({
      content: '❌ Không thể đọc được ảnh. Vui lòng kiểm tra link ảnh hoặc nhờ admin gửi thay (dùng /admin-submit-result).',
      ephemeral: true,
    });
  }

  const { kda, kill, death, assist, result } = extractKDAResult(ocrText);
  if (!kda || !result) {
    return interaction.reply({
      content: '❌ Không tìm thấy KDA hoặc kết quả trong ảnh. Vui lòng kiểm tra ảnh hoặc nhờ admin gửi thay (dùng /admin-submit-result).',
      ephemeral: true,
    });
  }

  if (!room.players.has(interaction.user.id)) return interaction.reply({ content: '❌ Bạn không ở trong phòng này.', ephemeral: true });
  if (Date.now() > room.resultWindowEnd) return interaction.reply({ content: '❌ Đã quá hạn 45 phút.', ephemeral: true });
  if (room.resultMap.has(interaction.user.id)) return interaction.reply({ content: 'ℹ️ Bạn đã gửi kết quả rồi.', ephemeral: true });

  room.resultMap.set(interaction.user.id, {
    result, imageUrl, submittedAt: Date.now(), kda, kill, death, assist
  });
  persistence.saveState(rooms, eloData);

  await interaction.reply({
    content: `✅ Đã ghi nhận kết quả **${result === 'win' ? 'Thắng' : 'Thua'}**, KDA ${kill}/${death}/${assist} (${kda.toFixed(2)}) cho ${room.label}. (OCR tự động)`,
    ephemeral: true,
  });
}

// ===== XỬ LÝ BUTTON =====
async function handleButton(interaction) {
  const { customId } = interaction;

  if (customId === 'menu_3v3' || customId === 'menu_5v5') {
    const mode = customId.split('_')[1];
    const roomsOfMode = getNormalRoomsByMode(mode); // Chỉ phòng thường
    if (roomsOfMode.length === 0) {
      return interaction.reply({
        content: t(interaction, `⚠️ Hiện chưa có phòng **${mode.toUpperCase()}** nào — chờ admin tạo.`, `⚠️ No **${mode.toUpperCase()}** rooms yet.`),
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: t(interaction, `Chọn 1 trong ${roomsOfMode.length} phòng **${mode.toUpperCase()}** để tham gia:`, `Pick one of the ${roomsOfMode.length} **${mode.toUpperCase()}** rooms:`),
      components: roomListRows(roomsOfMode),
      ephemeral: true,
    });
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
    if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });
    return interaction.reply({ content: '🌐 English buttons:', components: roomActionRowsEN(room), ephemeral: true });
  }
  if (customId.startsWith('hiddeninvitebtn_')) {
    const roomId = customId.replace('hiddeninvitebtn_', '');
    const room = getHiddenRoom(roomId);
    if (!room) return interaction.reply({ content: '❌ Phòng ẩn không tồn tại.', ephemeral: true });
    if (!await isAdminUserId(interaction.user.id)) return interaction.reply({ content: '❌ Chỉ admin.', ephemeral: true });
    if (!interaction.guild) {
      return interaction.reply({
        content: `⚠️ Không thể mời từ DM. Vào server và dùng \`/moi-phong-an phong:${room.id}\`.`,
        ephemeral: true,
      });
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(`hiddeninvite_${room.id}`)
      .setPlaceholder(`Chọn người mời vào ${room.label}`)
      .setMinValues(1)
      .setMaxValues(25);
    return interaction.reply({
      content: `📨 Chọn (nhiều) người muốn mời riêng vào **${room.label}**:`,
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
  }
  if (customId.startsWith('invite_')) {
    const roomId = customId.replace('invite_', '');
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });
    if (room.status === 'revealed') return interaction.reply({ content: '❌ Phòng đã phát code.', ephemeral: true });
    if (isFull(room)) return interaction.reply({ content: '❌ Phòng đã đầy.', ephemeral: true });

    const select = new UserSelectMenuBuilder()
      .setCustomId(`inviteselect_${room.id}`)
      .setPlaceholder(t(interaction, 'Chọn bạn bè mời vào phòng', 'Pick friends to invite'))
      .setMinValues(1)
      .setMaxValues(25);
    return interaction.reply({
      content: t(interaction, `📨 Chọn người mời vào **${room.label}**:`, `📨 Pick someone to invite to **${room.label}**:`),
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
  }

  // Nút "Gửi kết quả" trên panel rank
  if (customId.startsWith('submit_result_')) {
    const roomId = customId.replace('submit_result_', '');
    const room = getRoom(roomId);
    if (!room || !room.isRank) return interaction.reply({ content: '❌ Không phải phòng rank.', ephemeral: true });
    if (room.status !== 'revealed') return interaction.reply({ content: '❌ Phòng chưa phát code hoặc đã kết thúc.', ephemeral: true });
    if (!room.players.has(interaction.user.id)) return interaction.reply({ content: '❌ Bạn không ở trong phòng.', ephemeral: true });
    if (Date.now() > room.resultWindowEnd) return interaction.reply({ content: '❌ Đã quá hạn 45 phút.', ephemeral: true });
    if (room.resultMap.has(interaction.user.id)) return interaction.reply({ content: 'ℹ️ Bạn đã gửi rồi.', ephemeral: true });

    const modal = new ModalBuilder()
      .setCustomId(`submitresult_${room.id}`)
      .setTitle(`Gửi kết quả ${room.label}`);
    const imageInput = new TextInputBuilder()
      .setCustomId('image')
      .setLabel('Link ảnh (bắt buộc)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('Dán link ảnh chụp màn hình kết quả');
    const row = new ActionRowBuilder().addComponents(imageInput);
    modal.addComponents(row);
    await interaction.showModal(modal);
  }
}

// ===== USER SELECT MENU =====
async function handleUserSelectMenu(interaction) {
  const { customId } = interaction;

  if (customId.startsWith('hiddeninvite_')) {
    const roomId = customId.replace('hiddeninvite_', '');
    const room = getHiddenRoom(roomId);
    if (!room) return interaction.update({ content: '❌ Phòng ẩn không tồn tại.', components: [] });
    if (!await isAdminUserId(interaction.user.id)) return interaction.update({ content: '❌ Chỉ admin.', components: [] });

    const targets = interaction.users;
    if (targets.size === 0) return interaction.update({ content: '❌ Chưa chọn ai.', components: [] });

    const invited = [], failed = [];
    for (const targetUser of targets.values()) {
      const already = room.panelTargets.some(t => t.userId === targetUser.id);
      if (already) { invited.push(targetUser.id); continue; }
      try {
        await sendHiddenRoomDM(room, targetUser, `📨 Bạn được mời vào phòng ẩn: **${room.label}**`);
        invited.push(targetUser.id);
      } catch (err) {
        failed.push(targetUser.id);
      }
    }
    let summary = invited.length ? `✅ Đã mời ${invited.length} người.` : '';
    if (failed.length) summary += `\n⚠️ Không DM được: ${failed.map(id => `<@${id}>`).join(' ')}.`;
    return interaction.update({ content: summary || '❌ Không mời được ai.', components: [] });
  }

  if (customId.startsWith('inviteselect_')) {
    const roomId = customId.replace('inviteselect_', '');
    const room = getRoom(roomId);
    if (!room) return interaction.update({ content: '❌ Phòng không tồn tại.', components: [] });

    const targets = interaction.users;
    if (targets.size === 0) return interaction.update({ content: '❌ Chưa chọn ai.', components: [] });
    if (room.status === 'revealed') return interaction.update({ content: '❌ Phòng đã phát code.', components: [] });
    if (isFull(room)) return interaction.update({ content: '❌ Phòng đã đầy.', components: [] });

    const invitedIds = [], skipped = [];
    for (const targetUser of targets.values()) {
      if (targetUser.id === interaction.user.id) { skipped.push(`<@${targetUser.id}> (chính bạn)`); continue; }
      if (isBanned(room, targetUser.id)) { skipped.push(`<@${targetUser.id}> (bị cấm)`); continue; }
      invitedIds.push(targetUser.id);
    }
    if (invitedIds.length === 0) {
      return interaction.update({ content: `❌ Không mời được ai.${skipped.length ? `\nBỏ qua: ${skipped.join(', ')}` : ''}`, components: [] });
    }

    const joinRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`join_${room.id}`).setLabel('Tham gia ngay').setStyle(ButtonStyle.Success).setEmoji('➕')
    );
    const mentionList = invitedIds.map(id => `<@${id}>`).join(' ');
    await interaction.channel.send({
      content: t(interaction, `📨 <@${interaction.user.id}> mời ${mentionList} vào **${room.label}** (${room.players.size}/${room.capacity})!`, `📨 <@${interaction.user.id}> invited ${mentionList} to **${room.label}**!`),
      components: [joinRow],
    });
    let summary = `✅ Đã mời **${invitedIds.length}** người.`;
    if (skipped.length) summary += `\n⚠️ Bỏ qua: ${skipped.join(', ')}`;
    return interaction.update({ content: summary, components: [] });
  }
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
  if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });
  if (isBanned(room, interaction.user.id)) return interaction.reply({ content: `❌ Bạn bị cấm khỏi **${room.label}**.`, ephemeral: true });
  if (interaction.member && config.JOIN_ROLE_ID && !interaction.member.roles?.cache?.has(config.JOIN_ROLE_ID)) {
    return interaction.reply({ content: `❌ Bạn cần role <@&${config.JOIN_ROLE_ID}>.`, ephemeral: true });
  }

  const existing = findRoomOfUser(interaction.user.id);
  if (existing && existing.id !== room.id) return interaction.reply({ content: `⚠️ Bạn đang ở **${existing.label}**. Rời trước khi vào phòng khác.`, ephemeral: true });
  if (existing && existing.id === room.id) return interaction.reply({ content: 'ℹ️ Bạn đã ở trong phòng này.', ephemeral: true });
  if (isFull(room)) return interaction.reply({ content: '❌ Phòng đã đủ.', ephemeral: true });
  if (room.status === 'revealed') return interaction.reply({ content: '❌ Phòng đang chuẩn bị vào game.', ephemeral: true });

  const wasEmpty = room.players.size === 0;
  room.players.set(interaction.user.id, { username: interaction.member?.displayName || interaction.user.username, team: null, ready: false });
  const channel = interaction.channel;
  if (wasEmpty) { room.firstJoinAt = Date.now(); scheduleInactivityTimeout(room, channel); }
  await renderRoom(room, channel);
  if (isFull(room)) { await announceRoomFull(room, channel); scheduleReadyCountdown(room, channel); }
  return interaction.reply({ content: `✅ Bạn đã gia nhập **${room.label}**.`, ephemeral: true });
}

async function leaveRoom(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });
  if (!room.players.has(interaction.user.id)) return interaction.reply({ content: 'ℹ️ Bạn không ở trong phòng.', ephemeral: true });
  if (room.status === 'revealed') return interaction.reply({ content: '❌ Phòng đã phát code, không thể rời.', ephemeral: true });

  room.players.delete(interaction.user.id);
  const channel = interaction.channel;
  if (room.timers.readyCountdown && !isFull(room)) {
    clearTimeout(room.timers.readyCountdown);
    room.timers.readyCountdown = null;
    room.fullAt = null;
    if (room.timers.blink) { clearInterval(room.timers.blink); room.timers.blink = null; room._flashColor = null; }
  }
  if (room.players.size === 0) resetRoom(room);
  await renderRoom(room, channel);
  return interaction.reply({ content: `✅ Bạn đã rời **${room.label}**.`, ephemeral: true });
}

async function toggleReady(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });
  const player = room.players.get(interaction.user.id);
  if (!player) return interaction.reply({ content: '⚠️ Bạn cần gia nhập phòng trước.', ephemeral: true });
  if (room.status === 'revealed') return interaction.reply({ content: 'ℹ️ Phòng đã phát code.', ephemeral: true });
  if (!isFull(room)) return interaction.reply({ content: `⚠️ Phòng chưa đủ người (${room.players.size}/${room.capacity}).`, ephemeral: true });
  if (!checkCooldown(interaction.user.id)) return interaction.reply({ content: '⏳ Bạn thao tác hơi nhanh.', ephemeral: true });

  player.ready = !player.ready;
  const channel = interaction.channel;
  await renderRoom(room, channel);
  await tryRevealCode(room, channel);
  let extra = '';
  if (room.status === 'waiting' && isFull(room) && allReady(room)) {
    extra = '\n⚖️ Team chưa cân bằng nên code chưa phát — tự đổi team hoặc chờ người khác.';
  }
  return interaction.reply({
    content: (player.ready ? '✅ Bạn đã sẵn sàng.' : '↩️ Bạn đã bỏ sẵn sàng.') + extra,
    ephemeral: true,
  });
}

async function setTeam(interaction, roomId, team) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });
  const player = room.players.get(interaction.user.id);
  if (!player) return interaction.reply({ content: '⚠️ Bạn cần gia nhập phòng trước.', ephemeral: true });
  if (room.status === 'revealed') return interaction.reply({ content: 'ℹ️ Phòng đã phát code.', ephemeral: true });
  if (!checkCooldown(interaction.user.id)) return interaction.reply({ content: '⏳ Bạn thao tác hơi nhanh.', ephemeral: true });

  player.team = team;
  const channel = interaction.channel;
  await renderRoom(room, channel);
  await tryRevealCode(room, channel);
  return interaction.reply({
    content: team ? `✅ Bạn đã chọn **Team ${team}**.` : '✅ Bạn đã bỏ chọn team.',
    ephemeral: true,
  });
}

async function giveCode(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });
  if (room.status !== 'revealed' || !room.code) return interaction.reply({ content: 'ℹ️ Phòng chưa có code.', ephemeral: true });
  const personal = formatPersonalCode(room, interaction.user.id);
  if (!personal) return interaction.reply({ content: '⚠️ Bạn không ở trong phòng.', ephemeral: true });
  await interaction.reply({ content: '🔑 Code của bạn (tin nhắn bên dưới, bấm giữ để copy):', ephemeral: true });
  return interaction.followUp({ content: personal, ephemeral: true });
}

client.login(config.TOKEN)
  .then(() => console.log(`=== BOT DISCORD ĐÃ ONLINE THÀNH CÔNG: ${client.user.tag} ===`))
  .catch((err) => console.error('=== LỖI ĐĂNG NHẬP DISCORD ===', err));

process.on('unhandledRejection', (err) => console.error('=== UNHANDLED REJECTION ===', err));