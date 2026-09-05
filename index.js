// Fix: một số nền tảng host (Render, ...) ưu tiên phân giải DNS ra IPv6 trước,
// nhưng route IPv6 ra ngoài không thông tới Discord gateway -> WebSocket kết nối
// bị TREO VÔ THỜI HẠN, không báo lỗi gì (bot chạy "live" nhưng không bao giờ login xong).
// Ép Node ưu tiên IPv4 trước để tránh việc này.
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
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
} = require('./src/rooms');
const { mainMenuEmbed, mainMenuRow, roomListRows, roomEmbed, roomActionRows } = require('./src/ui');
const persistence = require('./src/persistence');
const { startKeepAliveServer, startSelfPing } = require('./src/keepalive');

// Mở server HTTP nhỏ để nền tảng hosting kiểu "Web Service" (Render, ...) không báo
// port scan timeout. Nếu chạy trên máy riêng / VPS / Background Worker thì dòng này
// vô hại, chỉ tốn 1 cổng cục bộ.
startKeepAliveServer();
// Tự ping chính mình mỗi 10 phút để hạn chế bị Render spin-down (xem ghi chú trong keepalive.js).
startSelfPing();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
initRooms();
persistence.loadState().forEach((data, id) => {
  const room = getRoom(id);
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
});

// Cooldown chống spam (Phương án 2): userId -> timestamp lần thao tác gần nhất
const lastActionAt = new Map();
function checkCooldown(userId) {
  const now = Date.now();
  const last = lastActionAt.get(userId) || 0;
  if (now - last < config.ACTION_COOLDOWN_MS) return false;
  lastActionAt.set(userId, now);
  return true;
}

// ---------- Helpers ----------

function isAdmin(interaction) {
  if (!interaction.member) return false;
  if (interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (config.ADMIN_ROLE_ID && interaction.member.roles?.cache?.has(config.ADMIN_ROLE_ID)) return true;
  return false;
}

async function logAdmin(text) {
  if (!config.LOG_CHANNEL_ID) return;
  const ch = await client.channels.fetch(config.LOG_CHANNEL_ID).catch(() => null);
  if (ch) await ch.send(text).catch(() => {});
}

// Vẽ lại / tạo panel phòng trong kênh, dùng chung cho mọi thay đổi state
async function renderRoom(room, channel) {
  const embed = roomEmbed(room);
  const rowsUi = roomActionRows(room);

  try {
    if (room.panelMessageId && room.panelChannelId) {
      const ch = await client.channels.fetch(room.panelChannelId).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(room.panelMessageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed], components: rowsUi });
          persistence.saveState(rooms);
          return msg;
        }
      }
    }
    // Chưa có panel -> tạo mới trong channel hiện tại
    const msg = await channel.send({ embeds: [embed], components: rowsUi });
    room.panelChannelId = channel.id;
    room.panelMessageId = msg.id;
    persistence.saveState(rooms);
    return msg;
  } catch (err) {
    console.error(`Lỗi render phòng ${room.id}:`, err);
    return null;
  }
}

function scheduleInactivityTimeout(room, channel, customMs) {
  if (room.timers.inactivity) clearTimeout(room.timers.inactivity);
  const ms = customMs ?? room.timeoutMs;
  room.timers.inactivity = setTimeout(async () => {
    if (room.status !== 'revealed') {
      resetRoom(room);
      await renderRoom(room, channel);
      await channel
        .send(`⏰ **${room.label}** đã tự động reset vì quá thời gian chờ mà chưa đủ người / chưa sẵn sàng.`)
        .catch(() => {});
    }
  }, ms);
}

async function announceRoomFull(room, channel) {
  const ids = Array.from(room.players.keys());
  const mentions = ids.map((id) => `<@${id}>`).join(' ');
  await channel
    .send(
      `✅ **${room.label}** đã đủ người! ${mentions}\nHãy bấm **Sẵn sàng** trong vòng ${Math.round(
        config.READY_COUNTDOWN_MS / 60000
      )} phút, nếu không sẽ bị đá khỏi phòng.`
    )
    .catch(() => {});

  // Gửi tin nhắn riêng (DM) cho từng người trong phòng
  for (const id of ids) {
    client.users
      .fetch(id)
      .then((user) =>
        user.send(
          `✅ **${room.label}** mà bạn đăng ký đã **đủ người**!\n` +
            `Vào kênh <#${channel.id}> và bấm **Sẵn sàng** trong vòng ${Math.round(
              config.READY_COUNTDOWN_MS / 60000
            )} phút, nếu không bạn sẽ bị đá khỏi phòng để nhường chỗ cho người khác.`
        )
      )
      .catch(() => {}); // user tắt DM hoặc lỗi khác -> bỏ qua, không chặn luồng chính
  }
}

