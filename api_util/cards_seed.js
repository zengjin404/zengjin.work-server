// 认知图卡 (cards) 初始内容种子
//
// 定位：数据库首次初始化时写入的「可真实体验」内容，不是前端假数据。
// 约束：
//   1. category.id 固定且 <=20 字符，item.id 由数组顺序生成 (ci0001...)，card_key 才是稳定业务标识。
//   2. card_key 一经发布不可修改；用户进度、统计都以 card_key 记录。
//   3. 生活认知卡片使用本地自绘 SVG 插画 (render_config.kind = illustration)；
//      基础概念卡片使用程序化渲染 (number / letter / color / shape / size)。
//   4. 拼音、英文、介绍均为人工编写，供 3~6 岁儿童使用，避免复杂科普。

// 分类：8 个生活认知 + 5 个基础概念
export const seed_categories = [
	{
		id: 'cc_animal',
		code: 'animal',
		name: '小动物',
		description: '认识身边可爱的小动物',
		icon: 'fa-solid fa-paw',
		theme_color: '#f59e0b',
		sort_order: 10,
	},
	{
		id: 'cc_fruit',
		code: 'fruit',
		name: '水果',
		description: '常见水果的颜色和味道',
		icon: 'fa-solid fa-apple-whole',
		theme_color: '#ef4444',
		sort_order: 20,
	},
	{
		id: 'cc_vegetable',
		code: 'vegetable',
		name: '蔬菜',
		description: '餐桌上常见的蔬菜',
		icon: 'fa-solid fa-carrot',
		theme_color: '#22c55e',
		sort_order: 30,
	},
	{
		id: 'cc_vehicle',
		code: 'vehicle',
		name: '交通工具',
		description: '我们会乘坐的交通工具',
		icon: 'fa-solid fa-car-side',
		theme_color: '#3b82f6',
		sort_order: 40,
	},
	{
		id: 'cc_food',
		code: 'food',
		name: '食物',
		description: '每天都能见到的食物',
		icon: 'fa-solid fa-bowl-food',
		theme_color: '#f97316',
		sort_order: 50,
	},
	{
		id: 'cc_life',
		code: 'life',
		name: '衣物与生活用品',
		description: '穿衣、喝水、出门会用到的物品',
		icon: 'fa-solid fa-shirt',
		theme_color: '#8b5cf6',
		sort_order: 60,
	},
	{
		id: 'cc_toy',
		code: 'toy',
		name: '玩具',
		description: '陪伴我们玩耍的玩具',
		icon: 'fa-solid fa-baseball',
		theme_color: '#ec4899',
		sort_order: 70,
	},
	{
		id: 'cc_nature',
		code: 'nature',
		name: '大自然',
		description: '抬头就能看到的自然景象',
		icon: 'fa-solid fa-leaf',
		theme_color: '#10b981',
		sort_order: 80,
	},
	{
		id: 'cc_number',
		code: 'number',
		name: '数字',
		description: '从 1 数到 10',
		icon: 'fa-solid fa-hashtag',
		theme_color: '#6366f1',
		sort_order: 110,
	},
	{
		id: 'cc_letter',
		code: 'letter',
		name: '字母',
		description: '认识 A 到 Z',
		icon: 'fa-solid fa-font',
		theme_color: '#0ea5e9',
		sort_order: 120,
	},
	{
		id: 'cc_color',
		code: 'color',
		name: '颜色',
		description: '生活里五颜六色的颜色',
		icon: 'fa-solid fa-palette',
		theme_color: '#f43f5e',
		sort_order: 130,
	},
	{
		id: 'cc_shape',
		code: 'shape',
		name: '形状',
		description: '认识身边常见的形状',
		icon: 'fa-solid fa-shapes',
		theme_color: '#a855f7',
		sort_order: 140,
	},
	{
		id: 'cc_size',
		code: 'size',
		name: '大小',
		description: '比较大小、长短、高矮和多少',
		icon: 'fa-solid fa-up-right-and-down-left-from-center',
		theme_color: '#14b8a6',
		sort_order: 150,
	},
]

