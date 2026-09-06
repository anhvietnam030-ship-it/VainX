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
    .setName('ready')
    .setDescription('Ép trạng thái Sẵn sàng cho 1 người trong phòng thay họ (chỉ admin)')
    .addStringOption((opt) =>
      opt.setName('phong').setDescription('ID phòng, ví dụ: 3v3-1, 5v5-4').setRequired(true)
    )
    .addUserOption((opt) => opt.setName('user').setDescription('Người chơi cần đổi trạng thái').setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName('trang_thai')
        .setDescription('Sẵn sàng hay Hủy sẵn sàng')
        .addChoices({ name: 'Sẵn sàng', value: 'ready' }, { name: 'Hủy sẵn sàng', value: 'notready' })
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('gia-han-phong')
    .setDescription('Cộng thêm thời gian trước khi 1 phòng tự reset do chưa đủ người (chỉ admin)')
    .addStringOption((opt) =>
      opt.setName('phong').setDescription('ID phòng, ví dụ: 3v3-1, 5v5-4').setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt.setName('phut').setDescription('Số phút muốn cộng thêm').setMinValue(1).setMaxValue(180).setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('moi-ban')
    .setDescription('Mời 1 người bạn vào chung phòng bạn đang ở (ai cũng dùng được)')
    .addStringOption((opt) =>
      opt.setName('phong').setDescription('ID phòng, ví dụ: 3v3-1, 5v5-4').setRequired(true)
    )
    .addUserOption((opt) => opt.setName('ban').setDescription('Người bạn muốn mời').setRequired(true)),

  new SlashCommandBuilder()
    .setName('ban-phong')
    .setDescription('Cấm 1 thành viên tham gia 1 phòng cụ thể (chỉ admin)')
    .addStringOption((opt) =>
      opt.setName('phong').setDescription('ID phòng, ví dụ: 3v3-1, 5v5-4').setRequired(true)
    )
    .addUserOption((opt) => opt.setName('user').setDescription('Thành viên muốn cấm').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unban-phong')
    .setDescription('Bỏ cấm 1 thành viên khỏi 1 phòng cụ thể (chỉ admin)')
    .addStringOption((opt) =>
      opt.setName('phong').setDescription('ID phòng, ví dụ: 3v3-1, 5v5-4').setRequired(true)
    )
    .addUserOption((opt) => opt.setName('user').setDescription('Thành viên muốn bỏ cấm').setRequired(true)),

  new SlashCommandBuilder()
    .setName('kick-room')
    .setDescription('Đá 1 người khỏi TRẬN đang diễn ra trong phòng (họ vẫn xem/vào lại phòng được) - chỉ admin')
    .addStringOption((opt) =>
      opt.setName('phong').setDescription('ID phòng, ví dụ: 3v3-1, 5v5-4, hoặc ID phòng ẩn').setRequired(true)
    )
    .addUserOption((opt) => opt.setName('user').setDescription('Người chơi cần đá khỏi trận').setRequired(true)),

  new SlashCommandBuilder()
    .setName('kick-group')
    .setDescription('[ẨN] Xoá hẳn 1 người khỏi nhóm được mời vào phòng ẩn (mất quyền xem luôn) - chỉ admin')
    .addStringOption((opt) => opt.setName('phong').setDescription('ID phòng ẩn').setRequired(true))
    .addUserOption((opt) => opt.setName('user').setDescription('Người cần xoá khỏi nhóm phòng ẩn').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setup-phong-an')
    .setDescription('[ẨN] Tạo 1 phòng bí mật, không ai thấy trừ người được mời riêng (chỉ admin)')
    .addStringOption((opt) =>
      opt
        .setName('che_do')
        .setDescription('Chế độ')
        .addChoices({ name: '3v3', value: '3v3' }, { name: '5v5', value: '5v5' })
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('moi-phong-an')
    .setDescription('[ẨN] Mời (nhiều) người vào phòng ẩn qua DM riêng (chỉ admin)')
    .addStringOption((opt) => opt.setName('phong').setDescription('ID phòng ẩn (xem bằng /danh-sach-phong-an)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('danh-sach-phong-an')
    .setDescription('[ẨN] Xem danh sách các phòng ẩn đang tồn tại (chỉ admin)'),

  new SlashCommandBuilder()
    .setName('xoa-phong-an')
    .setDescription('[ẨN] Đóng và xóa 1 phòng ẩn (chỉ admin)')
    .addStringOption((opt) => opt.setName('phong').setDescription('ID phòng ẩn').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Đăng panel phòng của 1 chế độ vào kênh này, có thể kèm tạo thêm phòng (chỉ admin)')
    .addStringOption((opt) =>
      opt
        .setName('che_do')
        .setDescription('Chế độ muốn đăng panel')
        .addChoices({ name: '3v3', value: '3v3' }, { name: '5v5', value: '5v5' })
        .setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('so_luong')
        .setDescription('Để trống = chỉ đăng panel. Nhập số = tạo thêm số đó phòng mới (cộng dồn, tối đa 10/chế độ)')
        .setMinValue(1)
        .setMaxValue(10)
        .setRequired(false)
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
    .setName('xoa-setup-phong')
    .setDescription('Xóa hẳn panel phòng đã đăng (để đăng lại mới bằng /setup) - chỉ admin')
    .addStringOption((opt) =>
      opt
        .setName('che_do')
        .setDescription('Chỉ xóa 1 chế độ (để trống = xóa panel của cả 8 phòng)')
        .addChoices({ name: '3v3', value: '3v3' }, { name: '5v5', value: '5v5' })
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('don-rac')
    .setDescription('Xóa nhanh các tin nhắn gần đây trong kênh này (chỉ admin, dưới 14 ngày tuổi)')
    .addIntegerOption((opt) =>
      opt
        .setName('so_luong')
        .setDescription('Số tin nhắn muốn xóa (mặc định 50, tối đa 100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('xoa-phong-thuong')
    .setDescription('Xóa hẳn 1 phòng thường đã tạo thêm bằng /setup (không xóa được 4 phòng gốc) - chỉ admin')
    .addStringOption((opt) =>
      opt.setName('phong').setDescription('ID phòng, ví dụ: 3v3-5').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('reset-tat-ca-phong')
    .setDescription('Reset toàn bộ 8 phòng (3v3 + 5v5) về trạng thái trống cùng lúc (chỉ admin)'),

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

// /xoa-tin-nhan-bot đăng ký RIÊNG dưới dạng lệnh TOÀN CỤC (global) kèm quyền dùng trong DM
// (.setDMPermission(true)) — để admin xóa được tin nhắn Bot ngay trong DM riêng với Bot,
// nơi các panel phòng ẩn được gửi tới. Lệnh đăng ký theo guild (như mọi lệnh phía trên)
// KHÔNG BAO GIỜ hiện được trong DM — đây là giới hạn của Discord, không phải bug.
const dmCommands = [
  new SlashCommandBuilder()
    .setName('xoa-tin-nhan-bot')
    .setDescription('Xóa tin nhắn của Bot (trong kênh hoặc DM với Bot) — từng phần hoặc toàn bộ (chỉ admin)')
    .setDMPermission(true)
    .addIntegerOption((opt) =>
      opt
        .setName('so_luong')
        .setDescription('Số tin nhắn của Bot muốn xóa (để trống = xóa TẤT CẢ)')
        .setMinValue(1)
        .setRequired(false)
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(config.TOKEN);

(async () => {
  try {
    if (!config.CLIENT_ID) throw new Error('Thiếu CLIENT_ID trong .env');

    if (config.GUILD_ID) {
      // Lệnh server-only đăng theo guild (cập nhật gần như ngay lập tức, tiện lúc test).
      await rest.put(Routes.applicationGuildCommands(config.CLIENT_ID, config.GUILD_ID), { body: commands });
      // Lệnh dùng được cả trong DM PHẢI đăng ký toàn cục — dù có GUILD_ID hay không.
      await rest.put(Routes.applicationCommands(config.CLIENT_ID), { body: dmCommands });
    } else {
      // Không có GUILD_ID -> mọi lệnh đều phải đăng cùng 1 lần lên endpoint toàn cục
      // (PUT sẽ ghi đè toàn bộ danh sách ở endpoint đó, gộp chung tránh bị mất lệnh).
      await rest.put(Routes.applicationCommands(config.CLIENT_ID), { body: [...commands, ...dmCommands] });
    }

    console.log(
      `Đã đăng ký ${commands.length} lệnh ${config.GUILD_ID ? `cho guild ${config.GUILD_ID}` : 'toàn cục (có thể mất tới 1h để hiện)'} + ${dmCommands.length} lệnh dùng được cả trong DM (toàn cục, có thể mất tới 1h để hiện).`
    );
  } catch (err) {
    console.error(err);
  }
})();
