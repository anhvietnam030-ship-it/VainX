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
  createHiddenRoom,
  getHiddenRoom,
  getAllHiddenRooms,
  deleteHiddenRoom,
  ensureRoom,
  addRoomsToMode,
  removeExtraRoom,
} = require('./src/rooms');
const { mainMenuEmbed, mainMenuRow, roomListRows, roomEmbed, roomActionRows, roomActionRowsEN } = require('./src/ui');
const persistence = require('./src/persistence');
const { startKeepAliveServer, startSelfPing } = require('./src/keepalive');

// Chọn text theo ngôn ngữ Discord client của người bấm nút (chỉ áp dụng được cho
// các phản hồi ephemeral - riêng người bấm mới thấy). Không dùng được cho tin nhắn
// công khai trong kênh hay embed panel phòng, vì những cái đó hiển thị chung cho
// tất cả mọi người, Discord không cho hiển thị khác nhau theo từng người xem.
function t(interaction, vi, en) {
  return interaction.locale === 'vi' ? vi : en;
}

// Ghép song ngữ VN + EN cho những tin nhắn CÔNG KHAI (kênh chung / DM chủ động),
// vì những tin này hiển thị y hệt cho mọi người xem, không thể chỉ hiện 1 thứ
// tiếng riêng theo từng người như các phản hồi ephemeral ở trên.
function bi(vi, en) {
  return `${vi}\n🌐 ${en}`;
}