// 生活认知卡片：统一走本地 SVG 插画，key 与 card_key 一一对应
const life_items = [
	// 小动物
	['animal', 'animal_cat', '猫', 'māo', 'cat', '猫是一种常见的小动物，会喵喵叫，喜欢晒太阳。', '猫的胡须能帮它感受周围的东西。'],
	['animal', 'animal_dog', '狗', 'gǒu', 'dog', '狗是人类的好朋友，会汪汪叫，还能帮人看家。', '狗的鼻子很灵，能闻出很多气味。'],
	['animal', 'animal_rabbit', '兔子', 'tù zi', 'rabbit', '兔子有长长的耳朵和短短的尾巴，喜欢吃胡萝卜。', '兔子的耳朵能帮它听见远处的声音。'],
	['animal', 'animal_panda', '熊猫', 'xióng māo', 'panda', '熊猫是中国的国宝，身体黑白相间，最爱吃竹子。', '熊猫每天要花很多时间吃竹子。'],
	['animal', 'animal_tiger', '老虎', 'lǎo hǔ', 'tiger', '老虎是森林里的大猫，身上有黑色的条纹。', '每只老虎的条纹都不一样，就像指纹。'],
	['animal', 'animal_duck', '鸭子', 'yā zi', 'duck', '鸭子有扁扁的嘴巴，会在水里游来游去。', '鸭子的羽毛上有油脂，所以不怕水。'],

	// 水果
	['fruit', 'fruit_apple', '苹果', 'píng guǒ', 'apple', '苹果圆圆的，红红的，吃起来又甜又脆。', '苹果里含有丰富的维生素。'],
	['fruit', 'fruit_banana', '香蕉', 'xiāng jiāo', 'banana', '香蕉弯弯的，像小船，剥开黄色的皮就可以吃。', '香蕉长在热带地区。'],
	['fruit', 'fruit_orange', '橙子', 'chéng zi', 'orange', '橙子是橙色的，剥开皮能闻到香香的味道。', '橙子含有丰富的维生素 C。'],
	['fruit', 'fruit_grape', '葡萄', 'pú tao', 'grape', '葡萄一颗一颗串在一起，有紫色也有绿色。', '葡萄可以晒成葡萄干。'],
	['fruit', 'fruit_strawberry', '草莓', 'cǎo méi', 'strawberry', '草莓红红的，上面有小籽，闻起来很香。', '草莓的籽长在果实的表面。'],
	['fruit', 'fruit_watermelon', '西瓜', 'xī guā', 'watermelon', '西瓜又大又圆，切开是红红的果肉和黑黑的籽。', '西瓜的水分很多，夏天吃很解渴。'],

	// 蔬菜
	['vegetable', 'vegetable_carrot', '胡萝卜', 'hú luó bo', 'carrot', '胡萝卜是橙色的，长长尖尖的，小兔子最爱吃。', '胡萝卜对眼睛有好处。'],
	['vegetable', 'vegetable_tomato', '西红柿', 'xī hóng shì', 'tomato', '西红柿圆圆的，红红的，可以生吃也可以做菜。', '西红柿也叫番茄。'],
	['vegetable', 'vegetable_broccoli', '西兰花', 'xī lán huā', 'broccoli', '西兰花像一棵绿色的小树，有很多小花朵。', '西兰花要煮熟了再吃。'],
	['vegetable', 'vegetable_corn', '玉米', 'yù mǐ', 'corn', '玉米穿着一层层绿色的外衣，里面是金黄的玉米粒。', '玉米可以磨成玉米面。'],
	['vegetable', 'vegetable_eggplant', '茄子', 'qié zi', 'eggplant', '茄子是紫色的，弯弯的，摸起来滑滑的。', '茄子是夏天常见的蔬菜。'],
	['vegetable', 'vegetable_pumpkin', '南瓜', 'nán guā', 'pumpkin', '南瓜又大又圆，橙色的，可以做成南瓜饼。', '南瓜里有很多南瓜籽。'],

	// 交通工具
	['vehicle', 'vehicle_car', '小汽车', 'xiǎo qì chē', 'car', '小汽车有四个轮子，跑起来又快又稳。', '坐车时要系好安全带。'],
	['vehicle', 'vehicle_bus', '公交车', 'gōng jiāo chē', 'bus', '公交车能载很多人，会沿着固定的路线行驶。', '坐公交车要排队上车。'],
	['vehicle', 'vehicle_bicycle', '自行车', 'zì xíng chē', 'bicycle', '自行车有两个轮子，要用脚踩踏板才能前进。', '骑自行车要戴好头盔。'],
	['vehicle', 'vehicle_train', '火车', 'huǒ chē', 'train', '火车在铁轨上行驶，能载很多人和货物。', '火车有很多节车厢。'],
	['vehicle', 'vehicle_airplane', '飞机', 'fēi jī', 'airplane', '飞机在天上飞，可以带我们去很远的地方。', '飞机起飞前要系好安全带。'],
	['vehicle', 'vehicle_ship', '轮船', 'lún chuán', 'ship', '轮船在水上航行，能运送很多货物。', '轮船靠螺旋桨推动前进。'],

	// 食物
	['food', 'food_bread', '面包', 'miàn bāo', 'bread', '面包软软的，香香的，是常见的早餐。', '面包是用面粉做成的。'],
	['food', 'food_milk', '牛奶', 'niú nǎi', 'milk', '牛奶是白色的，喝起来香香的，很有营养。', '牛奶里含有钙。'],
	['food', 'food_egg', '鸡蛋', 'jī dàn', 'egg', '鸡蛋圆圆的，可以煮着吃，也可以炒着吃。', '鸡蛋里有蛋白和蛋黄。'],
	['food', 'food_rice', '米饭', 'mǐ fàn', 'rice', '米饭白白香香，是很多人每天都要吃的主食。', '米饭是用大米煮成的。'],
	['food', 'food_noodles', '面条', 'miàn tiáo', 'noodles', '面条长长的，滑滑的，可以做成汤面。', '面条是用面粉做的。'],
	['food', 'food_cake', '蛋糕', 'dàn gāo', 'cake', '蛋糕甜甜的，软软的，过生日时常常会吃。', '蛋糕上常有奶油和水果。'],

	// 衣物与生活用品
	['life', 'life_shirt', '衣服', 'yī fu', 'clothes', '衣服穿在身上，可以保暖，也可以让我们更漂亮。', '衣服脏了要洗干净。'],
	['life', 'life_hat', '帽子', 'mào zi', 'hat', '帽子戴在头上，可以遮太阳，也可以保暖。', '夏天可以戴遮阳帽。'],
	['life', 'life_shoes', '鞋子', 'xié zi', 'shoes', '鞋子穿在脚上，走路时能保护我们的脚。', '鞋子要选合脚的。'],
	['life', 'life_cup', '杯子', 'bēi zi', 'cup', '杯子可以装水，我们每天都要喝水。', '多喝水对身体有好处。'],
	['life', 'life_umbrella', '雨伞', 'yǔ sǎn', 'umbrella', '雨伞下雨时能帮我们挡雨。', '雨伞用完要晾干再收起来。'],
	['life', 'life_clock', '闹钟', 'nào zhōng', 'clock', '闹钟会发出声音，提醒我们起床或做事情。', '钟表上的指针会告诉我们时间。'],

	// 玩具
	['toy', 'toy_ball', '皮球', 'pí qiú', 'ball', '皮球圆圆的，可以拍、可以踢、可以滚。', '玩球要在安全的地方。'],
	['toy', 'toy_kite', '风筝', 'fēng zheng', 'kite', '风筝有长长的线，风大的时候能飞得很高。', '放风筝要远离电线。'],
	['toy', 'toy_teddy', '小熊玩偶', 'xiǎo xióng wán ǒu', 'teddy bear', '小熊玩偶毛茸茸的，抱着软软的。', '玩偶脏了要洗一洗。'],
	['toy', 'toy_blocks', '积木', 'jī mù', 'blocks', '积木可以一块一块搭起来，搭成房子和城堡。', '搭积木要有耐心。'],
	['toy', 'toy_drum', '小鼓', 'xiǎo gǔ', 'drum', '小鼓敲一敲会咚咚响，很有节奏。', '鼓是一种打击乐器。'],
	['toy', 'toy_balloon', '气球', 'qì qiú', 'balloon', '气球轻轻的，会飘起来，颜色很漂亮。', '气球里可以装空气或氦气。'],

	// 大自然
	['nature', 'nature_sun', '太阳', 'tài yáng', 'sun', '太阳圆圆的，亮亮的，给我们光和温暖。', '太阳从东边升起，从西边落下。'],
	['nature', 'nature_moon', '月亮', 'yuè liang', 'moon', '月亮在晚上出来，有时圆圆的，有时弯弯的。', '月亮本身不会发光。'],
	['nature', 'nature_star', '星星', 'xīng xing', 'star', '星星在夜空中一闪一闪的。', '星星离我们非常非常远。'],
	['nature', 'nature_cloud', '云朵', 'yún duǒ', 'cloud', '云朵白白的，软软的，在天空中飘来飘去。', '云是由小水滴组成的。'],
	['nature', 'nature_tree', '大树', 'dà shù', 'tree', '大树有粗粗的树干和绿绿的叶子。', '树能给我们带来新鲜的空气。'],
	['nature', 'nature_flower', '小花', 'xiǎo huā', 'flower', '小花有五颜六色的花瓣，闻起来香香的。', '花谢了会结出种子。'],
].map(([category_code, card_key, label, pinyin, en_label, description, knowledge], index) => ({
	category_code,
	card_key,
	label,
	pinyin,
	en_label,
	description,
	knowledge,
	render_type: 'svg',
	render_config: { kind: 'illustration', key: card_key },
	sort_order: (index % 6) * 10 + 10,
}))

