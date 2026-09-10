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

// Trả về Map<userId, { ign, '3v3': {elo, rank, wins, losses}, '5v5': {elo, rank, wins, losses} }>
async function loadAllElo() {
  if (!supabase) return new Map();
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('user_id, mode, elo, rank, ign, wins, losses');
    if (error) {
      console.error('❌ Lỗi tải ELO từ Supabase:', error.message);
      return new Map();
    }
    const map = new Map();
    for (const row of data || []) {
      if (!map.has(row.user_id)) {
        map.set(row.user_id, {
          ign: null,
          '3v3': { elo: null, rank: 'Unranked', wins: 0, losses: 0 },
          '5v5': { elo: null, rank: 'Unranked', wins: 0, losses: 0 },
        });
      }
      const entry = map.get(row.user_id);
      if (row.ign) entry.ign = row.ign;
      if (row.mode === '3v3' || row.mode === '5v5') {
        entry[row.mode] = {
          elo: row.elo ?? null,
          rank: row.rank || 'Unranked',
          wins: row.wins || 0,
          losses: row.losses || 0,
        };
      }
    }
    return map;
  } catch (err) {
    console.error('❌ Lỗi tải ELO từ Supabase:', err.message);
    return new Map();
  }
}

// fullData = { ign, '3v3': {elo, rank, wins, losses}, '5v5': {...} }
// displayName (optional) = tên hiển thị để log dễ đọc (IGN / username Discord)
async function upsertElo(userId, fullData, displayName) {
  if (!supabase) {
    console.warn('⚠️ Supabase chưa cấu hình, không lưu ELO cho', displayName || userId);
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
      wins: fullData?.[mode]?.wins || 0,
      losses: fullData?.[mode]?.losses || 0,
      updated_at: now,
    }));
    const { error } = await supabase
      .from(TABLE)
      .upsert(rows, { onConflict: 'user_id,mode' });

    const label = `${displayName || 'Unknown'} [${userId}]`;
    if (error) {
      console.error(`❌ Lỗi lưu ELO của ${label}:`, error.message);
    } else {
      const e3 = fullData?.['3v3']?.elo ?? 'null';
      const e5 = fullData?.['5v5']?.elo ?? 'null';
      const w3 = fullData?.['3v3']?.wins || 0;
      const l3 = fullData?.['3v3']?.losses || 0;
      const w5 = fullData?.['5v5']?.wins || 0;
      const l5 = fullData?.['5v5']?.losses || 0;
      console.log(`✅ Đã lưu ELO của ${label} (3v3=${e3} ${w3}W-${l3}L, 5v5=${e5} ${w5}W-${l5}L)`);
    }
  } catch (err) {
    console.error(`❌ Lỗi lưu ELO của ${displayName || userId} [${userId}]:`, err.message);
  }
}

// Reset ELO về 0, GIỮ NGUYÊN ign. Không xóa row khỏi DB.
// mode rỗng -> reset cả 2 mode. mode có giá trị -> chỉ reset mode đó.
async function deleteElo(userId, mode) {
  if (!supabase) return;
  try {
    const now = new Date().toISOString();
    const reset = { elo: null, rank: 'Unranked', wins: 0, losses: 0, updated_at: now };

    let q = supabase.from(TABLE).update(reset).eq('user_id', userId);
    if (mode) q = q.eq('mode', mode);

    const { error } = await q;
    if (error) {
      console.error(`❌ Lỗi reset ELO của ${userId}:`, error.message);
    } else {
      console.log(`✅ Đã reset ELO của ${userId}${mode ? ` (mode=${mode})` : ' (cả 2 mode)'} — giữ nguyên IGN`);
    }
  } catch (err) {
    console.error(`❌ Lỗi reset ELO của ${userId}:`, err.message);
  }
}

module.exports = { loadAllElo, upsertElo, deleteElo, isEnabled };