// Mở server HTTP nhỏ để nền tảng hosting kiểu "Web Service" (Render, ...) không báo
// port scan timeout. Nếu chạy trên máy riêng / VPS / Background Worker thì dòng này
// vô hại, chỉ tốn 1 cổng cục bộ.
startKeepAliveServer();
// Tự ping chính mình mỗi 10 phút để hạn chế bị Render spin-down (xem ghi chú trong keepalive.js).
startSelfPing();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
initRooms();
persistence.loadState().forEach((data, id) => {
  // Nếu id không nằm trong 4 phòng mặc định (vì admin đã /setup che_do so_luong để tạo thêm trước khi bot restart)
  // thì tạo lại đúng slot đó trước khi gán dữ liệu đã lưu vào, tránh mất phòng admin đã thêm.
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

// Dùng cho những lệnh có thể được gọi TỪ CẢ TRONG SERVER LẪN TRONG DM (ví dụ
// /xoa-tin-nhan-bot) — tự chọn đúng cách kiểm tra quyền admin theo ngữ cảnh.
async function isAdminAnywhere(interaction) {
  if (interaction.member) return isAdmin(interaction);
  return isAdminUserId(interaction.user.id);
}

// Dùng khi tương tác xảy ra trong DM (interaction.member = null vì DM không có ngữ cảnh
// server) - phải tự tra cứu thành viên đó trong guild chính để biết họ có phải admin không.
// Cần thiết cho các nút quản lý phòng ẩn (được bấm từ trong DM).
async function isAdminUserId(userId) {
  // KHÔNG fail cứng nếu thiếu GUILD_ID trong .env — biến này vốn optional cho các lệnh khác
  // nên rất dễ bị bỏ quên, và nếu fail cứng ở đây thì MỌI admin thật đều bị báo sai "không
  // có quyền" khi thao tác từ trong DM (panel phòng ẩn). Thay vào đó: nếu có GUILD_ID thì ưu
  // tiên dùng đúng guild đó; nếu không, dò qua tất cả server mà bot đang tham gia.
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

// Chuẩn hóa ID phòng gõ/dán vào lệnh admin: bỏ dấu backtick (```` ` ````) và khoảng trắng thừa.
// Lý do: ID phòng được hiển thị trong code-format (`3v3-an-...`) để dễ đọc, nhưng trên
// Discord mobile, long-press "copy" sẽ dính luôn dấu backtick bao quanh — dán vào ô lệnh
// sẽ không khớp ID thật, khiến lệnh báo "không tìm thấy phòng" dù ID đúng (mà PC thì copy
// sạch nên không dính lỗi này — đúng kiểu "lúc được lúc không" tùy máy).
function sanitizeRoomId(raw) {
  return String(raw ?? '').replace(/`/g, '').trim();
}

async function logAdmin(text) {
  if (!config.LOG_CHANNEL_ID) return;
  const ch = await client.channels.fetch(config.LOG_CHANNEL_ID).catch(() => null);
  if (ch) await ch.send(text).catch(() => {});
}

// Vẽ lại / tạo panel phòng trong kênh, dùng chung cho mọi thay đổi state
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

// Bảng màu "tia chớp" ngẫu nhiên khi phòng đủ người đang chờ Sẵn sàng
const FLASH_COLORS = [0xffffff, 0xffd700, 0xff69b4, 0x00ffff, 0xff4500, 0x9b59b6];

// Bắt đầu hiệu ứng nhấp nháy (nút Sẵn sàng đổi màu rainbow + embed thỉnh thoảng "chớp")
// khi phòng vừa đủ người, đang chờ mọi người bấm Sẵn sàng. Tự dừng khi phát code hoặc reset
// (vì clearRoomTimers đã xóa timer này rồi).
function startWaitingBlink(room, channel) {
  if (room.timers.blink) return; // đã chạy rồi, khỏi chạy chồng
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
        // Phòng ẩn: KHÔNG được gửi thông báo vào kênh công khai (dù channel truyền vào là kênh
        // admin gõ lệnh test) - chỉ báo riêng qua DM cho những người đã từng được mời.
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
    // Phòng ẩn: không có kênh chung để ping, nhưng vẫn nhắc riêng từng người qua DM như bình thường.
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

  // Gửi tin nhắn riêng (DM) cho từng người trong phòng
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
      .catch(() => {}); // user tắt DM hoặc lỗi khác -> bỏ qua, không chặn luồng chính
  }
}

function scheduleReadyCountdown(room, channel) {
  if (room.timers.readyCountdown) clearTimeout(room.timers.readyCountdown);
  room.fullAt = Date.now();
  room.timers.readyCountdown = setTimeout(() => handleReadyCountdownExpire(room, channel), config.READY_COUNTDOWN_MS);
  startWaitingBlink(room, channel);
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
  if (room.timers.blink) {
    clearInterval(room.timers.blink);
    room.timers.blink = null;
    room._flashColor = null;
  }

  if (kicked.length === 0) {
    // Mọi người đã sẵn sàng nhưng vẫn kẹt (thường do team chưa cân bằng) -> không đá ai,
    // đồng hồ 30' gốc (từ firstJoinAt) vẫn chạy làm lưới an toàn.
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
    }

    // Tự dọn rác: mọi phản hồi riêng tư (ephemeral - chỉ người bấm thấy) sẽ tự bị xóa
    // sau 5 phút, đỡ chất đống trong lịch sử chat của từng người.
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
        roomCount: list.length,
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

  if (commandName === 'ready') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
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
    persistence.saveState(rooms);

    return interaction.reply({
      content: `✅ Đã gia hạn thêm **${phut} phút** cho **${room.label}** trước khi tự reset.`,
      ephemeral: true,
    });
  }

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
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
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

  // Đá khỏi TRẬN đang diễn ra trong phòng — KHÔNG ban, KHÔNG đụng tới quyền xem/mời của
  // phòng ẩn. Người bị đá vẫn còn trong danh sách được mời (nếu là phòng ẩn) và có thể tự
  // bấm "Gia nhập" lại ngay trên panel của họ.
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
    persistence.saveState(rooms);

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

  // Xoá hẳn khỏi NHÓM được mời của 1 phòng ẨN — mất quyền xem/tương tác panel luôn, không
  // giống kick-room (chỉ đá khỏi trận, vẫn còn quyền xem). Chỉ áp dụng cho phòng ẩn vì phòng
  // thường không có khái niệm "danh sách được mời".
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

    // Xoá hẳn tin nhắn panel trong DM của họ (không chỉ sửa nội dung) để họ không còn thấy gì nữa
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

  if (commandName === 'moi-phong-an') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    // Menu chọn người (User Select) chỉ hiện đủ danh sách thành viên khi mở TRONG 1 kênh
    // của server — mở từ DM sẽ bị Discord giới hạn chỉ thấy vài người. Chặn ở đây để không
    // lặp lại bug "chỉ mời được 2 người".
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

  if (commandName === 'xoa-phong-an') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getHiddenRoom(roomId);
    if (!room) {
      return interaction.reply({ content: `❌ Không tìm thấy phòng ẩn "${roomId}".`, ephemeral: true });
    }

    // Báo cho những người đã được mời biết phòng đã bị đóng (DM riêng, không ai khác thấy)
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

  // Gộp /setup-phong (đăng panel) + /them-phong (tạo thêm phòng) thành 1 lệnh /setup duy nhất:
  // không nhập so_luong -> chỉ đăng lại panel của các phòng hiện có (như /setup-phong cũ);
  // có nhập so_luong -> đảm bảo đủ số phòng đó (tự tạo thêm nếu còn thiếu, tối đa 10
  // phòng/chế độ), rồi mới đăng panel của TẤT CẢ phòng trong chế độ đó.
  if (commandName === 'setup') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const mode = interaction.options.getString('che_do', true);
    const soLuong = interaction.options.getInteger('so_luong'); // optional

    let note = '';
    if (soLuong) {
      const currentCount = getRoomsByMode(mode).length;
      if (soLuong > currentCount) {
        const { created, capped, currentTotal, maxAllowed } = addRoomsToMode(mode, soLuong - currentCount);
        if (created.length > 0) {
          note += `\n✅ Đã tạo thêm **${created.length}** phòng mới: ${created.map((r) => `\`${r.id}\``).join(', ')}.`;
        }
        if (capped) {
          note += `\n⚠️ Chỉ tạo được tới **${currentTotal}/${maxAllowed}** phòng vì đã chạm giới hạn tối đa ${maxAllowed} phòng/chế độ.`;
        }
      } else if (soLuong < currentCount) {
        note += `\nℹ️ Chế độ này đã có **${currentCount}** phòng (nhiều hơn ${soLuong} bạn nhập) — lệnh này không tự xóa bớt, dùng \`/xoa-phong-thuong\` nếu muốn giảm.`;
      }
    }

    const roomsOfMode = getRoomsByMode(mode);

    await interaction.reply({
      content: `✅ Đang đăng ${roomsOfMode.length} panel phòng **${mode.toUpperCase()}** vào kênh này...${note}`,
      ephemeral: true,
    });

    for (const room of roomsOfMode) {
      // Bỏ liên kết panel cũ (nếu có ở kênh khác) để panel mới luôn được tạo tại đúng kênh này.
      room.panelChannelId = null;
      room.panelMessageId = null;
      await renderRoom(room, interaction.channel);
    }
    persistence.saveState(rooms);
    return;
  }

  if (commandName === 'test-fill') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh test này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
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

  if (commandName === 'xoa-setup-phong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const mode = interaction.options.getString('che_do'); // optional, để trống = tất cả
    const targetRooms = mode ? getRoomsByMode(mode) : getAllRooms();

    await interaction.reply({
      content: `🗑️ Đang xóa panel của ${targetRooms.length} phòng...`,
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
    persistence.saveState(rooms);

    return interaction.followUp({
      content: `✅ Đã xóa **${deletedCount}** panel và reset **${targetRooms.length}** phòng. Dùng /setup để đăng panel mới.`,
      ephemeral: true,
    });
  }

  if (commandName === 'don-rac') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const soLuong = interaction.options.getInteger('so_luong') || 50;
    const channel = interaction.channel;

    await interaction.reply({ content: `🧹 Đang dọn ${soLuong} tin nhắn gần nhất...`, ephemeral: true });

    try {
      const deleted = await channel.bulkDelete(soLuong, true);
      return interaction.followUp({
        content: `✅ Đã xóa **${deleted.size}** tin nhắn (Discord chỉ cho xóa hàng loạt tin nhắn dưới 14 ngày tuổi, tin cũ hơn sẽ bị bỏ qua).`,
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

  if (commandName === 'xoa-tin-nhan-bot') {
    // Lệnh này dùng được cả TRONG SERVER lẫn TRONG DM riêng với Bot -> phải tự chọn đúng
    // cách kiểm tra quyền admin theo ngữ cảnh (isAdmin thường trả về false trong DM vì
    // Discord không gửi kèm interaction.member ở đó).
    const allowed = await isAdminAnywhere(interaction);
    if (!allowed) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    // Để trống so_luong = xóa TẤT CẢ tin nhắn của Bot trong kênh/DM này (quét ngược lịch sử,
    // gộp theo lô 100 tin/lần fetch). Có nhập so_luong = chỉ xóa đúng số đó (mới nhất trước).
    const soLuong = interaction.options.getInteger('so_luong'); // null = tất cả
    const channel = interaction.channel;
    const isDM = !interaction.guild; // true khi lệnh được gõ trong DM với Bot
    const noiChung = isDM ? 'trong DM này' : 'trong kênh này';
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

    await interaction.reply({
      content: soLuong
        ? `🧹 Đang xóa tối đa **${soLuong}** tin nhắn của Bot ${noiChung}...`
        : `🧹 Đang xóa **TẤT CẢ** tin nhắn của Bot ${noiChung} (có thể mất một lúc nếu nhiều tin cũ)...`,
      ephemeral: true,
    });

    let totalDeleted = 0;
    let lastId;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (soLuong && totalDeleted >= soLuong) break;
        const batch = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
        if (batch.size === 0) break;
        lastId = batch.last().id;

        let botMsgs = Array.from(batch.filter((m) => m.author.id === client.user.id).values());
        if (soLuong && botMsgs.length > soLuong - totalDeleted) {
          botMsgs = botMsgs.slice(0, soLuong - totalDeleted);
        }

        if (botMsgs.length > 0) {
          if (isDM) {
            // Discord KHÔNG hỗ trợ xóa hàng loạt (bulkDelete) trong kênh DM — chỉ xóa được
            // từng tin một qua API, nên phải xóa lần lượt (kèm nghỉ ngắn để tránh rate-limit).
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

        if (batch.size < 100) break; // đã quét tới đầu kênh/DM
      }
    } catch (err) {
      console.error('Lỗi xoa-tin-nhan-bot:', err);
    }

    return interaction.followUp({
      content:
        `✅ Đã xóa **${totalDeleted}** tin nhắn của Bot ${noiChung}.` +
        (totalDeleted > 0 && !isDM
          ? '\n⚠️ Nếu vừa xóa trúng panel phòng đang hoạt động, dùng lại `/setup` để đăng panel mới.'
          : ''),
      ephemeral: true,
    });
  }

  if (commandName === 'xoa-phong-thuong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }
    const roomId = sanitizeRoomId(interaction.options.getString('phong', true));
    const room = getRoom(roomId);
    if (!room || room.hidden) {
      return interaction.reply({
        content: `❌ Không tìm thấy phòng thường "${roomId}" (lệnh này không xóa được phòng ẩn — dùng \`/xoa-phong-an\` cho phòng ẩn).`,
        ephemeral: true,
      });
    }

    // Xóa panel cũ trên Discord trước khi xóa phòng khỏi bộ nhớ, tránh để lại panel "mồ côi".
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

    persistence.saveState(rooms);
    return interaction.reply({ content: `✅ Đã xóa hẳn **${result.room.label}** (\`${result.room.id}\`).`, ephemeral: true });
  }

  if (commandName === 'reset-tat-ca-phong') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Chỉ admin mới dùng được lệnh này.', ephemeral: true });
    }

    const allRoomsNow = getAllRooms();
    await interaction.reply({ content: `♻️ Đang reset toàn bộ ${allRoomsNow.length} phòng...`, ephemeral: true });

    for (const room of allRoomsNow) {
      resetRoom(room);
      const channel =
        (room.panelChannelId && (await client.channels.fetch(room.panelChannelId).catch(() => null))) ||
        interaction.channel;
      await renderRoom(room, channel);
    }
    persistence.saveState(rooms);

    return interaction.followUp({ content: `✅ Đã reset toàn bộ ${allRoomsNow.length} phòng (3v3 + 5v5) về trạng thái trống.`, ephemeral: true });
  }

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
      content: t(
        interaction,
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

    // NGUYÊN NHÂN của bug "chỉ mời được 2 người, không hiện đủ danh sách": panel phòng ẩn
    // được gửi qua DM, nên khi admin bấm "Mời riêng" NGAY TRONG DM, menu chọn người (User
    // Select) được tạo ra cũng nằm trong ngữ cảnh DM — mà Discord chỉ cho User Select trong
    // DM thấy vài người liên quan gần đây (không có ngữ cảnh server nên không tra được đủ
    // danh sách thành viên), khác hẳn khi menu đó được mở trong 1 kênh của server (đủ danh
    // sách, tìm kiếm được, chọn tối đa 25 người/lần — mức tối đa Discord cho phép/1 menu).
    // Vì vậy: nếu bấm nút này từ trong DM, không tạo menu ở đây nữa (vì kiểu gì cũng thiếu
    // người) mà hướng dẫn admin dùng lệnh /moi-phong-an ngay trong 1 kênh của server.
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
}

async function sendHiddenRoomDM(room, targetUser, introText) {
  const dm = await targetUser.createDM();
  const embed = roomEmbed(room);
  const rowsUi = roomActionRows(room);
  const sent = await dm.send({ content: introText, embeds: [embed], components: rowsUi });
  room.panelTargets.push({ userId: targetUser.id, channelId: dm.id, messageId: sent.id });
  return sent;
}

async function handleHiddenInviteSelect(interaction, roomId) {
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
    // Đã có bản DM cho người này rồi -> khỏi gửi lại, tránh spam trùng
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

async function handleUserSelectMenu(interaction) {
  const { customId } = interaction;

  if (customId.startsWith('hiddeninvite_')) {
    return handleHiddenInviteSelect(interaction, customId.replace('hiddeninvite_', ''));
  }

  if (!customId.startsWith('inviteselect_')) return;

  const roomId = customId.replace('inviteselect_', '');
  const room = getRoom(roomId);
  if (!room) return interaction.update({ content: t(interaction, '❌ Phòng không tồn tại.', '❌ This room does not exist.'), components: [] });

  const targets = interaction.users; // Collection<userId, User> - có thể nhiều người
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
      content: t(
        interaction,
        `❌ Bạn đã bị cấm tham gia **${room.label}** (vẫn vào được các phòng khác bình thường).`,
        `❌ You're banned from **${room.label}** (you can still join other rooms).`
      ),
      ephemeral: true,
    });
  }

  if (interaction.member && config.JOIN_ROLE_ID && !interaction.member.roles?.cache?.has(config.JOIN_ROLE_ID)) {
    return interaction.reply({
      content: t(
        interaction,
        `❌ Bạn cần role <@&${config.JOIN_ROLE_ID}> mới được tham gia phòng.`,
        `❌ You need the <@&${config.JOIN_ROLE_ID}> role to join a room.`
      ),
      ephemeral: true,
    });
  }

  const existing = findRoomOfUser(interaction.user.id);
  if (existing && existing.id !== room.id) {
    return interaction.reply({
      content: t(
        interaction,
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
      content: t(
        interaction,
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
      content: t(
        interaction,
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
      content: t(
        interaction,
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
    extra = t(
      interaction,
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
    content: t(
      interaction,
      '🔑 Code của bạn (tin nhắn ngay bên dưới, bấm giữ để copy):',
      '🔑 Your code (message right below, tap and hold to copy):'
    ),
    ephemeral: true,
  });
  // Gửi code ở tin nhắn riêng, KHÔNG bọc code block (```) và không kèm chữ nào khác.
  // Lý do: trên Discord mobile, long-press vào một khối code sẽ copy luôn cả 3 dấu
  // backtick bao quanh (hành vi có sẵn của app Discord mobile, bot không chỉnh được).
  // Một tin nhắn chỉ chứa đúng mỗi chuỗi code thì long-press ở máy nào cũng copy sạch,
  // không dính ký tự thừa.
  return interaction.followUp({
    content: personal,
    ephemeral: true,
  });
}

client.login(config.TOKEN)
  .then(() => console.log(`=== BOT DISCORD ĐÃ ONLINE THÀNH CÔNG: ${client.user.tag} ===`))
  .catch((err) => console.error('=== LỖI ĐĂNG NHẬP DISCORD ===', err));

// Bắt lỗi ngầm (unhandled) để log ra Render thay vì bot tự chết âm thầm không rõ lý do
process.on('unhandledRejection', (err) => console.error('=== UNHANDLED REJECTION ===', err));