// 数字 1~10：圆点数量由前端按 value 生成
const number_en = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const number_pinyin = ['yī', 'èr', 'sān', 'sì', 'wǔ', 'liù', 'qī', 'bā', 'jiǔ', 'shí']
const number_items = number_en.map((en_label, i) => {
	const value = i + 1
	return {
		category_code: 'number',
		card_key: `number_${value}`,
		label: String(value),
		pinyin: number_pinyin[i],
		en_label,
		description: `这是数字 ${value}，数一数图里有 ${value} 个圆点。`,
		knowledge: `${value} 可以表示 ${value} 个东西。`,
		render_type: 'svg',
		render_config: { kind: 'number', value },
		sort_order: (i + 1) * 10,
	}
})

// 字母 A~Z：每个字母配一个常见英文单词
const letter_words = [
	['A', 'Apple', '苹果'],
	['B', 'Ball', '皮球'],
	['C', 'Cat', '猫'],
	['D', 'Dog', '狗'],
	['E', 'Egg', '鸡蛋'],
	['F', 'Fish', '鱼'],
	['G', 'Grape', '葡萄'],
	['H', 'Hat', '帽子'],
	['I', 'Ice cream', '冰淇淋'],
	['J', 'Juice', '果汁'],
	['K', 'Kite', '风筝'],
	['L', 'Lion', '狮子'],
	['M', 'Moon', '月亮'],
	['N', 'Nose', '鼻子'],
	['O', 'Orange', '橙子'],
	['P', 'Panda', '熊猫'],
	['Q', 'Queen', '女王'],
	['R', 'Rabbit', '兔子'],
	['S', 'Sun', '太阳'],
	['T', 'Tiger', '老虎'],
	['U', 'Umbrella', '雨伞'],
	['V', 'Van', '面包车'],
	['W', 'Water', '水'],
	['X', 'Xylophone', '木琴'],
	['Y', 'Yo-yo', '悠悠球'],
	['Z', 'Zebra', '斑马'],
]
const letter_items = letter_words.map(([letter, word, wordCn], i) => ({
	category_code: 'letter',
	card_key: `letter_${letter.toLowerCase()}`,
	label: letter,
	pinyin: '',
	en_label: letter,
	description: `${letter} 是字母表的第 ${i + 1} 个字母。`,
	knowledge: `${letter} 开头的单词：${word}（${wordCn}）。`,
	render_type: 'svg',
	render_config: { kind: 'letter', value: letter, word, wordCn },
	sort_order: (i + 1) * 10,
}))

