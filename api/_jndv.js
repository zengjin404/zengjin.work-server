import { checkAuth, verifyAuth } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import db from '#api_util/db.js'
import {
	allow_answer_attempt,
	check_answer,
	gate_public_info,
	get_req_ip,
	jndv_gate,
	record_answer_failure,
	sign_jndv_ticket,
	verify_jndv_ticket,
} from '#api_util/jndv_gate.js'

let dbInitialized = false

// 初始种子数据定义（34 个座位）
const SEAT_PRESETS = [
	// 总监室 (zjs)
	{ room: 'zjs', seat_id: 'zjs-c1-r1', name: '刘玉娇', sex: 0, work: '项目总监', leader: true },
	{ room: 'zjs', seat_id: 'zjs-c2-r1', name: '王永贞', sex: 1, work: '技术总监', leader: true },

	// 支持部 (zcb)
	{ room: 'zcb', seat_id: 'zcb-c1-r1', name: '黄江伟', sex: 1, work: '通讯', leader: false },
	{ room: 'zcb', seat_id: 'zcb-c1-r2', name: '张新昌', sex: 1, work: 'C++', leader: true },
	{ room: 'zcb', seat_id: 'zcb-c1-r3', name: '朱爱光', sex: 1, work: 'C++', leader: false },
	{ room: 'zcb', seat_id: 'zcb-c2-r1', name: '于县芝', sex: 1, work: 'JAVA', leader: false },
	{ room: 'zcb', seat_id: 'zcb-c2-r2', name: '冯斌', sex: 1, work: 'JAVA', leader: false },
	{ room: 'zcb', seat_id: 'zcb-c2-r3', name: '武剑', sex: 1, work: 'JAVA', leader: true },
	{ room: 'zcb', seat_id: 'zcb-c3-r1', name: '王国栋', sex: 1, work: '安卓', leader: false },
	{ room: 'zcb', seat_id: 'zcb-c3-r2', name: '陈青华', sex: 1, work: 'JAVA', leader: false },
	{ room: 'zcb', seat_id: 'zcb-c3-r3', name: '王凯', sex: 1, work: 'JAVA', leader: false },
	{ room: 'zcb', seat_id: 'zcb-c4-r1', name: '侯雨', sex: 1, work: '大数据', leader: false },
	{ room: 'zcb', seat_id: 'zcb-c4-r2', name: '赵小玮', sex: 1, work: '运维', leader: false },
	{ room: 'zcb', seat_id: 'zcb-c4-r3', name: '', sex: 1, work: '', leader: false },

	// 政府应用事业部 (zfyy)
	{ room: 'zfyy', seat_id: 'zfyy-c1-r1', name: '石祥玲', sex: 0, work: '产品', leader: true },
	{ room: 'zfyy', seat_id: 'zfyy-c1-r2', name: '张震', sex: 1, work: '产品', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c1-r3', name: '范世草', sex: 1, work: '产品', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c1-r4', name: '', sex: 1, work: '', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c1-r5', name: '王长香', sex: 0, work: '测试', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c2-r1', name: '李昌婷', sex: 0, work: 'C#', leader: true },
	{ room: 'zfyy', seat_id: 'zfyy-c2-r2', name: '崔兴涛', sex: 1, work: 'C#', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c2-r3', name: '蒋元', sex: 1, work: '前端', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c2-r4', name: '刘浩', sex: 1, work: '产品', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c2-r5', name: '姜博皓', sex: 1, work: '前端', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c3-r1', name: '范文峰', sex: 1, work: 'C#', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c3-r2', name: '李丽萍', sex: 0, work: 'C#', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c3-r3', name: '尹德鹏', sex: 1, work: '前端', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c3-r4', name: '曾进', sex: 1, work: '前端', leader: true },
	{ room: 'zfyy', seat_id: 'zfyy-c3-r5', name: '张飞虎', sex: 1, work: '前端', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c4-r1', name: '彭杰', sex: 1, work: 'UI', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c4-r2', name: '韩爱成', sex: 1, work: '产品', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c4-r3', name: '刘付刚', sex: 1, work: '前端', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c4-r4', name: '李峻韬', sex: 1, work: '前端', leader: false },
	{ room: 'zfyy', seat_id: 'zfyy-c4-r5', name: '彭立涛', sex: 1, work: 'PHP', leader: false },
]

/**
 * 确保表结构与种子数据已初始化 (异步，首次请求触发)
 */
async function ensure_dbInitialized_async() {
	if (dbInitialized) return

	await db.query(`
		CREATE TABLE IF NOT EXISTS public.jndv_seat (
			id          VARCHAR(20) PRIMARY KEY,
			room        VARCHAR(20) NOT NULL,
			seat_id     VARCHAR(40) NOT NULL UNIQUE,
			name        VARCHAR(40) DEFAULT '',
			pinyin      VARCHAR(60) DEFAULT '',
			work        VARCHAR(40) DEFAULT '',
			sex         SMALLINT DEFAULT 1,
			leader      BOOLEAN DEFAULT false,
			version     INT DEFAULT 1,
			createtime  TIMESTAMPTZ DEFAULT NOW(),
			updatetime  TIMESTAMPTZ DEFAULT NOW(),
			updateby    VARCHAR(40) DEFAULT ''
		);
	`)
	// 已有库不会走上面的 CREATE，补一列（幂等，可重复执行）
	await db.query(`ALTER TABLE public.jndv_seat ADD COLUMN IF NOT EXISTS pinyin VARCHAR(60) DEFAULT ''`)
	await db.query('CREATE INDEX IF NOT EXISTS idx_jndv_seat_room ON public.jndv_seat (room)')

	// 问答门的「通过标记」表：只存「谁在哪个版本上通过了」，不存答案也不存题目
	// （答案在 api_util/jndv_gate.js 里，是纯配置）。user_id 唯一约束同时也是
	// 下面 ON CONFLICT (user_id) 的落点，少了它会直接报错。
	await db.query(`
		CREATE TABLE IF NOT EXISTS public.jndv_unlock (
			id           VARCHAR(20) PRIMARY KEY,
			user_id      VARCHAR(40) NOT NULL UNIQUE,
			username     VARCHAR(40) DEFAULT '',
			gate_version INT DEFAULT 1,
			createtime   TIMESTAMPTZ DEFAULT NOW(),
			updatetime   TIMESTAMPTZ DEFAULT NOW()
		);
	`)

	// 幂等补齐种子数据：当表为空时全量导入
	const countRes = await db.query('SELECT COUNT(*) FROM public.jndv_seat')
	if (parseInt(countRes.rows[0].count, 10) === 0) {
		for (const seat of SEAT_PRESETS) {
			await db.query(
				`
				INSERT INTO public.jndv_seat (id, room, seat_id, name, work, sex, leader, version, createtime, updatetime, updateby)
				VALUES ($1, $2, $3, $4, $5, $6, $7, 1, NOW(), NOW(), 'system')
				ON CONFLICT (seat_id) DO NOTHING
			`,
				[base.getId(), seat.room, seat.seat_id, seat.name, seat.work, seat.sex, seat.leader],
			)
		}
	}

	dbInitialized = true
}

/** 该账号是否在当前版本上通过过问答门（版本对不上就当没通过，改版即全员重答） */
async function has_unlock_async(userId) {
	const res = await db.query('SELECT gate_version FROM public.jndv_unlock WHERE user_id = $1', [userId])
	const row = res?.rows?.[0]
	if (!row) return false
	return Number(row.gate_version) === jndv_gate.version
}

/** 记下「这个账号通过了」，同一账号重复通过只更新版本与时间，不新增行 */
async function save_unlock_async(user) {
	await db.query(
		`
		INSERT INTO public.jndv_unlock (id, user_id, username, gate_version, createtime, updatetime)
		VALUES ($1, $2, $3, $4, NOW(), NOW())
		ON CONFLICT (user_id) DO UPDATE SET username = $3, gate_version = $4, updatetime = NOW()
	`,
		[base.getId(), user.userId, user.username || '', jndv_gate.version],
	)
}

export default async function jndvHandler(req, resp) {
	base.req = req
	base.resp = resp
	const reqInfo = base.getReqInfo()
	const method = reqInfo.method
	const query = reqInfo.query
	const body = reqInfo.body
	const action =
		(Array.isArray(query.action) ? query.action[query.action.length - 1] : '') ||
		(Array.isArray(req.query?.action) ? req.query.action[req.query.action.length - 1] : '') ||
		reqInfo.action

	try {
		await ensure_dbInitialized_async()

		// ---- 问答门：进门前的验证，登录可选 ----
		if (method === 'get' && action === 'gate') {
			// 有 Token 就顺便认一下：已登录用户不必再答一遍
			const user = await verifyAuth(req)
			const ticket = req.headers?.['x-jndv-pass'] || req.headers?.['X-Jndv-Pass'] || ''
			const passed = verify_jndv_ticket(ticket) || (user?.userId ? await has_unlock_async(user.userId) : false)

			return base.respSuccess({
				msg: passed ? '已通过访问验证' : '需要回答访问验证问题',
				data: {
					passed,
					// 已经通过的请求不再回题干与提示：没必要把问题条件反复发给已经进门的人
					...(passed ? {} : gate_public_info()),
				},
			})
		}

		if (method === 'post' && action === 'gate') {
			const ip = get_req_ip(req)
			if (!allow_answer_attempt(ip)) {
				return base.respFailure({ msg: '答错次数过多，请稍后再试' })
			}

			if (!check_answer(body.answer ?? body.name)) {
				record_answer_failure(ip)
				// 只说「不对」，不区分是哪一项不满足 —— 否则能用错误提示反推答案条件
				return base.respFailure({ msg: '答案不对，再想想' })
			}

			const user = await verifyAuth(req)
			if (user?.userId) await save_unlock_async(user)

			return base.respSuccess({
				msg: '验证通过',
				data: {
					passed: true,
					version: jndv_gate.version,
					// 无论登录与否都发凭证：登录用户退出登录后，本机仍凭它继续放行
					ticket: sign_jndv_ticket(),
					saved: Boolean(user?.userId),
				},
			})
		}

		if (method === 'post' && action === 'claim') {
			// 这里用 verifyAuth 而非 checkAuth：未登录时要给出一句可读的失败原因，而不是被写成 401
			const user = await verifyAuth(req)
			if (!user?.userId) return base.respFailure({ msg: '未登录，无法把验证状态记到账号上' })
			if (!verify_jndv_ticket(body.ticket)) {
				return base.respFailure({ msg: '验证凭证已失效，请重新回答一次' })
			}
			await save_unlock_async(user)
			return base.respSuccess({ msg: '验证状态已记录到账号', data: { passed: true, version: jndv_gate.version } })
		}

		// 路由分发
		if (method === 'get' && (action === 'select' || action === 'list')) {
			// 公开或半公开查询全部座位
			const room = query.room
			let sql = `
				SELECT id, room, seat_id as "seatId", name, pinyin, work, sex, leader, version,
				       to_char(updatetime, 'YYYY-MM-DD HH24:MI:SS') as updatetime, updateby
				FROM public.jndv_seat
			`
			const params = []
			if (room) {
				sql += ` WHERE room = $1`
				params.push(room)
			}
			sql += ` ORDER BY seat_id ASC`

			const { rows } = await db.query(sql, params)

			const rooms = {
				zjs: rows.filter(r => r.room === 'zjs'),
				zcb: rows.filter(r => r.room === 'zcb'),
				zfyy: rows.filter(r => r.room === 'zfyy'),
			}

			return base.respSuccess({
				msg: '查询成功',
				data: {
					list: rows,
					rooms,
					byRoom: rooms,
				},
			})
		}

		if (method === 'post' && (action === 'update' || action === 'save')) {
			// 必须登录才能修改
			if (!(await checkAuth(req, resp))) return

			const seatId = body.seatId || body.seat_id
			const version = parseInt(body.version, 10)
			const name = (body.name || '').trim()
			const pinyin = (body.pinyin || '').trim()
			const work = (body.work || '').trim()
			const sex = body.sex === 0 || body.sex === '0' ? 0 : 1
			const leader = Boolean(body.leader)
			const username = req.user?.username || 'user'

			if (!seatId || isNaN(version)) {
				return base.respFailure({ msg: '缺少必填参数 seatId 或 version' })
			}

			// 乐观锁原子更新：WHERE seat_id = $7 AND version = $8
			const updateRes = await db.query(
				`
				UPDATE public.jndv_seat
				SET name = $1,
				    pinyin = $2,
				    work = $3,
				    sex = $4,
				    leader = $5,
				    version = version + 1,
				    updatetime = NOW(),
				    updateby = $6
				WHERE seat_id = $7 AND version = $8
				RETURNING id, room, seat_id as "seatId", name, pinyin, work, sex, leader, version,
				          to_char(updatetime, 'YYYY-MM-DD HH24:MI:SS') as updatetime, updateby
			`,
				[name, pinyin, work, sex, leader, username, seatId, version],
			)

			if (updateRes.rowCount === 0) {
				// 检查是因为不存在还是版本冲突
				const checkExist = await db.query('SELECT version FROM public.jndv_seat WHERE seat_id = $1', [seatId])
				if ((checkExist.rowCount && checkExist.rowCount > 0) || (checkExist.rows && checkExist.rows.length > 0)) {
					const curVer = checkExist.rows[0]?.version
					return base.respFailure({
						msg: '该座位已被他人修改，再次保存将覆盖对方的内容',
						currentVersion: curVer,
					})
				} else {
					return base.respFailure({ msg: '未找到指定座位' })
				}
			}

			return base.respSuccess({
				msg: '保存成功',
				data: updateRes.rows[0],
			})
		}

		return base.respFailure({ msg: '请求类型或接口动作无效' })
	} catch (error) {
		console.error('[jndvHandler Error]', error)
		return base.respFailure({
			msg: `操作失败：${error.message || '服务器内部错误'}`,
		})
	}
}
