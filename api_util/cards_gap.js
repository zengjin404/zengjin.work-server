import { createHash } from 'crypto'

import base from '#api_util/base.js'
import db from '#api_util/db.js'
import {
	CARDS_IMAGE_MODES,
	CARDS_PLAY_MODES,
	NotificationPayloadError,
	build_cards_gap_dedupe_key,
	sanitize_gap_report_payload,
} from '#api_util/notification_schema.js'
import {
	ensure_notification_db_async,
	get_notification_setting_async,
	hit_rate_limit_async,
	resolve_notification_async,
	select_open_notifications_async,
	upsert_notification_async,
} from '#api_util/notification_store.js'

/**
 * CARDS 内容缺口 —— 业务资格判断与上报 / 自动消警
 *
 * 与前端 apps/cards/utils/asset-selector.js 保持同一套业务语义：
 *   - 固定图片：需要至少一条有效视觉素材
 *   - 随机图片：认一认需要有效视觉；连一连 / 翻一翻需要同一概念至少 2 个视觉不同的可随机素材
 *   - 图文关联：需要有效视觉 + 中文名称
 *   - 视觉身份：图片忽略 query / hash，Emoji 按字符本身去重
 *
 * 本模块只负责判断「是否具备开局条件」以及维护 CARDS 自己的缺料通知；
 * 通知的创建、聚合、状态流转仍由 notification_store.js 完成。
 */

export const GAP_APP_CODE = 'cards'
export const GAP_CATEGORY = 'missing_resource'
export const GAP_REPORT_MAX_PER_MINUTE = 8

const VISUAL_ASSET_TYPES = new Set(['image', 'thumbnail', 'emoji'])
const PLAY_LABELS = { recognize: '认一认', connect: '连一连', memory: '翻一翻' }
const MODE_LABELS = { fixed_image: '固定图片', random_image: '随机图片', image_text: '图文关联' }
// 玩法最低档位仅用于后台展示「推荐数量」，是否可开局以游戏引擎真实行为为准（≥1 张即可发牌）
const PREFERRED_COUNTS = { recognize: 1, connect: 3, memory: 4 }

/** 从素材记录中提取 Emoji 字符（与前端 extract_emoji_char 保持一致） */
export function extract_emoji_char(asset) {
	if (!asset) return ''
	if (asset.metadata?.emoji) return String(asset.metadata.emoji)
	if (asset.emoji) return String(asset.emoji)
	if (typeof asset.asset_url === 'string' && asset.asset_url.startsWith('emoji:')) return asset.asset_url.slice(6)
	return ''
}

/**
 * 视觉身份：判断两条素材看起来是否同一张图
 * - 图片：忽略 query / hash，只比较 origin + pathname
 * - Emoji：比较字符本身
 */
