import { requireAdmin, requireAuth, verifyAuth } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import {
	CardsPayloadError,
	sanitize_assets,
	sanitize_category_payload,
	sanitize_cognition_settings,
	sanitize_event_payload,
	sanitize_favorite_payload,
	sanitize_int,
	sanitize_item_payload,
	sanitize_play_payload,
	sanitize_progress_payload,
	sanitize_text,
} from '#api_util/cards_schema.js'
import { seed_categories, seed_items } from '#api_util/cards_seed.js'
import db from '#api_util/db.js'

/**
 * 图卡乐园 (cards) 全栈接口
 *
 * 设计要点：
 *   1. 内容读取公开、进度/收藏/对局需要登录；管理接口一律 requireAdmin。
 *   2. 内容版本 (cards_content_version) 是本地缓存是否刷新的唯一依据，
 *      任何管理端写操作都会自增版本。
 *   3. 用户进度以 card_key 为业务主键，SQL 层用 LEAST / GREATEST 做幂等合并，
 *      重复同步不会把记录改成更晚的首次探索或更早的最近探索。
 *   4. 匿名统计只做按天聚合，不保存 IP、UA、儿童身份信息；IP 仅用于内存限频。
 *   5. 时间列统一使用无时区 TIMESTAMP + 北京时间字面值，与 dphxb / seal / jndv 一致。
 */

const T_CATEGORY = 'cards_category'
const T_ITEM = 'cards_item'
const T_ASSET = 'cards_asset'
const T_PROGRESS = 'cards_user_progress'
const T_PLAY = 'cards_play_record'
const T_STATS = 'cards_stats_daily'
const T_VERSION = 'cards_content_version'
const T_SETTING = 'cards_user_setting'

const NOW_SQL = `(now() AT TIME ZONE 'Asia/Shanghai')`
const TODAY_SQL = `(now() AT TIME ZONE 'Asia/Shanghai')::date`

// 限频内存滑窗（serverless 实例内生效，作为防脚本重放的第一道闸）
const rateMap = new Map()
const RATE_WINDOW_SECONDS = 60
const PROGRESS_MAX_PER_MINUTE = 60
const PLAY_MAX_PER_MINUTE = 15
const PLAY_MAX_IP_PER_MINUTE = 20
const STATS_MAX_IP_PER_MINUTE = 30

let dbInitialized = false

function get_req_ip(req) {
	const forwarded = req?.headers?.['x-forwarded-for']
	if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
	return req?.socket?.remoteAddress || req?.ip || 'unknown'
}

function check_rate_limit(scope, key, max) {
	const now = Date.now()
	const mapKey = `${scope}:${key}`
	if (rateMap.size > 5000) {
		for (const [k, item] of rateMap.entries()) {
			if (now - item.time > 10 * 60 * 1000) rateMap.delete(k)
		}
	}
	const record = rateMap.get(mapKey)
	if (!record || now - record.startTime > RATE_WINDOW_SECONDS * 1000) {
		rateMap.set(mapKey, { startTime: now, time: now, count: 1 })
		return true
	}
	record.time = now
	if (record.count >= max) return false
	record.count++
	return true
}

