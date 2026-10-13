import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock 数据库操作
const mockQuery = vi.fn()

vi.mock('../db.js', () => ({
	default: {
		query: (...args) => mockQuery(...args),
	},
}))

// Mock auth 校验中间件
vi.mock('../auth_middleware.js', () => ({
	checkAuth: vi.fn((req, resp) => {
		if (req.headers && req.headers.authorization && req.headers.authorization.includes('valid-token')) {
			// 字段名必须与真实中间件一致：auth_middleware.js:46 挂的是 userId，不是 id。
			// 保存分支要拿它去 base_user 查「最后编辑人」的昵称，名字写错不会报错，
			// 只会静默退化成账户名 —— 测试也就跟着测不到昵称那条路。
			req.user = { userId: 'u123', username: 'tester_zengjin', role: 'admin' }
			return true
		}
		resp.status(401).json({ code: -1, msg: '未登录或登录已过期，请重新登录' })
		return false
	}),
	// 问答门走的是「登录可选」的非写入式认证：没有 Token 时返回 null，绝不自己写响应
	verifyAuth: vi.fn(async req => {
		if (req?.headers?.authorization?.includes('valid-token')) {
			req.user = { userId: 'u123', username: 'tester_zengjin' }
			return req.user
		}
		return null
	}),
}))

const base = (await import('../base.js')).default

// 响应对象 mock
const mockJson = vi.fn().mockImplementation(data => data)
const mockStatus = vi.fn().mockReturnValue({ json: mockJson })

// 动态载入 jndvHandler
const jndvHandler = (await import('../../api/_jndv.js')).default