// 颜色 10
const color_items_data = [
	['red', '红色', 'hóng sè', 'red', '#ef4444', '红色是暖暖的颜色，像熟透的苹果。'],
	['orange', '橙色', 'chéng sè', 'orange', '#f97316', '橙色像甜甜的橙子。'],
	['yellow', '黄色', 'huáng sè', 'yellow', '#facc15', '黄色亮亮的，像太阳。'],
	['green', '绿色', 'lǜ sè', 'green', '#22c55e', '绿色像小草和树叶。'],
	['blue', '蓝色', 'lán sè', 'blue', '#3b82f6', '蓝色像天空和大海。'],
	['purple', '紫色', 'zǐ sè', 'purple', '#8b5cf6', '紫色像一串串葡萄。'],
	['pink', '粉色', 'fěn sè', 'pink', '#ec4899', '粉色柔柔的，像桃花。'],
	['black', '黑色', 'hēi sè', 'black', '#1f2937', '黑色像夜晚的天空。'],
	['white', '白色', 'bái sè', 'white', '#f8fafc', '白色像雪和云朵。'],
	['brown', '棕色', 'zōng sè', 'brown', '#92400e', '棕色像树干和巧克力。'],
]
const color_items = color_items_data.map(([key, label, pinyin, en_label, value, description], i) => ({
	category_code: 'color',
	card_key: `color_${key}`,
	label,
	pinyin,
	en_label,
	description,
	knowledge: '颜色让我们的世界变得丰富多彩。',
	render_type: 'svg',
	render_config: { kind: 'color', value, label },
	sort_order: (i + 1) * 10,
}))

