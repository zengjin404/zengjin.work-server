/**
 * 应用分类字典（后端唯一权威定义）
 *
 * 与前端 `_src/js/appCategories.js` 保持同一份数据；前端测试会读取本文件做同步校验。
 * `inclusion` / `exclusion` 不只是注释，也是本地 AI 元数据审查的判断依据。
 */

export const APP_CATEGORIES = [
	{
		key: 'efficiency',
		label: '效率工具',
		labelEn: 'Efficiency',
		description: '日常事务处理、办公辅助、信息组织和工作效率',
		inclusion: [
			'日常计算、格式转换、文本处理等通用工具',
			'办公文档、信息整理和数据处理辅助工具',
			'文件管理、内容分享等偏工作流程的工具',
			'不属于其他专业领域的通用效率应用',
		],
		exclusion: [
			'主要面向开发人员的专业编码和调试工具',
			'主要面向设备检测的硬件诊断工具',
			'以图像、音频、视频处理为核心的专业媒体工具',
			'游戏和互动娱乐应用',
			'GIS 专业应用',
		],
		status: 'active',
		sort: 10,
	},
	{
		key: 'system',
		label: '系统硬件',
		labelEn: 'System & Hardware',
		description: '设备检测、硬件诊断、浏览器与运行环境检测',
		inclusion: [
			'摄像头、麦克风等设备检测',
			'浏览器兼容性、硬件能力和运行环境检测',
			'系统参数、设备状态及硬件诊断',
			'面向普通用户或开发者的设备能力测试工具',
		],
		exclusion: ['仅仅使用摄像头、麦克风完成内容创作的媒体工具', '主要进行图像、音频内容编辑的应用', '仅提供浏览器开发调试功能、但不涉及系统设备诊断的工具'],
		status: 'active',
		sort: 20,
	},
	{
		key: 'media',
		label: '影音图像',
		labelEn: 'Media',
		description: '图像、音频、视频、色彩及视觉内容处理',
		inclusion: [
			'图片处理、图像转换、图像生成',
			'音频处理、录音、音频格式转换',
			'视频处理及视频素材工具',
			'色彩提取、配色、颜色转换等视觉工具',
			'证件照、图像采集及视觉内容制作',
		],
		exclusion: ['主要用于摄像头硬件能力检测的工具', '主要用于前端代码开发和调试的工具', '主要用于 GIS 空间数据分析的工具'],
		status: 'active',
		sort: 30,
	},
	{
		key: 'dev',
		label: '前端开发',
		labelEn: 'Development',
		description: '前端开发、Web 技术、编码、调试和开发辅助',
		inclusion: [
			'编码、调试、格式化、转换及开发辅助',
			'HTML、CSS、JavaScript 等 Web 技术工具',
			'浏览器开发、网络请求和前端运行环境辅助',
			'面向开发者的专业技术工具',
		],
		exclusion: ['仅仅因为使用了 Web 技术就归入此类的普通应用', '主要面向普通用户的日常效率工具', '主要用于设备诊断的硬件工具'],
		status: 'active',
		sort: 40,
	},
	{
		key: 'play',
		label: '休闲娱乐',
		labelEn: 'Play',
		description: '游戏、互动体验、益智认知及轻娱乐',
		inclusion: ['小游戏、策略游戏、互动游戏', '益智、记忆、认知训练', '儿童启蒙、互动学习和轻娱乐', '不以严肃工作任务为主要目的的互动体验'],
		exclusion: ['主要用于办公或专业学习的工具', '以开发、诊断、媒体处理为核心的工具'],
		status: 'active',
		sort: 50,
	},
	{
		key: 'gis',
		label: '空间地理',
		labelEn: 'GIS & Geography',
		description: '地理信息、地图、空间数据与 GIS 专业工具',
		inclusion: ['地图展示、地图编辑及地理可视化', 'GIS 数据处理、空间分析', '坐标转换、地理测绘和空间数据工具', '遥感影像、地形数据和空间信息处理'],
		exclusion: ['仅仅展示普通图片或普通数据图表的应用', '不涉及地理空间信息的通用数据工具'],
		status: 'active',
		sort: 60,
	},
]

