import { requireAdmin } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import { evaluate_cards_content_gap_async, report_cards_content_gap_async, resolve_cards_content_gaps_async } from '#api_util/cards_gap.js'
import {
	CARDS_IMAGE_MODES,
	CARDS_PLAY_MODES,
	NotificationPayloadError,
	sanitize_ids,
	sanitize_notification_query,
	sanitize_setting_payload,
	sanitize_status_payload,
} from '#api_util/notification_schema.js'
import {
	count_unread_notifications_async,
	get_notification_async,
	get_notification_setting_async,
	mark_all_notifications_read_async,
	mark_notifications_read_async,
	select_notifications_async,
	set_notification_setting_async,
	set_notification_status_async,
} from '#api_util/notification_store.js'

/**
 * Admin 全局消息通知中心 API
 *
 * 路由（由 api/index.js 分发到 admin/notification）：
 *   POST /api/admin/notification/report          公开缺口上报（服务端独立验证内容资格）
 *   GET  /api/admin/notification/select          管理端分页列表
 *   GET  /api/admin/notification/detail          通知详情
 *   GET  /api/admin/notification/unread-count    全局未读数量
 *   POST /api/admin/notification/read            批量 / 单条标记已读
 *   POST /api/admin/notification/read-all        全部标记已读
 *   POST /api/admin/notification/status          修改处理状态
 *   GET  /api/admin/notification/setting         读取功能开关
 *   POST /api/admin/notification/setting         保存功能开关
 *
 * 除 report 外全部 requireAdmin；匿名用户不能查询或管理通知。
 */

const routes = {}

// 公开上报：只接受 CARDS 内容缺口，前端无法指定状态、次数、解决时间
routes['post:admin_notification:report'] = async ({ req, body }) => {
	const result = await report_cards_content_gap_async(req, body)
	return base.respSuccess({ msg: result.accepted ? '已记录内容缺口' : '当前内容可用，无需提醒', data: result })
}

// 管理端列表
routes['get:admin_notification:select'] = requireAdmin(async ({ query }) => {
	const filters = sanitize_notification_query(query)
	const { rows, total, page, size } = await select_notifications_async(filters, query)
	return base.respSuccess({
		msg: '查询成功',
		total,
		data: base.formatDbRows(rows),
		page,
		pageSize: size,
	})
})

// 通知详情（CARDS 缺料通知附带当前实时资格，便于管理员判断是否已恢复）
routes['get:admin_notification:detail'] = requireAdmin(async ({ query }) => {
	const id = String(query.id || '').trim()
	if (!id) return base.respFailure({ msg: 'id 参数缺失' })
	const row = await get_notification_async(id)
	if (!row) return base.respFailure({ msg: '通知不存在' })

	const data = base.formatDbRows([row])[0]
	const metadata = normalize_metadata(data.metadata)
	data.metadata = metadata

	if (data.app_code === 'cards' && data.category === 'missing_resource') {
		const playMode = String(metadata.playMode || '')
		const imageMode = String(metadata.imageMode || '')
		if (CARDS_PLAY_MODES.includes(playMode) && CARDS_IMAGE_MODES.includes(imageMode)) {
			try {
				data.currentEvaluation = await evaluate_cards_content_gap_async({
					categoryId: String(metadata.categoryId || ''),
					playMode,
					imageMode,
				})
			} catch {
				data.currentEvaluation = null
			}
		}
	}

	return base.respSuccess({ msg: '查询成功', data })
})

// 未读数量：只依据 read_at，不与处理状态混为一谈
routes['get:admin_notification:unread-count'] = requireAdmin(async () => {
	const count = await count_unread_notifications_async()
	return base.respSuccess({ msg: '查询成功', data: { count } })
})

// 批量 / 单条标记已读
routes['post:admin_notification:read'] = requireAdmin(async ({ body }) => {
	const ids = sanitize_ids(body.ids ?? body.id)
	const updated = await mark_notifications_read_async(ids)
	return base.respSuccess({ msg: '已标记已读', data: { updated } })
})

// 全部标记已读
routes['post:admin_notification:read-all'] = requireAdmin(async () => {
	const updated = await mark_all_notifications_read_async()
	return base.respSuccess({ msg: '已全部标记已读', data: { updated } })
})

// 修改处理状态
routes['post:admin_notification:status'] = requireAdmin(async ({ body }) => {
	const id = String(body.id || '').trim()
	if (!id) return base.respFailure({ msg: 'id 参数缺失' })
	const status = sanitize_status_payload(body)
	const row = await set_notification_status_async(id, status)
	if (!row) return base.respFailure({ msg: '通知不存在' })
	return base.respSuccess({ msg: '状态已更新', data: base.formatDbRows([row])[0] })
})

// 读取功能开关
routes['get:admin_notification:setting'] = requireAdmin(async () => {
	const contentGapEnabled = await get_notification_setting_async('content_gap_alert_enabled', false)
	return base.respSuccess({ msg: '查询成功', data: { content_gap_alert_enabled: Boolean(contentGapEnabled) } })
})

// 保存功能开关
routes['post:admin_notification:setting'] = requireAdmin(async ({ body }) => {
	const { key, value } = sanitize_setting_payload(body)
	await set_notification_setting_async(key, value)

	// 开关关闭期间内容可能已被修复，重新开启时做一次全量对账，避免遗留失效的待处理通知
	if (key === 'content_gap_alert_enabled' && value) {
		try {
			await resolve_cards_content_gaps_async({ categoryIds: [], all: true, reason: 'switch_enabled' })
		} catch (error) {
			// 对账失败不影响开关本身保存
			console.error('开启缺口提醒后的自动对账失败:', error.message)
		}
	}

	return base.respSuccess({ msg: value ? '已开启' : '已关闭', data: { [key]: value } })
})

function normalize_metadata(value) {
	if (!value) return {}
	if (typeof value === 'string') {
		try {
			return JSON.parse(value)
		} catch {
			return {}
		}
	}
	return value
}

export default async (req, resp) => {
	base.req = req
	base.resp = resp
	const { method, action, table, query, body } = base.getReqInfo()

	try {
		const handler = routes[`${method}:${table}:${action}`]
		if (!handler) return base.respFailure({ msg: `消息通知模块未知操作: ${method} ${table || ''}/${action || ''}` })
		return await handler({ req, resp, query, body })
	} catch (error) {
		if (error instanceof NotificationPayloadError) return base.respFailure({ msg: error.message })
		console.error('消息通知模块异常:', error)
		return base.respFailure({ msg: '消息通知服务暂时不可用，请稍后重试' })
	}
}