export function get_asset_visual_key(asset) {
	if (!asset) return ''
	const assetType = asset.asset_type || (asset.emoji ? 'emoji' : 'image')
	if (assetType === 'emoji') {
		const emoji = extract_emoji_char(asset).trim()
		return emoji ? `emoji:${emoji}` : ''
	}

	const url = String(asset.asset_url || '').trim()
	if (!url) return ''
	if (url.startsWith('emoji:')) {
		const emoji = url.slice(6).trim()
		return emoji ? `emoji:${emoji}` : ''
	}

	try {
		const parsed = new URL(url, 'https://cards.local/')
		const origin = parsed.origin === 'https://cards.local' ? '' : parsed.origin
		return `${origin}${parsed.pathname}`
	} catch {
		return url.split(/[?#]/)[0]
	}
}

/** 是否为可用视觉素材（已启用、类型受支持、地址 / Emoji 非空） */
export function is_visual_asset(asset) {
	if (!asset || asset.is_enabled === false) return false
	const assetType = asset.asset_type || (asset.emoji ? 'emoji' : 'image')
	if (!VISUAL_ASSET_TYPES.has(assetType)) return false
	if (assetType === 'emoji') return Boolean(extract_emoji_char(asset).trim())
	const url = String(asset.asset_url || '').trim()
	return Boolean(url && !url.startsWith('javascript:'))
}

/**
 * 单张卡片在指定模式与玩法下的资格
 * @returns {{eligible: boolean, reason: string}}
 */
export function evaluate_card_qualification({ label = '', play_modes = '' } = {}, assets = [], imageMode = 'fixed_image', playMode = 'recognize') {
	const modes = String(play_modes || '')
		.split(',')
		.map(mode => mode.trim())
		.filter(Boolean)
	if (modes.length && !modes.includes(playMode)) return { eligible: false, reason: 'play_mode_unsupported' }

	const effective = (assets || []).filter(is_visual_asset)
	const visualKeys = new Set(effective.map(get_asset_visual_key).filter(Boolean))
	const hasVisual = visualKeys.size > 0
	const hasChineseLabel = Boolean(String(label || '').trim())

	if (imageMode === 'fixed_image') {
		return hasVisual ? { eligible: true, reason: '' } : { eligible: false, reason: 'no_valid_visual' }
	}

	if (imageMode === 'random_image') {
		if (playMode === 'recognize') {
			return hasVisual ? { eligible: true, reason: '' } : { eligible: false, reason: 'no_valid_visual' }
		}
		// 连一连 / 翻一翻：同一概念至少两个视觉不同的可随机素材，不能复制记录凑数
		const randomKeys = new Set(
			effective
				.filter(asset => asset.is_random !== false)
				.map(get_asset_visual_key)
				.filter(Boolean),
		)
		return randomKeys.size >= 2 ? { eligible: true, reason: '' } : { eligible: false, reason: 'insufficient_visual_variants' }
	}

	if (imageMode === 'image_text') {
		if (!hasChineseLabel) return { eligible: false, reason: 'missing_chinese_name' }
		return hasVisual ? { eligible: true, reason: '' } : { eligible: false, reason: 'no_valid_visual' }
	}

	return { eligible: false, reason: 'unsupported_mode' }
}

/** 汇总缺口主要原因，供通知详情直接展示 */
function resolve_overall_reason({ totalCards, availableCount, imageMode, playMode, reasonCounts }) {
	if (availableCount > 0) return ''
	if (!totalCards) return 'no_cards'
	if (reasonCounts.no_valid_visual === totalCards) return 'no_valid_visual'
	if (imageMode === 'random_image' && playMode !== 'recognize' && reasonCounts.insufficient_visual_variants === totalCards) {
		return 'insufficient_visual_variants'
	}
	if (imageMode === 'image_text' && reasonCounts.missing_chinese_name === totalCards) return 'missing_chinese_name'
	return 'insufficient_cards'
}

/**
 * 读取真实数据库内容并计算某分类 / 玩法 / 模式下的内容资格
 * @param {Object} params
 * @param {string} [params.categoryId] 分类 id；留空表示全部分类（混搭）
 * @param {'recognize'|'connect'|'memory'} params.playMode
 * @param {'fixed_image'|'random_image'|'image_text'} params.imageMode
 */
export async function evaluate_cards_content_gap_async({ categoryId = '', playMode, imageMode } = {}) {
	if (!CARDS_PLAY_MODES.includes(playMode) || !CARDS_IMAGE_MODES.includes(imageMode)) {
		throw new NotificationPayloadError('玩法或认知模式不合法')
	}

	const categoryFilter = categoryId ? 'AND i.category_id = $1' : ''
	const binds = categoryId ? [categoryId] : []

	const [itemRes, assetRes] = await Promise.all([
		db.query(
			`SELECT i.id, i.card_key, i.label, i.play_modes, i.category_id
			 FROM cards_item i
			 JOIN cards_category c ON c.id = i.category_id
			 WHERE i.publish_status = 1 AND i.is_enabled = true
			   AND c.publish_status = 1 AND c.is_enabled = true
			   ${categoryFilter}
			 ORDER BY c.sort_order ASC, i.sort_order ASC`,
			binds,
		),
		db.query(
			`SELECT a.card_id, a.asset_type, a.asset_url, a.is_enabled, a.is_random, a.metadata
			 FROM cards_asset a
			 JOIN cards_item i ON i.id = a.card_id
			 JOIN cards_category c ON c.id = i.category_id
			 WHERE i.publish_status = 1 AND i.is_enabled = true
			   AND c.publish_status = 1 AND c.is_enabled = true
			   AND (a.is_enabled IS NOT FALSE)
			   ${categoryFilter}
			 ORDER BY a.sort_order ASC`,
			binds,
		),
	])

	const assetsByCard = new Map()
	for (const asset of assetRes.rows || []) {
		if (!assetsByCard.has(asset.card_id)) assetsByCard.set(asset.card_id, [])
		assetsByCard.get(asset.card_id).push(asset)
	}

	const itemsInMode = (itemRes.rows || []).filter(item => {
		const modes = String(item.play_modes || '')
			.split(',')
			.map(mode => mode.trim())
		return !modes.length || modes.includes(playMode)
	})

	const reasonCounts = {}
	let availableCount = 0
	for (const item of itemsInMode) {
		const check = evaluate_card_qualification(item, assetsByCard.get(item.id) || [], imageMode, playMode)
		if (check.eligible) availableCount++
		else if (check.reason) reasonCounts[check.reason] = (reasonCounts[check.reason] || 0) + 1
	}

	const totalCards = itemsInMode.length
	const reason = resolve_overall_reason({ totalCards, availableCount, imageMode, playMode, reasonCounts })
	const reasons = Object.entries(reasonCounts)
		.map(([key, count]) => ({ reason: key, count }))
		.sort((a, b) => b.count - a.count)

	return {
		available: availableCount > 0,
		availableCount,
		requiredCount: 1,
		preferredCount: PREFERRED_COUNTS[playMode] || 1,
		totalCards,
		reason,
		reasons,
		playMode,
		imageMode,
		categoryId: categoryId || '',
	}
}

/** 读取公开可见分类（只允许已发布且启用的分类） */
async function read_public_category_async(categoryCode) {
	if (!categoryCode) return { id: '', code: '', name: '' }
	const { rows } = await db.query(
		`SELECT id, code, name
		 FROM cards_category
		 WHERE code = $1 AND publish_status = 1 AND is_enabled = true
		 LIMIT 1`,
		[categoryCode],
	)
	return rows?.[0] || null
}

function build_gap_copy({ categoryName, playMode, imageMode, evaluation }) {
	const scopeName = categoryName ? `分类「${categoryName}」` : '全部分类'
	const playLabel = PLAY_LABELS[playMode] || playMode
	const modeLabel = MODE_LABELS[imageMode] || imageMode
	return {
		title: '认知图卡 · 内容缺口',
		content: `${scopeName}的「${playLabel} · ${modeLabel}」当前没有可用卡片（共 ${evaluation.totalCards} 张，可用 ${evaluation.availableCount} 张）`,
	}
}

/** 从请求中取 IP 并做不可逆摘要，限频表不保存明文 IP */
function hash_req_ip(req) {
	const forwarded = req?.headers?.['x-forwarded-for']
	const raw = typeof forwarded === 'string' && forwarded ? forwarded.split(',')[0].trim() : req?.socket?.remoteAddress || req?.ip || 'unknown'
	return createHash('sha256').update(String(raw)).digest('hex').slice(0, 32)
}

/**
 * 公开缺口上报
 *
 * 顺序：开关 → 限频 → 字段校验 → 读取真实内容 → 独立验证资格 → 原子聚合。
 * 前端报告的缺口不成立时直接结束，不创建通知。
 */
export async function report_cards_content_gap_async(req, body = {}) {
	const enabled = await get_notification_setting_async('content_gap_alert_enabled', false)
	if (!enabled) return { accepted: false, reason: 'disabled' }

	const ipHash = hash_req_ip(req)
	if (!(await hit_rate_limit_async('cards-gap', ipHash, GAP_REPORT_MAX_PER_MINUTE, 60000))) {
		throw new NotificationPayloadError('上报过于频繁，请稍后再试')
	}

	const payload = sanitize_gap_report_payload(body)
	const category = await read_public_category_async(payload.categoryCode)
	if (payload.categoryCode && !category) throw new NotificationPayloadError('分类不存在或未发布')

	const evaluation = await evaluate_cards_content_gap_async({
		categoryId: category?.id || '',
		playMode: payload.playMode,
		imageMode: payload.imageMode,
	})

	// 后端独立验证：内容实际可用时拒绝创建缺料通知
	if (evaluation.available) {
		return { accepted: false, reason: 'content_available', evaluation }
	}

	const dedupeKey = build_cards_gap_dedupe_key({
		categoryId: category?.id || '',
		playMode: payload.playMode,
		imageMode: payload.imageMode,
	})
	const copy = build_gap_copy({
		categoryName: category?.name || '',
		playMode: payload.playMode,
		imageMode: payload.imageMode,
		evaluation,
	})

	const notification = await upsert_notification_async({
		appCode: GAP_APP_CODE,
		category: GAP_CATEGORY,
		severity: 'warning',
		title: copy.title,
		content: copy.content,
		source: 'cards_play',
		dedupeKey,
		metadata: {
			categoryId: category?.id || '',
			categoryCode: category?.code || '',
			categoryName: category?.name || '',
			playMode: payload.playMode,
			imageMode: payload.imageMode,
			availableCount: evaluation.availableCount,
			requiredCount: evaluation.requiredCount,
			preferredCount: evaluation.preferredCount,
			totalCards: evaluation.totalCards,
			reason: evaluation.reason,
			reasons: evaluation.reasons,
			reportedAt: base.getTime(),
		},
	})

	return { accepted: true, notification, evaluation }
}

/**
 * 内容变化后的自动消警
 *
 * @param {Object} params
 * @param {string[]} params.categoryIds 受影响的分类 id；为空时不做任何检查
 * @param {string} [params.reason] 变更来源，仅用于日志诊断
 */
export async function resolve_cards_content_gaps_async({ categoryIds = [], reason = 'content_changed' } = {}) {
	const ids = [...new Set((categoryIds || []).map(id => String(id || '').trim()).filter(Boolean))]
	if (!ids.length) return { checked: 0, resolved: 0 }

	// 内容写操作可能先于通知模块首次请求发生，这里保证通知表可用
	await ensure_notification_db_async()
	const rows = await select_open_notifications_async({ appCode: GAP_APP_CODE, category: GAP_CATEGORY })
	const cache = new Map()
	let checked = 0
	let resolved = 0

	for (const row of rows) {
		const metadata = typeof row.metadata === 'string' ? safe_parse(row.metadata) : row.metadata || {}
		const categoryId = String(metadata.categoryId || '')
		// 混搭（全部分类）缺口可能被任意分类的内容变化影响，需要一起检查
		if (categoryId && categoryId !== 'all' && !ids.includes(categoryId)) continue

		const playMode = String(metadata.playMode || '')
		const imageMode = String(metadata.imageMode || '')
		if (!CARDS_PLAY_MODES.includes(playMode) || !CARDS_IMAGE_MODES.includes(imageMode)) continue

		const cacheKey = `${categoryId}|${playMode}|${imageMode}`
		let evaluation = cache.get(cacheKey)
		if (!evaluation) {
			evaluation = await evaluate_cards_content_gap_async({ categoryId, playMode, imageMode })
			cache.set(cacheKey, evaluation)
		}

		checked++
		if (!evaluation.available) continue
		if (await resolve_notification_async(row.id)) resolved++
	}

	if (resolved > 0) console.log(`[cards_gap] 自动消警 (${reason}): 检查 ${checked} 条，解决 ${resolved} 条`)
	return { checked, resolved }
}

function safe_parse(text) {
	try {
		return JSON.parse(text)
	} catch {
		return {}
	}
}
