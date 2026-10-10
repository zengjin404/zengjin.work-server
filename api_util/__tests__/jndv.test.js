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
			req.user = { id: 'u123', username: 'tester_zengjin', role: 'admin' }
			return true
		}
		resp.status(401).json({ code: -1, msg: '未登录或登录已过期，请重新登录' })
		return false
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
			// 1. mock 建表和 count 查询
			mockQuery.mockResolvedValueOnce({ rows: [] }) // CREATE TABLE
			mockQuery.mockResolvedValueOnce({ rows: [] }) // CREATE INDEX
			mockQuery.mockResolvedValueOnce({ rows: [{ count: '34' }] }) // COUNT(*) > 0

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

			const req = {
				method: 'POST',
				url: '/api/jndv/update',
				query: { action: ['jndv', 'update'] },
				body: {
					seatId: 'zcb-c1-r1',
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

			// 验证 UPDATE SQL 必须携带乐观锁版本号谓词与更新人
			const updateCall = mockQuery.mock.calls[0]
			expect(updateCall[0]).toContain('WHERE seat_id = $6 AND version = $7')
			expect(updateCall[0]).toContain('version = version + 1')
			expect(updateCall[1]).toEqual([
				'黄江伟(改)',
				'架构师',
				1,
				true,
				'tester_zengjin', // 来自 Token 提取的用户，防篡改
				'zcb-c1-r1',
				1, // 传入的原版本
			])
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
