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
			createtime  TIMESTAMP DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
			updatetime  TIMESTAMP DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
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
			createtime   TIMESTAMP DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
			updatetime   TIMESTAMP DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')
		);
	`)

	// 存量库的时间列类型迁移（自带迁移，不需要手工执行 SQL）
	//
	// 定案（2026-10-13）：这两列一律「所见即所得」。原先两列是 TIMESTAMPTZ + NOW()：存进去的瞬间是对的，
	// 但 timestamptz **不存显示用的字面值**，显示成什么完全取决于读它的客户端 —— to_char 按会话时区渲染
	// （Supabase 会话是 UTC），Supabase 控制台的 Table Editor 也固定按 UTC 显示、且没有时区开关
	// （官方仍只是 feature request）。结果就是直接查表会比北京时间少 8 小时、得心算，而这两处都在我们掌控之外。
	//
	// 改成无时区 TIMESTAMP 后，列里存的就是北京时间字面值，Studio / psql / 代码三处看到的一致。
	// 之所以敢用无时区类型：Asia/Shanghai 恒为 +08:00 且无夏令时（pg_timezone_names 实测 utc_offset = 8h、
	// is_dst = false；中国 1986–1991 实行过夏令时、1992 年起取消），墙上时间因此单调、不重复、不跳变
	// —— 这正是 naive timestamp 唯一会出问题的场景，这里不存在。需要还原 UTC 瞬间时减 8 小时即可。
	//
	// ⚠️ USING 不能省：`ALTER COLUMN ... TYPE timestamp` 默认按**会话时区(UTC)** 解释，
	// 会把存量数据整体改错 8 小时（08:18 变 00:18）。查 data_type 只是为了让迁移幂等、可重复执行。
	//
	// 表名进 SQL 只能拼字符串（PG 不支持标识符参数化，仓库里 crud.js 也是这么做的），
	// 所以这里用「白名单 + 遍历」取代散落的两次调用：插值进来的值永远只能是下面这两个字面量，
	// 将来有人想接外部输入会在第一行就被挡下（抛错而不是静默拼进 SQL）。
	const TIME_COLUMN_TABLES = ['jndv_seat', 'jndv_unlock']
	const migrate_time_column = async table => {
		if (!TIME_COLUMN_TABLES.includes(table)) throw new Error(`时间列迁移不接受表名：${table}`)
		const { rows } = await db.query(
			`SELECT data_type FROM information_schema.columns
			 WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'updatetime'`,
			[table],
		)
		if (rows[0]?.data_type === 'timestamp with time zone') {
			await db.query(
				`ALTER TABLE public.${table}
					ALTER COLUMN createtime TYPE timestamp USING (createtime AT TIME ZONE 'Asia/Shanghai'),
					ALTER COLUMN updatetime TYPE timestamp USING (updatetime AT TIME ZONE 'Asia/Shanghai')`,
			)
		}
		// 改完类型还要单独钉一次默认值，这一步**不能**跟着上面的 if 走：
		// 老库建表时是 TIMESTAMPTZ DEFAULT NOW()，ALTER TYPE 会把这个默认值原样带过来，而它落在无时区列上
		// 会按**会话时区(UTC)**取墙上时间 —— 于是「没显式给时间列」的 INSERT 又会存成 UTC 字面值。
		// 现在所有写入都显式给了 createtime / updatetime，所以这只是拆掉一颗哑弹，不动任何现有数据。
		await db.query(
			`ALTER TABLE public.${table}
				ALTER COLUMN createtime SET DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
				ALTER COLUMN updatetime SET DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')`,
		)
	}
	for (const table of TIME_COLUMN_TABLES) await migrate_time_column(table)

	// 幂等补齐种子数据：当表为空时全量导入
	const countRes = await db.query('SELECT COUNT(*) FROM public.jndv_seat')
	if (parseInt(countRes.rows[0].count, 10) === 0) {
		for (const seat of SEAT_PRESETS) {
			await db.query(
				`
				INSERT INTO public.jndv_seat (id, room, seat_id, name, work, sex, leader, version, createtime, updatetime, updateby)
				VALUES ($1, $2, $3, $4, $5, $6, $7, 1, (now() AT TIME ZONE 'Asia/Shanghai'), (now() AT TIME ZONE 'Asia/Shanghai'), 'system')
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
		VALUES ($1, $2, $3, $4, (now() AT TIME ZONE 'Asia/Shanghai'), (now() AT TIME ZONE 'Asia/Shanghai'))
		ON CONFLICT (user_id) DO UPDATE SET username = $3, gate_version = $4, updatetime = (now() AT TIME ZONE 'Asia/Shanghai')
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
			//
			// 这里仍然走 to_char 输出字符串（而不是直接返回列值）：列是无时区 timestamp，
			// 直出的话 node-postgres 会按**进程本地时区**把它解析成 JS Date，序列化后又变成 UTC 的 ISO 串，
			// 等于绕一圈回到「看时间要心算」的老问题，而且服务端时区一换结果就变。to_char 出来就是字面值。
			// 列现在存的本就是北京时间（见上面建表处的时区定案），所以不需要再 AT TIME ZONE。
			// 「最后编辑人」优先展示昵称：jndv_seat 只存账户名（写入时取自 Token 的 username），
			// 昵称在平台用户表 base_user 里，读的时候现查一次。兜底口径与仓库其他渲染层一致
			// （api/_base/user.js:875 的注释）：nickname || username —— 昵称留空时原样显示账户名，
			// 别让这一栏空着。昵称是随时可改的展示名，所以只在读侧解析、不落进 jndv_seat。
			//
			// 用 LIMIT 1 的相关子查询而不是 LEFT JOIN：base_user.username 上没有唯一索引
			// （唯一索引只在 id 上），撞上重名会把座位行 join 成多行；顺带也免了给 FROM 里
			// 的列逐个加前缀消歧义（id 在两张表里同名）。
			const room = query.room
			let sql = `
				SELECT id, room, seat_id as "seatId", name, pinyin, work, sex, leader, version,
				       to_char(updatetime, 'YYYY-MM-DD HH24:MI:SS') as updatetime,
				       updateby,
				       COALESCE(NULLIF(btrim((SELECT nickname FROM public.base_user WHERE username = jndv_seat.updateby LIMIT 1)), ''), updateby) as "updatebyName"
				FROM public.jndv_seat
			`
			const params = []
			if (room) {
				sql += ` WHERE room = $1`
				params.push(room)
			}
			sql += ` ORDER BY seat_id ASC`

			const { rows } = await db.query(sql, params)

			// 房间分组按数据里实际出现的 room 动态聚合，不再硬编码房间名。
			// 原先那份写死了 zjs/zcb/zfyy 三个，zhsq 漏在外面 —— 之所以没出事，
			// 是因为前端 apps/jndv/data/seats.js 取不到 res.data.rooms[room] 时会退回 list.filter 兜底。
			// 布局每新增一个房间就要改一次这里，不如直接按数据聚合，服务端本来也不需要认识房间清单。
			const rooms = {}
			for (const row of rows) {
				if (!rooms[row.room]) rooms[row.room] = []
				rooms[row.room].push(row)
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
			const room = (body.room || '').trim()
			const name = (body.name || '').trim()
			const pinyin = (body.pinyin || '').trim()
			const work = (body.work || '').trim()
			const sex = body.sex === 0 || body.sex === '0' ? 0 : 1
			const leader = Boolean(body.leader)
			const username = req.user?.username || 'user'

			if (!seatId || isNaN(version)) {
				return base.respFailure({ msg: '缺少必填参数 seatId 或 version' })
			}
			// room 只在「这一格还没建过行」时用于 INSERT，所以它必须与 seatId 自洽（seatId 形如 zhsq-c3-r3）。
			// 对不上就拒掉，免得建出 room 与格位不符的野行 —— 那种行 select 会当成另一个房间的座位返回
			if (!room || !seatId.startsWith(`${room}-`)) {
				return base.respFailure({ msg: '座位参数不合法：room 与 seatId 不一致' })
			}

			// upsert + 乐观锁原子写入
			//
			// 为什么不是纯 UPDATE：「库里没有这一行」在业务上等于「这个格位还没有人坐过」，不是异常。
			// 布局新增一个房间、或某个房间扩出一列/一行时，那些格位在库里天然没有行，
			// 纯 UPDATE 会让它们永远存不进去（一路报「未找到指定座位」）。
			// 之所以敢把「不存在」当新建：仓库没有删除接口 —— clear_seat 是把内容字段写回空值，
			// 行本身始终留着（seat_id/version 是后续编辑的锚点）。所以「行不存在」只可能意味着「从没建过」，
			// 不会把「刚被人删掉」误判成新建。
			//
			// 乐观锁靠 DO UPDATE 分支上的 WHERE 保住：
			//   行不存在       → 走 INSERT，version 直接落 2
			//   行在且版本相符 → 走 DO UPDATE，version + 1
			//   行在但版本不符 → WHERE 不成立，不插也不写，rowCount = 0
			// 新行为什么落 2 而不是 1：前端对没有库行的格位补的是 version = 1（见 apps/jndv/data/seats.js），
			// 那把 1 已经被这次写入消耗掉了。若这里落 1，两个客户端同时首次写入时后到的那个
			// 会撞上 `version = 1` 成立而被放行，前一份内容被无声覆盖 —— 正好是乐观锁要挡的事。
			const updateRes = await db.query(
				`
				INSERT INTO public.jndv_seat (id, room, seat_id, name, pinyin, work, sex, leader, version, createtime, updatetime, updateby)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 2, (now() AT TIME ZONE 'Asia/Shanghai'), (now() AT TIME ZONE 'Asia/Shanghai'), $9)
				ON CONFLICT (seat_id) DO UPDATE
				SET name = EXCLUDED.name,
				    pinyin = EXCLUDED.pinyin,
				    work = EXCLUDED.work,
				    sex = EXCLUDED.sex,
				    leader = EXCLUDED.leader,
				    version = jndv_seat.version + 1,
				    updatetime = (now() AT TIME ZONE 'Asia/Shanghai'),
				    updateby = EXCLUDED.updateby
				WHERE jndv_seat.version = $10
				RETURNING id, room, seat_id as "seatId", name, pinyin, work, sex, leader, version,
				          to_char(updatetime, 'YYYY-MM-DD HH24:MI:SS') as updatetime, updateby
			`,
				[base.getId(), room, seatId, name, pinyin, work, sex, leader, username, version],
			)

			if (updateRes.rowCount === 0) {
				// 行不存在的话上面必然插入成功，所以走到这里只可能是版本冲突。
				// 回查一次是为了把当前版本号告诉前端（前端据此提示「重新加载后再改」）
				const checkExist = await db.query('SELECT version FROM public.jndv_seat WHERE seat_id = $1', [seatId])
				return base.respFailure({
					msg: '该座位已被他人修改，再次保存将覆盖对方的内容',
					currentVersion: checkExist.rows?.[0]?.version,
				})
			}

			// 保存后弹窗里的「最后修改」要当场换成操作者的昵称，所以顺手带上：
			// 前端 handle_saved 会把整个 data 合并回本地座位对象，少了它就得等下次刷新才显示昵称。
			// 这里用 id 精确命中（Token 里带的就是 base_user.id，主键唯一），
			// 比再拿 username 查一次可靠 —— username 上没有唯一索引。
			// 查不到（账号已删）或昵称为空都退回账户名，与 select 侧同一口径。
			const nicknameRes = await db.query('SELECT nickname FROM public.base_user WHERE id = $1 LIMIT 1', [req.user.userId])
			const updatebyName = String(nicknameRes?.rows?.[0]?.nickname || '').trim() || updateRes.rows[0].updateby

			return base.respSuccess({
				msg: '保存成功',
				data: { ...updateRes.rows[0], updatebyName },
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
