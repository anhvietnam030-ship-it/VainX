// ===============================================================
// ===== HÀM OCR – ƯU TIÊN TÌM KDA TRÊN CÙNG DÒNG ==============
// ===============================================================
function extractAllKDAResult(text, room) {
  const resultMap = new Map();
  const players = Array.from(room.players.entries());

  console.log('📝 OCR Text:', text);
  console.log('👥 Players:', players.map(([id, p]) => `${p.username} (${id})`).join(', '));

  // Tách dòng
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

  // Duyệt từng người chơi
  for (const [userId, playerData] of players) {
    const eloObj = getElo(userId);
    const searchName = eloObj.ign || playerData.username;
    console.log(`🔎 Tìm IGN: "${searchName}"`);

    // Tìm dòng chứa tên
    const nameRegex = new RegExp(searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    let foundLine = null;
    let foundLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (nameRegex.test(lines[i])) {
        foundLine = lines[i];
        foundLineIndex = i;
        break;
      }
    }

    if (!foundLine) {
      console.warn(`⚠️ Không tìm thấy dòng nào chứa tên "${searchName}"`);
      continue;
    }

    // Tìm KDA trên dòng đó
    const kdaRegex = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/g;
    const match = kdaRegex.exec(foundLine);
    if (match) {
      const kill = parseInt(match[1], 10);
      const death = parseInt(match[2], 10);
      const assist = parseInt(match[3], 10);
      resultMap.set(userId, { kill, death, assist });
      console.log(`✅ Map KDA cho ${searchName}: ${kill}/${death}/${assist} (trên dòng "${foundLine}")`);
      continue;
    }

    // Nếu không có KDA trên dòng, thử tìm gần nhất (phạm vi 300 ký tự) từ vị trí của dòng đó
    console.warn(`⚠️ Không tìm thấy KDA trên dòng của "${searchName}", thử tìm gần nhất...`);
    const linePos = text.indexOf(foundLine);
    if (linePos === -1) continue;

    // Lấy tất cả KDA trong toàn bộ văn bản để chọn gần nhất
    const allKda = [];
    const globalRegex = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/g;
    let m;
    while ((m = globalRegex.exec(text)) !== null) {
      allKda.push({
        kill: parseInt(m[1], 10),
        death: parseInt(m[2], 10),
        assist: parseInt(m[3], 10),
        index: m.index,
      });
    }

    let best = null;
    let bestDist = Infinity;
    for (const kda of allKda) {
      const dist = Math.abs(kda.index - linePos);
      if (dist < bestDist && dist < 300) {
        bestDist = dist;
        best = kda;
      }
    }
    if (best) {
      resultMap.set(userId, { kill: best.kill, death: best.death, assist: best.assist });
      console.log(`✅ Map KDA (fallback) cho ${searchName}: ${best.kill}/${best.death}/${best.assist} (cách ${bestDist} ký tự)`);
    } else {
      console.warn(`⚠️ Không tìm thấy KDA gần dòng của "${searchName}" trong phạm vi 300 ký tự.`);
    }
  }

  console.log('📊 Kết quả map KDA:', Array.from(resultMap.entries()));
  return resultMap;
}