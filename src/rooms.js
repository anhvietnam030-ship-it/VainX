function extractAllKDAResult(text, room) {
  const resultMap = new Map();
  const players = Array.from(room.players.entries());

  console.log('📝 OCR Text:', text);
  console.log('👥 Players:', players.map(([id, p]) => `${p.username} (${id})`).join(', '));

  // Tách dòng
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  console.log(`📄 Tổng số dòng: ${lines.length}`);

  // Với mỗi người chơi, tìm dòng chứa tên
  for (const [userId, playerData] of players) {
    const eloObj = getElo(userId);
    const searchName = eloObj.ign || playerData.username;
    console.log(`🔎 Tìm IGN: "${searchName}"`);

    // Tìm dòng nào chứa tên (không phân biệt hoa thường)
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

    // Trên dòng đó, tìm KDA ở phía sau tên (cùng dòng)
    const lineText = foundLine;
    const namePos = lineText.search(nameRegex);
    if (namePos === -1) continue;

    // Tìm tất cả KDA trên dòng này
    const kdaRegex = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/g;
    let match;
    let best = null;
    let bestDist = Infinity;
    while ((match = kdaRegex.exec(lineText)) !== null) {
      const kdaIndex = match.index;
      // Chỉ lấy KDA nằm phía sau tên (vị trí > namePos)
      if (kdaIndex > namePos) {
        const dist = kdaIndex - namePos;
        if (dist < bestDist && dist < 200) {
          bestDist = dist;
          best = {
            kill: parseInt(match[1], 10),
            death: parseInt(match[2], 10),
            assist: parseInt(match[3], 10),
          };
        }
      }
    }

    if (best) {
      resultMap.set(userId, {
        kill: best.kill,
        death: best.death,
        assist: best.assist,
      });
      console.log(`✅ Map KDA cho ${searchName}: ${best.kill}/${best.death}/${best.assist} (cùng dòng, cách ${bestDist} ký tự)`);
    } else {
      // Fallback: tìm KDA gần nhất ở các dòng xung quanh (phạm vi 1-2 dòng) - ít xảy ra
      console.warn(`⚠️ Không tìm thấy KDA trên cùng dòng với "${searchName}", thử fallback...`);
      // Có thể giữ logic cũ nhưng hạn chế
      // (ta có thể bỏ fallback hoặc giữ để an toàn)
      // Ở đây ta bỏ qua fallback để đảm bảo chính xác tuyệt đối
    }
  }

  console.log('📊 Kết quả map KDA:', Array.from(resultMap.entries()));
  return resultMap;
}