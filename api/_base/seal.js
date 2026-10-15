import { requireAuth } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import db from '#api_util/db.js'
import { SealPayloadError, sanitize_export_payload } from '#api_util/seal_schema.js'

// 印章生成器的导出留痕 (base_seal_export_log)
//
// 前端只在「登录用户点击下载无标识原图」时调用 post.record, 服务端写库成功才允许
// 浏览器栅格化 clean 版本 —— 顺序即约束: 没有记录, 就没有无标识原图。
//
// 这个模块刻意只做三件事, 别的都不做:
//   1. 归属只认会话: user_id 取自 verifyAccessToken 解出的 req.user.userId。
//      请求体里就算带 userId / createdAt, 也进不了 CONFIG/PAYLOAD 白名单, 一律拒收。
//   2. 时间只由服务端/数据库生成: createtime 在 SQL 里算, 客户端没有任何字段能影响它。
//   3. 不保存图片: 首版只存记录 + 配置快照, 不落 PNG 本体, 不存 IP、完整 UA、指纹、图片 URL。
//
// 记录一经写入就永久保留: 没有保留期字段, 也没有清理入口。
// (早期设计里有 retention_until = 180 天 与一个清理端点, 已整体移除; 该表在任何库里都
//  没有以旧结构建过, 所以不需要迁移。真要清理由运维直接操作数据库, 不在应用里开这个口子。)

// 单用户限频: 窗口内最多这么多条。前端按钮有 loading 兜住手滑, 这里是防脚本重放。
// 用「查库计数」而不是内存计数: serverless 每个实例的内存各算各的, 拦不住真正的连发。
const RATE_WINDOW_SECONDS = 60
const RATE_MAX = 10

const TABLE = 'public.base_seal_export_log'

let dbInitialized = false

/**
 * 建表 + 建索引（幂等，可重复执行）
 *
 * 时间列用无时区 TIMESTAMP + (now() AT TIME ZONE 'Asia/Shanghai')，与 jndv 两表同一套定案：
 * 列里存的就是北京时间字面值，Studio / psql / 代码三处看到的一致。
 * 不用 timestamptz 的原因见 _jndv.js 的定案注释（timestamptz 不存显示用的字面值，
 * 显示成什么取决于读它的客户端，Supabase 会话是 UTC，直接查表会少 8 小时）。
 */
async function ensure_dbInitialized_async() {
	if (dbInitialized) return

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${TABLE} (
			id               VARCHAR(20) PRIMARY KEY,
			user_id          VARCHAR(40) NOT NULL,
			event_type       VARCHAR(40) NOT NULL,
			template_id      VARCHAR(40) DEFAULT '',
			shape            VARCHAR(20) NOT NULL,
			output_format    VARCHAR(10) NOT NULL,
			output_size      INT NOT NULL,
			renderer_version VARCHAR(10) DEFAULT '',
			request_id       VARCHAR(40) NOT NULL,
			config_snapshot  JSONB NOT NULL,
			createtime       TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')
		);
	`)

	// 按用户查自己的记录(以及限频计数)走这条
	await db.query(`CREATE INDEX IF NOT EXISTS idx_base_seal_export_log_user ON ${TABLE} (user_id, createtime DESC)`)

	// 幂等键: 前端连点两次下载发的是同一个 requestId, 唯一索引 + ON CONFLICT DO NOTHING
	// 保证同一次导出只留一条。不给 request_id 默认值 —— 空串会让所有「没带 requestId」的
	// 请求在唯一索引上互相冲突, 那才是真的把不同导出记成同一条。
	await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_base_seal_export_log_request ON ${TABLE} (user_id, request_id)`)

	dbInitialized = true
}