export const APP_CATEGORY_KEYS = APP_CATEGORIES.map(category => category.key)
export const APP_CATEGORY_MAP = Object.fromEntries(APP_CATEGORIES.map(category => [category.key, category]))

export const APP_VISIBILITY_VALUES = ['public', 'private', 'admin']
export const APP_VISIBILITY_LABELS = { public: '公开', private: '私有', admin: '管理员' }

/**
 * 旧分类兼容映射
 * 只用于迁移和读取旧数据；新写入必须使用 APP_CATEGORY_KEYS，不允许继续写入旧 key。
 */
export const APP_LEGACY_CATEGORY_MAP = {
	daily: 'efficiency',
	kids: 'play',
	game: 'play',
	ai: 'efficiency',
	tool: 'efficiency',
	office: 'efficiency',
	map: 'gis',
	frame: 'dev',
	demo: 'dev',
	media: 'media',
	dev: 'dev',
	gis: 'gis',
}

/** 把逗号字符串 / 数组拆成去空 token，保留原顺序 */
export function split_app_categories(raw) {
	const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',')
	return list
		.map(item =>
			String(item ?? '')
				.trim()
				.toLowerCase(),
		)
		.filter(Boolean)
}

/**
 * 归一化分类：去重、保留顺序、过滤未知 / 停用分类
 * @param {string|string[]} raw
 * @param {{allowLegacy?: boolean}} options
 * @returns {{categories: string[], invalid: string[], legacy: string[]}}
 */
export function normalize_app_categories(raw, { allowLegacy = false } = {}) {
	const categories = []
	const invalid = []
	const legacy = []

	for (const token of split_app_categories(raw)) {
		let key = token
		const mapped = APP_LEGACY_CATEGORY_MAP[token]
		if (!APP_CATEGORY_MAP[token] && mapped) {
			if (!allowLegacy) {
				invalid.push(token)
				continue
			}
			key = mapped
			legacy.push(token)
		}
		const definition = APP_CATEGORY_MAP[key]
		if (!definition || definition.status !== 'active') {
			if (!invalid.includes(token)) invalid.push(token)
			continue
		}
		if (!categories.includes(key)) categories.push(key)
	}

	return { categories, invalid, legacy }
}

/**
 * 写入前校验
 * @param {string|string[]} raw
 * @param {{allowLegacy?: boolean, requireAtLeastOne?: boolean}} options
 * @returns {{categories: string[], errors: string[], warnings: string[]}}
 */
export function validate_app_categories(raw, { allowLegacy = false, requireAtLeastOne = true } = {}) {
	const { categories, invalid, legacy } = normalize_app_categories(raw, { allowLegacy })
	const errors = []
	const warnings = []

	if (invalid.length) errors.push(`存在未定义或已停用的分类：${[...new Set(invalid)].join(', ')}`)
	if (legacy.length) warnings.push(`旧分类已自动映射：${[...new Set(legacy)].join(', ')}`)
	if (requireAtLeastOne && !categories.length) errors.push('至少需要选择一个有效分类')
	if (categories.length > 2) warnings.push(`该应用归属 ${categories.length} 个分类，请确认跨领域归属的实际依据`)

	return { categories, errors, warnings }
}

export function is_valid_app_visibility(value) {
	return APP_VISIBILITY_VALUES.includes(
		String(value ?? '')
			.trim()
			.toLowerCase(),
	)
}

export function normalize_app_visibility(value, fallback = 'public') {
	const text = String(value ?? '')
		.trim()
		.toLowerCase()
	return APP_VISIBILITY_VALUES.includes(text) ? text : fallback
}

/** 读取时把分类转换为展示标签；旧分类自动映射，未知分类原样标出 */
export function get_app_category_labels(raw) {
	return split_app_categories(raw)
		.map(key => {
			const mapped = APP_CATEGORY_MAP[key] ? key : APP_LEGACY_CATEGORY_MAP[key]
			const definition = APP_CATEGORY_MAP[mapped]
			return definition ? { key: mapped, label: definition.label, legacy: key !== mapped ? key : '' } : { key, label: key, legacy: '' }
		})
		.filter(Boolean)
}
