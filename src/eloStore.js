const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TABLE = 'player_elo';

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
} else {
  console.warn(
    '⚠️ SUPABASE_URL / SUPABASE_SERVICE_KEY chưa được cấu hình trong biến môi trường -> ELO sẽ KHÔNG được lưu bền vững, sẽ mất mỗi khi deploy lại.'
  );
}

function isEnabled() {
  return !!supabase;
}

// Tải toàn bộ ELO đã lưu, trả về Map(userId -> { elo, rank, ign })
async function loadAllElo() {
  if (!supabase) return new Map();
  try {
    const { data, error } = await supabase.from(TABLE).select('user_id, elo, rank, ign');
    if (error) {
      console.error('❌ Lỗi tải ELO từ Supabase:', error.message);
      return new Map();
    }
    const map = new Map();
    for (const row of data || []) {
      map.set(row.user_id, {
        elo: row.elo,
        rank: row.rank,
        ...(row.ign ? { ign: row.ign } : {}),
      });
    }
    return map;
  } catch (err) {
    console.error('❌ Lỗi tải ELO từ Supabase:', err.message);
    return new Map();
  }
}

// Lưu/ cập nhật ELO của 1 người chơi ngay khi thay đổi (kết quả trận, đăng ký IGN...)
async function upsertElo(userId, data) {
  if (!supabase) {
    console.warn('⚠️ Supabase chưa được cấu hình, không lưu ELO cho', userId);
    return;
  }
  try {
    const { error } = await supabase.from(TABLE).upsert(
      {
        user_id: userId,
        elo: data.elo ?? null,
        rank: data.rank || 'Unranked',
        ign: data.ign || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    if (error) {
      console.error(`❌ Lỗi lưu ELO của ${userId} lên Supabase:`, error.message);
    } else {
      console.log(`✅ Đã lưu ELO của ${userId} lên Supabase (${data.elo} điểm)`);
    }
  } catch (err) {
    console.error(`❌ Lỗi lưu ELO của ${userId} lên Supabase:`, err.message);
  }
}

async function deleteElo(userId) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from(TABLE).delete().eq('user_id', userId);
    if (error) {
      console.error(`❌ Lỗi xóa ELO của ${userId} trên Supabase:`, error.message);
    } else {
      console.log(`✅ Đã xóa ELO của ${userId} trên Supabase`);
    }
  } catch (err) {
    console.error(`❌ Lỗi xóa ELO của ${userId} trên Supabase:`, err.message);
  }
}

module.exports = { loadAllElo, upsertElo, deleteElo, isEnabled };