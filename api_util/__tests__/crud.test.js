/**
 * api_util/crud.js 单元测试
 *
 * 测试覆盖（全 Mock 模式）：
 *  - select:  分页查询 SQL 结构正确性、参数化查询、保留字转义
 *  - detail:  单条查询、缺失 id 校验
 *  - insert:  新增记录、auto id、必填校验、保留字转义
 *  - update:  批量修改、缺失 id 校验、保留字（如 desc）双引号安全转义
 *  - delete:  批量删除、缺失 id 校验
 *  - 错误处理：db.query 异常时的容错返回
 *
 * 关键：所有测试验证 SQL 使用 $n 参数化占位符，不拼接用户数据
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Mock 层：在导入 crud 前先 mock db.js
// ============================================================
const mockQuery = vi.fn()

vi.mock('../db.js', () => ({
	default: {
		query: (...args) => mockQuery(...args),
	},
}))

// 先导入 base 并设置 request context mock（base.resp 在模块顶层被引用）
const base = (await import('../base.js')).default

// 模拟 base.resp 响应对象（生产环境中由 AsyncLocalStorage 在请求时注入）
// json() 需要透传参数，因为 respSuccess/respFailure 通过 .json(data) 返回响应数据
const mockJson = vi.fn().mockImplementation(data => data)
const mockStatus = vi.fn().mockReturnValue({ json: mockJson })
base.resp = { status: mockStatus }

// 在 mock 之后动态导入 crud
const crud = await import('../crud.js').then(m => m.default)

// 用 spy 覆盖 getId 和 getTime，让时间相关输出可预测
vi.spyOn(base, 'getId').mockReturnValue('test_id_123')
vi.spyOn(base, 'getTime').mockReturnValue('2026-07-23 15:00:00')

// ============================================================
// select — 分页查询
// ============================================================
describe('crud.get.select', () => {
	const options = {
		table: 'fc',
		fields: ['name', 'maker'],
		valids: [],
		joins: [],
	}

	beforeEach(() => {
		mockQuery.mockReset()
		// 默认 mock：返回空结果
		mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
	})

	it('page ≤ 0 应返回失败', async () => {
		const result = await crud.get.select({ ...options, query: { page: 0, size: 10 } })
		expect(result.code).toBe(-1)
		expect(result.msg).toContain('页码参数无效')
	})

	it('size ≤ 0 应返回失败', async () => {
		const result = await crud.get.select({ ...options, query: { page: 1, size: 0 } })
		expect(result.code).toBe(-1)
		expect(result.msg).toContain('页码参数无效')
	})

	it('首次查询（page=1, size=10）应发起两次 db.query 调用', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [{ id: '1', name: 'test' }], rowCount: 1 }).mockResolvedValueOnce({ rows: [{ total: '100' }] })

		await crud.get.select({ ...options, query: { page: 1, size: 10 } })

		expect(mockQuery).toHaveBeenCalledTimes(2)
		// 第一次：数据查询
		const dataSql = mockQuery.mock.calls[0][0]
		expect(dataSql.toLowerCase()).toContain('order by fc.id desc')
		expect(dataSql.toLowerCase()).toContain('limit')
		expect(dataSql.toLowerCase()).toContain('offset')
	})

	it('带关键词搜索应生成 ILIKE 条件', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [{ total: '0' }] })

		await crud.get.select({
			...options,
			query: { page: 1, size: 10, name: '马里奥' },
		})

		const dataSql = mockQuery.mock.calls[0][0]
		// 应包含 ILIKE 模糊匹配
		expect(dataSql).toContain('ilike')
	})

	it('关键词参数应使用参数化绑定而非字符串拼接', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [{ total: '0' }] })

		await crud.get.select({
			...options,
			query: { page: 1, size: 10, name: 'test' },
		})

		// binds 应包含 %test% 而非直接拼进 SQL
		const binds = mockQuery.mock.calls[0][1]
		expect(binds).toBeDefined()
		expect(binds.length).toBeGreaterThan(0)
		expect(binds[0]).toBe('%test%')
	})

	it('包含 Postgres 保留字列名（如 desc）时应安全转义为 "desc"', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [{ total: '0' }] })

		await crud.get.select({
			table: 'base_app',
			fields: ['title', 'desc'],
			valids: [],
			joins: [],
			query: { page: 1, size: 10, desc: '测试描述' },
		})

		const dataSql = mockQuery.mock.calls[0][0]
		expect(dataSql).toContain('base_app."desc" ilike $1')
	})

	it('db.query 异常时应返回失败而非抛出', async () => {
		mockQuery.mockRejectedValueOnce(new Error('connection refused'))

		const result = await crud.get.select({ ...options, query: { page: 1, size: 10 } })
		expect(result.code).toBe(-1)
		expect(result.msg).toContain('查询失败')
	})
})

// ============================================================
// detail — 单条详情
// ============================================================
describe('crud.get.detail', () => {
	const options = {
		table: 'fc',
		fields: ['name', 'maker'],
		valids: [],
		joins: [],
	}

	beforeEach(() => {
		mockQuery.mockReset()
	})

	it('缺少 id 参数应返回失败', async () => {
		const result = await crud.get.detail({ ...options, query: {} })
		expect(result.code).toBe(-1)
		expect(result.msg).toContain('id 参数缺失')
	})

	it('应使用参数化 id 查询', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc', name: 'test' }], rowCount: 1 })

		await crud.get.detail({ ...options, query: { id: 'abc' } })

		const sql = mockQuery.mock.calls[0][0]
		const binds = mockQuery.mock.calls[0][1]

		// SQL 使用 $1 占位符
		expect(sql).toContain('$1')
		// binds 为 [id]
		expect(binds).toEqual(['abc'])
	})

	it('无匹配记录时返回空对象', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

		const result = await crud.get.detail({ ...options, query: { id: 'nonexistent' } })
		expect(result.code).toBe(0)
		expect(result.data).toEqual({})
	})
})

// ============================================================
// insert — 新增记录
// ============================================================
describe('crud.post.insert', () => {
	const options = {
		table: 'note',
		fields: ['id', 'title', 'content', 'createtime'],
		valids: ['title', 'content'],
	}

	beforeEach(() => {
		mockQuery.mockReset()
	})

	it('缺少必填字段应返回失败', async () => {
		const result = await crud.post.insert({
			...options,
			body: { title: '', content: '' },
		})
		expect(result.code).toBe(-1)
		expect(result.msg).toContain('必要字段缺失')
	})

	it('成功插入应自动生成 id 和 createtime', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'test_id_123' }], rowCount: 1 })

		const result = await crud.post.insert({
			...options,
			body: { title: '测试笔记', content: '内容' },
		})

		expect(result.code).toBe(0)
		expect(result.msg).toContain('新增成功')

		// 验证 SQL 使用参数化占位符
		const sql = mockQuery.mock.calls[0][0]
		expect(sql).toContain('$1')
		expect(sql.toLowerCase()).toContain('returning id')

		// 验证 body.id 被自动注入
		const binds = mockQuery.mock.calls[0][1]
		expect(binds[0]).toBe('test_id_123') // auto id
		expect(binds[1]).toBe('测试笔记') // title
		expect(binds[2]).toBe('内容') // content
	})

	it('包含 Postgres 保留字列名（如 desc）时应安全包裹双引号', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'test_id_123' }], rowCount: 1 })

		await crud.post.insert({
			table: 'base_app',
			fields: ['id', 'title', 'desc'],
			valids: ['title'],
			body: { title: '测试', desc: '描述' },
		})

		const sql = mockQuery.mock.calls[0][0]
		expect(sql).toContain('insert into base_app (id,title,"desc")')
	})

	it('db.query 异常时应返回失败', async () => {
		mockQuery.mockRejectedValueOnce(new Error('duplicate key'))

		const result = await crud.post.insert({
			...options,
			body: { title: 'test', content: 'test' },
		})

		expect(result.code).toBe(-1)
		expect(result.msg).toContain('新增失败')
	})
})

// ============================================================
// update — 修改记录
// ============================================================
describe('crud.post.update', () => {
	const options = {
		table: 'note',
		fields: ['title', 'content', 'status', 'updatetime'],
		valids: [],
	}

	beforeEach(() => {
		mockQuery.mockReset()
	})

	it('缺少 id 参数应返回失败', async () => {
		const result = await crud.post.update({ ...options, body: {} })
		expect(result.code).toBe(-1)
		expect(result.msg).toContain('id 参数缺失')
	})

	// crud.post.update 永远会注入 updatetime，所以即使 body 只有 id，
	// updates 数组中也会有 updatetime 字段，不会触发「字段无效」
	it('即使只传 id，也应自动注入 updatetime 并执行更新', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 })

		const result = await crud.post.update({
			...options,
			body: { id: 'abc' },
		})

		// 注入 updatetime 后应成功
		expect(result.code).toBe(0)
		const sql = mockQuery.mock.calls[0][0]
		// SQL 中应包含 updatetime 字段
		expect(sql).toContain('updatetime')
	})

	it('应使用 $n 参数化占位符（而非 ? 占位符）', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 })

		await crud.post.update({
			...options,
			body: { id: 'abc', title: '新标题', status: '1' },
		})

		const sql = mockQuery.mock.calls[0][0]
		// SQL 应只包含 $n 风格占位符，不包含 ? 占位符
		expect(sql).not.toContain('?')
		expect(sql).toContain('$1')
		expect(sql).toContain('$2')
		expect(sql).toContain('$3')
	})

	it('更新包含 Postgres 保留字列名（如 desc）时应安全包裹双引号防语法错误', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 })

		await crud.post.update({
			table: 'base_app',
			fields: ['title', 'desc', 'updatetime'],
			valids: [],
			body: { id: 'app123', desc: '设备与浏览器信息' },
		})

		const sql = mockQuery.mock.calls[0][0]
		expect(sql).toContain('"desc" = $1')
	})

	it('批量更新：逗号分隔的多个 id', async () => {
		mockQuery.mockResolvedValue({ rows: [], rowCount: 1 })

		const result = await crud.post.update({
			...options,
			body: { id: 'id1,id2,id3', title: '批量修改' },
		})

		expect(result.code).toBe(0)
		expect(mockQuery).toHaveBeenCalledTimes(3) // 三次独立 update
	})
})

// ============================================================
// delete — 删除记录
// ============================================================
describe('crud.post.delete', () => {
	const options = {
		table: 'note',
		fields: [],
		valids: [],
	}

	beforeEach(() => {
		mockQuery.mockReset()
	})

	it('缺少 id 参数应返回失败', async () => {
		const result = await crud.post.delete({ ...options, body: {} })
		expect(result.code).toBe(-1)
		expect(result.msg).toContain('id 参数缺失')
	})

	it('应使用参数化 id 执行删除', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 })

		await crud.post.delete({ ...options, body: { id: 'abc' } })

		const sql = mockQuery.mock.calls[0][0]
		const binds = mockQuery.mock.calls[0][1]

		expect(sql).toContain('$1')
		expect(binds).toEqual(['abc'])
	})

	it('批量删除：逗号分隔的多个 id', async () => {
		mockQuery.mockResolvedValue({ rows: [], rowCount: 1 })

		const result = await crud.post.delete({
			...options,
			body: { id: 'id1,id2,id3' },
		})

		expect(result.code).toBe(0)
		expect(mockQuery).toHaveBeenCalledTimes(3)
	})

	it('部分成功时应返回混合状态', async () => {
		mockQuery
			.mockResolvedValueOnce({ rows: [], rowCount: 1 }) // 成功
			.mockResolvedValueOnce({ rowCount: null }) // 失败（无 rowCount）
			.mockResolvedValueOnce({ rows: [], rowCount: 1 }) // 成功

		const result = await crud.post.delete({
			...options,
			body: { id: 'id1,id2,id3' },
		})

		expect(result.code).toBe(0)
		expect(result.msg).toContain('成功')
		expect(result.msg).toContain('失败')
	})
})
