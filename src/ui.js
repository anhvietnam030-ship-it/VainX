const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const config = require('../config');
const { isFull, allReady, teamCounts, canRevealCode } = require('./rooms');

const COLOR = {
  empty: 0x99aab5, // xám - chưa có ai
  partial: 0x5865f2, // blurple - đang có người, chưa đủ
  fullWaiting: 0xfee75c, // vàng - đủ người, chờ sẵn sàng
  fullBlocked: 0xe67e22, // cam - đủ người, kẹt vì team lệch
  revealed: 0x57f287, // xanh lá - đã phát code
};

const RAINBOW_EMOJI = ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🌈'];

const MODE_EMOJI = { '3v3': '⚔️', '5v5': '🛡️' };

function progressBar(current, total, size = 12) {
  const filled = Math.max(0, Math.min(size, Math.round((current / total) * size)));
  return '🟩'.repeat(filled) + '⬜'.repeat(size - filled);
}

function unixSeconds(ms) {
  return Math.floor(ms / 1000);
}

// Ghép song ngữ VN + EN cho embed panel phòng — panel này hiển thị chung cho
// tất cả mọi người trong kênh nên không thể cá nhân hóa theo từng người xem.
function bi(vi, en) {
  return `${vi}\n🌐 ${en}`;
}

// ---------- Bảng chọn chế độ ----------

function mainMenuEmbed(stats) {
  const line3v3 = stats
    ? bi(
        `⚔️ **3v3** — 4 phòng · mỗi phòng **6** người · đang chờ: **${stats['3v3'].current}/${stats['3v3'].total}**`,
        `⚔️ **3v3** — 4 rooms · **6** players each · waiting: **${stats['3v3'].current}/${stats['3v3'].total}**`
      )
    : bi('⚔️ **3v3** — 4 phòng · mỗi phòng **6** người', '⚔️ **3v3** — 4 rooms · **6** players each');
  const line5v5 = stats
    ? bi(
        `🛡️ **5v5** — 4 phòng · mỗi phòng **10** người · đang chờ: **${stats['5v5'].current}/${stats['5v5'].total}**`,
        `🛡️ **5v5** — 4 rooms · **10** players each · waiting: **${stats['5v5'].current}/${stats['5v5'].total}**`
      )
    : bi('🛡️ **5v5** — 4 phòng · mỗi phòng **10** người', '🛡️ **5v5** — 4 rooms · **10** players each');

  return new EmbedBuilder()
    .setTitle('🎮 ✨ VAINGLORY LOBBY ✨')
    .setDescription(
      bi('**Chọn chế độ bên dưới để bắt đầu ghép đội!**', '**Pick a mode below to start matchmaking!**') +
        '\n━━━━━━━━━━━━━━━━━━━━━━\n' +
        `${line3v3}\n${line5v5}\n` +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        bi('_Mỗi người chỉ ở được 1 phòng tại một thời điểm._', '_Each person can only be in 1 room at a time._')
    )
    .setColor(0x5865f2)
    .setFooter({
      text: stats
        ? bi('📊 Số liệu tại thời điểm đăng · 🏆 Vào trận ngay!', '📊 Stats as of posting · 🏆 Get in a match now!')
        : bi('🏆 Ghép đội nhanh — Vào trận ngay!', '🏆 Fast matchmaking — Play now!'),
    });
}

function mainMenuRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('menu_3v3').setLabel('Chơi 3v3').setStyle(ButtonStyle.Primary).setEmoji('⚔️'),
    new ButtonBuilder().setCustomId('menu_5v5').setLabel('Chơi 5v5').setStyle(ButtonStyle.Danger).setEmoji('🛡️')
  );
}

const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

function roomListRows(roomsOfMode) {
  const row = new ActionRowBuilder();
  for (const room of roomsOfMode) {
    const full = isFull(room);
    let style = ButtonStyle.Success;
    if (room.status === 'revealed') style = ButtonStyle.Secondary;
    else if (full) style = ButtonStyle.Danger;

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`openroom_${room.id}`)
        .setLabel(`Phòng ${room.index} · ${room.players.size}/${room.capacity}`)
        .setEmoji(NUM_EMOJI[room.index - 1] || '🔹')
        .setStyle(style)
        .setDisabled(full)
    );
  }
  return [row];
}