function scheduleReadyCountdown(room, channel) {
  if (room.timers.readyCountdown) clearTimeout(room.timers.readyCountdown);
  room.fullAt = Date.now();
  room.timers.readyCountdown = setTimeout(() => handleReadyCountdownExpire(room, channel), config.READY_COUNTDOWN_MS);
}

// Hết 2 phút chờ sẵn sàng: đá người chưa sẵn sàng, tính lại đồng hồ 30' cho người còn lại
async function handleReadyCountdownExpire(room, channel) {
  room.timers.readyCountdown = null;
  if (room.status !== 'waiting') return; // đã phát code hoặc phòng đã reset
  if (!isFull(room)) return; // đã có người rời trước đó, không còn đủ người

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

  if (kicked.length === 0) {
    // Mọi người đã sẵn sàng nhưng vẫn kẹt (thường do team chưa cân bằng) -> không đá ai,
    // đồng hồ 30' gốc (từ firstJoinAt) vẫn chạy làm lưới an toàn.
    await channel
      .send(
        `⚖️ **${room.label}**: mọi người đã sẵn sàng nhưng team chưa cân bằng nên chưa phát được code. Hãy tự đổi team hoặc rời phòng.`
      )
      .catch(() => {});
    await renderRoom(room, channel);
    return;
  }

  const mentions = kicked.map((id) => `<@${id}>`).join(' ');
  await channel
    .send(
      `⏱️ Hết ${Math.round(
        config.READY_COUNTDOWN_MS / 60000
      )} phút chờ sẵn sàng tại **${room.label}** — đã đá ${mentions} ra khỏi phòng để nhường chỗ. Bấm **Gia nhập** để đăng ký lại.`
    )
    .catch(() => {});

  if (room.players.size === 0) {
    resetRoom(room);
  } else {
    // Còn người ở lại -> tính lại đồng hồ 30 phút từ đầu như quy định
    room.firstJoinAt = Date.now();
    scheduleInactivityTimeout(room, channel);
  }

  await renderRoom(room, channel);
}

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

  await renderRoom(room, channel);
  await channel
    .send(
      `🔑 **${room.label}** đã đủ người sẵn sàng! Code phòng đã được phát — mỗi người bấm nút **"Lấy code của tôi"** trên panel để nhận mã riêng.`
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

  room.timers.resetAfterCode = setTimeout(async () => {
    clearRoomTimers(room);
    resetRoom(room);
    await renderRoom(room, channel);
    await channel.send(`♻️ **${room.label}** đã được reset, mời mọi người đăng ký lại.`).catch(() => {});
  }, config.CODE_RESET_DELAY_MS);
}

// ---------- Ready ----------

