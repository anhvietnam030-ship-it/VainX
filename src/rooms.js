console.log('🔍 [DEBUG] slotLines =', JSON.stringify(slotLines.map(i => `[${i}] ${lines[i]}`)));
console.log('🔍 [DEBUG] foundLineIdx =', foundLineIdx, '| slotLineIdx =', slotLineIdx);
console.log('🔍 [DEBUG] blockStart =', blockStart, '| contiguousBlock =', JSON.stringify(contiguousBlock.map(i => `[${i}] ${lines[i]}`)));