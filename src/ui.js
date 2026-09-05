const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const config = require('../config');
const { isFull, allReady, teamCounts, canRevealCode } = require('./rooms');

function mainMenuEmbed() {
  return new EmbedBuilder()
    .setTitle('🎮 Ghép đội Vainglory')
    .setDescription(
      'Chọn chế độ bạn muốn chơi bên dưới để xem danh sách phòng.\n\n' +
        '**3v3** — 4 phòng, mỗi phòng 6 người\n' +
        '**5v5** — 4 phòng, mỗi phòng 10 người'
    )
    .setColor(0x5865f2);
}

function mainMenuRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('menu_3v3').setLabel('3v3').setStyle(ButtonStyle.Primary).setEmoji('⚔️'),
    new ButtonBuilder().setCustomId('menu_5v5').setLabel('5v5').setStyle(ButtonStyle.Danger).setEmoji('🛡️')
  );
}

function roomListRows(roomsOfMode) {
  const row = new ActionRowBuilder();
  for (const room of roomsOfMode) {
    const full = isFull(room);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`openroom_${room.id}`)
        .setLabel(`#${room.index} (${room.players.size}/${room.capacity})`)
        .setStyle(full ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(full && room.status !== 'waiting' ? true : false)
    );
  }
  return [row];
}

function statusText(room) {
  if (room.status === 'revealed') return '🟢 Đã phát code — chuẩn bị vào game!';

  if (isFull(room)) {
    const check = canRevealCode(room);
    if (check.ok) return '🟡 Đã đủ người — chờ mọi người bấm Sẵn sàng';
    const lines = [
      `🟠 **Đã đủ người!** Có ${Math.round(config.READY_COUNTDOWN_MS / 60000)} phút để tất cả bấm Sẵn sàng.`,
      '⚠️ Ai chưa Sẵn sàng khi hết giờ sẽ **bị đá khỏi phòng** để nhường slot cho người khác.',
    ];
    if (check.reason === 'team_unbalanced') lines.push('⚖️ Team đang **chưa cân bằng**, code sẽ không phát cho tới khi đều nhau.');
    if (check.reason === 'team_incomplete') lines.push('⚖️ Có người chưa chọn Team — cần **tất cả cùng chọn** hoặc **không ai chọn** team.');
    return lines.join('\n');
  }

  return '⚪ Đang chờ người tham gia';
}

function playerLine(player) {
  const teamTag = player.team ? `**[Team ${player.team}]**` : '_(chưa chọn team)_';
  const readyTag = player.ready ? '✅ Sẵn sàng' : '❌ Chưa sẵn sàng';
  return `• <@${player.id ?? ''}> ${teamTag} — ${readyTag}`;
}

function roomEmbed(room) {
  const embed = new EmbedBuilder()
    .setTitle(`${room.label} — ${room.players.size}/${room.capacity}`)
    .setColor(room.status === 'revealed' ? 0x57f287 : isFull(room) ? 0xfee75c : 0x5865f2)
    .setDescription(statusText(room));

  if (room.players.size > 0) {
    const lines = Array.from(room.players.entries()).map(([id, p]) =>
      playerLine({ ...p, id })
    );
    embed.addFields({ name: 'Người chơi', value: lines.join('\n').slice(0, 1024) });

    const { team1, team2, none } = teamCounts(room);
    if (team1 > 0 || team2 > 0) {
      embed.addFields({
        name: 'Team',
        value: `Team 1: **${team1}** — Team 2: **${team2}** — Chưa chọn: **${none}**`,
      });
    }
  } else {
    embed.addFields({ name: 'Người chơi', value: '_Chưa có ai đăng ký_' });
  }

  if (room.status === 'revealed' && room.code) {
    embed.addFields({
      name: '🔑 Code phòng',
      value:
        'Bấm nút **"📋 Lấy code của tôi"** bên dưới để nhận mã riêng của bạn (dễ copy).\n' +
        `Phòng sẽ tự reset sau ${Math.round(config.CODE_RESET_DELAY_MS / 1000)} giây.`,
    });
  }

  embed.setFooter({
    text: `Timeout tự reset khi chưa đủ người: ${Math.round(room.timeoutMs / 60000)} phút`,
  });

  return embed;
}

function roomActionRows(room) {
  const full = isFull(room);
  const ready = allReady(room) && full;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_${room.id}`)
      .setLabel('Gia nhập')
      .setStyle(ButtonStyle.Success)
      .setEmoji('➕')
      .setDisabled(full),
    new ButtonBuilder()
      .setCustomId(`leave_${room.id}`)
      .setLabel('Rời đi')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🚪'),
    new ButtonBuilder()
      .setCustomId(`ready_${room.id}`)
      .setLabel('Sẵn sàng')
      .setStyle(ready ? ButtonStyle.Success : ButtonStyle.Primary)
      .setEmoji(ready ? '✅' : '🙋')
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`team1_${room.id}`).setLabel('Team 1').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`team2_${room.id}`).setLabel('Team 2').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`teamnone_${room.id}`).setLabel('Không chọn team').setStyle(ButtonStyle.Secondary)
  );

  const canPlay = room.status === 'revealed';
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel(canPlay ? (room._blinkOn ? '📱 Chơi ngay (iOS)' : '📱 Chơi ngay (iOS) ✨') : '📱 Chơi (iOS)')
      .setStyle(ButtonStyle.Link)
      .setURL(config.IOS_STORE_URL)
      .setDisabled(!canPlay),
    new ButtonBuilder()
      .setLabel(canPlay ? (room._blinkOn ? '🤖 Chơi ngay (Android)' : '🤖 Chơi ngay (Android) ✨') : '🤖 Chơi (Android)')
      .setStyle(ButtonStyle.Link)
      .setURL(config.ANDROID_STORE_URL)
      .setDisabled(!canPlay)
  );

  const rows = [row1, row2, row3];

  if (room.status === 'revealed') {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`copycode_${room.id}`)
          .setLabel('📋 Lấy code của tôi')
          .setStyle(ButtonStyle.Success)
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
};