client.once('ready', async () => {
  console.log(`Đã đăng nhập với tên ${client.user.tag}`);

  // Khôi phục timer cho các phòng còn dữ liệu từ lần chạy trước
  for (const room of getAllRooms()) {
    if (room.players.size === 0 || !room.panelChannelId) continue;
    const channel = await client.channels.fetch(room.panelChannelId).catch(() => null);
    if (!channel) continue;

    if (room.status === 'revealed' && room.revealedAt) {
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
          await channel.send(`♻️ **${room.label}** đã được reset, mời mọi người đăng ký lại.`).catch(() => {});
        }, remaining);
      }
    } else if (room.status === 'waiting') {
      if (isFull(room) && room.fullAt) {
        const remaining = config.READY_COUNTDOWN_MS - (Date.now() - room.fullAt);
        if (remaining <= 0) {
          await handleReadyCountdownExpire(room, channel);
        } else {
          room.timers.readyCountdown = setTimeout(() => handleReadyCountdownExpire(room, channel), remaining);
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

// ---------- Slash commands ----------

async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (commandName === 'lobby') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const statsFor = (mode) => {
      const list = getRoomsByMode(mode);
      return {
        current: list.reduce((sum, r) => sum + r.players.size, 0),
        total: list.reduce((sum, r) => sum + r.capacity, 0),
      };
    };
    const stats = { '3v3': statsFor('3v3'), '5v5': statsFor('5v5') };
    await interaction.channel.send({ embeds: [mainMenuEmbed(stats)], components: [mainMenuRow()] });
    return interaction.reply({ content: '✅ Đã đăng bảng chọn phòng.', ephemeral: true });
  }

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
    persistence.saveState(rooms);

    return interaction.reply({
      content: `✅ Đã đặt thời gian tự reset = **${minutes} phút** cho ${
        scope === 'all' ? 'tất cả phòng' : `phòng ${scope}`
      }.`,
      ephemeral: true,
    });
  }

  if (commandName === 'set-ready') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = interaction.options.getString('phong', true);
    const targetUser = interaction.options.getUser('user', true);
    const trangThai = interaction.options.getString('trang_thai', true); // 'ready' | 'notready'
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

    persistence.saveState(rooms);
    return interaction.reply({
      content: `✅ Đã đặt <@${targetUser.id}> thành **${player.ready ? 'Sẵn sàng' : 'Chưa sẵn sàng'}** trong **${room.label}**.`,
      ephemeral: true,
    });
  }

  if (commandName === 'gia-han-phong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = interaction.options.getString('phong', true);
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
    persistence.saveState(rooms);

    return interaction.reply({
      content: `✅ Đã gia hạn thêm **${phut} phút** cho **${room.label}** trước khi tự reset.`,
      ephemeral: true,
    });
  }

  if (commandName === 'moi-ban') {
    const roomId = interaction.options.getString('phong', true);
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

  if (commandName === 'ban-phong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = interaction.options.getString('phong', true);
    const targetUser = interaction.options.getUser('user', true);
    const room = getRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }

    const wasInRoom = room.players.has(targetUser.id);
    banUser(room, targetUser.id);
    persistence.saveState(rooms);

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

  if (commandName === 'unban-phong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = interaction.options.getString('phong', true);
    const targetUser = interaction.options.getUser('user', true);
    const room = getRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }

    unbanUser(room, targetUser.id);
    persistence.saveState(rooms);

    return interaction.reply({
      content: `✅ Đã bỏ cấm <@${targetUser.id}> khỏi **${room.label}**.`,
      ephemeral: true,
    });
  }

  if (commandName === 'setup-phong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const mode = interaction.options.getString('che_do', true);
    const roomsOfMode = getRoomsByMode(mode);

    await interaction.reply({
      content: `✅ Đang đăng 4 panel phòng **${mode.toUpperCase()}** vào kênh này...`,
      ephemeral: true,
    });

    for (const room of roomsOfMode) {
      // Bỏ liên kết panel cũ (nếu có ở kênh khác) để panel mới luôn được tạo tại đúng kênh này.
      room.panelChannelId = null;
      room.panelMessageId = null;
      await renderRoom(room, interaction.channel);
    }
    return;
  }

  if (commandName === 'test-fill') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh test này.', ephemeral: true });
    }
    const roomId = interaction.options.getString('phong', true);
    const room = getRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
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
      const fakeId = `9${Date.now()}${i}`.slice(0, 18); // id số giả, không trùng user thật
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

  if (commandName === 'reset-room') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới ép reset phòng được.', ephemeral: true });
    }
    const roomId = interaction.options.getString('phong', true);
    const room = getRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng "${roomId}".`, ephemeral: true });
    }
    resetRoom(room);
    const channel =
      (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) ||
      interaction.channel;
    await renderRoom(room, channel);
    return interaction.reply({ content: `✅ Đã ép reset **${room.label}**.`, ephemeral: true });
  }
}

// ---------- Buttons ----------

async function handleButton(interaction) {
  const { customId } = interaction;

  if (customId === 'menu_3v3' || customId === 'menu_5v5') {
    const mode = customId.split('_')[1];
    const roomsOfMode = getRoomsByMode(mode);
    return interaction.reply({
      content: `Chọn 1 trong 4 phòng **${mode.toUpperCase()}** để tham gia:`,
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
  if (customId.startsWith('invite_')) {
    const roomId = customId.replace('invite_', '');
    const room = getRoom(roomId);
    if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });
    if (room.status === 'revealed') {
      return interaction.reply({ content: '❌ Phòng đã phát code, không mời thêm được nữa.', ephemeral: true });
    }
    if (isFull(room)) {
      return interaction.reply({ content: '❌ Phòng đã đầy rồi.', ephemeral: true });
    }

    const select = new UserSelectMenuBuilder()
      .setCustomId(`inviteselect_${room.id}`)
      .setPlaceholder('Chọn bạn muốn mời vào phòng này')
      .setMinValues(1)
      .setMaxValues(1);

    return interaction.reply({
      content: `📨 Chọn người bạn muốn mời vào **${room.label}**:`,
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
  }
}

async function handleUserSelectMenu(interaction) {
  const { customId } = interaction;
  if (!customId.startsWith('inviteselect_')) return;

  const roomId = customId.replace('inviteselect_', '');
  const room = getRoom(roomId);
  if (!room) return interaction.update({ content: '❌ Phòng không tồn tại.', components: [] });

  const targetUser = interaction.users.first();
  if (!targetUser) return interaction.update({ content: '❌ Chưa chọn ai cả.', components: [] });

  if (room.status === 'revealed') {
    return interaction.update({ content: '❌ Phòng đã phát code, không mời thêm được nữa.', components: [] });
  }
  if (isFull(room)) {
    return interaction.update({ content: '❌ Phòng đã đầy rồi.', components: [] });
  }
  if (isBanned(room, targetUser.id)) {
    return interaction.update({
      content: `❌ <@${targetUser.id}> đang bị cấm khỏi **${room.label}**, không mời được.`,
      components: [],
    });
  }
  if (targetUser.id === interaction.user.id) {
    return interaction.update({ content: '❌ Không thể tự mời chính mình 😄.', components: [] });
  }

  const joinRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_${room.id}`)
      .setLabel('Tham gia ngay')
      .setStyle(ButtonStyle.Success)
      .setEmoji('➕')
  );

  await interaction.channel.send({
    content: `📨 <@${interaction.user.id}> mời <@${targetUser.id}> vào **${room.label}** (${room.players.size}/${room.capacity})!`,
    components: [joinRow],
  });

  return interaction.update({ content: `✅ Đã gửi lời mời cho <@${targetUser.id}>.`, components: [] });
}

