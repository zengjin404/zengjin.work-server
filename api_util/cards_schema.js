import dayjs from 'dayjs'

import base from '#api_util/base.js'

/**
 * 认知图卡 (cards) 入参白名单与校验
 *
 * 原则：
 *   1. 所有对外写接口先过本文件，非法载荷连一次 SQL 都不发。
 *   2. 归属只认会话：进度 / 收藏接口的 user_id 由 requireAuth 注入，本文件不接收任何 user 字段。
 *   3. 时间统一转成 base.getTime 的北京时间字面值，拒绝明显未来的时间。
 *   4. 文案有上限，避免把数据库当对象存储。
 */

export class CardsPayloadError extends Error {
	constructor(message) {
		super(message)
		this.name = 'CardsPayloadError'
	}
}

export const CARD_KEY_RE = /^[a-z][a-z0-9_]{1,59}$/
export const CATEGORY_CODE_RE = /^[a-z][a-z0-9_]{1,29}$/
export const OBJECT_ID_RE = /^[a-z0-9_-]{0,60}$/
export const PLAY_MODES = ['recognize', 'connect', 'memory']
export const ASSET_TYPES = ['image', 'thumbnail', 'narration', 'sound', 'emoji']
export const EVENT_TYPES = ['hall_view', 'category_view', 'card_view', 'game_start', 'game_finish']
export const RENDER_TYPES = ['image', 'svg', 'emoji']

const MAX_FUTURE_MS = 5 * 60 * 1000

/** 文本清洗：去控制字符、trim、限制长度 */
export function sanitize_text(value, max = 255, field = '文本') {
	if (value == null) return ''
	const text = String(value)
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
		.trim()
	if (text.length > max) throw new CardsPayloadError(`${field}不能超过 ${max} 个字符`)
	return text
}

/** 整数清洗：默认 0，超界直接拒绝 */
export function sanitize_int(value, { min = -2147483648, max = 2147483647, fallback = 0, field = '数值' } = {}) {
	if (value == null || value === '') return fallback
	const num = Number(value)
	if (!Number.isFinite(num) || !Number.isInteger(num)) throw new CardsPayloadError(`${field}必须是整数`)
	if (num < min || num > max) throw new CardsPayloadError(`${field}超出允许范围`)
	return num
}

/** 布尔清洗：兼容 t-switch / 0/1 / 'true' */
export function sanitize_bool(value, fallback = false) {
	if (value == null || value === '') return fallback
	if (typeof value === 'boolean') return value
	if (value === 1 || value === '1' || value === 'true') return true
	if (value === 0 || value === '0' || value === 'false') return false
	return Boolean(value)
}

/**
 * 北京时间时间戳清洗：空值返回空串；未来时间直接拒绝
 *
 * 关键：客户端发来的 "YYYY-MM-DD HH:mm:ss" 是北京时间字面值，必须原样保留。
 * 不能先 dayjs(value) 再 tz('Asia/Shanghai') —— Serverless 运行在 UTC 时会被整体加 8 小时。
 * 只有带时区的 ISO 字符串才通过 base.getTime 做真正的时区换算。
 */
export function sanitize_timestamp(value, field = '时间') {
	if (value == null || value === '') return ''

	const text = String(value).trim()
	let normalized = ''
	if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(text)) {
		// 早于 2000 年的时间视为脏数据（含 0000/1900 这类误传），不进入解析
		if (Number(text.slice(0, 4)) < 2000) return ''
		// 字面值模式：只校验并规范成统一分隔符
		const literal = text.replace('T', ' ').slice(0, 19)
		const parsed = dayjs(literal)
		if (!parsed.isValid() || parsed.format('YYYY-MM-DD HH:mm:ss') !== literal) throw new CardsPayloadError(`${field}格式不正确`)
		normalized = literal
	} else {
		const parsed = dayjs(text)
		if (!parsed.isValid()) throw new CardsPayloadError(`${field}格式不正确`)
		normalized = base.getTime(parsed.valueOf())
	}

	// 与北京时间字面值做字符串比较，避免服务器时区影响
	if (normalized > base.getTime(Date.now() + MAX_FUTURE_MS)) throw new CardsPayloadError(`${field}不能晚于当前时间`)
	// 早于 2000 年的时间视为脏数据，避免把误传的 0 当成有效探索记录
	if (normalized < '2000-01-01 00:00:00') return ''
	return normalized
}

