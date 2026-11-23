/**
 * Admin 全局消息通知中心 —— 入参白名单与校验
 *
 * 设计原则：
 *   1. 通知状态、触发次数、解决时间等受保护字段一律不接受前端传入。
 *   2. 上报接口只允许白名单内的应用 / 类别，去重键由服务端根据业务字段重新构造。
 *   3. 文本有长度上限，筛选条件逐项收敛，非法值直接拒绝而不是静默忽略。
 */

export class NotificationPayloadError extends Error {
	constructor(message) {
		super(message)
		this.name = 'NotificationPayloadError'
	}
}

export const NOTIFICATION_APP_CODES = ['cards', 'system']
export const NOTIFICATION_CATEGORIES = ['missing_resource', 'system_notice']
export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'error']
export const NOTIFICATION_STATUSES = ['pending', 'processing', 'resolved']
export const NOTIFICATION_SOURCES = ['cards_play', 'admin_manual', 'system']

export const CARDS_PLAY_MODES = ['recognize', 'connect', 'memory']
export const CARDS_IMAGE_MODES = ['fixed_image', 'random_image', 'image_text']

export const NOTIFICATION_SETTING_KEYS = ['content_gap_alert_enabled']

const CATEGORY_ID_RE = /^[a-zA-Z0-9_-]{1,30}$/

/** 文本清洗：去控制字符、trim、限制长度 */
export function sanitize_notification_text(value, max = 255, field = '文本') {
	if (value == null) return ''
	const text = String(value)
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
		.trim()
	if (text.length > max) throw new NotificationPayloadError(`${field}不能超过 ${max} 个字符`)
	return text
}

/** 枚举校验 */
export function sanitize_enum(value, allowed, field = '取值', fallback = '') {
	const text = sanitize_notification_text(value, 32, field).toLowerCase()
	if (!text) return fallback
	if (!allowed.includes(text)) throw new NotificationPayloadError(`${field}不支持`)
	return text
}

/** 布尔清洗：兼容 t-switch / 0/1 / 'true' */
export function sanitize_notification_bool(value, fallback = false) {
	if (value == null || value === '') return fallback
	if (typeof value === 'boolean') return value
	if (value === 1 || value === '1' || value === 'true') return true
	if (value === 0 || value === '0' || value === 'false') return false
	return Boolean(value)
}

/** 时间筛选：接受 YYYY-MM-DD / YYYY-MM-DD HH:mm:ss，统一按北京时间字面值比较 */
export function sanitize_time_filter(value, field = '时间') {
	if (value == null || value === '') return ''
	const text = String(value).trim()
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 00:00:00`
	if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)) throw new NotificationPayloadError(`${field}格式不正确`)
	return text.replace('T', ' ')
}

/**
 * 公开缺口上报载荷
 *
 * 只接受业务上下文；dedupeKey、reportedCount、status、resolvedAt 等字段即使传入也会被忽略。
 */
export function sanitize_gap_report_payload(body = {}) {
	const appCode = sanitize_enum(body.appCode ?? body.app_code, NOTIFICATION_APP_CODES, '来源应用')
	if (!appCode) throw new NotificationPayloadError('缺少来源应用')
	if (appCode !== 'cards') throw new NotificationPayloadError('当前接口只接受图卡乐园的内容缺口上报')

	const category = sanitize_enum(body.category, NOTIFICATION_CATEGORIES, '通知类别')
	if (!category) throw new NotificationPayloadError('缺少通知类别')
	if (category !== 'missing_resource') throw new NotificationPayloadError('公开接口只接受内容缺口上报')

	const playMode = sanitize_enum(body.playMode ?? body.play_mode, CARDS_PLAY_MODES, '玩法')
	if (!playMode) throw new NotificationPayloadError('缺少玩法')

	const imageMode = sanitize_enum(body.imageMode ?? body.image_mode, CARDS_IMAGE_MODES, '认知模式')
	if (!imageMode) throw new NotificationPayloadError('缺少认知模式')

	// 方案二后分类只有主键 id；旧客户端的 categoryCode 是 code，不能静默当成 id 处理
	const legacyCode = body.categoryCode ?? body.category_code
	const rawCategoryId = body.categoryId ?? body.category_id
	if ((rawCategoryId == null || rawCategoryId === '') && legacyCode != null && legacyCode !== '') {
		throw new NotificationPayloadError('分类参数已升级，请刷新页面后重试')
	}

	const categoryId = sanitize_notification_text(rawCategoryId, 30, '分类标识')
	if (categoryId && !CATEGORY_ID_RE.test(categoryId)) throw new NotificationPayloadError('分类标识不合法')

	return { appCode, category, playMode, imageMode, categoryId }
}

/** 管理端列表筛选参数 */
export function sanitize_notification_query(query = {}) {
	const read = sanitize_enum(query.read, ['read', 'unread'], '阅读状态')
	const status = sanitize_enum(query.status, NOTIFICATION_STATUSES, '处理状态')
	const appCode = sanitize_enum(query.appCode ?? query.app_code, NOTIFICATION_APP_CODES, '来源应用')
	const category = sanitize_enum(query.category, NOTIFICATION_CATEGORIES, '通知类别')
	const severity = sanitize_enum(query.severity, NOTIFICATION_SEVERITIES, '重要程度')
	const keyword = sanitize_notification_text(query.keyword, 50, '关键词')
	const startTime = sanitize_time_filter(query.startTime ?? query.start_time, '开始时间')
	const endTime = sanitize_time_filter(query.endTime ?? query.end_time, '结束时间')
	if (startTime && endTime && startTime > endTime) throw new NotificationPayloadError('开始时间不能晚于结束时间')

	return { read, status, appCode, category, severity, keyword, startTime, endTime }
}

/** 通知 id 列表（批量已读） */
export function sanitize_ids(value, { max = 100, field = '通知 id' } = {}) {
	const list = Array.isArray(value) ? value : [value]
	const ids = [...new Set(list.map(item => sanitize_notification_text(item, 24, field)).filter(Boolean))]
	if (!ids.length) throw new NotificationPayloadError('缺少通知 id')
	if (ids.length > max) throw new NotificationPayloadError(`单次最多处理 ${max} 条通知`)
	return ids
}

/** 处理状态载荷 */
export function sanitize_status_payload(body = {}) {
	const status = sanitize_enum(body.status, NOTIFICATION_STATUSES, '处理状态')
	if (!status) throw new NotificationPayloadError('缺少处理状态')
	return status
}

/** 配置项载荷 */
export function sanitize_setting_payload(body = {}) {
	const key = sanitize_enum(body.key, NOTIFICATION_SETTING_KEYS, '配置项')
	if (!key) throw new NotificationPayloadError('缺少配置项')
	if (typeof body.value !== 'boolean') throw new NotificationPayloadError('配置值必须是布尔值')
	return { key, value: body.value }
}

/** 服务端去重键：只使用稳定业务标识，绝不信任前端传入值 */
export function build_cards_gap_dedupe_key({ categoryId = '', playMode, imageMode }) {
	return `cards:${categoryId || 'all'}:${playMode}:${imageMode}`
}