function splitTeamCustomId(customId) {
  if (customId.startsWith('team1_')) return [1, customId.replace('team1_', '')];
  if (customId.startsWith('team2_')) return [2, customId.replace('team2_', '')];
  return [null, customId.replace('teamnone_', '')];
}

async function joinRoom(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });

  if (isBanned(room, interaction.user.id)) {
    return interaction.reply({
      content: `❌ Bạn đã bị cấm tham gia **${room.label}** (vẫn vào được các phòng khác bình thường).`,
      ephemeral: true,
    });
  }

  if (config.JOIN_ROLE_ID && !interaction.member.roles?.cache?.has(config.JOIN_ROLE_ID)) {
    return interaction.reply({
      content: `❌ Bạn cần role <@&${config.JOIN_ROLE_ID}> mới được tham gia phòng.`,
      ephemeral: true,
    });
  }

  const existing = findRoomOfUser(interaction.user.id);
  if (existing && existing.id !== room.id) {
    return interaction.reply({
      content: `⚠️ Bạn đang ở **${existing.label}** rồi. Hãy rời phòng đó trước khi vào phòng khác.`,
      ephemeral: true,
    });
  }
  if (existing && existing.id === room.id) {
    return interaction.reply({ content: 'ℹ️ Bạn đã ở trong phòng này rồi.', ephemeral: true });
  }
  if (isFull(room)) {
    return interaction.reply({ content: '❌ Phòng đã đủ người.', ephemeral: true });
  }
  if (room.status === 'revealed') {
    return interaction.reply({
      content: '❌ Phòng đang chuẩn bị vào game, không thể tham gia lúc này.',
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

  return interaction.reply({ content: `✅ Bạn đã gia nhập **${room.label}**.`, ephemeral: true });
}

async function leaveRoom(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });
  if (!room.players.has(interaction.user.id)) {
    return interaction.reply({ content: 'ℹ️ Bạn không ở trong phòng này.', ephemeral: true });
  }
  if (room.status === 'revealed') {
    return interaction.reply({
      content: '❌ Phòng đã phát code, không thể rời lúc này. Chờ phòng tự reset nhé.',
      ephemeral: true,
    });
  }

  room.players.delete(interaction.user.id);
  const channel = interaction.channel;

  if (room.timers.readyCountdown && !isFull(room)) {
    clearTimeout(room.timers.readyCountdown);
    room.timers.readyCountdown = null;
    room.fullAt = null;
  }

  if (room.players.size === 0) {
    resetRoom(room);
  }
  await renderRoom(room, channel);
  return interaction.reply({ content: `✅ Bạn đã rời **${room.label}**.`, ephemeral: true });
}

