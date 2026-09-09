// === OCR HELPER: extract all KDA from OCR text ===
function extractAllKDAResult(text, room) {
  const resultMap = new Map();
  const players = Array.from(room.players.entries());

  // Log toàn bộ text OCR để kiểm tra
  console.log('📝 OCR Text:', text);
  console.log('👥 Players trong phòng:', players.map(([id, p]) => `${p.username} (${id})`).join(', '));

  // Tìm tất cả KDA trong text
  const kdaRegex = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/g;
  const kdaList = [];
  let match;
  while ((match = kdaRegex.exec(text)) !== null) {
    kdaList.push({
      kill: parseInt(match[1], 10),
      death: parseInt(match[2], 10),
      assist: parseInt(match[3], 10),
      index: match.index,
    });
  }
  console.log(`🔍 Tìm thấy ${kdaList.length} cụm KDA trong OCR.`);

  if (kdaList.length === 0) {
    console.warn('⚠️ Không tìm thấy bất kỳ KDA nào trong text.');
    return resultMap;
  }

  // Với mỗi người chơi, tìm KDA gần tên họ nhất
  for (const [userId, playerData] of players) {
    const eloObj = getElo(userId);
    const searchName = eloObj.ign || playerData.username;
    console.log(`🔎 Tìm IGN: "${searchName}" cho user ${userId}`);

    // Tìm vị trí tên trong text (không phân biệt hoa thường)
    const nameRegex = new RegExp(searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const nameMatch = text.match(nameRegex);
    if (!nameMatch) {
      console.warn(`⚠️ Không tìm thấy tên "${searchName}" trong OCR.`);
      continue;
    }

    const nameIndex = nameMatch.index;
    console.log(`📍 Tìm thấy "${searchName}" tại vị trí ${nameIndex}`);

    // Chọn KDA gần tên nhất (trong vòng 300 ký tự, tăng từ 200 lên 300)
    let best = null;
    let bestDist = Infinity;
    for (const kda of kdaList) {
      const dist = Math.abs(kda.index - nameIndex);
      if (dist < bestDist && dist < 300) {
        bestDist = dist;
        best = kda;
      }
    }
    if (best) {
      resultMap.set(userId, {
        kill: best.kill,
        death: best.death,
        assist: best.assist,
      });
      console.log(`✅ Map KDA cho ${searchName}: ${best.kill}/${best.death}/${best.assist} (cách ${bestDist} ký tự)`);
    } else {
      console.warn(`⚠️ Không tìm thấy KDA gần tên "${searchName}" trong phạm vi 300 ký tự.`);
    }
  }

  console.log(`📊 Kết quả map KDA:`, Array.from(resultMap.entries()));
  return resultMap;
}