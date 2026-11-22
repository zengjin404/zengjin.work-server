import base from '#api_util/base.js'
import db from '#api_util/db.js'
import { publish_message_ws } from '#api_util/ws.js'

/**
 * Admin 全局消息通知中心 —— 存储与生命周期
 *
 * 本文件只负责通知本身：建表、原子聚合、状态流转、阅读状态、配置读取。
 * 具体业务（例如 CARDS 内容资格）由 api_util/cards_gap.js 判断，避免把业务规则塞进公共模块。
 *
 * 约束：
 *   1. dedupe_key 全局唯一，同一条通知从创建到解决、再次激活始终复用同一个 id。
 *   2. 重复触发使用 INSERT ... ON CONFLICT DO UPDATE 原子累加，绝不先 SELECT 再 INSERT。
 *   3. 时间统一使用数据库北京时间字面值，不依赖前端传入时间。
 */

const T_NOTIFICATION = 'admin_notification'
const T_SETTING = 'admin_notification_setting'
const T_RATE = 'admin_notification_rate'

const NOW_SQL = `(now() AT TIME ZONE 'Asia/Shanghai')`

let dbInitialized = false

/** 建表 / 索引 / 默认配置（幂等，模块级只执行一次） */
export async function ensure_notification_db_async() {
	if (dbInitialized) return

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${T_NOTIFICATION} (
			id               VARCHAR(24) PRIMARY KEY,
			app_code         VARCHAR(32) NOT NULL,
			category         VARCHAR(32) NOT NULL,
			severity         VARCHAR(16) NOT NULL DEFAULT 'warning',
			title            VARCHAR(128) NOT NULL DEFAULT '',
			content          TEXT NOT NULL DEFAULT '',
			source           VARCHAR(64) DEFAULT '',
			dedupe_key       VARCHAR(255) NOT NULL,
			metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
			status           VARCHAR(16) NOT NULL DEFAULT 'pending',
			read_at          TIMESTAMP,
			first_occurred_at TIMESTAMP NOT NULL DEFAULT ${NOW_SQL},
			last_occurred_at  TIMESTAMP NOT NULL DEFAULT ${NOW_SQL},
			occurrence_count INTEGER NOT NULL DEFAULT 1,
			resolved_at      TIMESTAMP,
			createtime       TIMESTAMP NOT NULL DEFAULT ${NOW_SQL},
			updatetime       TIMESTAMP
		);
	`)
	// dedupe_key 全局唯一：一条问题从首次创建到解决、重新激活始终保留同一个记录 id
	await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_notification_dedupe ON ${T_NOTIFICATION} (dedupe_key)`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_admin_notification_scope ON ${T_NOTIFICATION} (app_code, category, status)`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_admin_notification_status ON ${T_NOTIFICATION} (status, last_occurred_at DESC)`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_admin_notification_read ON ${T_NOTIFICATION} (read_at)`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_admin_notification_time ON ${T_NOTIFICATION} (last_occurred_at DESC)`)

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${T_SETTING} (
			key        VARCHAR(64) PRIMARY KEY,
			value      JSONB NOT NULL DEFAULT '{}'::jsonb,
			updatetime TIMESTAMP
		);
	`)
	// 内容缺口提醒默认关闭：不产生通知，直到管理员在后台显式开启
	await db.query(
		`INSERT INTO ${T_SETTING} (key, value, updatetime) VALUES ('content_gap_alert_enabled', 'false'::jsonb, ${NOW_SQL}) ON CONFLICT (key) DO NOTHING`,
	)

	// 数据库级限频：bucket 含时间窗，主键冲突时原子自增，多实例同样有效
	await db.query(`
		CREATE TABLE IF NOT EXISTS ${T_RATE} (
			scope        VARCHAR(32) NOT NULL,
			bucket       VARCHAR(160) NOT NULL,
			window_start TIMESTAMP NOT NULL DEFAULT ${NOW_SQL},
			count        INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (scope, bucket)
		);
	`)

	// Supabase PostgREST 默认会把 public 表暴露给 anon / authenticated。
	// 这里启用 RLS 且不创建任何策略：匿名与普通登录用户直接读写全部被拒绝；
	// 后端使用服务端数据库连接（表 owner，绕过 RLS），不受影响。
	await db.query(`ALTER TABLE ${T_NOTIFICATION} ENABLE ROW LEVEL SECURITY`)
	await db.query(`ALTER TABLE ${T_SETTING} ENABLE ROW LEVEL SECURITY`)
	await db.query(`ALTER TABLE ${T_RATE} ENABLE ROW LEVEL SECURITY`)

	dbInitialized = true
}

/**
 * 原子创建或聚合通知
 *
 * 状态行为：
 *   - 不存在：创建，次数 1
 *   - 待处理 / 处理中：次数 +1，更新时间，保留原处理状态
 *   - 已解决：重新激活为待处理，清零解决时间，阅读状态重置为未读，保留首次发生时间
 */
export async function upsert_notification_async({ appCode, category, severity = 'warning', title = '', content = '', source = '', dedupeKey, metadata = {} }) {
	const { rows } = await db.query(
		`INSERT INTO ${T_NOTIFICATION}
			(id, app_code, category, severity, title, content, source, dedupe_key, metadata,
			 status, read_at, first_occurred_at, last_occurred_at, occurrence_count, resolved_at, createtime, updatetime)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'pending', NULL, ${NOW_SQL}, ${NOW_SQL}, 1, NULL, ${NOW_SQL}, ${NOW_SQL})
		 ON CONFLICT (dedupe_key) DO UPDATE SET
			severity = EXCLUDED.severity,
			title = EXCLUDED.title,
			content = EXCLUDED.content,
			source = EXCLUDED.source,
			metadata = EXCLUDED.metadata,
			occurrence_count = ${T_NOTIFICATION}.occurrence_count + 1,
			last_occurred_at = ${NOW_SQL},
			status = CASE WHEN ${T_NOTIFICATION}.status = 'resolved' THEN 'pending' ELSE ${T_NOTIFICATION}.status END,
			read_at = CASE WHEN ${T_NOTIFICATION}.status = 'resolved' THEN NULL ELSE ${T_NOTIFICATION}.read_at END,
			resolved_at = CASE WHEN ${T_NOTIFICATION}.status = 'resolved' THEN NULL ELSE ${T_NOTIFICATION}.resolved_at END,
			updatetime = ${NOW_SQL}
		 RETURNING id, status, occurrence_count, read_at, first_occurred_at, last_occurred_at, resolved_at, (xmax = 0) AS created`,
		[base.getId(), appCode, category, severity, title.slice(0, 128), content, source, dedupeKey, JSON.stringify(metadata || {})],
	)

	const row = rows?.[0] || {}
	const result = {
		id: row.id || '',
		status: row.status || 'pending',
		occurrenceCount: Number(row.occurrence_count) || 1,
		created: Boolean(row.created),
	}

	push_notification_ws_async({
		id: result.id,
		appCode,
		category,
		severity,
		title: title.slice(0, 128),
		content,
		occurrenceCount: result.occurrenceCount,
		created: result.created,
	}).catch(() => {})

	return result
}

/** WebSocket 实时推送给管理员 */
export async function push_notification_ws_async(notice) {
	try {
		const payload = {
			app: '$base',
			type: 'admin_notification',
			data: {
				id: notice.id,
				appCode: notice.appCode,
				category: notice.category,
				severity: notice.severity,
				title: notice.title,
				content: notice.content,
				occurrenceCount: notice.occurrenceCount,
				created: notice.created,
				timestamp: Date.now(),
			},
		}

		// 1. 广播到 admin_notification 频道
		await publish_message_ws('admin_notification', payload).catch(err => {
			console.warn('[WS Push] 广播到 admin_notification 失败:', err?.message || err)
		})

		// 2. 推送到管理员个人专属频道 (user_${adminId})：覆盖内置 admin 以及站长 zengjin
		const { rows } = await db.query("SELECT id FROM base_user WHERE username = 'admin' OR username = 'zengjin'")
		for (const u of rows || []) {
			if (u.id) {
				await publish_message_ws(`user_${u.id}`, payload).catch(err => {
					console.warn(`[WS Push] 推送到 user_${u.id} 失败:`, err?.message || err)
				})
			}
		}
	} catch (e) {
		console.error('[notification_ws] 推送异常:', e?.message || e)
	}
}

/** 解决通知后的实时推送 */
export async function push_notification_resolved_ws_async(id) {
	try {
		const payload = {
			app: '$base',
			type: 'admin_notification_resolved',
			data: { id, timestamp: Date.now() },
		}
		await publish_message_ws('admin_notification', payload).catch(() => {})
		const { rows } = await db.query("SELECT id FROM base_user WHERE username = 'admin' OR username = 'zengjin'")
		for (const u of rows || []) {
			if (u.id) {
				await publish_message_ws(`user_${u.id}`, payload).catch(() => {})
			}
		}
	} catch (e) {
		console.error('[notification_ws_resolve] 推送异常:', e?.message || e)
	}
}

/** 自动解决：只更新未解决的通知，重复调用不会反复改写已解决记录 */
export async function resolve_notification_async(id) {
	const { rows } = await db.query(
		`UPDATE ${T_NOTIFICATION}
		 SET status = 'resolved', resolved_at = ${NOW_SQL}, updatetime = ${NOW_SQL}
		 WHERE id = $1 AND status <> 'resolved'
		 RETURNING id`,
		[id],
	)
	if (rows?.length) {
		push_notification_resolved_ws_async(id).catch(() => {})
	}
	return Boolean(rows?.length)
}

/** 读取未解决的业务通知（自动消警使用，只读通知表，不扫描内容表） */
export async function select_open_notifications_async({ appCode, category }) {
	const { rows } = await db.query(
		`SELECT id, dedupe_key, metadata
		 FROM ${T_NOTIFICATION}
		 WHERE app_code = $1 AND category = $2 AND status <> 'resolved'
		 ORDER BY id ASC`,
		[appCode, category],
	)
	return rows || []
}

function read_page(query = {}) {
	const page = Math.max(1, Math.min(100000, Number(query.page ?? query.current) || 1))
	const size = Math.max(1, Math.min(100, Number(query.size ?? query.pageSize) || 20))
	return { page, size, offset: (page - 1) * size }
}

/** 管理端列表查询 */
export async function select_notifications_async(filters = {}, query = {}) {
	const { page, size, offset } = read_page(query)
	const wheres = []
	const binds = []

	if (filters.read === 'unread') wheres.push('read_at IS NULL')
	if (filters.read === 'read') wheres.push('read_at IS NOT NULL')
	if (filters.status) {
		binds.push(filters.status)
		wheres.push(`status = $${binds.length}`)
	}
	if (filters.appCode) {
		binds.push(filters.appCode)
		wheres.push(`app_code = $${binds.length}`)
	}
	if (filters.category) {
		binds.push(filters.category)
		wheres.push(`category = $${binds.length}`)
	}
	if (filters.severity) {
		binds.push(filters.severity)
		wheres.push(`severity = $${binds.length}`)
	}
	if (filters.keyword) {
		binds.push(`%${filters.keyword}%`)
		wheres.push(`(title ILIKE $${binds.length} OR content ILIKE $${binds.length})`)
	}
	if (filters.startTime) {
		binds.push(filters.startTime)
		wheres.push(`last_occurred_at >= $${binds.length}::timestamp`)
	}
	if (filters.endTime) {
		binds.push(filters.endTime)
		wheres.push(`last_occurred_at <= $${binds.length}::timestamp`)
	}

	const whereStr = wheres.length ? `WHERE ${wheres.join(' AND ')}` : ''
	const [listRes, countRes] = await Promise.all([
		db.query(
			`SELECT * FROM ${T_NOTIFICATION}
			 ${whereStr}
			 ORDER BY last_occurred_at DESC NULLS LAST, createtime DESC
			 LIMIT ${size} OFFSET ${offset}`,
			binds,
		),
		db.query(`SELECT COUNT(*) AS total FROM ${T_NOTIFICATION} ${whereStr}`, binds),
	])

	return { rows: listRes.rows || [], total: Number(countRes.rows?.[0]?.total) || 0, page, size }
}

/** 通知详情 */
export async function get_notification_async(id) {
	const { rows } = await db.query(`SELECT * FROM ${T_NOTIFICATION} WHERE id = $1`, [id])
	return rows?.[0] || null
}

/** 未读数量：只依据 read_at，不与处理状态混为一谈 */
export async function count_unread_notifications_async() {
	const { rows } = await db.query(`SELECT COUNT(*) AS total FROM ${T_NOTIFICATION} WHERE read_at IS NULL`)
	return Number(rows?.[0]?.total) || 0
}

/** 批量标记已读（已读记录保持原阅读时间） */
export async function mark_notifications_read_async(ids = []) {
	let updated = 0
	for (const id of ids) {
		const { rows } = await db.query(
			`UPDATE ${T_NOTIFICATION}
			 SET read_at = COALESCE(read_at, ${NOW_SQL}), updatetime = ${NOW_SQL}
			 WHERE id = $1
			 RETURNING id`,
			[id],
		)
		if (rows?.length) updated++
	}
	if (updated > 0) {
		push_notification_resolved_ws_async('read').catch(() => {})
	}
	return updated
}

/** 全部标记已读 */
export async function mark_all_notifications_read_async() {
	const { rowCount } = await db.query(
		`UPDATE ${T_NOTIFICATION}
		 SET read_at = ${NOW_SQL}, updatetime = ${NOW_SQL}
		 WHERE read_at IS NULL`,
	)
	const updated = Number(rowCount) || 0
	if (updated > 0) {
		push_notification_resolved_ws_async('read_all').catch(() => {})
	}
	return updated
}

/** 修改处理状态（阅读状态独立，不受影响） */
export async function set_notification_status_async(id, status) {
	const { rows } = await db.query(
		`UPDATE ${T_NOTIFICATION}
		 SET status = $2::varchar,
		     resolved_at = CASE WHEN $2::varchar = 'resolved' THEN ${NOW_SQL} ELSE NULL END,
		     updatetime = ${NOW_SQL}
		 WHERE id = $1
		 RETURNING id, status, resolved_at`,
		[id, status],
	)
	if (rows?.length && status === 'resolved') {
		push_notification_resolved_ws_async(id).catch(() => {})
	}
	return rows?.[0] || null
}

/** 读取配置；缺失时返回 fallback */
export async function get_notification_setting_async(key, fallback = false) {
	const { rows } = await db.query(`SELECT value FROM ${T_SETTING} WHERE key = $1`, [key])
	if (!rows?.length) return fallback
	const value = rows[0].value
	return value == null ? fallback : value
}

/** 保存配置（布尔值以 JSONB 存储） */
export async function set_notification_setting_async(key, value) {
	await db.query(
		`INSERT INTO ${T_SETTING} (key, value, updatetime)
		 VALUES ($1, $2::jsonb, ${NOW_SQL})
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updatetime = ${NOW_SQL}`,
		[key, JSON.stringify(value)],
	)
	return value
}

/**
 * 数据库级限频（原子自增）
 * @returns {Promise<boolean>} 是否仍在上限内
 */
export async function hit_rate_limit_async(scope, key, max, windowMs = 60000) {
	const bucket = `${key}:${Math.floor(Date.now() / windowMs)}`
	const { rows } = await db.query(
		`INSERT INTO ${T_RATE} (scope, bucket, window_start, count)
		 VALUES ($1, $2, ${NOW_SQL}, 1)
		 ON CONFLICT (scope, bucket) DO UPDATE SET count = ${T_RATE}.count + 1
		 RETURNING count`,
		[scope, bucket],
	)

	// 低概率清理过期窗口，避免限频表无限增长
	if (Math.random() < 0.02) {
		db.query(`DELETE FROM ${T_RATE} WHERE window_start < ${NOW_SQL} - INTERVAL '2 hours'`).catch(() => {})
	}

	return (Number(rows?.[0]?.count) || 0) <= max
}