// ---------- Panel phòng ----------

function roomColor(room) {
  if (room.status === 'revealed') return COLOR.revealed;
  if (isFull(room)) {
    if (!canRevealCode(room).ok) return COLOR.fullBlocked;
    // 🌩️ Hiệu ứng "tia chớp": thỉnh thoảng chớp sang màu ngẫu nhiên trong lúc chờ sẵn sàng
    if (room._blinkOn && room._flashColor) return room._flashColor;
    return COLOR.fullWaiting;
  }
  if (room.players.size > 0) return COLOR.partial;
  return COLOR.empty;
}

function statusText(room) {
  if (room.status === 'revealed') {
    const deadline = room.revealedAt ? unixSeconds(room.revealedAt + config.CODE_RESET_DELAY_MS) : null;
    return bi(
      '🟢 **Đã phát code — chuẩn bị vào game!**' + (deadline ? `\n♻️ Phòng tự reset ${`<t:${deadline}:R>`}` : ''),
      '🟢 **Code revealed — get ready to play!**' + (deadline ? `\n♻️ Room auto-resets ${`<t:${deadline}:R>`}` : '')
    );
  }

  if (isFull(room)) {
    const check = canRevealCode(room);
    const deadline = room.fullAt ? unixSeconds(room.fullAt + config.READY_COUNTDOWN_MS) : null;

    if (check.ok) {
      return bi(
        '🟡 **Đủ người rồi!** Đang chờ tất cả bấm Sẵn sàng để phát code...',
        '🟡 **Room is full!** Waiting for everyone to hit Ready so the code can be revealed...'
      );
    }

    const linesVi = [`🟠 **Đủ người!** Hạn bấm Sẵn sàng: ${deadline ? `<t:${deadline}:R>` : '—'}`];
    linesVi.push('⚠️ Hết giờ mà chưa Sẵn sàng → **bị đá khỏi phòng**, nhường chỗ cho người khác.');
    if (check.reason === 'team_unbalanced') linesVi.push('⚖️ Team đang **chưa cân bằng** — code sẽ không phát cho tới khi đều nhau.');
    if (check.reason === 'team_incomplete') linesVi.push('⚖️ Có người chưa chọn Team — cần **tất cả cùng chọn** hoặc **không ai chọn** team.');

    const linesEn = [`🟠 **Room full!** Ready deadline: ${deadline ? `<t:${deadline}:R>` : '—'}`];
    linesEn.push("⚠️ Not Ready in time → you'll be **kicked from the room** to free up your spot.");
    if (check.reason === 'team_unbalanced') linesEn.push("⚖️ Teams are **unbalanced** — the code won't be revealed until they're even.");
    if (check.reason === 'team_incomplete') linesEn.push('⚖️ Someone has no Team picked — either **everyone** picks a team or **no one** does.');

    return bi(linesVi.join('\n'), linesEn.join('\n'));
  }

  if (room.players.size > 0) {
    const deadline = room.firstJoinAt ? unixSeconds(room.firstJoinAt + room.timeoutMs) : null;
    return bi(
      '🔵 Đang chờ thêm người tham gia...' + (deadline ? `\n🕐 Tự động reset nếu chưa đủ người: <t:${deadline}:R>` : ''),
      '🔵 Waiting for more players to join...' + (deadline ? `\n🕐 Auto-resets if not full by: <t:${deadline}:R>` : '')
    );
  }
  return bi('⚪ Phòng trống — hãy là người đầu tiên!', '⚪ Room is empty — be the first to join!');
}

function playerLine(player) {
  const readyTag = player.ready ? '✅' : '⌛';
  return `${readyTag} <@${player.id ?? ''}>`;
}

function teamFieldValue(room, team) {
  const list = Array.from(room.players.entries())
    .filter(([, p]) => p.team === team)
    .map(([id, p]) => playerLine({ ...p, id }));
  return list.length ? list.join('\n') : bi('_Trống_', '_Empty_');
}

function noneTeamFieldValue(room) {
  const list = Array.from(room.players.entries())
    .filter(([, p]) => !p.team)
    .map(([id, p]) => playerLine({ ...p, id }));
  return list.length ? list.join('\n') : bi('_Trống_', '_Empty_');
}