async function toggleReady(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });
  const player = room.players.get(interaction.user.id);
  if (!player) {
    return interaction.reply({ content: '⚠️ Bạn cần **Gia nhập** phòng trước khi bấm Sẵn sàng.', ephemeral: true });
  }
  if (room.status === 'revealed') {
    return interaction.reply({ content: 'ℹ️ Phòng đã phát code rồi, chờ vòng sau nhé.', ephemeral: true });
  }
  if (!checkCooldown(interaction.user.id)) {
    return interaction.reply({ content: '⏳ Bạn thao tác hơi nhanh, đợi 1-2 giây rồi thử lại.', ephemeral: true });
  }

  player.ready = !player.ready;
  const channel = interaction.channel;
  await renderRoom(room, channel);
  await tryRevealCode(room, channel);

  let extra = '';
  if (room.status === 'waiting' && isFull(room) && allReady(room)) {
    extra = '\n⚖️ Team hiện chưa cân bằng nên code chưa được phát — tự đổi team hoặc chờ người khác đổi.';
  }

  return interaction.reply({
    content: (player.ready ? '✅ Bạn đã sẵn sàng.' : '↩️ Bạn đã bỏ trạng thái sẵn sàng.') + extra,
    ephemeral: true,
  });
}

async function setTeam(interaction, roomId, team) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });
  const player = room.players.get(interaction.user.id);
  if (!player) {
    return interaction.reply({ content: '⚠️ Bạn cần **Gia nhập** phòng trước khi chọn team.', ephemeral: true });
  }
  if (room.status === 'revealed') {
    return interaction.reply({ content: 'ℹ️ Phòng đã phát code rồi, không đổi team được nữa.', ephemeral: true });
  }
  if (!checkCooldown(interaction.user.id)) {
    return interaction.reply({ content: '⏳ Bạn thao tác hơi nhanh, đợi 1-2 giây rồi thử lại.', ephemeral: true });
  }

  player.team = team;
  const channel = interaction.channel;
  await renderRoom(room, channel);
  await tryRevealCode(room, channel);

  return interaction.reply({
    content: team ? `✅ Bạn đã chọn **Team ${team}**.` : '✅ Bạn chọn không phân team.',
    ephemeral: true,
  });
}

async function giveCode(interaction, roomId) {
  const room = getRoom(roomId);
  if (!room) return interaction.reply({ content: '❌ Phòng không tồn tại.', ephemeral: true });
  if (room.status !== 'revealed' || !room.code) {
    return interaction.reply({ content: 'ℹ️ Phòng chưa có code.', ephemeral: true });
  }
  const personal = formatPersonalCode(room, interaction.user.id);
  if (!personal) {
    return interaction.reply({ content: '⚠️ Bạn không nằm trong phòng này.', ephemeral: true });
  }
  return interaction.reply({
    content: `🔑 Code của bạn (bấm giữ để copy):\n\`\`\`${personal}\`\`\``,
    ephemeral: true,
  });
}

client.login(config.TOKEN)
  .then(() => console.log(`=== BOT DISCORD ĐÃ ONLINE THÀNH CÔNG: ${client.user.tag} ===`))
  .catch((err) => console.error('=== LỖI ĐĂNG NHẬP DISCORD ===', err));

// Bắt lỗi ngầm (unhandled) để log ra Render thay vì bot tự chết âm thầm không rõ lý do
process.on('unhandledRejection', (err) => console.error('=== UNHANDLED REJECTION ===', err));
