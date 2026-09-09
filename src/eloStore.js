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
    '⚠️ SUPABASE_URL / SUPABASE_SERVICE_KEY chưa được cấu hình -> ELO sẽ KHÔNG được lưu bền vững.'
  );
}

function isEnabled() {
  return !!supabase;
}

async function loadAllElo() {
  if (!supabase) return new Map();
  try {
    // ✅ Đúng tên cột: "Ign" viết hoa
    const { data, error } = await supabase.from(TABLE).select('user_id, elo, rank, Ign');
    if (error) {
      console.error('❌ Lỗi tải ELO từ Supabase:', error.message);
      return new Map();
    }
    const map = new Map();
    for (const row of data || []) {
      map.set(row.user_id, {
        elo: row.elo,
        rank: row.rank,
        ign: row.Ign || null,   // lấy từ cột "Ign"
      });
    }
    console.log(`✅ Đã tải ELO của ${map.size} người chơi từ Supabase.`);
    return map;
  } catch (err) {
    console.error('❌ Lỗi tải ELO từ Supabase:', err.message);
    return new Map();
  }
}

async function upsertElo(userId, data) {
  if (!supabase) {
    console.warn('⚠️ Supabase chưa được cấu hình, không lưu ELO cho', userId);
    return;
  }
  try {
    // ✅ Đúng tên cột: "Ign" viết hoa
    const { error } = await supabase.from(TABLE).upsert(
      {
        user_id: userId,
        elo: data.elo ?? null,
        rank: data.rank || 'Unranked',
        Ign: data.ign || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    if (error) {
      console.error(`❌ Lỗi upsert ELO cho ${userId}:`, error.message, error.details);
    } else {
      console.log(`✅ Đã lưu ELO của ${userId} (${data.elo} điểm)`);
    }
  } catch (err) {
    console.error(`❌ Lỗi upsert ELO cho ${userId}:`, err.message);
  }
}

async function deleteElo(userId) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from(TABLE).delete().eq('user_id', userId);
    if (error) {
      console.error(`❌ Lỗi xóa ELO của ${userId}:`, error.message);
    } else {
      console.log(`✅ Đã xóa ELO của ${userId}`);
    }
  } catch (err) {
    console.error(`❌ Lỗi xóa ELO của ${userId}:`, err.message);
  }
}

module.exports = { loadAllElo, upsertElo, deleteElo, isEnabled };