/** 限频计数: 窗口内该用户已有多少条记录 */
async function count_recent_records_async(userId) {
	const { rows } = await db.query(
		`SELECT COUNT(*) AS total FROM ${TABLE}
		 WHERE user_id = $1 AND createtime > (now() AT TIME ZONE 'Asia/Shanghai') - ($2::int * interval '1 second')`,
		[userId, RATE_WINDOW_SECONDS],
	)
	return parseInt(rows[0]?.total, 10) || 0
}

/**
 * 写入一条导出记录
 *
 * 幂等命中时不报错也不重复插: 把已存在那条的 id 返回去, 前端照样能下载 clean 版本
 * ——「同一次导出重试」本来就该成功, 报错反而会让用户以为留痕失败。
 */
async function insert_record_async(userId, payload) {
	const { rows } = await db.query(
		`INSERT INTO ${TABLE}
			(id, user_id, event_type, template_id, shape, output_format, output_size, renderer_version, request_id, config_snapshot, createtime)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, (now() AT TIME ZONE 'Asia/Shanghai'))
		 ON CONFLICT (user_id, request_id) DO NOTHING
		 RETURNING id`,
		[
			base.getId(),
			userId,
			payload.eventType,
			payload.templateId,
			payload.shape,
			payload.outputFormat,
			payload.outputSize,
			payload.rendererVersion,
			payload.requestId,
			base.formatDbBind(payload.configSnapshot),
		],
	)

	if (rows.length) return rows[0].id

	// 走到这里说明同 (user_id, request_id) 已存在 —— 取回原记录的 id
	const { rows: existing } = await db.query(`SELECT id FROM ${TABLE} WHERE user_id = $1 AND request_id = $2`, [userId, payload.requestId])
	return existing[0]?.id || ''
}

const actions = { post: {} }

/**
 * 记录一次无标识导出请求（登录用户）
 *
 * 失败一律 HTTP 200 + code:-1: 仓库既有约定(base.respFailure), 只有认证中间件才写真实 401。
 * msg 只描述「这件事为什么没成」, 不含 SQL、堆栈或任何表结构细节。
 */
actions.post.record = requireAuth(async ({ req, body }) => {
	try {
		// 1. 先白名单校验: 非法载荷连一次 SQL 都不该发出去
		const payload = sanitize_export_payload(body)

		// 2. 归属只认会话, 请求体里的任何身份字段都没有参与
		const userId = req.user?.userId
		if (!userId) return base.respFailure({ msg: '认证信息异常, 请重新登录', reason: 'auth_invalid' })

		// 3. 限频
		const recent = await count_recent_records_async(userId)
		if (recent >= RATE_MAX) return base.respFailure({ msg: '导出过于频繁, 请稍后再试', reason: 'rate_limited' })

		// 4. 写库(幂等)
		const recordId = await insert_record_async(userId, payload)
		if (!recordId) return base.respFailure({ msg: '生成记录写入失败, 请稍后重试', reason: 'insert_failed' })

		// 返回值只给 id: 记录内容与限频水位都不需要前端知道
		return base.respSuccess({ msg: '已记录', data: { recordId } })
	} catch (error) {
		if (error instanceof SealPayloadError) return base.respFailure({ msg: '配置校验未通过: ' + error.message, reason: 'invalid_payload' })
		console.error('印章导出记录写入异常:', error)
		return base.respFailure({ msg: '服务暂时不可用, 请稍后重试', reason: 'server_error' })
	}
})

export default async (req, resp) => {
	base.req = req
	base.resp = resp
	const { method, action, query, body } = base.getReqInfo()

	try {
		// 建表对所有入口统一前置, 幂等缓存保证只执行一次
		await ensure_dbInitialized_async()

		if (actions[method]?.[action]) {
			const handler = actions[method][action]
			return await handler({ req, resp, query, body })
		}
		return base.respFailure({ msg: '请求类型或方法无效' })
	} catch (error) {
		console.error('印章记录模块异常:', error)
		return base.respFailure({ msg: '服务暂时不可用, 请稍后重试' })
	}
}
