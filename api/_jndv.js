import { checkAuth } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import db from '#api_util/db.js'

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
			work        VARCHAR(40) DEFAULT '',
			sex         SMALLINT DEFAULT 1,
			leader      BOOLEAN DEFAULT false,
			version     INT DEFAULT 1,
			createtime  TIMESTAMPTZ DEFAULT NOW(),
			updatetime  TIMESTAMPTZ DEFAULT NOW(),
			updateby    VARCHAR(40) DEFAULT ''
		);
	`)
	await db.query('CREATE INDEX IF NOT EXISTS idx_jndv_seat_room ON public.jndv_seat (room)')

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

		// 路由分发
		if (method === 'get' && (action === 'select' || action === 'list')) {
			// 公开或半公开查询全部座位
			const room = query.room
			let sql = `
				SELECT id, room, seat_id as "seatId", name, work, sex, leader, version,
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
			const work = (body.work || '').trim()
			const sex = body.sex === 0 || body.sex === '0' ? 0 : 1
			const leader = Boolean(body.leader)
			const username = req.user?.username || 'user'

			if (!seatId || isNaN(version)) {
				return base.respFailure({ msg: '缺少必填参数 seatId 或 version' })
			}

			// 乐观锁原子更新：WHERE seat_id = $6 AND version = $7
			const updateRes = await db.query(
				`
				UPDATE public.jndv_seat
				SET name = $1,
				    work = $2,
				    sex = $3,
				    leader = $4,
				    version = version + 1,
				    updatetime = NOW(),
				    updateby = $5
				WHERE seat_id = $6 AND version = $7
				RETURNING id, room, seat_id as "seatId", name, work, sex, leader, version,
				          to_char(updatetime, 'YYYY-MM-DD HH24:MI:SS') as updatetime, updateby
			`,
				[name, work, sex, leader, username, seatId, version],
			)

			if (updateRes.rowCount === 0) {
				// 检查是因为不存在还是版本冲突
				const checkExist = await db.query('SELECT version FROM public.jndv_seat WHERE seat_id = $1', [seatId])
				if ((checkExist.rowCount && checkExist.rowCount > 0) || (checkExist.rows && checkExist.rows.length > 0)) {
					const curVer = checkExist.rows[0]?.version
					return base.respFailure({
						msg: '该座位已被他人修改，请刷新后重试',
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
