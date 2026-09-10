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

// Trả về Map<userId, { ign, '3v3': {elo, rank}, '5v5': {elo, rank} }>
async function loadAllElo() {
  if (!supabase) return new Map();
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('user_id, mode, elo, rank, ign');
    if (error) {
      console.error('❌ Lỗi tải ELO từ Supabase:', error.message);
      return new Map();
    }
    const map = new Map();
    for (const row of data || []) {
      if (!map.has(row.user_id)) {
        map.set(row.user_id, {
          ign: null,
          '3v3': { elo: null, rank: 'Unranked' },
          '5v5': { elo: null, rank: 'Unranked' },
        });
      }
      const entry = map.get(row.user_id);
      if (row.ign) entry.ign = row.ign;
      if (row.mode === '3v3' || row.mode === '5v5') {
        entry[row.mode] = {
          elo: row.elo ?? null,
          rank: row.rank || 'Unranked',
        };
      }
    }
    return map;
  } catch (err) {
    console.error('❌ Lỗi tải ELO từ Supabase:', err.message);
    return new Map();
  }
}

// Upsert cả 2 mode (3v3 + 5v5) cùng lúc, mỗi mode 1 row.
// fullData = { ign, '3v3': {elo, rank}, '5v5': {elo, rank} }
async function upsertElo(userId, fullData) {
  if (!supabase) {
    console.warn('⚠️ Supabase chưa được cấu hình, không lưu ELO cho', userId);
    return;
  }
  try {
    const now = new Date().toISOString();
    const rows = ['3v3', '5v5'].map(mode => ({
      user_id: userId,
      mode,
      elo: fullData?.[mode]?.elo ?? null,
      rank: fullData?.[mode]?.rank || 'Unranked',
      ign: fullData?.ign || null,
      updated_at: now,
    }));
    const { error } = await supabase
      .from(TABLE)
      .upsert(rows, { onConflict: 'user_id,mode' });
    if (error) {
      console.error(`❌ Lỗi lưu ELO của ${userId} lên Supabase:`, error.message);
    } else {
      const e3 = fullData?.['3v3']?.elo ?? 'null';
      const e5 = fullData?.['5v5']?.elo ?? 'null';
      console.log(`✅ Đã lưu ELO của ${userId} lên Supabase (3v3=${e3}, 5v5=${e5})`);
    }
  } catch (err) {
    console.error(`❌ Lỗi lưu ELO của ${userId} lên Supabase:`, err.message);
  }
}

// mode rỗng -> xóa cả 2 row của user.
async function deleteElo(userId, mode) {
  if (!supabase) return;
  try {
    let q = supabase.from(TABLE).delete().eq('user_id', userId);
    if (mode) q = q.eq('mode', mode);
    const { error } = await q;
    if (error) {
      console.error(`❌ Lỗi xóa ELO của ${userId} trên Supabase:`, error.message);
    } else {
      console.log(`✅ Đã xóa ELO của ${userId} trên Supabase${mode ? ` (mode=${mode})` : ' (cả 2 mode)'}`);
    }
  } catch (err) {
    console.error(`❌ Lỗi xóa ELO của ${userId} trên Supabase:`, err.message);
  }
}

module.exports = { loadAllElo, upsertElo, deleteElo, isEnabled };