function roomEmbed(room) {
  const modeEmoji = MODE_EMOJI[room.mode] || '🎮';
  const { team1, team2, none } = teamCounts(room);
  const usingTeams = team1 > 0 || team2 > 0;

  const embed = new EmbedBuilder()
    .setColor(roomColor(room))
    .setTitle(`${modeEmoji}  ${room.label}`)
    .setDescription(
      `${progressBar(room.players.size, room.capacity)}\n` +
        bi(
          `**${room.players.size} / ${room.capacity}** người`,
          `**${room.players.size} / ${room.capacity}** players`
        ) +
        `\n${statusText(room)}`
    );

  if (room.players.size === 0) {
    embed.addFields({
      name: bi('👥 Người chơi', '👥 Players'),
      value: bi('_Chưa có ai đăng ký — bấm Gia nhập để bắt đầu!_', '_No one signed up yet — hit Join to start!_'),
    });
  } else if (usingTeams) {
    embed.addFields(
      { name: '🔵 Team 1', value: teamFieldValue(room, 1), inline: true },
      { name: '🔴 Team 2', value: teamFieldValue(room, 2), inline: true },
      { name: bi('⚪ Chưa chọn', '⚪ Unassigned'), value: noneTeamFieldValue(room), inline: true }
    );
  } else {
    const list = Array.from(room.players.entries()).map(([id, p]) => playerLine({ ...p, id }));
    embed.addFields({ name: bi('👥 Người chơi', '👥 Players'), value: list.join('\n').slice(0, 1024) });
  }

  if (room.status === 'revealed' && room.code) {
    embed.addFields({
      name: bi('🔑 Code phòng', '🔑 Room code'),
      value: bi(
        '👉 Bấm **"📋 Lấy code của tôi"** bên dưới để nhận mã riêng, dễ copy vào game.',
        '👉 Tap **"📋 Get my code"** below to get your own copy, easy to paste into the game.'
      ),
    });
  }

  // (Tùy chọn) Ảnh/GIF banner riêng theo chế độ — dán URL vào Environment Variables
  // BANNER_3V3_URL / BANNER_5V5_URL trên Render là hiện ra ngay, không cần sửa code/deploy lại.
  const bannerUrl = config.MODE_BANNER_URL && config.MODE_BANNER_URL[room.mode];
  if (bannerUrl) embed.setImage(bannerUrl);

  embed
    .setFooter({
      text: `ID: ${room.id}  •  ${bi(`Timeout chờ đủ người: ${Math.round(room.timeoutMs / 60000)} phút`, `Fill timeout: ${Math.round(room.timeoutMs / 60000)} min`)}`,
    })
    .setTimestamp();

  return embed;
}