// 形状 8
const shape_items_data = [
	['circle', '圆形', 'yuán xíng', 'circle', '圆形没有角，边缘是圆圆的。'],
	['square', '正方形', 'zhèng fāng xíng', 'square', '正方形有四条一样长的边。'],
	['triangle', '三角形', 'sān jiǎo xíng', 'triangle', '三角形有三条边和三个角。'],
	['rectangle', '长方形', 'cháng fāng xíng', 'rectangle', '长方形有四条边，两条长两条短。'],
	['star', '星形', 'xīng xíng', 'star', '星形有五个尖尖的角。'],
	['heart', '心形', 'xīn xíng', 'heart', '心形中间凹进去，下面是尖的。'],
	['diamond', '菱形', 'líng xíng', 'diamond', '菱形四条边一样长，角是斜的。'],
	['oval', '椭圆形', 'tuǒ yuán xíng', 'oval', '椭圆形像压扁的圆形。'],
]
const shape_items = shape_items_data.map(([key, label, pinyin, en_label, description], i) => ({
	category_code: 'shape',
	card_key: `shape_${key}`,
	label,
	pinyin,
	en_label,
	description,
	knowledge: '形状藏在生活的很多地方。',
	render_type: 'svg',
	render_config: { kind: 'shape', value: key },
	sort_order: (i + 1) * 10,
}))

