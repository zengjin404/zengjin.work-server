/**
 * 应用目录归属与一次性迁移清单
 *
 * 本次分类重构的权威清单：既用于旧库一次性迁移，也用于补齐线上缺失的真实应用。
 * 不在这里修改应用 ID、名称或业务 URL。
 */

export const APP_CATEGORY_MIGRATION_KEY = 'app_category_restructure_v1'
export const APP_SORT_WEIGHT_MIGRATION_KEY = 'app_sort_weight_desc_v1'

/**
 * 权威应用排序权重标准映射字典（数值越大越靠前）
 * - 旗舰置顶应用（featured=1）：1000 ~ 950
 * - 常规已上架应用（featured=0, show=true）：900 ~ 640
 * - 未上架 / 模板 / 仅管理可见（show=false）：500 ~ 450
 */
export const APP_STANDARD_SORT_MAP = {
	// ---- 旗舰置顶 (featured=1) ----
	ai: 1000,
	fc: 990,
	music: 980,
	time: 970,
	note: 960,
	color: 950,

	// ---- 常规已上架 (featured=0, show=true) ----
	on: 900,
	share: 890,
	sub: 880,
	jq: 870,
	lucky: 860,
	qjt: 850,
	todo: 840,
	base64_qoder: 830,
	base64_trae: 820,
	char: 810,
	seal: 805,
	qrcode: 800,
	cards: 795,
	dphxb: 790,
	cursor: 780,
	fa: 770,
	fa5: 760,
	ti: 750,
	flex: 740,
	key: 730,
	llq: 720,
	cameracapture: 710,
	camera: 705,
	mic: 700,
	gis: 690,
	mars3d: 680,
	threed: 670,
	tile2d: 660,
	tileset: 650,
	case: 640,

	// ---- 未上架 / 仅管理可见 / 框架模板 (show=false) ----
	admin: 500,
	prime: 490,
	wired: 480,
	control: 470,
	jndv: 460,
	storage: 450,
}

/**
 * 每个真实应用的新分类归属
 * - category：新分类（逗号分隔，最多两个为常规；超过两个会在校验中提醒）
 * - visibility / show：只在特殊应用上覆盖，普通应用保留管理员当前设置
 * - reason：交付报告中的归属依据
 */
export const APP_CATALOG_OVERRIDES = {
	// 效率工具
	ai: { category: 'efficiency', reason: '通用 AI 对话与信息处理' },
	time: { category: 'efficiency', reason: '日常计时 / 秒表工具' },
	note: { category: 'efficiency', reason: '信息记录与整理' },
	todo: { category: 'efficiency', reason: '待办与任务管理' },
	on: { category: 'efficiency', reason: '保持屏幕常亮的日常辅助' },
	share: { category: 'efficiency', reason: '文件分享工作流' },
	sub: { category: 'efficiency', reason: '订阅周期与续费管理' },
	qrcode: { category: 'efficiency', reason: '通用二维码生成与识别' },

	// 系统硬件
	camera: { category: 'system', reason: '摄像头 / 麦克风硬件能力调试与诊断' },
	llq: { category: 'system', reason: '浏览器与设备信息检测' },
	key: { category: 'dev,system', reason: '面向开发者的按键码工具，同时属于输入设备能力检测' },
	mic: { category: 'system,media', reason: '麦克风设备诊断与音频采集 / 录音能力' },

	// 影音图像
	music: { category: 'media', reason: '音乐播放与音频内容' },
	qjt: { category: 'media', reason: '全景图视觉内容浏览' },
	color: { category: 'media', reason: '色彩与视觉内容工具' },
	seal: { category: 'media,efficiency', reason: '印章视觉内容生成，同时服务办公文档流程' },
	cameracapture: { category: 'media', reason: '摄像头图像采集与截图' },

	// 前端开发
	base64_qoder: { category: 'dev', reason: '面向开发者的图片编码 / 预览工具' },
	base64_trae: { category: 'dev', reason: '面向开发者的 Base64 编解码工具' },
	char: { category: 'dev', reason: '字符编码与 Unicode 参考' },
	cursor: { category: 'dev', reason: 'CSS 光标样式开发辅助' },
	fa: { category: 'dev', reason: '前端图标库检索工具' },
	fa5: { category: 'dev', reason: '前端图标库检索工具' },
	ti: { category: 'dev', reason: '前端图标库检索工具' },
	flex: { category: 'dev', reason: 'CSS Flex 布局开发演示' },
	case: { category: 'dev', reason: '技术案例与示例集合' },
	admin: { category: 'dev', visibility: 'admin', show: false, reason: '平台管理后台，仅管理员可见' },
	prime: { category: 'dev', reason: '未上架的框架模板' },
	wired: { category: 'dev', reason: '未上架的框架模板' },
	control: { category: 'dev', reason: '未上架的控件库模板' },
	storage: { category: 'dev', visibility: 'admin', show: false, reason: '站长 / 运维存储管理工具，仅管理员使用' },

	// 休闲娱乐
	fc: { category: 'play', reason: '红白机游戏' },
	jq: { category: 'play', reason: '军旗卡牌游戏' },
	lucky: { category: 'play', reason: '抽奖互动娱乐' },
	cards: { category: 'play', reason: '儿童认知互动游戏，儿童分类并入 play' },
	dphxb: { category: 'play', reason: '大炮轰小兵传统棋类游戏' },

	// 空间地理
	gis: { category: 'gis', reason: 'GIS 综合地图应用' },
	mars3d: { category: 'gis', reason: 'Mars3D 三维地理场景' },
	threed: { category: 'gis', reason: '基于 Cesium / 天地图的三维地理场景' },
	tile2d: { category: 'gis', reason: '正射影像瓦片' },
	tileset: { category: 'gis', reason: '倾斜摄影 3D Tiles' },

	// 内部应用
	jndv: { category: 'efficiency', visibility: 'private', show: false, reason: '内部户型图 / 座位图应用，使用私有可见性' },
}

