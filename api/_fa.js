import { requireAuth } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import db from '#api_util/db.js'

// Font Awesome 图标工作台用户数据持久化模块 (fa_user_config)
//
// 业务职责:
//   1. 存储并同步用户的收藏列表 (favorites) 与最近使用足迹 (recents)
//   2. 支持游客态登录后的「本地与云端数据无缝合并 (merge)」
//   3. 权限安全严格绑定会话: user_id 必须取自 token 解析的 req.user.userId

const TABLE = 'public.fa_user_config'
let dbInitialized = false

/**
 * 建表与索引（幂等执行）
 */
async function ensure_dbInitialized_async() {
	if (dbInitialized) return

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${TABLE} (
			id          VARCHAR(20) PRIMARY KEY,
			user_id     VARCHAR(40) NOT NULL UNIQUE,
			favorites   JSONB NOT NULL DEFAULT '[]'::jsonb,
			recents     JSONB NOT NULL DEFAULT '[]'::jsonb,
			config      JSONB NOT NULL DEFAULT '{}'::jsonb,
			createtime  TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
			updatetime  TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')
		);
	`)

	await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_user_config_user ON ${TABLE} (user_id)`)

	dbInitialized = true
}

const actions = {
	get: {},
	post: {},
}

/**
 * 获取当前登录用户的配置与数据
 * GET /api/fa/config
 */
actions.get.config = requireAuth(async () => {
	await ensure_dbInitialized_async()
	const userId = base.req.user.userId

	const { rows } = await db.query(
		`SELECT favorites, recents, config, updatetime
		 FROM ${TABLE}
		 WHERE user_id = $1`,
		[userId],
	)

	if (!rows.length) {
		return base.respSuccess({
			data: {
				favorites: [],
				recents: [],
				config: {},
			},
			msg: '默认空配置',
		})
	}

	const row = rows[0]
	return base.respSuccess({
		data: {
			favorites: Array.isArray(row.favorites) ? row.favorites : [],
			recents: Array.isArray(row.recents) ? row.recents : [],
			config: row.config || {},
			updateTime: row.updatetime,
		},
	})
})

/**
 * 保存或合并当前用户的配置与数据
 * POST /api/fa/config
 * body: { favorites: string[], recents: string[], config?: object, syncMode?: 'merge' | 'overwrite' }
 */
actions.post.config = requireAuth(async () => {
	await ensure_dbInitialized_async()
	const userId = base.req.user.userId
	const body = base.req.body || {}

	const clientFavs = Array.isArray(body.favorites) ? body.favorites.filter(c => typeof c === 'string' && c.trim()) : []
	const clientRecents = Array.isArray(body.recents) ? body.recents.filter(c => typeof c === 'string' && c.trim()) : []
	const clientConfig = body.config && typeof body.config === 'object' ? body.config : {}
	const syncMode = body.syncMode || 'overwrite'

	let finalFavs = clientFavs
	let finalRecents = clientRecents
	let finalConfig = clientConfig

	// 若为合并模式（通常在未登录转为已登录的初次同步触发），执行去重合并
	if (syncMode === 'merge') {
		const { rows } = await db.query(
			`SELECT favorites, recents, config FROM ${TABLE} WHERE user_id = $1`,
			[userId],
		)

		if (rows.length) {
			const dbFavs = Array.isArray(rows[0].favorites) ? rows[0].favorites : []
			const dbRecents = Array.isArray(rows[0].recents) ? rows[0].recents : []
			const dbConfig = rows[0].config || {}

			// 收藏取并集去重（保持客户端最新在后）
			const favSet = new Set([...dbFavs, ...clientFavs])
			finalFavs = Array.from(favSet)

			// 最近使用取并集去重，保留最新 30 项
			const recentSet = new Set([...clientRecents, ...dbRecents])
			finalRecents = Array.from(recentSet).slice(0, 30)

			finalConfig = { ...dbConfig, ...clientConfig }
		}
	}

	// 执行 Upsert (存在则更新，不存在则插入)
	const { rows: upsertRows } = await db.query(
		`INSERT INTO ${TABLE}
			(id, user_id, favorites, recents, config, createtime, updatetime)
		 VALUES
			($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, (now() AT TIME ZONE 'Asia/Shanghai'), (now() AT TIME ZONE 'Asia/Shanghai'))
		 ON CONFLICT (user_id) DO UPDATE SET
			favorites = EXCLUDED.favorites,
			recents = EXCLUDED.recents,
			config = EXCLUDED.config,
			updatetime = (now() AT TIME ZONE 'Asia/Shanghai')
		 RETURNING favorites, recents, config, updatetime`,
		[
			base.getId(),
			userId,
			JSON.stringify(finalFavs),
			JSON.stringify(finalRecents),
			JSON.stringify(finalConfig),
		],
	)

	const saved = upsertRows[0] || {}

	return base.respSuccess({
		data: {
			favorites: saved.favorites || finalFavs,
			recents: saved.recents || finalRecents,
			config: saved.config || finalConfig,
			updateTime: saved.updatetime,
		},
		msg: syncMode === 'merge' ? '已自动合并云端与本地数据' : '配置已保存',
	})
})

/**
 * 路由分发入口
 */
export default async (req, resp) => {
	base.req = req
	base.resp = resp

	const { method, action } = base.getReqInfo()

	try {
		// action 支持如 /api/fa/config
		const actionName = Array.isArray(action) ? action[1] : action
		const handler = actions[method]?.[actionName]

		if (handler) {
			return await handler()
		}

		return base.respFailure({
			msg: `fa 模块未识别的接口动作: ${method.toUpperCase()} ${actionName || '空'}`,
		})
	} catch (error) {
		console.error('FA API 异常:', error)
		return base.respFailure({
			msg: `服务器内部错误: ${error.message}`,
		})
	}
}