function roomActionRows(room) {
  const full = isFull(room);
  const ready = allReady(room) && full;
  const waitingForReady = full && !ready && room.status !== 'revealed';
  const readyEmoji = ready ? '✅' : waitingForReady ? (room._blinkOn ? '🔴' : '🟡') : '🙋';

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_${room.id}`)
      .setLabel('Gia nhập')
      .setStyle(ButtonStyle.Success)
      .setEmoji('➕')
      .setDisabled(full || room.status === 'revealed'),
    new ButtonBuilder()
      .setCustomId(`leave_${room.id}`)
      .setLabel('Rời đi')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🚪')
      .setDisabled(room.status === 'revealed'),
    new ButtonBuilder()
      .setCustomId(`ready_${room.id}`)
      .setLabel(ready ? 'Đã sẵn sàng!' : waitingForReady ? (room._blinkOn ? '🔥 SẴN SÀNG NGAY! 🔥' : '⚡ SẴN SÀNG NGAY! ⚡') : 'Sẵn sàng')
      .setStyle(ready ? ButtonStyle.Success : waitingForReady ? ButtonStyle.Danger : ButtonStyle.Primary)
      .setEmoji(readyEmoji)
      .setDisabled(!full || room.status === 'revealed'),
    new ButtonBuilder()
      .setCustomId(`translate_${room.id}`)
      .setLabel('English')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🌐')
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`team1_${room.id}`)
      .setLabel('Team 1')
      .setEmoji('🔵')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(room.status === 'revealed'),
    new ButtonBuilder()
      .setCustomId(`team2_${room.id}`)
      .setLabel('Team 2')
      .setEmoji('🔴')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(room.status === 'revealed'),
    new ButtonBuilder()
      .setCustomId(`teamnone_${room.id}`)
      .setLabel('Bỏ chọn team')
      .setEmoji('⚪')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(room.status === 'revealed'),
    new ButtonBuilder()
      .setCustomId(`invite_${room.id}`)
      .setLabel('Mời bạn')
      .setEmoji('📨')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(room.status === 'revealed' || isFull(room) || !!room.hidden)
  );

  const canPlay = room.status === 'revealed';
  const sparkle = canPlay && room._blinkOn ? ' ✨' : '';
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel(canPlay ? `🎮 Vào game ngay${sparkle}` : '🎮 Vào game')
      .setStyle(ButtonStyle.Link)
      .setURL(`${config.PUBLIC_BASE_URL}/play`)
      .setDisabled(!canPlay)
  );

  const rows = [row1, row2, row3];

  if (room.status === 'revealed') {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`copycode_${room.id}`)
          .setLabel(room._blinkOn ? '✨ LẤY CODE NGAY! ✨' : 'Lấy code của tôi')
          .setEmoji(room._blinkOn ? '🌈' : '📋')
          .setStyle(room._blinkOn ? ButtonStyle.Danger : ButtonStyle.Success)
      )
    );
  }

  return rows;
}

// ---------- Panel phòng (bản dịch tiếng Anh, chỉ hiển thị ephemeral khi bấm nút "English") ----------

function roomActionRowsEN(room) {
  const full = isFull(room);
  const ready = allReady(room) && full;
  const waitingForReady = full && !ready && room.status !== 'revealed';
  const readyEmoji = ready ? '✅' : waitingForReady ? (room._blinkOn ? '🔴' : '🟡') : '🙋';

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_${room.id}`)
      .setLabel('Join')
      .setStyle(ButtonStyle.Success)
      .setEmoji('➕')
      .setDisabled(full || room.status === 'revealed'),
    new ButtonBuilder()
      .setCustomId(`leave_${room.id}`)
      .setLabel('Leave')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🚪')
      .setDisabled(room.status === 'revealed'),
    new ButtonBuilder()
      .setCustomId(`ready_${room.id}`)
      .setLabel(ready ? 'Ready!' : waitingForReady ? (room._blinkOn ? '🔥 READY NOW! 🔥' : '⚡ READY NOW! ⚡') : 'Ready')
      .setStyle(ready ? ButtonStyle.Success : waitingForReady ? ButtonStyle.Danger : ButtonStyle.Primary)
      .setEmoji(readyEmoji)
      .setDisabled(!full || room.status === 'revealed')
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`team1_${room.id}`)
      .setLabel('Team 1')
      .setEmoji('🔵')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(room.status === 'revealed'),
    new ButtonBuilder()
      .setCustomId(`team2_${room.id}`)
      .setLabel('Team 2')
      .setEmoji('🔴')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(room.status === 'revealed'),
    new ButtonBuilder()
      .setCustomId(`teamnone_${room.id}`)
      .setLabel('Clear team')
      .setEmoji('⚪')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(room.status === 'revealed'),
    new ButtonBuilder()
      .setCustomId(`invite_${room.id}`)
      .setLabel('Invite friend')
      .setEmoji('📨')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(room.status === 'revealed' || isFull(room) || !!room.hidden)
  );

  const canPlay = room.status === 'revealed';
  const sparkle = canPlay && room._blinkOn ? ' ✨' : '';
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel(canPlay ? `🎮 Play now${sparkle}` : '🎮 Play game')
      .setStyle(ButtonStyle.Link)
      .setURL(`${config.PUBLIC_BASE_URL}/play`)
      .setDisabled(!canPlay)
  );

  const rows = [row1, row2, row3];

  if (room.status === 'revealed') {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`copycode_${room.id}`)
          .setLabel(room._blinkOn ? '✨ GET CODE NOW! ✨' : 'Get my code')
          .setEmoji(room._blinkOn ? '🌈' : '📋')
          .setStyle(room._blinkOn ? ButtonStyle.Danger : ButtonStyle.Success)
      )
    );
  }

  return rows;
}

module.exports = {
  mainMenuEmbed,
  mainMenuRow,
  roomListRows,
  roomEmbed,
  roomActionRows,
  roomActionRowsEN,
  progressBar,
};
