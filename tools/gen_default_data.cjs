const fs = require('fs');

const dump = JSON.parse(fs.readFileSync('tools/seeded_dump.json', 'utf8'));

// Format default_categories and default_items for fallback offline use
const categoriesCode = JSON.stringify(dump.categories.map(c => ({
  ...c,
  item_count: dump.items.filter(i => i.category_id === c.id).length
})), null, 2);

const itemsCode = JSON.stringify(dump.items, null, 2);

const fileContent = `// 内置兜底内容
//
// 用途只有一个：首次访问（还没有 localStorage 缓存）且网络不可用时，
// 应用仍然能打开、能玩三种核心玩法。它不是数据库内容的替代品：
// 联网后 card-repository 会拉取服务端完整内容并覆盖这里。
//
// 标识体系：执行方案二彻底 ID 化，直接使用 base.getId() 生成的 12 位 36 进制主键 id。
// 当前数据：2026-11-23 全量重建版（共 9 大分类、129 张卡片）。

export const default_categories = ${categoriesCode}

export const default_items = ${itemsCode}

export const default_content = {
\tversion: 0,
\tcategories: default_categories,
\titems: default_items,
\tassets: [],
}
`;

fs.writeFileSync('../zengjin.work-source/apps/cards/data/default-data.js', fileContent, 'utf8');
console.log('Successfully updated apps/cards/data/default-data.js');
