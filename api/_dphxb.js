import { verifyAuth } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import db from '#api_util/db.js'
import { DphxbPayloadError, sanitize_game_payload } from '#api_util/dphxb_schema.js'

/**
 * 大炮轰小兵 - 对局数据结算留痕模块
 *
 * 核心设计：
 *   1. 身份自洽：user_id 仅通过 verifyAuth 从 Token 解析，匿名对局记为 NULL；客户端任何伪造字段一律剥离。
 *   2. 单局幂等：以 request_id 为唯一索引键，配合 ON CONFLICT (request_id) DO NOTHING，避免重复记录。
 *   3. 终局后悔棋替代机制：
 *      - 终局后悔棋在产品语义上为“撤销原终局并继续对局”。
 *      - 原终局记录保留全部行棋审计信息，标记 is_superseded = true 并记录 superseded_by。
 *      - 新延续局在结算时关联 superseded_request_id，避免一盘被重复统计为两盘。
 *   4. 残局统计口径计算：
 *      - 留存 entered_endgame_at_ply（首次小兵 <= 2 的步数）、endgame_plies（残局持续半回合数）。
 *   5. 时区定案：时间戳统一使用无时区 TIMESTAMP + (now() AT TIME ZONE 'Asia/Shanghai') 保持北京时间一致性。
 */

const TABLE = 'public.dphxb_game_record'
const RATE_WINDOW_SECONDS = 60
const RATE_MAX_USER = 15 // 登录用户 1 分钟内最多上报 15 局
const RATE_MAX_IP = 20 // 匿名 IP 1 分钟内最多上报 20 局

let dbInitialized = false

// 匿名 IP 限流内存滑窗
const ipHitMap = new Map()

function get_req_ip(req) {
	const forwarded = req?.headers?.['x-forwarded-for']
	if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
	return req?.socket?.remoteAddress || req?.ip || 'unknown'
}

function check_ip_rate_limit(ip) {
	const now = Date.now()
	// 清理 10 分钟前的过期记录
	if (ipHitMap.size > 2000) {
		for (const [key, item] of ipHitMap.entries()) {
			if (now - item.time > 10 * 60 * 1000) {
				ipHitMap.delete(key)
			}
		}
	}

	const record = ipHitMap.get(ip)
	if (!record || now - record.startTime > RATE_WINDOW_SECONDS * 1000) {
		ipHitMap.set(ip, { startTime: now, time: now, count: 1 })
		return true
	}

	record.time = now
	if (record.count >= RATE_MAX_IP) {
		return false
	}
	record.count++
	return true
}

/**
 * 自动建表与索引（幂等）
 */