// 大小 / 长短 / 高矮 / 多少 8 张对照卡
const size_items_data = [
	['big', '大', 'dà', 'big', 'small', '大表示东西占的地方多。'],
	['small', '小', 'xiǎo', 'small', 'big', '小表示东西占的地方少。'],
	['long', '长', 'cháng', 'long', 'short', '长表示从头到尾距离大。'],
	['short', '短', 'duǎn', 'short', 'long', '短表示从头到尾距离小。'],
	['tall', '高', 'gāo', 'tall', 'low', '高表示从下到上距离大。'],
	['low', '矮', 'ǎi', 'low', 'tall', '矮表示从下到上距离小。'],
	['many', '多', 'duō', 'many', 'few', '多表示数量大。'],
	['few', '少', 'shǎo', 'few', 'many', '少表示数量小。'],
]
const size_items = size_items_data.map(([key, label, pinyin, en_label, compare, description], i) => ({
	category_code: 'size',
	card_key: `size_${key}`,
	label,
	pinyin,
	en_label,
	description,
	knowledge: '比一比，就能发现大小、长短、高矮和多少的不同。',
	render_type: 'svg',
	render_config: { kind: 'size', value: key, compare },
	sort_order: (i + 1) * 10,
}))

// 全量卡片 (固定顺序，index + 1 生成稳定 item id)
export const seed_items = [...life_items, ...number_items, ...letter_items, ...color_items, ...shape_items, ...size_items].map((item, index) => ({
	...item,
	id: `ci${String(index + 1).padStart(4, '0')}`,
	play_modes: 'recognize,connect,memory',
	publish_status: 1,
	is_enabled: true,
}))

// 供测试与运维核对的数量口径
export const SEED_CATEGORY_COUNT = seed_categories.length
export const SEED_ITEM_COUNT = seed_items.length

/**
 * 种子完整性自检：返回错误消息数组，空数组代表通过
 * 只做数据层约束检查，不依赖数据库
 */
export function validate_seed() {
	const errors = []
	const categoryCodes = new Set()
	const categoryIds = new Set()
	const cardKeys = new Set()

	for (const category of seed_categories) {
		if (!category.id || category.id.length > 20) errors.push(`分类 id 超出 20 字符: ${category.id}`)
		if (!/^[a-z][a-z0-9_]{1,29}$/.test(category.code)) errors.push(`分类 code 不合法: ${category.code}`)
		if (categoryCodes.has(category.code)) errors.push(`分类 code 重复: ${category.code}`)
		if (categoryIds.has(category.id)) errors.push(`分类 id 重复: ${category.id}`)
		categoryCodes.add(category.code)
		categoryIds.add(category.id)
		if (!category.name) errors.push(`分类缺少名称: ${category.code}`)
	}

	for (const item of seed_items) {
		if (!categoryCodes.has(item.category_code)) errors.push(`卡片引用了不存在的分类: ${item.card_key} -> ${item.category_code}`)
		if (!/^[a-z][a-z0-9_]{1,59}$/.test(item.card_key)) errors.push(`card_key 不合法: ${item.card_key}`)
		if (cardKeys.has(item.card_key)) errors.push(`card_key 重复: ${item.card_key}`)
		cardKeys.add(item.card_key)
		if (!item.id || item.id.length > 20) errors.push(`卡片 id 超出 20 字符: ${item.id}`)
		if (!item.label) errors.push(`卡片缺少名称: ${item.card_key}`)
		if (/[一-龥]/.test(item.label) && !item.pinyin) errors.push(`中文卡片缺少拼音: ${item.card_key}`)
		if (!item.render_config || typeof item.render_config !== 'object') errors.push(`卡片缺少渲染配置: ${item.card_key}`)
	}
	return errors
}
