const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const config = require('./config');

// Lưu ý: quyền admin được bot tự kiểm tra lúc xử lý lệnh (xem hàm isAdmin trong index.js),
// hỗ trợ cả quyền Administrator lẫn ADMIN_ROLE_ID tùy chỉnh trong .env.
const commands = [
  new SlashCommandBuilder()
    .setName('lobby')
    .setDescription('Đăng bảng chọn phòng Vainglory (3v3 / 5v5) vào kênh này'),

  new SlashCommandBuilder()
    .setName('set-timeout')
    .setDescription('Đổi thời gian tự reset khi phòng chưa đủ người (chỉ admin)')
    .addIntegerOption((opt) =>
      opt.setName('phut').setDescription('Số phút (1-120)').setMinValue(1).setMaxValue(120).setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('pham_vi')
        .setDescription('Áp dụng cho phòng nào')
        .addChoices(
          { name: 'Tất cả phòng', value: 'all' },
          { name: 'Chỉ phòng 3v3', value: '3v3' },
          { name: 'Chỉ phòng 5v5', value: '5v5' }
        )
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('setup-phong')
    .setDescription('Đăng thẳng 4 panel phòng của 1 chế độ vào kênh này (chỉ admin)')
    .addStringOption((opt) =>
      opt
        .setName('che_do')
        .setDescription('Chế độ muốn đăng panel')
        .addChoices({ name: '3v3', value: '3v3' }, { name: '5v5', value: '5v5' })
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('test-fill')
    .setDescription('[TEST] Tự nhét người chơi giả (đã sẵn sàng) vào phòng để test 1 mình (chỉ admin)')
    .addStringOption((opt) =>
      opt
        .setName('phong')
        .setDescription('ID phòng, ví dụ: 3v3-1, 5v5-4')
        .setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('so_nguoi')
        .setDescription('Số người giả muốn thêm (để trống = tự lấp đầy phòng)')
        .setMinValue(1)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('reset-room')
    .setDescription('Ép reset một phòng cụ thể ngay lập tức (chỉ admin)')
    .addStringOption((opt) =>
      opt
        .setName('phong')
        .setDescription('ID phòng, ví dụ: 3v3-1, 5v5-4')
        .setRequired(true)
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(config.TOKEN);

(async () => {
  try {
    if (!config.CLIENT_ID) throw new Error('Thiếu CLIENT_ID trong .env');

    const route = config.GUILD_ID
      ? Routes.applicationGuildCommands(config.CLIENT_ID, config.GUILD_ID)
      : Routes.applicationCommands(config.CLIENT_ID);

    await rest.put(route, { body: commands });
    console.log(
      `Đã đăng ký ${commands.length} slash command(s) ${
        config.GUILD_ID ? `cho guild ${config.GUILD_ID}` : 'toàn cục (có thể mất tới 1h để hiện)'
      }.`
    );
  } catch (err) {
    console.error(err);
  }
})();
