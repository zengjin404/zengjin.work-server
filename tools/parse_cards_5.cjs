const fs = require('fs');

const content = fs.readFileSync('../zengjin.work-source/docs/CARDS-5-分类与卡片数据全量重建.md', 'utf8');

const categoryMeta = [
  { name: '动物', desc: '认识天上飞、地上跑、水里游的可爱动物', icon: 'fa-solid fa-paw', color: '#f59e0b', sort: 10 },
  { name: '食物', desc: '认识香甜的水果、营养的蔬菜和日常美味食物', icon: 'fa-solid fa-bowl-food', color: '#f97316', sort: 20 },
  { name: '交通工具', desc: '认识路上跑、天上飞、水里航行的各种交通工具', icon: 'fa-solid fa-car-side', color: '#3b82f6', sort: 30 },
  { name: '生活用品', desc: '认识穿戴、洗漱、家居以及陪伴玩耍的日常物品', icon: 'fa-solid fa-shirt', color: '#8b5cf6', sort: 40 },
  { name: '大自然', desc: '认识天空气象、花草树木和山川河流等自然景象', icon: 'fa-solid fa-leaf', color: '#10b981', sort: 50 },
  { name: '数字', desc: '认识数字 0 到 10，建立基础的数量概念', icon: 'fa-solid fa-hashtag', color: '#6366f1', sort: 60 },
  { name: '颜色', desc: '辨识生活中纯粹而鲜明的各种基础颜色', icon: 'fa-solid fa-palette', color: '#f43f5e', sort: 70 },
  { name: '形状', desc: '认识几何图形的边、角和轮廓特征', icon: 'fa-solid fa-shapes', color: '#a855f7', sort: 80 },
  { name: '反义词', desc: '通过成对画面对比，理解大小、长短、冷热等相对概念', icon: 'fa-solid fa-up-right-and-down-left-from-center', color: '#14b8a6', sort: 90 },
];

function extractEmoji(raw) {
  if (!raw) return '';
  const trimmed = raw.trim();
  // Keycaps like 0️⃣ .. 9️⃣, 🔟
  const keycapMatch = trimmed.match(/^([0-9#*]️?⃣|🔟)/);
  if (keycapMatch) return keycapMatch[1];
  // Extended pictographic emojis (Unicode 15+ compatible)
  const emojiMatch = trimmed.match(/^(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u);
  if (emojiMatch) return emojiMatch[1];
  return '';
}

const parsedCategories = [];
let totalCards = 0;

for (let i = 0; i < categoryMeta.length; i++) {
  const meta = categoryMeta[i];
  const nextMeta = categoryMeta[i + 1];
  const startPattern = `## **${i + 1}. ${meta.name}`;
  const endPattern = nextMeta ? `## **${i + 2}. ${nextMeta.name}` : '# **三、';

  const startIdx = content.indexOf(startPattern);
  if (startIdx === -1) {
    console.error('Not found start:', startPattern);
    continue;
  }
  const endIdx = content.indexOf(endPattern, startIdx);
  const block = endIdx === -1 ? content.slice(startIdx) : content.slice(startIdx, endIdx);

  const lines = block.split(/\r?\n/).filter(l => l.startsWith('|') && !l.includes('---') && !l.includes('名称'));
  const cards = [];

  for (let sortIdx = 0; sortIdx < lines.length; sortIdx++) {
    const parts = lines[sortIdx].split('|').map(p => p.trim());
    // parts[0] is empty before first |
    // parts[1]: 名称, parts[2]: 拼音, parts[3]: 英语, parts[4]: 描述, parts[5]: 小知识, parts[6]: 参考素材 / 视觉构图参考
    const label = parts[1];
    const pinyin = parts[2];
    const en_label = parts[3];
    const description = parts[4];
    const knowledge = parts[5];
    const rawAsset = parts[6] || '';

    // For 反义词, no emoji as requested
    const emoji = meta.name === '反义词' ? '' : extractEmoji(rawAsset);

    cards.push({
      label,
      pinyin,
      en_label,
      description,
      knowledge,
      emoji,
      sort_order: (sortIdx + 1) * 10,
    });
  }

  totalCards += cards.length;
  parsedCategories.push({
    ...meta,
    cards,
  });
  console.log(`[${i + 1}] ${meta.name}: ${cards.length} cards`);
}

console.log('Total categories:', parsedCategories.length, 'Total cards:', totalCards);

fs.writeFileSync('tools/parsed_cards.json', JSON.stringify(parsedCategories, null, 2), 'utf8');
console.log('Wrote tools/parsed_cards.json successfully');
