const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const config = require('./config');

const commands = [
  // ----- PHÒNG THƯỜNG -----
  new SlashCommandBuilder()
    .setName('lobby')
    .setDescription('Đăng bảng chọn phòng Vainglory (3v3 / 5v5) vào kênh này'),
  new SlashCommandBuilder()
    .setName('set-timeout')
    .setDescription('Đổi thời gian tự reset khi phòng chưa đủ người (chỉ admin)')
    .addIntegerOption(opt => opt.setName('phut').setDescription('Số phút (1-120)').setMinValue(1).setMaxValue(120).setRequired(true))
    .addStringOption(opt => opt.setName('pham_vi').setDescription('Áp dụng cho phòng nào').addChoices(
      { name: 'Tất cả phòng', value: 'all' },
      { name: 'Chỉ phòng 3v3', value: '3v3' },
      { name: 'Chỉ phòng 5v5', value: '5v5' }
    ).setRequired(false)),
  new SlashCommandBuilder()
    .setName('ready')
    .setDescription('Ép trạng thái Sẵn sàng cho 1 người trong phòng thay họ (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng').setRequired(true))
    .addUserOption(opt => opt.setName('user').setDescription('Người chơi').setRequired(true))
    .addStringOption(opt => opt.setName('trang_thai').setDescription('Sẵn sàng hay Hủy').addChoices(
      { name: 'Sẵn sàng', value: 'ready' },
      { name: 'Hủy sẵn sàng', value: 'notready' }
    ).setRequired(true)),
  new SlashCommandBuilder()
    .setName('gia-han-phong')
    .setDescription('Cộng thêm thời gian trước khi 1 phòng tự reset (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng').setRequired(true))
    .addIntegerOption(opt => opt.setName('phut').setDescription('Số phút').setMinValue(1).setMaxValue(180).setRequired(true)),
  new SlashCommandBuilder()
    .setName('ban-phong')
    .setDescription('Cấm 1 thành viên tham gia 1 phòng cụ thể (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng').setRequired(true))
    .addUserOption(opt => opt.setName('user').setDescription('Thành viên muốn cấm').setRequired(true)),
  new SlashCommandBuilder()
    .setName('unban-phong')
    .setDescription('Bỏ cấm 1 thành viên khỏi 1 phòng cụ thể (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng').setRequired(true))
    .addUserOption(opt => opt.setName('user').setDescription('Thành viên muốn bỏ cấm').setRequired(true)),
  new SlashCommandBuilder()
    .setName('kick-room')
    .setDescription('Đá 1 người khỏi TRẬN đang diễn ra trong phòng (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng').setRequired(true))
    .addUserOption(opt => opt.setName('user').setDescription('Người cần đá').setRequired(true)),
  new SlashCommandBuilder()
    .setName('moi-ban')
    .setDescription('Mời 1 người bạn vào chung phòng bạn đang ở (ai cũng dùng được)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng').setRequired(true))
    .addUserOption(opt => opt.setName('ban').setDescription('Người bạn muốn mời').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Đăng panel phòng thường của 1 chế độ, có thể tạo thêm phòng (chỉ admin)')
    .addStringOption(opt => opt.setName('che_do').setDescription('Chế độ').addChoices(
      { name: '3v3', value: '3v3' },
      { name: '5v5', value: '5v5' }
    ).setRequired(true))
    .addIntegerOption(opt => opt.setName('so_luong').setDescription('Số phòng muốn tạo thêm (tối đa 10/chế độ)').setMinValue(1).setMaxValue(10).setRequired(false)),
  new SlashCommandBuilder()
    .setName('xoa-setup-phong')
    .setDescription('[CHỈ PHÒNG THƯỜNG] Xóa panel phòng đã đăng (chỉ admin)')
    .addStringOption(opt => opt.setName('che_do').setDescription('Chỉ xóa 1 chế độ (để trống = xóa tất cả)').addChoices(
      { name: '3v3', value: '3v3' },
      { name: '5v5', value: '5v5' }
    ).setRequired(false)),
  new SlashCommandBuilder()
    .setName('reset-tat-ca-phong')
    .setDescription('[CHỈ PHÒNG THƯỜNG] Reset toàn bộ phòng thường về trạng thái trống (chỉ admin)'),
  new SlashCommandBuilder()
    .setName('xoa-phong-thuong')
    .setDescription('[CHỈ PHÒNG THƯỜNG] Xóa hẳn 1 phòng thường đã tạo bằng /setup (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng, ví dụ: 3v3-5').setRequired(true)),
  new SlashCommandBuilder()
    .setName('xoa-tat-ca-phong-thuong')
    .setDescription('[CHỈ PHÒNG THƯỜNG] Xóa hẳn TOÀN BỘ phòng thường (chỉ admin)')
    .addStringOption(opt => opt.setName('che_do').setDescription('Để trống = xóa cả 2 chế độ').addChoices(
      { name: '3v3', value: '3v3' },
      { name: '5v5', value: '5v5' }
    ).setRequired(false)),

  // ----- PHÒNG ẨN -----
  new SlashCommandBuilder()
    .setName('setup-phong-an')
    .setDescription('[ẨN] Tạo 1 phòng bí mật (chỉ admin)')
    .addStringOption(opt => opt.setName('che_do').setDescription('Chế độ').addChoices(
      { name: '3v3', value: '3v3' },
      { name: '5v5', value: '5v5' }
    ).setRequired(true)),
  new SlashCommandBuilder()
    .setName('moi-phong-an')
    .setDescription('[ẨN] Mời người vào phòng ẩn (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng ẩn').setRequired(true)),
  new SlashCommandBuilder()
    .setName('danh-sach-phong-an')
    .setDescription('[ẨN] Xem danh sách phòng ẩn (chỉ admin)'),
  new SlashCommandBuilder()
    .setName('xoa-phong-an')
    .setDescription('[ẨN] Đóng và xóa 1 phòng ẩn (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng ẩn').setRequired(true)),
  new SlashCommandBuilder()
    .setName('xoa-tat-ca-phong-an')
    .setDescription('[ẨN] Đóng và xóa TOÀN BỘ phòng ẩn (chỉ admin)'),
  new SlashCommandBuilder()
    .setName('kick-group')
    .setDescription('[ẨN] Xoá hẳn 1 người khỏi nhóm phòng ẩn (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng ẩn').setRequired(true))
    .addUserOption(opt => opt.setName('user').setDescription('Người cần xoá').setRequired(true)),

  // ----- PHÒNG RANK -----
  new SlashCommandBuilder()
    .setName('setup-rank')
    .setDescription('Đăng panel phòng Rank của 1 chế độ, có thể tạo thêm phòng (chỉ admin)')
    .addStringOption(opt => opt.setName('che_do').setDescription('Chế độ').addChoices(
      { name: '3v3', value: '3v3' },
      { name: '5v5', value: '5v5' }
    ).setRequired(true))
    .addIntegerOption(opt => opt.setName('so_luong').setDescription('Số phòng muốn tạo thêm (tối đa 10/chế độ)').setMinValue(1).setMaxValue(10).setRequired(false)),
  new SlashCommandBuilder()
    .setName('submit-result')
    .setDescription('Gửi kết quả trận đấu cho phòng Rank (chỉ người trong phòng)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng rank').setRequired(true)),
  new SlashCommandBuilder()
    .setName('admin-submit-result')
    .setDescription('[ADMIN] Gửi kết quả thay cho người chơi trong phòng Rank')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng rank').setRequired(true))
    .addUserOption(opt => opt.setName('user').setDescription('Người chơi').setRequired(true))
    .addStringOption(opt => opt.setName('ketqua').setDescription('Thắng hay thua').addChoices(
      { name: 'Thắng', value: 'win' },
      { name: 'Thua', value: 'loss' }
    ).setRequired(true))
    .addStringOption(opt => opt.setName('kda').setDescription('KDA (kill/death/assist)').setRequired(true))
    .addStringOption(opt => opt.setName('hinhanh').setDescription('Link ảnh').setRequired(false)),
  new SlashCommandBuilder()
    .setName('xoa-phong-rank')
    .setDescription('Xóa hẳn 1 phòng Rank (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng rank').setRequired(true)),
  new SlashCommandBuilder()
    .setName('xoa-tat-ca-phong-rank')
    .setDescription('Xóa hẳn TOÀN BỘ phòng Rank (chỉ admin)')
    .addStringOption(opt => opt.setName('che_do').setDescription('Để trống = xóa cả 2 chế độ').addChoices(
      { name: '3v3', value: '3v3' },
      { name: '5v5', value: '5v5' }
    ).setRequired(false)),
  new SlashCommandBuilder()
    .setName('reset-room')
    .setDescription('Ép reset một phòng bất kỳ (thường, rank, ẩn) ngay lập tức (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng').setRequired(true)),

  // ----- TEST LỆNH -----
  new SlashCommandBuilder()
    .setName('test-fill')
    .setDescription('[TEST] Tự nhét người giả vào phòng THƯỜNG (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng thường').setRequired(true))
    .addIntegerOption(opt => opt.setName('so_nguoi').setDescription('Số người giả (để trống = lấp đầy)').setMinValue(1).setRequired(false)),

  new SlashCommandBuilder()
    .setName('test-fill-rank')
    .setDescription('[TEST] Tự nhét người giả vào phòng RANK (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng rank (ví dụ: 3v3-rank-1)').setRequired(true))
    .addIntegerOption(opt => opt.setName('so_nguoi').setDescription('Số người giả (để trống = lấp đầy)').setMinValue(1).setRequired(false)),

  new SlashCommandBuilder()
    .setName('test-fill-an')
    .setDescription('[TEST] Giống test-fill nhưng cho phòng ẩn (chỉ admin)')
    .addStringOption(opt => opt.setName('phong').setDescription('ID phòng ẩn').setRequired(true))
    .addIntegerOption(opt => opt.setName('so_nguoi').setDescription('Số người giả').setMinValue(1).setRequired(false)),

  // ----- TIỆN ÍCH -----
  new SlashCommandBuilder()
    .setName('don-rac')
    .setDescription('Xóa nhanh tin nhắn rác trong kênh (chỉ admin, không xóa panel)')
    .addIntegerOption(opt => opt.setName('so_luong').setDescription('Số tin nhắn (mặc định 50, tối đa 100)').setMinValue(1).setMaxValue(100).setRequired(false)),
  new SlashCommandBuilder()
    .setName('xoa-tin-nhan-bot')
    .setDescription('Xóa tin nhắn của Bot (cả DM) — từng phần hoặc toàn bộ (chỉ admin)')
    .setDMPermission(true)
    .addIntegerOption(opt => opt.setName('so_luong').setDescription('Số tin nhắn (để trống = xóa TẤT CẢ)').setMinValue(1).setRequired(false)),
];

const rest = new REST({ version: '10' }).setToken(config.TOKEN);
(async () => {
  try {
    if (!config.CLIENT_ID) throw new Error('Thiếu CLIENT_ID');
    if (config.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(config.CLIENT_ID, config.GUILD_ID), { body: commands });
      await rest.put(Routes.applicationCommands(config.CLIENT_ID), { body: [] });
    } else {
      await rest.put(Routes.applicationCommands(config.CLIENT_ID), { body: commands });
    }
    console.log(`Đã đăng ký ${commands.length} lệnh.`);
  } catch (err) {
    console.error(err);
  }
})();