/** 十六进制颜色 */
export function sanitize_theme_color(value, field = '主题色') {
	const text = sanitize_text(value, 20, field)
	if (!text) return ''
	if (!/^#[0-9a-fA-F]{3,8}$/.test(text)) throw new CardsPayloadError(`${field}必须是 #RRGGBB 格式`)
	return text
}

/** 渲染配置：对象或 JSON 字符串，限制体积与嵌套深度 */
export function sanitize_render_config(value) {
	if (value == null || value === '') return {}
	let obj = value
	if (typeof value === 'string') {
		const text = value.trim()
		if (text.length > 65536) throw new CardsPayloadError('渲染配置不能超过 64KB')
		try {
			obj = JSON.parse(text)
		} catch {
			throw new CardsPayloadError('渲染配置不是合法 JSON')
		}
	}
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new CardsPayloadError('渲染配置必须是对象')

	const json = JSON.stringify(obj)
	if (json.length > 65536) throw new CardsPayloadError('渲染配置不能超过 64KB')

	const check = (val, depth) => {
		if (depth > 4) throw new CardsPayloadError('渲染配置嵌套过深')
		if (val == null || typeof val === 'number' || typeof val === 'boolean') return
		if (typeof val === 'string') {
			if (val.length > 4096) throw new CardsPayloadError('渲染配置单项内容过长')
			return
		}
		if (Array.isArray(val)) {
			if (val.length > 60) throw new CardsPayloadError('渲染配置数组过长')
			val.forEach(item => check(item, depth + 1))
			return
		}
		if (typeof val === 'object') {
			const keys = Object.keys(val)
			if (keys.length > 40) throw new CardsPayloadError('渲染配置字段过多')
			for (const key of keys) {
				if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new CardsPayloadError('渲染配置包含非法字段')
				check(val[key], depth + 1)
			}
		}
	}
	check(obj, 0)
	return obj
}

/** 素材列表：仅允许受控类型与可访问 URL */
export function sanitize_assets(value) {
	if (value == null) return null
	if (!Array.isArray(value)) throw new CardsPayloadError('素材列表格式不正确')
	if (value.length > 20) throw new CardsPayloadError('单张卡片最多关联 20 个素材')

	let hasPrimary = false
	const sanitized = value.map((raw, index) => {
		const assetType = sanitize_text(raw?.asset_type ?? raw?.assetType, 20, '素材类型')
		if (!ASSET_TYPES.includes(assetType)) throw new CardsPayloadError(`第 ${index + 1} 个素材类型不支持`)

		let assetUrl = sanitize_text(raw?.asset_url ?? raw?.assetUrl, 500, '素材地址')
		const metadata = sanitize_render_config(raw?.metadata ?? {})

		if (assetType === 'emoji') {
			const emojiChar = sanitize_text(raw?.emoji ?? metadata.emoji ?? assetUrl.replace(/^emoji:/, ''), 50, 'Emoji')
			if (!emojiChar) throw new CardsPayloadError(`第 ${index + 1} 个 Emoji 素材内容不能为空`)
			assetUrl = emojiChar.startsWith('emoji:') ? emojiChar : `emoji:${emojiChar}`
			metadata.emoji = emojiChar.replace(/^emoji:/, '')
		} else if (!/^(https?:\/\/|\/)/.test(assetUrl)) {
			throw new CardsPayloadError(`第 ${index + 1} 个素材地址不合法`)
		}

		let isPrimary = sanitize_bool(raw?.is_primary ?? raw?.isPrimary ?? metadata.is_primary, false)
		if (isPrimary) {
			if (hasPrimary) isPrimary = false
			else hasPrimary = true
		}
		const isEnabled = sanitize_bool(raw?.is_enabled ?? raw?.isEnabled ?? metadata.is_enabled, true)
		const isRandom = sanitize_bool(raw?.is_random ?? raw?.isRandom ?? metadata.is_random, true)

		metadata.is_primary = isPrimary
		metadata.is_enabled = isEnabled
		metadata.is_random = isRandom

		return {
			id: sanitize_text(raw?.id, 30, '素材 id') || undefined,
			asset_type: assetType,
			asset_url: assetUrl,
			mime_type: sanitize_text(raw?.mime_type ?? raw?.mimeType, 100, '文件类型'),
			sort_order: sanitize_int(raw?.sort_order ?? raw?.sortOrder, { min: 0, max: 9999, fallback: index * 10, field: '素材排序' }),
			is_primary: isPrimary,
			is_enabled: isEnabled,
			is_random: isRandom,
			metadata,
		}
	})

	if (!hasPrimary && sanitized.length > 0) {
		const firstVisual = sanitized.find(a => ['image', 'thumbnail', 'emoji'].includes(a.asset_type) && a.is_enabled) || sanitized[0]
		firstVisual.is_primary = true
		firstVisual.metadata.is_primary = true
	}

	return sanitized
}

/** 分类写入载荷 */
export function sanitize_category_payload(body = {}, { partial = false } = {}) {
	const payload = {}

	if (!partial || body.code !== undefined) {
		const code = sanitize_text(body.code, 30, '分类编码').toLowerCase()
		if (!CATEGORY_CODE_RE.test(code)) throw new CardsPayloadError('分类编码只能使用小写字母、数字和下划线，且以字母开头')
		payload.code = code
	}
	if (!partial || body.name !== undefined) {
		const name = sanitize_text(body.name, 50, '分类名称')
		if (!name) throw new CardsPayloadError('分类名称不能为空')
		payload.name = name
	}
	if (!partial || body.parent_id !== undefined) payload.parent_id = sanitize_text(body.parent_id, 20, '父级分类')
	if (!partial || body.description !== undefined) payload.description = sanitize_text(body.description, 255, '分类介绍')
	if (!partial || body.icon !== undefined) payload.icon = sanitize_text(body.icon, 100, '分类图标')
	if (!partial || body.theme_color !== undefined) payload.theme_color = sanitize_theme_color(body.theme_color)
	if (!partial || body.sort_order !== undefined) payload.sort_order = sanitize_int(body.sort_order, { min: 0, max: 999999, field: '排序' })
	if (!partial || body.is_enabled !== undefined) payload.is_enabled = sanitize_bool(body.is_enabled, true)
	if (!partial || body.publish_status !== undefined) payload.publish_status = sanitize_int(body.publish_status, { min: 0, max: 1, field: '发布状态' })

	return payload
}

/** 卡片写入载荷 */
export function sanitize_item_payload(body = {}, { partial = false } = {}) {
	const payload = {}

	if (!partial || body.card_key !== undefined) {
		const cardKey = sanitize_text(body.card_key, 60, '卡片标识').toLowerCase()
		if (!CARD_KEY_RE.test(cardKey)) throw new CardsPayloadError('卡片标识只能使用小写字母、数字和下划线，且以字母开头')
		payload.card_key = cardKey
	}
	if (!partial || body.category_id !== undefined) {
		const categoryId = sanitize_text(body.category_id, 20, '所属分类')
		if (!categoryId) throw new CardsPayloadError('所属分类不能为空')
		payload.category_id = categoryId
	}
	if (!partial || body.label !== undefined) {
		const label = sanitize_text(body.label, 50, '中文名称')
		if (!label) throw new CardsPayloadError('中文名称不能为空')
		payload.label = label
	}
	if (!partial || body.pinyin !== undefined) payload.pinyin = sanitize_text(body.pinyin, 100, '拼音')
	if (!partial || body.en_label !== undefined) payload.en_label = sanitize_text(body.en_label, 100, '英文名称')
	if (!partial || body.description !== undefined) payload.description = sanitize_text(body.description, 255, '简短介绍')
	if (!partial || body.knowledge !== undefined) payload.knowledge = sanitize_text(body.knowledge, 500, '小知识')
	if (!partial || body.render_type !== undefined) {
		const renderType = sanitize_text(body.render_type, 10, '展示类型')
		if (!RENDER_TYPES.includes(renderType)) throw new CardsPayloadError('展示类型只能是 image 或 svg')
		payload.render_type = renderType
	}
	if (!partial || body.render_config !== undefined) payload.render_config = sanitize_render_config(body.render_config)
	if (!partial || body.play_modes !== undefined) {
		const modes = Array.isArray(body.play_modes) ? body.play_modes : String(body.play_modes || '').split(',')
		const clean = [...new Set(modes.map(mode => sanitize_text(mode, 20, '玩法').toLowerCase()).filter(Boolean))]
		if (!clean.length) throw new CardsPayloadError('至少选择一个适用玩法')
		if (clean.some(mode => !PLAY_MODES.includes(mode))) throw new CardsPayloadError('存在不支持的玩法')
		payload.play_modes = clean.join(',')
	}
	if (!partial || body.sort_order !== undefined) payload.sort_order = sanitize_int(body.sort_order, { min: 0, max: 999999, field: '排序' })
	if (!partial || body.is_enabled !== undefined) payload.is_enabled = sanitize_bool(body.is_enabled, true)
	if (!partial || body.publish_status !== undefined) payload.publish_status = sanitize_int(body.publish_status, { min: 0, max: 1, field: '发布状态' })

	return payload
}

/**
 * 进度同步载荷
 * 返回 [{ cardKey, exploredAt, lastExploredAt }]，同 key 去重时取最早 / 最晚
 */
export function sanitize_progress_payload(body = {}) {
	const list = body?.items
	if (!Array.isArray(list)) throw new CardsPayloadError('进度数据必须是数组')
	if (list.length > 500) throw new CardsPayloadError('单次最多同步 500 条进度')

	const merged = new Map()
	for (const raw of list) {
		const cardKey = sanitize_text(raw?.cardKey ?? raw?.card_key, 60, '卡片标识').toLowerCase()
		if (!CARD_KEY_RE.test(cardKey)) throw new CardsPayloadError(`卡片标识不合法: ${cardKey || '空'}`)

		let exploredAt = sanitize_timestamp(raw?.exploredAt ?? raw?.explored_at, '首次探索时间')
		let lastExploredAt = sanitize_timestamp(raw?.lastExploredAt ?? raw?.last_explored_at, '最近探索时间')
		if (!exploredAt && !lastExploredAt) continue
		if (!exploredAt) exploredAt = lastExploredAt
		if (!lastExploredAt) lastExploredAt = exploredAt
		if (dayjs(lastExploredAt).isBefore(dayjs(exploredAt))) exploredAt = lastExploredAt

		const exist = merged.get(cardKey)
		if (!exist) {
			merged.set(cardKey, { cardKey, exploredAt, lastExploredAt })
		} else {
			if (dayjs(exploredAt).isBefore(dayjs(exist.exploredAt))) exist.exploredAt = exploredAt
			if (dayjs(lastExploredAt).isAfter(dayjs(exist.lastExploredAt))) exist.lastExploredAt = lastExploredAt
		}
	}
	return [...merged.values()]
}

/** 收藏 / 取消收藏载荷 */
export function sanitize_favorite_payload(body = {}) {
	const cardKey = sanitize_text(body.cardKey ?? body.card_key, 60, '卡片标识').toLowerCase()
	if (!CARD_KEY_RE.test(cardKey)) throw new CardsPayloadError('卡片标识不合法')
	if (typeof body.favorite !== 'boolean') throw new CardsPayloadError('favorite 必须是布尔值')
	return { cardKey, favorite: body.favorite }
}

/** 对局完成载荷 */
export function sanitize_play_payload(body = {}) {
	const mode = sanitize_text(body.mode, 20, '玩法').toLowerCase()
	if (!PLAY_MODES.includes(mode)) throw new CardsPayloadError('玩法不支持')

	const requestId = sanitize_text(body.requestId ?? body.request_id, 64, '请求标识')
	if (!requestId) throw new CardsPayloadError('缺少请求标识')
	if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw new CardsPayloadError('请求标识格式不正确')

	const totalPairs = sanitize_int(body.totalPairs ?? body.total_pairs, { min: 0, max: 50, field: '总配对数' })
	const completedPairs = sanitize_int(body.completedPairs ?? body.completed_pairs, { min: 0, max: 50, field: '完成配对数' })
	if (completedPairs > totalPairs) throw new CardsPayloadError('完成配对数不能大于总配对数')

	const duration = sanitize_int(body.duration, { min: 0, max: 86400, field: '游戏耗时' })
	const result = sanitize_text(body.result, 20, '结果').toLowerCase() || 'completed'
	if (!['completed', 'quit', 'abandoned'].includes(result)) throw new CardsPayloadError('结果状态不支持')

	return {
		mode,
		requestId,
		categoryId: sanitize_text(body.categoryId ?? body.category_id, 20, '分类标识'),
		difficulty: sanitize_text(body.difficulty, 20, '难度'),
		totalPairs,
		completedPairs,
		duration,
		result,
	}
}

export const COGNITION_GLOBAL_MODES = ['fixed_image', 'random_image', 'image_text']
export const COGNITION_OVERRIDE_MODES = ['inherit', 'fixed_image', 'random_image', 'image_text']

function map_legacy_mode(val) {
	if (val === 'visual' || val === 'same') return 'fixed_image'
	if (val === 'literacy' || val === 'image_text') return 'image_text'
	if (val === 'inherit') return 'inherit'
	return null
}

/**
 * 认知方式配置（全局预设 + 玩法独立覆盖）
 *
 * 后端只做结构收敛，不因未知值报错：任何损坏/越界的字段都回退到默认值，
 * 保证客户端永远能拿到一份可用的配置。未知字段直接忽略，便于前向兼容。
 */
export function sanitize_cognition_settings(value) {
	let raw = value
	if (typeof value === 'string') {
		if (value.length > 8192) throw new CardsPayloadError('认知设置不能超过 8KB')
		try {
			raw = JSON.parse(value)
		} catch {
			throw new CardsPayloadError('认知设置不是合法 JSON')
		}
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CardsPayloadError('认知设置必须是对象')
	if (JSON.stringify(raw).length > 8192) throw new CardsPayloadError('认知设置不能超过 8KB')

	let globalMode = 'fixed_image'
	if (COGNITION_GLOBAL_MODES.includes(raw.globalMode)) {
		globalMode = raw.globalMode
	} else if (raw.cognitionPreset) {
		const mapped = map_legacy_mode(raw.cognitionPreset)
		if (mapped && mapped !== 'inherit') globalMode = mapped
	}

	const overridesInput = raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {}
	const legacyModes = raw.gameCognitionModes && typeof raw.gameCognitionModes === 'object' ? raw.gameCognitionModes : {}

	function resolve_override(game) {
		const direct = overridesInput[game]
		if (COGNITION_OVERRIDE_MODES.includes(direct)) return direct
		const legacy = legacyModes[game === 'connect' ? (legacyModes.connect ? 'connect' : 'matching') : game]
		const mapped = map_legacy_mode(legacy)
		if (mapped) return mapped
		return 'inherit'
	}

	const inputOptions = raw.gameOptions && typeof raw.gameOptions === 'object' ? raw.gameOptions : {}
	const connectPairs = Number(inputOptions.connect?.pairCount ?? inputOptions.matching?.pairCount)
	const memoryPairs = Number(inputOptions.memory?.pairCount)

	const recognizeOverride = resolve_override('recognize')
	const connectOverride = resolve_override('connect')
	const memoryOverride = resolve_override('memory')

	const toLegacy = m => (m === 'image_text' ? 'literacy' : m === 'fixed_image' ? 'visual' : 'inherit')

	return {
		version: 2,
		globalMode,
		cognitionPreset: globalMode === 'image_text' ? 'literacy' : 'visual',
		overrides: {
			recognize: recognizeOverride,
			connect: connectOverride,
			memory: memoryOverride,
		},
		gameCognitionModes: {
			recognize: toLegacy(recognizeOverride),
			matching: toLegacy(connectOverride),
			memory: toLegacy(memoryOverride),
		},
		gameOptions: {
			connect: { pairCount: [3, 4, 5].includes(connectPairs) ? connectPairs : 4 },
			matching: { pairCount: [3, 4, 5].includes(connectPairs) ? connectPairs : 4 },
			memory: {
				pairCount: [4, 6, 8, 10].includes(memoryPairs) ? memoryPairs : 6,
				previewEnabled: typeof inputOptions.memory?.previewEnabled === 'boolean' ? inputOptions.memory.previewEnabled : true,
			},
		},
	}
}

/** 匿名统计事件批量载荷 */
export function sanitize_event_payload(body = {}) {
	const list = body?.events
	if (!Array.isArray(list)) throw new CardsPayloadError('统计事件必须是数组')
	if (list.length > 30) throw new CardsPayloadError('单次最多上报 30 个事件')

	return list.map(raw => {
		const type = sanitize_text(raw?.type, 30, '事件类型')
		if (!EVENT_TYPES.includes(type)) throw new CardsPayloadError(`统计事件类型不支持: ${type || '空'}`)
		const objectId = sanitize_text(raw?.objectId ?? raw?.object_id, 60, '统计对象').toLowerCase()
		if (!OBJECT_ID_RE.test(objectId)) throw new CardsPayloadError('统计对象不合法')
		return { type, objectId }
	})
}