/** 建表 / 索引 / 种子（幂等，模块级只执行一次） */
async function ensure_dbInitialized_async() {
	if (dbInitialized) return

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${T_CATEGORY} (
			id             VARCHAR(20) PRIMARY KEY,
			code           VARCHAR(50) NOT NULL,
			name           VARCHAR(50) NOT NULL,
			parent_id      VARCHAR(20) DEFAULT '',
			description    VARCHAR(255) DEFAULT '',
			icon           VARCHAR(100) DEFAULT '',
			theme_color    VARCHAR(20) DEFAULT '',
			sort_order     INT DEFAULT 0,
			is_enabled     BOOLEAN NOT NULL DEFAULT true,
			publish_status SMALLINT NOT NULL DEFAULT 0,
			createtime     TIMESTAMP NOT NULL DEFAULT ${NOW_SQL},
			updatetime     TIMESTAMP
		);
	`)
	await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_category_code ON ${T_CATEGORY} (code)`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_cards_category_sort ON ${T_CATEGORY} (publish_status, is_enabled, sort_order)`)

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${T_ITEM} (
			id             VARCHAR(20) PRIMARY KEY,
			card_key       VARCHAR(60) NOT NULL,
			category_id    VARCHAR(20) NOT NULL,
			label          VARCHAR(50) NOT NULL,
			pinyin         VARCHAR(100) DEFAULT '',
			en_label       VARCHAR(100) DEFAULT '',
			description    VARCHAR(255) DEFAULT '',
			knowledge      VARCHAR(500) DEFAULT '',
			render_type    VARCHAR(10) NOT NULL DEFAULT 'image',
			render_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
			play_modes     VARCHAR(50) NOT NULL DEFAULT 'recognize,connect,memory',
			sort_order     INT DEFAULT 0,
			is_enabled     BOOLEAN NOT NULL DEFAULT true,
			publish_status SMALLINT NOT NULL DEFAULT 0,
			createtime     TIMESTAMP NOT NULL DEFAULT ${NOW_SQL},
			updatetime     TIMESTAMP
		);
	`)
	await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_item_key ON ${T_ITEM} (card_key)`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_cards_item_category ON ${T_ITEM} (category_id, sort_order)`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_cards_item_publish ON ${T_ITEM} (publish_status, is_enabled)`)

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${T_ASSET} (
			id          VARCHAR(20) PRIMARY KEY,
			card_id     VARCHAR(20) NOT NULL,
			asset_type  VARCHAR(20) NOT NULL,
			asset_url   VARCHAR(500) NOT NULL,
			mime_type   VARCHAR(100) DEFAULT '',
			sort_order  INT DEFAULT 0,
			is_primary  BOOLEAN NOT NULL DEFAULT false,
			is_enabled  BOOLEAN NOT NULL DEFAULT true,
			is_random   BOOLEAN NOT NULL DEFAULT true,
			metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
			createtime  TIMESTAMP NOT NULL DEFAULT ${NOW_SQL}
		);
	`)
	await db.query(`ALTER TABLE ${T_ASSET} ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false`)
	await db.query(`ALTER TABLE ${T_ASSET} ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT true`)
	await db.query(`ALTER TABLE ${T_ASSET} ADD COLUMN IF NOT EXISTS is_random BOOLEAN NOT NULL DEFAULT true`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_cards_asset_card ON ${T_ASSET} (card_id, asset_type, sort_order)`)
	// 历史数据可能在同一卡片上存在多条 is_primary；先按 (sort_order, id) 保留第一条，避免唯一索引创建失败
	await db.query(`
		UPDATE ${T_ASSET} a SET is_primary = false
		WHERE a.is_primary = true
		  AND EXISTS (
			SELECT 1 FROM ${T_ASSET} b
			WHERE b.card_id = a.card_id AND b.is_primary = true
			  AND (b.sort_order, b.id) < (a.sort_order, a.id)
		  )
	`)
	// 同一张卡片最多一个主图：服务端白名单之外再加一层数据库约束
	await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_asset_primary ON ${T_ASSET} (card_id) WHERE is_primary`)

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${T_PROGRESS} (
			id               VARCHAR(20) PRIMARY KEY,
			user_id          VARCHAR(40) NOT NULL,
			card_key         VARCHAR(60) NOT NULL,
			explored_at      TIMESTAMP,
			last_explored_at TIMESTAMP,
			favorite_at      TIMESTAMP,
			createtime       TIMESTAMP NOT NULL DEFAULT ${NOW_SQL},
			updatetime       TIMESTAMP
		);
	`)
	await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_progress_user_card ON ${T_PROGRESS} (user_id, card_key)`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_cards_progress_user_time ON ${T_PROGRESS} (user_id, last_explored_at DESC)`)

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${T_PLAY} (
			id              VARCHAR(20) PRIMARY KEY,
			request_id      VARCHAR(64) NOT NULL,
			user_id         VARCHAR(40),
			play_mode       VARCHAR(20) NOT NULL,
			category_id     VARCHAR(20) DEFAULT '',
			difficulty      VARCHAR(20) DEFAULT '',
			total_pairs     INT NOT NULL DEFAULT 0,
			completed_pairs INT NOT NULL DEFAULT 0,
			duration        INT NOT NULL DEFAULT 0,
			result          VARCHAR(20) NOT NULL DEFAULT 'completed',
			createtime      TIMESTAMP NOT NULL DEFAULT ${NOW_SQL}
		);
	`)
	await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_play_request ON ${T_PLAY} (request_id)`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_cards_play_user ON ${T_PLAY} (user_id, createtime DESC)`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_cards_play_mode ON ${T_PLAY} (play_mode, createtime DESC)`)

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${T_STATS} (
			stat_date  DATE NOT NULL,
			event_type VARCHAR(30) NOT NULL,
			object_id  VARCHAR(60) NOT NULL DEFAULT '',
			count      INT NOT NULL DEFAULT 0,
			updatetime TIMESTAMP,
			PRIMARY KEY (stat_date, event_type, object_id)
		);
	`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_cards_stats_type ON ${T_STATS} (event_type, stat_date DESC)`)

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${T_SETTING} (
			user_id    VARCHAR(40) PRIMARY KEY,
			settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
			createtime TIMESTAMP NOT NULL DEFAULT ${NOW_SQL},
			updatetime TIMESTAMP
		);
	`)

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${T_VERSION} (
			id               VARCHAR(20) PRIMARY KEY,
			version          BIGINT NOT NULL DEFAULT 1,
			category_version BIGINT NOT NULL DEFAULT 1,
			item_version     BIGINT NOT NULL DEFAULT 1,
			asset_version    BIGINT NOT NULL DEFAULT 1,
			seed_version     INT NOT NULL DEFAULT 0,
			updatetime       TIMESTAMP
		);
	`)
	await db.query(`ALTER TABLE ${T_VERSION} ADD COLUMN IF NOT EXISTS seed_version INT NOT NULL DEFAULT 0`)
	await db.query(
		`INSERT INTO ${T_VERSION} (id, version, category_version, item_version, asset_version, seed_version) VALUES ('cards', 1, 1, 1, 1, 0) ON CONFLICT (id) DO NOTHING`,
	)

	// 种子只执行一次（seed_version 标记）：
	//   - 中途失败时 seed_version 仍为 0，下次请求继续用 ON CONFLICT DO NOTHING 自愈；
	//   - 完成后管理员删掉的分类 / 卡片不会被「数量不足」逻辑自动复活。
	const seedRes = await db.query(`SELECT seed_version FROM ${T_VERSION} WHERE id = 'cards'`)
	const seedVersion = Number(seedRes.rows?.[0]?.seed_version) || 0
	if (seedVersion < 1) {
		for (const category of seed_categories) {
			await db.query(
				`INSERT INTO ${T_CATEGORY}
					(id, code, name, parent_id, description, icon, theme_color, sort_order, is_enabled, publish_status, createtime)
				 VALUES ($1, $2, $3, '', $4, $5, $6, $7, true, 1, ${NOW_SQL})
				 ON CONFLICT DO NOTHING`,
				[category.id, category.code, category.name, category.description, category.icon, category.theme_color, category.sort_order],
			)
		}

		// 分类 id 以数据库中的 code 映射为准，兼容管理员先手工建过同 code 分类的情况
		const catRows = await db.query(`SELECT id, code FROM ${T_CATEGORY}`)
		const catMap = new Map((catRows.rows || []).map(row => [row.code, row.id]))
		for (const item of seed_items) {
			const categoryId = catMap.get(item.category_code) || item.category_code
			await db.query(
				`INSERT INTO ${T_ITEM}
					(id, card_key, category_id, label, pinyin, en_label, description, knowledge,
					 render_type, render_config, play_modes, sort_order, is_enabled, publish_status, createtime)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, true, 1, ${NOW_SQL})
				 ON CONFLICT DO NOTHING`,
				[
					item.id,
					item.card_key,
					categoryId,
					item.label,
					item.pinyin,
					item.en_label,
					item.description,
					item.knowledge,
					item.render_type,
					JSON.stringify(item.render_config),
					item.play_modes,
					item.sort_order,
				],
			)
		}

		await db.query(`UPDATE ${T_VERSION} SET seed_version = 1, updatetime = ${NOW_SQL} WHERE id = 'cards'`)
	}

	dbInitialized = true
}

/** 读取当前内容版本 */
async function read_version_async() {
	const { rows } = await db.query(`SELECT version, category_version, item_version, asset_version FROM ${T_VERSION} WHERE id = 'cards'`)
	return rows?.[0] || { version: 1, category_version: 1, item_version: 1, asset_version: 1 }
}

/** 内容变更后自增版本（可一次标记多个维度，例如卡片 + 素材） */
async function bump_version_async(kind = 'item') {
	const kinds = Array.isArray(kind) ? kind : [kind]
	const columns = [...new Set(kinds.map(item => (item === 'category' ? 'category_version' : item === 'asset' ? 'asset_version' : 'item_version')))]
	const increments = columns.map(column => `${column} = ${column} + 1`).join(', ')
	await db.query(`UPDATE ${T_VERSION} SET version = version + 1, ${increments}, updatetime = ${NOW_SQL} WHERE id = 'cards'`)
}

/** 读取某用户的全部进度 */
async function read_progress_async(userId) {
	const { rows } = await db.query(
		`SELECT card_key, explored_at, last_explored_at, favorite_at
		 FROM ${T_PROGRESS}
		 WHERE user_id = $1
		 ORDER BY last_explored_at DESC NULLS LAST, createtime DESC`,
		[userId],
	)
	return base.formatDbRows(rows || []).map(row => ({
		cardKey: row.card_key,
		exploredAt: row.explored_at || '',
		lastExploredAt: row.last_explored_at || '',
		favoriteAt: row.favorite_at || '',
	}))
}

/** 分页参数（管理端表格） */
function read_page(query = {}) {
	const page = Math.max(1, sanitize_int(query.page ?? query.current, { min: 1, max: 100000, fallback: 1, field: '页码' }))
	const size = Math.min(100, Math.max(1, sanitize_int(query.size ?? query.pageSize, { min: 1, max: 100, fallback: 20, field: '每页条数' })))
	return { page, size, offset: (page - 1) * size }
}

const routes = {}

/* ==========================================================================
 * 公开内容接口
 * ========================================================================== */

// GET /api/cards/content/bootstrap
routes['get:cards_content:bootstrap'] = async ({ query }) => {
	const versionInfo = await read_version_async()
	const version = Number(versionInfo.version) || 1
	if (query.version && Number(query.version) === version) {
		return base.respSuccess({ msg: '内容已是最新', data: { version, unchanged: true } })
	}

	const [categoryRes, itemRes, assetRes] = await Promise.all([
		db.query(
			`SELECT c.id, c.code, c.name, c.parent_id, c.description, c.icon, c.theme_color, c.sort_order,
			        (SELECT COUNT(*) FROM ${T_ITEM} i
			          WHERE i.category_id = c.id AND i.publish_status = 1 AND i.is_enabled = true) AS item_count
			 FROM ${T_CATEGORY} c
			 WHERE c.publish_status = 1 AND c.is_enabled = true
			 ORDER BY c.sort_order ASC, c.createtime ASC`,
		),
		db.query(
			`SELECT i.id, i.card_key, i.category_id, c.code AS category_code, i.label, i.pinyin, i.en_label,
			        i.description, i.knowledge, i.render_type, i.render_config, i.play_modes, i.sort_order
			 FROM ${T_ITEM} i
			 JOIN ${T_CATEGORY} c ON c.id = i.category_id
			 WHERE i.publish_status = 1 AND i.is_enabled = true AND c.publish_status = 1 AND c.is_enabled = true
			 ORDER BY c.sort_order ASC, i.sort_order ASC, i.createtime ASC`,
		),
		db.query(
			`SELECT a.id, a.card_id, i.card_key, a.asset_type, a.asset_url, a.mime_type, a.sort_order,
			        COALESCE(a.is_primary, (a.metadata->>'is_primary')::boolean, false) AS is_primary,
			        COALESCE(a.is_enabled, (a.metadata->>'is_enabled')::boolean, true) AS is_enabled,
			        COALESCE(a.is_random, (a.metadata->>'is_random')::boolean, true) AS is_random,
			        a.metadata
			 FROM ${T_ASSET} a
			 JOIN ${T_ITEM} i ON i.id = a.card_id
			 JOIN ${T_CATEGORY} c ON c.id = i.category_id
			 WHERE i.publish_status = 1 AND i.is_enabled = true AND c.publish_status = 1 AND c.is_enabled = true
			   AND (a.is_enabled IS NOT FALSE)
			 ORDER BY a.sort_order ASC, a.createtime ASC`,
		),
	])

	return base.respSuccess({
		msg: '查询成功',
		data: {
			version,
			unchanged: false,
			categories: base.formatDbRows(categoryRes.rows || []),
			items: base.formatDbRows(itemRes.rows || []),
			assets: base.formatDbRows(assetRes.rows || []),
			serverTime: base.getTime(),
		},
	})
}

// GET /api/cards/content/version
routes['get:cards_content:version'] = async () => {
	const versionInfo = await read_version_async()
	return base.respSuccess({ msg: '查询成功', data: { version: Number(versionInfo.version) || 1 } })
}

/* ==========================================================================
 * 用户进度（必须登录）
 * ========================================================================== */

// POST /api/cards/progress/sync
routes['post:cards_progress:sync'] = requireAuth(async ({ req, body }) => {
	const userId = req.user?.userId
	if (!userId) return base.respFailure({ msg: '认证信息异常，请重新登录' })
	if (!check_rate_limit('progress', userId, PROGRESS_MAX_PER_MINUTE)) {
		return base.respFailure({ msg: '进度同步过于频繁，请稍后再试' })
	}

	const items = sanitize_progress_payload(body)

	for (const item of items) {
		await db.query(
			`INSERT INTO ${T_PROGRESS} (id, user_id, card_key, explored_at, last_explored_at, createtime, updatetime)
			 VALUES ($1, $2, $3, $4::timestamp, $5::timestamp, ${NOW_SQL}, ${NOW_SQL})
			 ON CONFLICT (user_id, card_key) DO UPDATE SET
				explored_at = LEAST(${T_PROGRESS}.explored_at, EXCLUDED.explored_at),
				last_explored_at = GREATEST(${T_PROGRESS}.last_explored_at, EXCLUDED.last_explored_at),
				updatetime = ${NOW_SQL}`,
			[base.getId(), userId, item.cardKey, item.exploredAt, item.lastExploredAt],
		)
	}

	const merged = await read_progress_async(userId)
	return base.respSuccess({ msg: '同步成功', data: { items: merged, serverTime: base.getTime() } })
})

// GET /api/cards/progress/list
routes['get:cards_progress:list'] = requireAuth(async ({ req }) => {
	const userId = req.user?.userId
	const items = await read_progress_async(userId)
	return base.respSuccess({ msg: '查询成功', data: { items } })
})

// POST /api/cards/progress/favorite
routes['post:cards_progress:favorite'] = requireAuth(async ({ req, body }) => {
	const userId = req.user?.userId
	const { cardKey, favorite } = sanitize_favorite_payload(body)
	await db.query(
		`INSERT INTO ${T_PROGRESS} (id, user_id, card_key, favorite_at, createtime, updatetime)
		 VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN ${NOW_SQL} ELSE NULL END, ${NOW_SQL}, ${NOW_SQL})
		 ON CONFLICT (user_id, card_key) DO UPDATE SET
			favorite_at = CASE WHEN $4::boolean THEN ${NOW_SQL} ELSE NULL END,
			updatetime = ${NOW_SQL}`,
		[base.getId(), userId, cardKey, favorite],
	)
	return base.respSuccess({ msg: favorite ? '已收藏' : '已取消收藏', data: { cardKey, favorite } })
})

/* ==========================================================================
 * 用户认知设置（必须登录；独立表，不混入进度）
 * ========================================================================== */

// GET /api/cards/settings/get
routes['get:cards_settings:get'] = requireAuth(async ({ req }) => {
	const userId = req.user?.userId
	if (!userId) return base.respFailure({ msg: '认证信息异常，请重新登录' })
	const { rows } = await db.query(`SELECT settings FROM ${T_SETTING} WHERE user_id = $1`, [userId])
	return base.respSuccess({ msg: '查询成功', data: { settings: rows?.[0]?.settings || null } })
})

// POST /api/cards/settings/save
routes['post:cards_settings:save'] = requireAuth(async ({ req, body }) => {
	const userId = req.user?.userId
	if (!userId) return base.respFailure({ msg: '认证信息异常，请重新登录' })
	if (!check_rate_limit('settings', userId, 30)) return base.respFailure({ msg: '设置保存过于频繁，请稍后再试' })

	const settings = sanitize_cognition_settings(body.settings ?? body)
	await db.query(
		`INSERT INTO ${T_SETTING} (user_id, settings, createtime, updatetime)
		 VALUES ($1, $2::jsonb, ${NOW_SQL}, ${NOW_SQL})
		 ON CONFLICT (user_id) DO UPDATE SET
			settings = EXCLUDED.settings,
			updatetime = ${NOW_SQL}`,
		[userId, JSON.stringify(settings)],
	)
	return base.respSuccess({ msg: '设置已保存', data: { settings } })
})

/* ==========================================================================
 * 对局记录与匿名统计
 * ========================================================================== */

// POST /api/cards/play/finish
routes['post:cards_play:finish'] = async ({ req, body }) => {
	const payload = sanitize_play_payload(body)
	const user = await verifyAuth(req)
	const userId = user?.userId || null

	if (userId) {
		if (!check_rate_limit('play-user', userId, PLAY_MAX_PER_MINUTE)) return base.respFailure({ msg: '对局上报过于频繁，请稍后再试' })
	} else if (!check_rate_limit('play-ip', get_req_ip(req), PLAY_MAX_IP_PER_MINUTE)) {
		return base.respFailure({ msg: '对局上报过于频繁，请稍后再试' })
	}

	// 游客不落个人对局明细，只进匿名聚合，避免无意收集儿童行为链路
	if (userId) {
		const { rows } = await db.query(
			`INSERT INTO ${T_PLAY}
				(id, request_id, user_id, play_mode, category_id, difficulty, total_pairs, completed_pairs, duration, result, createtime)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${NOW_SQL})
			 ON CONFLICT (request_id) DO NOTHING
			 RETURNING id`,
			[
				base.getId(),
				payload.requestId,
				userId,
				payload.mode,
				payload.categoryId,
				payload.difficulty,
				payload.totalPairs,
				payload.completedPairs,
				payload.duration,
				payload.result,
			],
		)
		if (!rows?.length) return base.respSuccess({ msg: '对局记录已存在', data: { repeated: true } })
	}

	await upsert_stats_async([{ type: 'game_finish', objectId: payload.mode }])
	return base.respSuccess({ msg: '对局记录保存成功', data: { repeated: false } })
}

// POST /api/cards/stats/event
routes['post:cards_stats:event'] = async ({ req, body }) => {
	const events = sanitize_event_payload(body)
	if (!check_rate_limit('stats-ip', get_req_ip(req), STATS_MAX_IP_PER_MINUTE)) {
		return base.respFailure({ msg: '统计上报过于频繁，请稍后再试' })
	}
	await upsert_stats_async(events)
	return base.respSuccess({ msg: '已记录', data: { count: events.length } })
}

/** 批量聚合统计：同一请求内的重复事件合并成一次 upsert */
async function upsert_stats_async(events) {
	const agg = new Map()
	for (const event of events) {
		const key = `${event.type}|${event.objectId}`
		agg.set(key, (agg.get(key) || 0) + 1)
	}
	for (const [key, count] of agg.entries()) {
		const [type, objectId] = key.split('|')
		await db.query(
			`INSERT INTO ${T_STATS} (stat_date, event_type, object_id, count, updatetime)
			 VALUES (${TODAY_SQL}, $1, $2, $3, ${NOW_SQL})
			 ON CONFLICT (stat_date, event_type, object_id) DO UPDATE SET
				count = ${T_STATS}.count + EXCLUDED.count,
				updatetime = ${NOW_SQL}`,
			[type, objectId, count],
		)
	}
}

/* ==========================================================================
 * 管理端：分类
 * ========================================================================== */

// GET /api/cards/admin/category/select
routes['get:cards_admin_category:select'] = requireAdmin(async ({ query }) => {
	const { page, size, offset } = read_page(query)
	const keyword = sanitize_text(query.keyword ?? query.name ?? query.code, 50, '关键词')
	const wheres = []
	const binds = []
	if (keyword) {
		binds.push(`%${keyword}%`)
		wheres.push(`(c.name ILIKE $${binds.length} OR c.code ILIKE $${binds.length})`)
	}
	const whereStr = wheres.length ? `WHERE ${wheres.join(' AND ')}` : ''

	const [listRes, countRes] = await Promise.all([
		db.query(
			`SELECT c.*,
			        (SELECT COUNT(*) FROM ${T_ITEM} i WHERE i.category_id = c.id) AS item_count
			 FROM ${T_CATEGORY} c ${whereStr}
			 ORDER BY c.sort_order ASC, c.createtime ASC
			 LIMIT ${size} OFFSET ${offset}`,
			binds,
		),
		db.query(`SELECT COUNT(*) AS total FROM ${T_CATEGORY} c ${whereStr}`, binds),
	])

	return base.respSuccess({
		msg: '查询成功',
		total: Number(countRes.rows?.[0]?.total) || 0,
		data: base.formatDbRows(listRes.rows || []),
	})
})

// GET /api/cards/admin/category/detail
routes['get:cards_admin_category:detail'] = requireAdmin(async ({ query }) => {
	const id = sanitize_text(query.id, 20, '分类 id')
	if (!id) return base.respFailure({ msg: 'id 参数缺失' })
	const { rows } = await db.query(
		`SELECT c.*,
		        (SELECT COUNT(*) FROM ${T_ITEM} i WHERE i.category_id = c.id) AS item_count
		 FROM ${T_CATEGORY} c WHERE c.id = $1`,
		[id],
	)
	return base.respSuccess({ msg: '查询成功', data: base.formatDbRows(rows || [])[0] || {} })
})

// POST /api/cards/admin/category/insert
routes['post:cards_admin_category:insert'] = requireAdmin(async ({ body }) => {
	const payload = sanitize_category_payload(body)
	if (payload.parent_id) {
		const parentRes = await db.query(`SELECT id FROM ${T_CATEGORY} WHERE id = $1`, [payload.parent_id])
		if (!parentRes.rows?.length) return base.respFailure({ msg: '父级分类不存在' })
	}

	const id = base.getId()
	try {
		await db.query(
			`INSERT INTO ${T_CATEGORY}
				(id, code, name, parent_id, description, icon, theme_color, sort_order, is_enabled, publish_status, createtime)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${NOW_SQL})`,
			[
				id,
				payload.code,
				payload.name,
				payload.parent_id,
				payload.description,
				payload.icon,
				payload.theme_color,
				payload.sort_order,
				payload.is_enabled,
				payload.publish_status,
			],
		)
	} catch (error) {
		if (String(error.message).includes('duplicate key')) return base.respFailure({ msg: '分类编码已存在' })
		throw error
	}
	await bump_version_async('category')
	return base.respSuccess({ msg: '新增成功', data: id })
})

// POST /api/cards/admin/category/update
routes['post:cards_admin_category:update'] = requireAdmin(async ({ body }) => {
	const id = sanitize_text(body.id, 20, '分类 id')
	if (!id) return base.respFailure({ msg: 'id 参数缺失' })
	const payload = sanitize_category_payload(body, { partial: true })
	const fields = Object.keys(payload)
	if (!fields.length) return base.respFailure({ msg: '没有可更新的字段' })

	if (payload.parent_id) {
		if (payload.parent_id === id) return base.respFailure({ msg: '父级分类不能是自己' })
		const parentRes = await db.query(`SELECT id FROM ${T_CATEGORY} WHERE id = $1`, [payload.parent_id])
		if (!parentRes.rows?.length) return base.respFailure({ msg: '父级分类不存在' })
	}

	const updates = fields.map((field, index) => `${field} = $${index + 1}`)
	const binds = fields.map(field => payload[field])
	binds.push(base.getTime())
	updates.push(`updatetime = $${binds.length}`)
	binds.push(id)

	try {
		await db.query(`UPDATE ${T_CATEGORY} SET ${updates.join(', ')} WHERE id = $${binds.length}`, binds)
	} catch (error) {
		if (String(error.message).includes('duplicate key')) return base.respFailure({ msg: '分类编码已存在' })
		throw error
	}
	await bump_version_async('category')
	return base.respSuccess({ msg: '编辑成功', data: id })
})

// POST /api/cards/admin/category/delete
routes['post:cards_admin_category:delete'] = requireAdmin(async ({ body }) => {
	const id = sanitize_text(body.id, 20, '分类 id')
	if (!id) return base.respFailure({ msg: 'id 参数缺失' })

	const itemRes = await db.query(`SELECT COUNT(*) AS total FROM ${T_ITEM} WHERE category_id = $1`, [id])
	if ((Number(itemRes.rows?.[0]?.total) || 0) > 0) {
		return base.respFailure({ msg: '该分类下还有卡片，请先移动或删除卡片' })
	}
	const childRes = await db.query(`SELECT COUNT(*) AS total FROM ${T_CATEGORY} WHERE parent_id = $1`, [id])
	if ((Number(childRes.rows?.[0]?.total) || 0) > 0) {
		return base.respFailure({ msg: '该分类下还有子分类，请先处理子分类' })
	}

	await db.query(`DELETE FROM ${T_CATEGORY} WHERE id = $1`, [id])
	await bump_version_async('category')
	return base.respSuccess({ msg: '删除成功', data: id })
})

/* ==========================================================================
 * 管理端：卡片与素材
 * ========================================================================== */

// GET /api/cards/admin/item/select
routes['get:cards_admin_item:select'] = requireAdmin(async ({ query }) => {
	const { page, size, offset } = read_page(query)
	const keyword = sanitize_text(query.keyword ?? query.label, 50, '关键词')
	const categoryId = sanitize_text(query.category_id, 20, '分类')
	const publishStatus = query.publish_status
	const enabled = query.is_enabled

	const wheres = []
	const binds = []
	if (keyword) {
		binds.push(`%${keyword}%`)
		wheres.push(`(i.label ILIKE $${binds.length} OR i.card_key ILIKE $${binds.length} OR i.pinyin ILIKE $${binds.length})`)
	}
	if (categoryId) {
		binds.push(categoryId)
		wheres.push(`i.category_id = $${binds.length}`)
	}
	if (publishStatus !== undefined && publishStatus !== '') {
		binds.push(Number(publishStatus))
		wheres.push(`i.publish_status = $${binds.length}`)
	}
	if (enabled !== undefined && enabled !== '') {
		binds.push(String(enabled) === 'true' || String(enabled) === '1')
		wheres.push(`i.is_enabled = $${binds.length}`)
	}
	const whereStr = wheres.length ? `WHERE ${wheres.join(' AND ')}` : ''

	const [listRes, countRes] = await Promise.all([
		db.query(
			`SELECT i.*, c.name AS category_name, c.code AS category_code, c.sort_order AS category_sort
			 FROM ${T_ITEM} i
			 LEFT JOIN ${T_CATEGORY} c ON c.id = i.category_id
			 ${whereStr}
			 ORDER BY c.sort_order ASC NULLS LAST, i.sort_order ASC, i.createtime ASC
			 LIMIT ${size} OFFSET ${offset}`,
			binds,
		),
		db.query(`SELECT COUNT(*) AS total FROM ${T_ITEM} i ${whereStr}`, binds),
	])

	return base.respSuccess({
		msg: '查询成功',
		total: Number(countRes.rows?.[0]?.total) || 0,
		data: base.formatDbRows(listRes.rows || []),
	})
})

// GET /api/cards/admin/item/detail
routes['get:cards_admin_item:detail'] = requireAdmin(async ({ query }) => {
	const id = sanitize_text(query.id, 20, '卡片 id')
	if (!id) return base.respFailure({ msg: 'id 参数缺失' })
	const [itemRes, assetRes] = await Promise.all([
		db.query(
			`SELECT i.*, c.name AS category_name, c.code AS category_code
			 FROM ${T_ITEM} i LEFT JOIN ${T_CATEGORY} c ON c.id = i.category_id
			 WHERE i.id = $1`,
			[id],
		),
		db.query(
			`SELECT id, asset_type, asset_url, mime_type, sort_order,
			        COALESCE(is_primary, (metadata->>'is_primary')::boolean, false) AS is_primary,
			        COALESCE(is_enabled, (metadata->>'is_enabled')::boolean, true) AS is_enabled,
			        COALESCE(is_random, (metadata->>'is_random')::boolean, true) AS is_random,
			        metadata
			 FROM ${T_ASSET} WHERE card_id = $1
			 ORDER BY asset_type ASC, sort_order ASC`,
			[id],
		),
	])
	const data = base.formatDbRows(itemRes.rows || [])[0] || {}
	if (data.id) data.assets = base.formatDbRows(assetRes.rows || [])
	return base.respSuccess({ msg: '查询成功', data })
})

// POST /api/cards/admin/item/insert
routes['post:cards_admin_item:insert'] = requireAdmin(async ({ body }) => {
	const payload = sanitize_item_payload(body)
	const assets = sanitize_assets(body.assets)
	await assert_category_exists(payload.category_id)

	const id = base.getId()
	try {
		await db.query(
			`INSERT INTO ${T_ITEM}
				(id, card_key, category_id, label, pinyin, en_label, description, knowledge,
				 render_type, render_config, play_modes, sort_order, is_enabled, publish_status, createtime)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, ${NOW_SQL})`,
			[
				id,
				payload.card_key,
				payload.category_id,
				payload.label,
				payload.pinyin,
				payload.en_label,
				payload.description,
				payload.knowledge,
				payload.render_type,
				JSON.stringify(payload.render_config),
				payload.play_modes,
				payload.sort_order,
				payload.is_enabled,
				payload.publish_status,
			],
		)
	} catch (error) {
		if (String(error.message).includes('duplicate key')) return base.respFailure({ msg: '卡片标识已存在，请换一个 card_key' })
		throw error
	}

	if (assets?.length) await insert_assets_async(id, assets)
	await bump_version_async(assets?.length ? ['item', 'asset'] : 'item')
	return base.respSuccess({ msg: '新增成功', data: id })
})

// POST /api/cards/admin/item/update
routes['post:cards_admin_item:update'] = requireAdmin(async ({ body }) => {
	const id = sanitize_text(body.id, 20, '卡片 id')
	if (!id) return base.respFailure({ msg: 'id 参数缺失' })
	const payload = sanitize_item_payload(body, { partial: true })
	const assets = sanitize_assets(body.assets)
	if (payload.category_id) await assert_category_exists(payload.category_id)

	const fields = Object.keys(payload)
	const updates = []
	const binds = []
	for (const field of fields) {
		binds.push(payload[field])
		updates.push(field === 'render_config' ? `${field} = $${binds.length}::jsonb` : `${field} = $${binds.length}`)
	}
	if (updates.length) {
		binds.push(base.getTime())
		updates.push(`updatetime = $${binds.length}`)
		binds.push(id)
		try {
			await db.query(`UPDATE ${T_ITEM} SET ${updates.join(', ')} WHERE id = $${binds.length}`, binds)
		} catch (error) {
			if (String(error.message).includes('duplicate key')) return base.respFailure({ msg: '卡片标识已存在，请换一个 card_key' })
			throw error
		}
	}

	if (assets) {
		await db.query(`DELETE FROM ${T_ASSET} WHERE card_id = $1`, [id])
		if (assets.length) await insert_assets_async(id, assets)
	}

	if (!updates.length && !assets) return base.respFailure({ msg: '没有可更新的字段' })
	await bump_version_async(assets ? ['item', 'asset'] : 'item')
	return base.respSuccess({ msg: '编辑成功', data: id })
})

// POST /api/cards/admin/item/delete
routes['post:cards_admin_item:delete'] = requireAdmin(async ({ body }) => {
	const id = sanitize_text(body.id, 20, '卡片 id')
	if (!id) return base.respFailure({ msg: 'id 参数缺失' })
	// 用户进度按 card_key 保存，卡片删除不会连带删除历史进度
	await db.query(`DELETE FROM ${T_ASSET} WHERE card_id = $1`, [id])
	await db.query(`DELETE FROM ${T_ITEM} WHERE id = $1`, [id])
	await bump_version_async('item')
	return base.respSuccess({ msg: '删除成功', data: id })
})

// POST /api/cards/admin/item/duplicate
routes['post:cards_admin_item:duplicate'] = requireAdmin(async ({ body }) => {
	const id = sanitize_text(body.id, 20, '卡片 id')
	if (!id) return base.respFailure({ msg: 'id 参数缺失' })

	const itemRes = await db.query(`SELECT * FROM ${T_ITEM} WHERE id = $1`, [id])
	const source = itemRes.rows?.[0]
	if (!source) return base.respFailure({ msg: '原卡片不存在' })

	const newId = base.getId()
	const suffix = base.getId().slice(-4)
	const cardKey = `${String(source.card_key).slice(0, 54)}_${suffix}`

	try {
		await db.query(
			`INSERT INTO ${T_ITEM}
				(id, card_key, category_id, label, pinyin, en_label, description, knowledge,
				 render_type, render_config, play_modes, sort_order, is_enabled, publish_status, createtime)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, false, 0, ${NOW_SQL})`,
			[
				newId,
				cardKey,
				source.category_id,
				`${source.label}（副本）`.slice(0, 50),
				source.pinyin,
				source.en_label,
				source.description,
				source.knowledge,
				source.render_type,
				typeof source.render_config === 'string' ? source.render_config : JSON.stringify(source.render_config || {}),
				source.play_modes,
				(source.sort_order || 0) + 1,
			],
		)
	} catch (error) {
		if (String(error.message).includes('duplicate key')) return base.respFailure({ msg: '复制失败：卡片标识冲突，请重试' })
		throw error
	}

	// 复制素材关联（不复制二进制）
	const assetRes = await db.query(
		`SELECT asset_type, asset_url, mime_type, sort_order,
		        COALESCE(is_primary, (metadata->>'is_primary')::boolean, false) AS is_primary,
		        COALESCE(is_enabled, (metadata->>'is_enabled')::boolean, true) AS is_enabled,
		        COALESCE(is_random, (metadata->>'is_random')::boolean, true) AS is_random,
		        metadata
		 FROM ${T_ASSET} WHERE card_id = $1`,
		[id],
	)
	for (const asset of assetRes.rows || []) {
		await db.query(
			`INSERT INTO ${T_ASSET} (id, card_id, asset_type, asset_url, mime_type, sort_order, is_primary, is_enabled, is_random, metadata, createtime)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, ${NOW_SQL})`,
			[
				base.getId(),
				newId,
				asset.asset_type,
				asset.asset_url,
				asset.mime_type,
				asset.sort_order,
				Boolean(asset.is_primary),
				asset.is_enabled !== false,
				asset.is_random !== false,
				typeof asset.metadata === 'string' ? asset.metadata : JSON.stringify(asset.metadata || {}),
			],
		)
	}

	await bump_version_async('item')
	return base.respSuccess({ msg: '复制成功，副本为草稿状态', data: newId })
})

async function assert_category_exists(categoryId) {
	const { rows } = await db.query(`SELECT id FROM ${T_CATEGORY} WHERE id = $1`, [categoryId])
	if (!rows?.length) throw new CardsPayloadError('所属分类不存在')
}

async function insert_assets_async(cardId, assets) {
	for (const asset of assets) {
		const assetId = asset.id || base.getId()
		await db.query(
			`INSERT INTO ${T_ASSET} (id, card_id, asset_type, asset_url, mime_type, sort_order, is_primary, is_enabled, is_random, metadata, createtime)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, ${NOW_SQL})`,
			[
				assetId,
				cardId,
				asset.asset_type,
				asset.asset_url,
				asset.mime_type,
				asset.sort_order,
				Boolean(asset.is_primary),
				asset.is_enabled !== false,
				asset.is_random !== false,
				JSON.stringify(asset.metadata || {}),
			],
		)
	}
}

/* ==========================================================================
 * 管理端：统计
 * ========================================================================== */

// GET /api/cards/admin/stats/overview
routes['get:cards_admin_stats:overview'] = requireAdmin(async () => {
	const [contentRes, statsRes, dailyRes, playRes, objectRes] = await Promise.all([
		db.query(
			`SELECT
				(SELECT COUNT(*) FROM ${T_CATEGORY}) AS category_count,
				(SELECT COUNT(*) FROM ${T_ITEM}) AS item_count,
				(SELECT COUNT(*) FROM ${T_ITEM} WHERE publish_status = 1 AND is_enabled = true) AS published_item_count`,
		),
		db.query(
			`SELECT event_type, SUM(count) AS total
			 FROM ${T_STATS}
			 WHERE stat_date >= ${TODAY_SQL} - INTERVAL '29 days'
			 GROUP BY event_type`,
		),
		db.query(
			`SELECT stat_date, event_type, SUM(count) AS total
			 FROM ${T_STATS}
			 WHERE stat_date >= ${TODAY_SQL} - INTERVAL '13 days'
			 GROUP BY stat_date, event_type
			 ORDER BY stat_date ASC`,
		),
		db.query(
			`SELECT play_mode, COUNT(*) AS total, COALESCE(SUM(duration), 0) AS duration
			 FROM ${T_PLAY}
			 GROUP BY play_mode`,
		),
		db.query(
			`SELECT event_type, object_id, SUM(count) AS total
			 FROM ${T_STATS}
			 WHERE stat_date >= ${TODAY_SQL} - INTERVAL '29 days'
			   AND event_type IN ('category_view', 'card_view')
			   AND object_id <> ''
			 GROUP BY event_type, object_id
			 ORDER BY total DESC
			 LIMIT 20`,
		),
	])

	const totals = {}
	for (const row of statsRes.rows || []) totals[row.event_type] = Number(row.total) || 0

	return base.respSuccess({
		msg: '查询成功',
		data: {
			content: base.formatDbRows(contentRes.rows || [])[0] || {},
			totals,
			daily: base.formatDbRows(dailyRes.rows || []),
			playModes: base.formatDbRows(playRes.rows || []),
			objectStats: base.formatDbRows(objectRes.rows || []),
		},
	})
})

/* ==========================================================================
 * 分发
 * ========================================================================== */

export default async (req, resp) => {
	base.req = req
	base.resp = resp
	const { method, action, table, query, body } = base.getReqInfo()

	try {
		await ensure_dbInitialized_async()

		const handler = routes[`${method}:${table}:${action}`]
		if (!handler) return base.respFailure({ msg: `图卡乐园模块未知操作: ${method} ${table || ''}/${action || ''}` })
		return await handler({ req, resp, query, body })
	} catch (error) {
		if (error instanceof CardsPayloadError) return base.respFailure({ msg: error.message })
		console.error('图卡乐园模块异常:', error)
		return base.respFailure({ msg: '图卡乐园服务暂时不可用，请稍后重试' })
	}
}