/**
 * 线上真实存在、但 presets 未覆盖或曾因计数补种逻辑漏掉的应用
 * 使用 ON CONFLICT (name) DO NOTHING，绝不覆盖管理员后续调整。
 */
export const EXTRA_APPS = [
	{
		name: 'on',
		title: '屏幕常亮',
		alias: '屏幕常亮, 唤醒, Wake Lock, NoSleep, 防息屏',
		desc: '保持屏幕常亮，防止设备自动息屏',
		icon: 'fa-regular fa-lightbulb',
		icon_color: '#f9a825',
		category: 'efficiency',
		featured: 0,
		tag: '',
		visibility: 'public',
		show: true,
		sort: 900,
	},
	{
		name: 'share',
		title: '云文件分享',
		alias: '文件分享, 分享链接, OneDrive, 提取码',
		desc: '基于 OneDrive 的临时文件分享',
		icon: 'fa-regular fa-share-from-square',
		icon_color: '#4f6bff',
		category: 'efficiency',
		featured: 0,
		tag: '',
		visibility: 'public',
		show: true,
		sort: 890,
	},
	{
		name: 'sub',
		title: '订阅周期管家',
		alias: '订阅, 周期, 续费, 账单, 订阅管理',
		desc: '订阅周期与续费管理',
		icon: 'fa-regular fa-calendar-check',
		icon_color: '#26a69a',
		category: 'efficiency',
		featured: 0,
		tag: '',
		visibility: 'public',
		show: true,
		sort: 880,
	},
	{
		name: 'dphxb',
		title: '大炮轰小兵',
		alias: '大炮轰小兵, 棋类, 策略, 对战, 民间棋',
		desc: '中国传统民间双人策略棋类博弈',
		icon: 'fa-regular fa-chess-knight',
		icon_color: '#8d6e63',
		category: 'play',
		featured: 0,
		tag: '',
		visibility: 'public',
		show: true,
		sort: 790,
	},
	{
		name: 'mic',
		title: 'Mic Lab · 麦克风调试器',
		alias: '麦克风, 录音, 音频, 电平, 频谱, 调试',
		desc: '麦克风设备能力、实时电平与录音调试, 本地检测报告',
		icon: 'fa-regular fa-microphone',
		icon_color: '#0f9d76',
		category: 'system,media',
		featured: 0,
		tag: '',
		visibility: 'public',
		show: true,
		sort: 700,
	},
	{
		name: 'jndv',
		title: '金诺视讯',
		alias: '金诺视讯, 户型图, 座位图, 排座',
		desc: '内部户型图与座位图编辑',
		icon: 'fa-regular fa-building',
		icon_color: '#607d8b',
		category: 'efficiency',
		featured: 0,
		tag: '',
		visibility: 'private',
		show: false,
		sort: 460,
	},
	{
		name: 'storage',
		title: '存储管理中台',
		alias: '存储, 七牛云, 文件管理, 对象存储',
		desc: '七牛云对象存储文件管理（管理员）',
		icon: 'fa-regular fa-hard-drive',
		icon_color: '#607d8b',
		category: 'dev',
		featured: 0,
		tag: '',
		visibility: 'admin',
		show: false,
		sort: 450,
	},
]
