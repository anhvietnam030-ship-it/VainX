function extractAllKDAResult(text, room) {
  const resultMap = new Map();
  const players = Array.from(room.players.entries());

  console.log('📝 OCR Text:', text);
  console.log('👥 Players:', players.map(([id, p]) => `${p.username} (${id})`).join(', '));

  // Chuẩn hóa OCR: thay các ký tự OCR hay đọc nhầm dấu / (l, I, |) thành /
  const normalizedText = text.replace(/(\d+)\s*[lI|]\s*(\d+)\s*[lI|]\s*(\d+)/g, '$1/$2/$3');

  for (const [userId, playerData] of players) {
    const eloObj = getElo(userId);
    const searchName = eloObj.ign || playerData.username;
    console.log(`🔎 Tìm IGN: "${searchName}"`);

    const escapedName = searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 1. Ưu tiên: Bắt KDA nằm ngay sau tên trong khoảng 100 ký tự (cho phép xuống dòng)
    const exactRegex = new RegExp(`(?:[a-zA-Z0-9_-]+_)?${escapedName}[\\s\\S]{0,100}?(\\d+)\\s*\\/\\s*(\\d+)\\s*\\/\\s*(\\d+)`, 'i');
    let match = normalizedText.match(exactRegex);

    if (match) {
      const kdaObj = {
        kill: parseInt(match[1], 10),
        death: parseInt(match[2], 10),
        assist: parseInt(match[3], 10),
      };
      resultMap.set(userId, kdaObj);
      console.log(`✅ Map KDA chính xác cho ${searchName}: ${kdaObj.kill}/${kdaObj.death}/${kdaObj.assist}`);
      continue;
    }

    // 2. Fallback linh hoạt: Tìm KDA đầu tiên xuất hiện sau vị trí tên IGN trong văn bản
    console.warn(`⚠️ Không thấy KDA sát tên "${searchName}", thử fallback tìm KDA phía sau...`);
    const namePos = normalizedText.toLowerCase().indexOf(searchName.toLowerCase());

    if (namePos !== -1) {
      const textAfterName = normalizedText.slice(namePos);
      const kdaRegex = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/;
      const fallbackMatch = textAfterName.match(kdaRegex);

      if (fallbackMatch) {
        const kdaObj = {
          kill: parseInt(fallbackMatch[1], 10),
          death: parseInt(fallbackMatch[2], 10),
          assist: parseInt(fallbackMatch[3], 10),
        };
        resultMap.set(userId, kdaObj);
        console.log(`✅ Map KDA (Fallback) cho ${searchName}: ${kdaObj.kill}/${kdaObj.death}/${kdaObj.assist}`);
      } else {
        console.warn(`⚠️ Vẫn không tìm thấy KDA cho ${searchName}`);
      }
    } else {
      console.warn(`⚠️ Không tìm thấy tên "${searchName}" trong OCR text`);
    }
  }

  console.log('📊 Kết quả map KDA:', Array.from(resultMap.entries()));
  return resultMap;
}