async function ensure_dbInitialized_async() {
	if (dbInitialized) return

	await db.query(`
		CREATE TABLE IF NOT EXISTS ${TABLE} (
			id                      VARCHAR(20) PRIMARY KEY,
			request_id              VARCHAR(64) NOT NULL,
			mode                    VARCHAR(20) NOT NULL,
			user_id                 VARCHAR(40),
			rule_version            VARCHAR(20) NOT NULL DEFAULT '1.0.0',
			player_side             VARCHAR(10),
			ai_difficulty           VARCHAR(10),
			participants            JSONB NOT NULL DEFAULT '[]'::jsonb,
			winner                  VARCHAR(10) NOT NULL,
			end_reason              VARCHAR(50) NOT NULL,
			end_reason_text         VARCHAR(100) DEFAULT '',
			total_plies             INT NOT NULL,
			cannons_remaining       INT NOT NULL,
			soldiers_remaining      INT NOT NULL,
			is_normal_finish        BOOLEAN NOT NULL DEFAULT true,
			is_superseded           BOOLEAN NOT NULL DEFAULT false,
			superseded_by           VARCHAR(64) DEFAULT NULL,
			superseded_request_id   VARCHAR(64) DEFAULT NULL,
			entered_endgame_at_ply  INT DEFAULT NULL,
			endgame_plies           INT NOT NULL DEFAULT 0,
			min_soldiers_remaining  INT NOT NULL DEFAULT 18,
			game_data               JSONB NOT NULL,
			started_at              TIMESTAMP,
			ended_at                TIMESTAMP,
			createtime              TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')
		);
	`)

	// 渐进式结构对齐（防止已有表缺少新字段）
	await db.query(`
		ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS is_superseded BOOLEAN NOT NULL DEFAULT false;
		ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS superseded_by VARCHAR(64) DEFAULT NULL;
		ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS superseded_request_id VARCHAR(64) DEFAULT NULL;
		ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS entered_endgame_at_ply INT DEFAULT NULL;
		ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS endgame_plies INT NOT NULL DEFAULT 0;
		ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS min_soldiers_remaining INT NOT NULL DEFAULT 18;
	`)

	// 幂等键：同一次对局只留一条记录
	await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dphxb_game_record_request ON ${TABLE} (request_id);`)

	// 索引：按用户查个人战绩与限频
	await db.query(`CREATE INDEX IF NOT EXISTS idx_dphxb_game_record_user ON ${TABLE} (user_id, createtime DESC);`)

	// 索引：按模式与胜方用于统计残局分布
	await db.query(`CREATE INDEX IF NOT EXISTS idx_dphxb_game_record_mode ON ${TABLE} (mode, createtime DESC);`)
	await db.query(`CREATE INDEX IF NOT EXISTS idx_dphxb_game_record_winner ON ${TABLE} (winner, createtime DESC);`)

	// 索引：残局阶段快查索引
	await db.query(`CREATE INDEX IF NOT EXISTS idx_dphxb_game_record_endgame ON ${TABLE} (is_superseded, entered_endgame_at_ply);`)

	dbInitialized = true
}

/**
 * 查库限频计数：检查当前用户在窗口内提交的对局数
 */
async function count_recent_user_records_async(userId) {
	const { rows } = await db.query(
		`SELECT COUNT(*) AS total FROM ${TABLE}
		 WHERE user_id = $1 AND createtime > (now() AT TIME ZONE 'Asia/Shanghai') - ($2::int * interval '1 second')`,
		[userId, RATE_WINDOW_SECONDS],
	)
	return parseInt(rows[0]?.total, 10) || 0
}

/**
 * 插入对局记录
 */
async function insert_game_record_async(userId, payload) {
	const newId = base.getId()

	// 若存在被替代的旧对局记录，先更新旧记录失效状态
	if (payload.supersededRequestId) {
		await db.query(`UPDATE ${TABLE} SET is_superseded = true, superseded_by = $1 WHERE request_id = $2`, [newId, payload.supersededRequestId])
	}

	const { rows } = await db.query(
		`INSERT INTO ${TABLE}
			(id, request_id, mode, user_id, rule_version, player_side, ai_difficulty,
			 participants, winner, end_reason, end_reason_text, total_plies,
			 cannons_remaining, soldiers_remaining, is_normal_finish,
			 is_superseded, superseded_by, superseded_request_id,
			 entered_endgame_at_ply, endgame_plies, min_soldiers_remaining,
			 game_data, started_at, ended_at, createtime)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15,
		         $16, $17, $18, $19, $20, $21, $22::jsonb, $23, $24, (now() AT TIME ZONE 'Asia/Shanghai'))
		 ON CONFLICT (request_id) DO NOTHING
		 RETURNING id`,
		[
			newId,
			payload.requestId,
			payload.mode,
			userId,
			payload.ruleVersion,
			payload.playerSide,
			payload.aiDifficulty,
			JSON.stringify(payload.participants),
			payload.winner,
			payload.endReason,
			payload.endReasonText,
			payload.totalPlies,
			payload.cannonsRemaining,
			payload.soldiersRemaining,
			payload.isNormalFinish,
			false, // is_superseded
			null, // superseded_by
			payload.supersededRequestId,
			payload.enteredEndgameAtPly,
			payload.endgamePlies,
			payload.minSoldiersRemaining,
			JSON.stringify(payload.gameData),
			payload.startedAt,
			payload.endedAt,
		],
	)

	if (rows.length) {
		return { id: rows[0].id, repeated: false }
	}

	// 幂等命中：回查原有记录 ID
	const { rows: existing } = await db.query(`SELECT id FROM ${TABLE} WHERE request_id = $1`, [payload.requestId])
	return { id: existing[0]?.id || '', repeated: true }
}

const actions = { post: {}, get: {} }

/**
 * 撤销 / 标记失效已有终局记录（终局后悔棋）
 */
actions.post.revoke = async ({ body }) => {
	await ensure_dbInitialized_async()
	const requestId = typeof body?.requestId === 'string' ? body.requestId.trim() : ''
	if (!requestId || requestId.length > 64) {
		return base.respFailure({ msg: 'requestId 参数不合法' })
	}

	try {
		const { rowCount } = await db.query(`UPDATE ${TABLE} SET is_superseded = true WHERE request_id = $1`, [requestId])
		return base.respSuccess({
			msg: rowCount > 0 ? '对局已标记失效' : '未找到匹配的对局记录',
			data: { superseded: true, rowCount },
		})
	} catch (error) {
		console.error('撤回大炮轰小兵对局记录异常:', error)
		return base.respFailure({ msg: '撤回对局记录服务异常' })
	}
}

/**
 * 记录一局完成的对局数据
 */
actions.post.finish = async ({ req, body }) => {
	await ensure_dbInitialized_async()

	// 1. 数据校验与白名单过滤
	let payload
	try {
		payload = sanitize_game_payload(body)
	} catch (error) {
		if (error instanceof DphxbPayloadError) {
			return base.respFailure({ msg: error.message })
		}
		return base.respFailure({ msg: '对局数据解析校验失败' })
	}

	// 2. 身份校验：有 Token 提取 userId，未登录设为 null
	const user = await verifyAuth(req)
	const userId = user?.userId || null

	// 3. 限频控制
	if (userId) {
		const recentCount = await count_recent_user_records_async(userId)
		if (recentCount >= RATE_MAX_USER) {
			return base.respFailure({ msg: '对局上报过于频繁，请稍后再试' })
		}
	} else {
		const ip = get_req_ip(req)
		if (!check_ip_rate_limit(ip)) {
			return base.respFailure({ msg: '对局上报过于频繁，请稍后再试' })
		}
	}

	// 4. 写库
	try {
		const result = await insert_game_record_async(userId, payload)
		return base.respSuccess({
			msg: result.repeated ? '对局记录已存在' : '对局记录保存成功',
			data: { id: result.id, repeated: result.repeated },
		})
	} catch (error) {
		console.error('保存大炮轰小兵对局记录异常:', error)
		return base.respFailure({ msg: '对局记录保存服务异常' })
	}
}

export default async (req, resp) => {
	base.req = req
	base.resp = resp
	const { method, action, query, body } = base.getReqInfo()

	try {
		if (actions[method]?.[action]) {
			return await actions[method][action]({ req, query, body })
		}
		return base.respFailure({ msg: `大炮轰小兵模块未知操作: ${action}` })
	} catch (error) {
		return base.respFailure({ msg: `大炮轰小兵服务异常: ${error.message}` })
	}
}