describe('jndv 业务模块单元测试', () => {
	beforeEach(() => {
		mockQuery.mockReset()
		mockJson.mockClear()
		mockStatus.mockClear()
		base.resp = { status: mockStatus }
	})

	describe('GET /api/jndv/select - 座位数据查询', () => {
		it('应能正确初始化表并查询全量座位，自动按房间聚合并带出所有必要字段', async () => {
			// 1. mock 建表和 count 查询（顺序即 ensure_dbInitialized_async 里的执行顺序）
			mockQuery.mockResolvedValueOnce({ rows: [] }) // CREATE TABLE jndv_seat
			mockQuery.mockResolvedValueOnce({ rows: [] }) // ALTER TABLE 补 pinyin 列
			mockQuery.mockResolvedValueOnce({ rows: [] }) // CREATE INDEX
			mockQuery.mockResolvedValueOnce({ rows: [] }) // CREATE TABLE jndv_unlock
			// 时间列迁移：seat 还是 timestamptz（要走 ALTER TYPE），unlock 已是 timestamp（跳过 ALTER TYPE）。
			// 两张表都要走那步「把默认值钉成北京时间」的 SET DEFAULT —— 它不跟着类型判断走。
			mockQuery.mockResolvedValueOnce({ rows: [{ data_type: 'timestamp with time zone' }] }) // 查 jndv_seat.updatetime 类型
			mockQuery.mockResolvedValueOnce({ rows: [] }) // ALTER TABLE jndv_seat ... TYPE ... USING ...
			mockQuery.mockResolvedValueOnce({ rows: [] }) // ALTER TABLE jndv_seat ... SET DEFAULT ...
			mockQuery.mockResolvedValueOnce({ rows: [{ data_type: 'timestamp without time zone' }] }) // 查 jndv_unlock.updatetime 类型
			mockQuery.mockResolvedValueOnce({ rows: [] }) // ALTER TABLE jndv_unlock ... SET DEFAULT ...
			mockQuery.mockResolvedValueOnce({ rows: [{ count: '34' }] }) // COUNT(*) > 0，无需补种子

			// 2. mock SELECT 查询全量座位
			const fakeSeats = [
				{
					id: 'id1',
					room: 'zjs',
					seatId: 'zjs-c1-r1',
					name: '刘玉娇',
					work: '项目总监',
					sex: 0,
					leader: true,
					version: 1,
					updatetime: '2026-10-10 10:00:00',
					updateby: 'system',
				},
				{
					id: 'id2',
					room: 'zcb',
					seatId: 'zcb-c1-r1',
					name: '黄江伟',
					work: '通讯',
					sex: 1,
					leader: false,
					version: 1,
					updatetime: '2026-10-10 10:00:00',
					updateby: 'system',
				},
			]
			mockQuery.mockResolvedValueOnce({ rows: fakeSeats })

			const req = {
				method: 'GET',
				url: '/api/jndv/select',
				query: { action: ['jndv', 'select'] },
				headers: {},
			}
			const resp = { status: mockStatus }

			await jndvHandler(req, resp)

			expect(mockStatus).toHaveBeenCalledWith(200)
			expect(mockJson).toHaveBeenCalled()
			const resData = mockJson.mock.calls[0][0]
			expect(resData.code).toBe(0)
			expect(resData.data.list.length).toBe(2)
			expect(resData.data.byRoom.zjs.length).toBe(1)
			expect(resData.data.byRoom.zcb.length).toBe(1)

			// 「最后编辑人」的昵称在读侧解析：座位表只存账户名，昵称得从 base_user 现查。
			// 写成相关子查询而非 LEFT JOIN 的理由见 _jndv.js —— 这里只锁住「查了」和「带回别名」
			const selectSql = mockQuery.mock.calls[mockQuery.mock.calls.length - 1][0]
			expect(selectSql).toContain('public.base_user')
			expect(selectSql).toContain('as "updatebyName"')

			// 时间列迁移：只有还是 timestamptz 的表才 ALTER TYPE，且必须带 USING
			// —— 不带 USING 的 `ALTER COLUMN ... TYPE timestamp` 会按会话时区(UTC)解释，把存量数据整体改错 8 小时
			const alterCalls = mockQuery.mock.calls.filter(c => String(c[0]).includes('ALTER COLUMN createtime TYPE timestamp'))
			expect(alterCalls).toHaveLength(1)
			expect(alterCalls[0][0]).toContain("USING (updatetime AT TIME ZONE 'Asia/Shanghai')")
			expect(alterCalls[0][0]).toContain('ALTER TABLE public.jndv_seat')

			// 默认值那步两张表都要走，且与类型判断无关：
			// 老库的 DEFAULT NOW() 被 ALTER TYPE 原样带过来后，落在无时区列上会按会话时区(UTC)取墙上时间。
			const setDefaultCalls = mockQuery.mock.calls.filter(c =>
				String(c[0]).includes("ALTER COLUMN createtime SET DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')"),
			)
			expect(setDefaultCalls).toHaveLength(2)
			expect(setDefaultCalls.map(c => c[0])).toEqual([
				expect.stringContaining('ALTER TABLE public.jndv_seat'),
				expect.stringContaining('ALTER TABLE public.jndv_unlock'),
			])
		})

		it('按特定 room 查询时，SQL 应当带有 room 参数化过滤', async () => {
			mockQuery.mockResolvedValueOnce({
				rows: [
					{
						id: 'id1',
						room: 'zjs',
						seatId: 'zjs-c1-r1',
						name: '刘玉娇',
						work: '项目总监',
						sex: 0,
						leader: true,
						version: 1,
						updatetime: '2026-10-10 10:00:00',
						updateby: 'system',
					},
				],
			})

			const req = {
				method: 'GET',
				url: '/api/jndv/select?room=zjs',
				query: { action: ['jndv', 'select'], room: 'zjs' },
				headers: {},
			}
			const resp = { status: mockStatus }

			await jndvHandler(req, resp)

			expect(mockStatus).toHaveBeenCalledWith(200)
			const resData = mockJson.mock.calls[0][0]
			expect(resData.code).toBe(0)
			expect(resData.data.list.length).toBe(1)

			// 验证使用了参数化查询，防止 SQL 注入
			const selectCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1]
			expect(selectCall[0]).toContain('WHERE room = $1')
			expect(selectCall[1]).toEqual(['zjs'])

			// 回归锁：updatetime 列是无时区 timestamp（列里存的就是北京时间字面值），读侧必须走 to_char 出字符串。
			// 直出列值会被 node-postgres 按进程时区解析成 Date、序列化成 UTC 的 ISO 串，又绕回「看时间要心算」。
			expect(selectCall[0]).toContain("to_char(updatetime, 'YYYY-MM-DD HH24:MI:SS')")
		})
	})

	describe('POST /api/jndv/update - 座位修改与乐观锁并发控制', () => {
		it('未提供 Token 时，应当被 auth 校验拦截并返回 401', async () => {
			const req = {
				method: 'POST',
				url: '/api/jndv/update',
				query: { action: ['jndv', 'update'] },
				body: { seatId: 'zjs-c1-r1', name: '新名字', version: 1 },
				headers: {},
			}
			const resp = { status: mockStatus }

			await jndvHandler(req, resp)

			expect(mockStatus).toHaveBeenCalledWith(401)
			const resData = mockJson.mock.calls[0][0]
			expect(resData.code).toBe(-1)
			expect(resData.msg).toContain('未登录')
		})

		it('版本号匹配时，应当成功更新并递增版本号 (version = version + 1)，写入当前操作人', async () => {
			const updatedSeat = {
				id: 'id1',
				room: 'zcb',
				seatId: 'zcb-c1-r1',
				name: '黄江伟(改)',
				work: '架构师',
				sex: 1,
				leader: true,
				version: 2,
				updatetime: '2026-10-10 12:00:00',
				updateby: 'tester_zengjin',
			}

			mockQuery.mockResolvedValueOnce({
				rowCount: 1,
				rows: [updatedSeat],
			})
			// upsert 之后紧跟一次昵称查询（按 base_user.id 精确命中 Token 里的 userId）
			mockQuery.mockResolvedValueOnce({ rows: [{ nickname: '超级管理员' }] })

			const req = {
				method: 'POST',
				url: '/api/jndv/update',
				query: { action: ['jndv', 'update'] },
				body: {
					seatId: 'zcb-c1-r1',
					room: 'zcb',
					name: '黄江伟(改)',
					work: '架构师',
					sex: 1,
					leader: true,
					version: 1,
				},
				headers: { authorization: 'Bearer valid-token' },
			}
			const resp = { status: mockStatus }

			await jndvHandler(req, resp)

			expect(mockStatus).toHaveBeenCalledWith(200)
			const resData = mockJson.mock.calls[0][0]
			expect(resData.code).toBe(0)
			expect(resData.data.version).toBe(2)
			expect(resData.data.name).toBe('黄江伟(改)')

			// 写入语句必须是 upsert，且乐观锁谓词挂在 DO UPDATE 分支上（$10 = 前端传来的原版本）
			const updateCall = mockQuery.mock.calls[0]
			expect(updateCall[0]).toContain('INSERT INTO public.jndv_seat')
			expect(updateCall[0]).toContain('ON CONFLICT (seat_id) DO UPDATE')
			expect(updateCall[0]).toContain('version = jndv_seat.version + 1')
			expect(updateCall[0]).toContain('WHERE jndv_seat.version = $10')
			// 写入与回传都必须落在北京时间轴上：列是无时区 timestamp，写 NOW() 会按会话时区(UTC)取墙上时间，
			// 存进去就成了 UTC 字面值。读侧同理要 to_char 出字符串，理由见 select 那条断言。
			expect(updateCall[0]).toContain("updatetime = (now() AT TIME ZONE 'Asia/Shanghai')")
			expect(updateCall[0]).toContain("to_char(updatetime, 'YYYY-MM-DD HH24:MI:SS')")
			expect(updateCall[1]).toEqual([
				expect.any(String), // base.getId() 生成的主键，只在 INSERT 分支用得上
				'zcb',
				'zcb-c1-r1',
				'黄江伟(改)',
				'', // 未传 pinyin 时写入空串
				'架构师',
				1,
				true,
				'tester_zengjin', // 来自 Token 提取的用户，防篡改
				1, // 传入的原版本，落在 DO UPDATE 的 WHERE 上
			])

			// 回包里要带上昵称：前端 handle_saved 把整个 data 合并回本地座位对象，
			// 少了它弹窗里的「最后修改」要等下次刷新才换成人名
			expect(resData.data.updatebyName).toBe('超级管理员')
			const nicknameCall = mockQuery.mock.calls[1]
			expect(nicknameCall[0]).toContain('SELECT nickname FROM public.base_user WHERE id = $1')
			expect(nicknameCall[1]).toEqual(['u123'])
		})

		it('座位在库里还没有行时，应当走 INSERT 新建（新房间/扩列的格位不会永远存不进去）', async () => {
			const createdSeat = {
				id: 'newid',
				room: 'zhsq',
				seatId: 'zhsq-c3-r3',
				name: '测试同事',
				pinyin: '',
				work: 'JAVA',
				sex: 1,
				leader: false,
				version: 2,
				updatetime: '2026-10-13 12:00:00',
				updateby: 'tester_zengjin',
			}

			mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [createdSeat] })
			// 昵称留空（注册后还没设置）→ 必须退回账户名，这一栏不能是空白
			mockQuery.mockResolvedValueOnce({ rows: [{ nickname: '' }] })

			const req = {
				method: 'POST',
				url: '/api/jndv/update',
				query: { action: ['jndv', 'update'] },
				body: { seatId: 'zhsq-c3-r3', room: 'zhsq', name: '测试同事', work: 'JAVA', sex: 1, leader: false, version: 1 },
				headers: { authorization: 'Bearer valid-token' },
			}
			const resp = { status: mockStatus }

			await jndvHandler(req, resp)

			expect(mockStatus).toHaveBeenCalledWith(200)
			expect(mockJson.mock.calls[0][0].code).toBe(0)
			// 新建的行 version 落 2 而不是 1：前端对没有库行的格位补的 1 已经被这次写入消耗掉了，
			// 落 1 会让两个客户端同时首次写入时后到的那个拿着 1 蒙混过关、无声覆盖前一份内容
			const insertCall = mockQuery.mock.calls[0]
			expect(insertCall[0]).toContain('INSERT INTO public.jndv_seat')
			expect(insertCall[0]).toContain(', 2, (now() AT TIME ZONE') // INSERT 分支把 version 写死成 2
			expect(insertCall[1][1]).toBe('zhsq')
			expect(insertCall[1][2]).toBe('zhsq-c3-r3')
			expect(insertCall[1][9]).toBe(1)
			expect(mockJson.mock.calls[0][0].data.version).toBe(2)
			// 无昵称时的兼容口径：nickname || username，不能显示成空白
			expect(mockJson.mock.calls[0][0].data.updatebyName).toBe('tester_zengjin')
		})

		it('room 与 seatId 不一致时，应当拒写（避免建出房间归属错误的野行）', async () => {
			const req = {
				method: 'POST',
				url: '/api/jndv/update',
				query: { action: ['jndv', 'update'] },
				body: { seatId: 'zcb-c1-r1', room: 'zhsq', name: '串房间的写入', version: 1 },
				headers: { authorization: 'Bearer valid-token' },
			}
			const resp = { status: mockStatus }

			await jndvHandler(req, resp)

			const resData = mockJson.mock.calls[0][0]
			expect(resData.code).toBe(-1)
			expect(resData.msg).toContain('room 与 seatId 不一致')
			// 参数校验就该在写库之前发生：一条 SQL 都不该发出去
			expect(mockQuery).not.toHaveBeenCalled()
		})

		it('版本号不匹配（已被他人抢先更新）时，应当触发乐观锁拦截并提示冲突', async () => {
			// rowCount = 0 表示没有找到 seat_id + version 同时匹配的记录
			mockQuery.mockResolvedValueOnce({
				rowCount: 0,
				rows: [],
			})
			// 兜底查存在性：该座位确实存在（但 version 已经变成了 2）
			mockQuery.mockResolvedValueOnce({
				rows: [{ seat_id: 'zcb-c1-r1', version: 2 }],
			})

			const req = {
				method: 'POST',
				url: '/api/jndv/update',
				query: { action: ['jndv', 'update'] },
				body: {
					seatId: 'zcb-c1-r1',
					room: 'zcb',
					name: '后提交的内容',
					work: '测试',
					sex: 1,
					leader: false,
					version: 1, // 旧版本号
				},
				headers: { authorization: 'Bearer valid-token' },
			}
			const resp = { status: mockStatus }

			await jndvHandler(req, resp)

			expect(mockStatus).toHaveBeenCalledWith(200)
			const resData = mockJson.mock.calls[0][0]
			expect(resData.code).toBe(-1)
			expect(resData.msg).toContain('该座位已被他人修改，再次保存将覆盖对方的内容')
		})

		it('缺少必填字段 seatId 或 version 时，应当返回参数缺失错误', async () => {
			const req = {
				method: 'POST',
				url: '/api/jndv/update',
				query: { action: ['jndv', 'update'] },
				body: {
					name: '无 seatId 的测试',
				},
				headers: { authorization: 'Bearer valid-token' },
			}
			const resp = { status: mockStatus }

			await jndvHandler(req, resp)

			expect(mockStatus).toHaveBeenCalledWith(200)
			const resData = mockJson.mock.calls[0][0]
			expect(resData.code).toBe(-1)
			expect(resData.msg).toContain('缺少必填参数 seatId 或 version')
		})
	})
})
