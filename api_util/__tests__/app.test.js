/**
 * api/_base/app.js 单元测试
 *
 * 覆盖重点：
 *  - get.home:  首页公开列表 SQL 结构（show & status 过滤、featured/sort 排序）、响应格式化
 *  - 种子幂等：  计数不足 presets.length 时用 ON CONFLICT 增量补齐（不覆盖已存在行）
 *  - 鉴权门槛：  select/insert 等管理端操作在未登录时被 requireAuth 拒绝（401）
 *
 * 关键：所有数据查询均通过 mock 的 db.query，验证 SQL 使用 $n 参数化，不拼接用户数据。
 * 注意：app 模块持有模块级 dbInitialized 缓存，故每个用例前 vi.resetModules() 重新加载；
 *       db 单例由 global.dbPools 缓存，resetModules 后仍是同一个实例，运行时补丁持续生效。
 *       （曾用「给 import 路径拼查询串」做缓存破坏，但 vite 分析不了变量拼接的说明符，
 *       运行时报 Unknown variable dynamic import，已改为与 ai.test.js 同一套做法。）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { generateAccessToken } from '#api_util/jwt.js'

// ============================================================
// Mock 层：运行时替换真实 db 单例的 query
// 刻意不用 vi.mock('#api_util/db.js')：bun 的 mock 注册表跨文件共享，
// 会与 crud.test.js 的 db mock（同一模块 ID）冲突；运行时补丁只影响本文件。
// ============================================================
const db = (await import('#api_util/db.js')).default
const mockQuery = vi.fn()

beforeEach(() => {
	mockQuery.mockReset()
	// 每次把真实池实例的 query 替换为 spy（Pool.prototype.query 被实例属性遮蔽）
	db.query = (...args) => mockQuery(...args)
	vi.resetModules() // 重置 app 模块级 dbInitialized，使 ensure 每个用例都真实执行
})

// 重新导入一份全新的 app 模块（模块级 dbInitialized 状态随之重置），返回其 default handler
async function load_app() {
	return (await import('../../api/_base/app.js')).default
}

// 构造一次 HTTP 调用，记录 resp.status 与 body（模块内部会自行注入 base.req/base.resp）
async function call_api(appHandler, url, method, headers = {}, body = {}, query = {}) {
	const out = {}
	const resp = {
		status(code) {
			out.status = code
			return { json: data => (out.json = data) }
		},
		setHeader() {},
		end() {},
	}
	const req = { url, method, query, body, headers }
	await appHandler(req, resp)
	return out
}

// 生成管理员访问令牌（vitest 已注入 JWT_SECRET）
const admin_token = () => `Bearer ${generateAccessToken({ userId: 'admin001', username: 'admin' })}`

// 默认 mock：ensure 阶段 6 个查询 (建表/索引/image迁移/category扩容/老数据刷正/计数)
function mock_ensure(count = '31') {
	mockQuery
		.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
		.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE INDEX
		.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE (image 列迁移)
		.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE (category 列扩容)
		.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE (老分类迁移)
		.mockResolvedValueOnce({ rows: [{ count }] }) // SELECT COUNT
}

beforeEach(() => {
	mockQuery.mockReset()
})

describe('app.get.home — 首页公开列表', () => {
	it('仅返回 show=true 且 status=1 的应用，并按 featured/sort 排序', async () => {
		const appHandler = await load_app()
		mock_ensure('31')
		mockQuery.mockResolvedValueOnce({
			rows: [
				{ name: 'ai', title: 'Zen AI 对话', featured: 1, sort: 10 },
				{ name: 'jq', title: '军旗卡牌', featured: 0, sort: 100 },
			],
			rowCount: 2,
		})

		const res = await call_api(appHandler, '/api/base/app/home', 'GET')

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(0)
		expect(res.json.data).toHaveLength(2)

		// 校验过滤与排序 SQL（过滤条件写死在 SQL 层，不拼接用户输入）
		const homeSql = mockQuery.mock.calls[6][0]
		expect(homeSql).toContain('WHERE show = true AND status = 1')
		expect(homeSql).toContain('ORDER BY featured DESC, sort ASC, createtime ASC')
		// 封面图字段必须随列表返回（大卡封面 / 图标降级共用）
		expect(homeSql).toContain('image')
	})

	it('种子缺失时以 ON CONFLICT 幂等补插（不覆盖已存在行）', async () => {
		const appHandler = await load_app()
		// 表里只有 1 行（< presets.length），应触发补种
		mock_ensure('1')
		mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })

		await call_api(appHandler, '/api/base/app/home', 'GET')

		// 6 次 ensure 查询 (建表/索引/image迁移/category扩容/老分类迁移/计数) 之后的所有调用都是 INSERT
		const insertCalls = mockQuery.mock.calls.slice(6)
		expect(insertCalls.length).toBeGreaterThanOrEqual(31)
		const insertSql = insertCalls[0][0]
		expect(insertSql).toContain('INSERT INTO base_app')
		expect(insertSql).toContain('ON CONFLICT (name) DO NOTHING')
		// 参数化占位符而非拼接
		expect(insertSql).toContain('$14')
		const binds = insertCalls[0][1]
		expect(typeof binds[0]).toBe('string')
		expect(binds[0].length).toBeGreaterThan(0)
	})

	it('home 查询异常时返回失败而非抛出', async () => {
		const appHandler = await load_app()
		// 建表/种子正常，但首页列表查询本身失败
		mock_ensure('31')
		mockQuery.mockRejectedValueOnce(new Error('connection refused'))

		const res = await call_api(appHandler, '/api/base/app/home', 'GET')

		expect(res.json.code).toBe(-1)
		expect(res.json.msg).toContain('查询失败')
	})
})

describe('app 管理端操作 — 未登录拦截', () => {
	it('select 无 token 应被 requireAuth 拒绝（401 未提供认证令牌）', async () => {
		const appHandler = await load_app()
		mock_ensure('31')
		mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })

		const res = await call_api(appHandler, '/api/base/app/select', 'GET', {})

		expect(res.status).toBe(401)
		expect(res.json.msg).toContain('未提供认证令牌')
		// 鉴权失败后不应发起列表数据查询（排除 ensure 的 SELECT COUNT）
		const selectCalls = mockQuery.mock.calls.filter(c => String(c[0]).toLowerCase().includes('select base_app'))
		expect(selectCalls).toHaveLength(0)
	})

	it('insert 无 token 应被 requireAuth 拒绝（401）', async () => {
		const appHandler = await load_app()
		mock_ensure('31')
		mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })

		const res = await call_api(appHandler, '/api/base/app/insert', 'POST', {})

		expect(res.status).toBe(401)
		const insertCalls = mockQuery.mock.calls.filter(c => String(c[0]).toLowerCase().includes('insert'))
		expect(insertCalls).toHaveLength(0)
	})

	it('无 token 访问公开 home 仍可正常放行', async () => {
		const appHandler = await load_app()
		mock_ensure('31')
		mockQuery.mockResolvedValueOnce({ rows: [{ name: 'ai' }], rowCount: 1 })

		const res = await call_api(appHandler, '/api/base/app/home', 'GET', {})

		expect(res.json.code).toBe(0)
		expect(res.json.data).toHaveLength(1)
	})
})

describe('app 管理端操作 — 登录后 CRUD', () => {
	const token = admin_token()

	it('insert: fields 必须包含 id 且首绑定为新生成主键', async () => {
		const appHandler = await load_app()
		mock_ensure('31')
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'newid' }], rowCount: 1 })

		const res = await call_api(
			appHandler,
			'/api/base/app/insert',
			'POST',
			{ Authorization: token },
			{ name: 'testapp', title: '测试应用', category: 'tool', show: true },
		)

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(0)
		expect(res.json.msg).toBe('新增成功')

		// 定位 INSERT 语句（ensure 阶段的 CREATE/COUNT 之后）
		const insertCall = mockQuery.mock.calls.find(c => String(c[0]).startsWith('insert into base_app'))
		expect(insertCall).toBeTruthy()
		const [insertSql, binds] = insertCall
		expect(insertSql).toContain('insert into base_app (id,')
		// 主键由 base.getId() 生成并作为 $1 绑定
		expect(typeof binds[0]).toBe('string')
		expect(binds[0].length).toBeGreaterThan(0)
	})

	it('update: 仅更新 body 中提供的字段，按 id 定位', async () => {
		const appHandler = await load_app()
		mock_ensure('31')
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'app001' }], rowCount: 1 })

		const res = await call_api(appHandler, '/api/base/app/update', 'POST', { Authorization: token }, { id: 'app001', title: '改名后的应用' })

		expect(res.json.code).toBe(0)
		expect(res.json.msg).toContain('编辑成功')

		const updateCall = mockQuery.mock.calls.find(c => String(c[0]).startsWith('update base_app'))
		expect(updateCall).toBeTruthy()
		const [updateSql, binds] = updateCall
		// crud 会追加 updatetime 作为最后更新的列
		expect(updateSql).toContain('set title = $1')
		expect(updateSql).toContain('where id = $3')
		// 参数化：业务值 + 时间戳 + id，无字符串拼接
		expect(binds[0]).toBe('改名后的应用')
		expect(typeof binds[1]).toBe('string')
		expect(binds[1].length).toBeGreaterThan(0)
		expect(binds[2]).toBe('app001')
	})

	it('delete: 按 id 物理删除', async () => {
		const appHandler = await load_app()
		mock_ensure('31')
		mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 })

		const res = await call_api(appHandler, '/api/base/app/delete', 'POST', { Authorization: token }, { id: 'app001' })

		expect(res.json.code).toBe(0)
		expect(res.json.msg).toContain('删除成功')

		const deleteCall = mockQuery.mock.calls.find(c => String(c[0]).startsWith('delete from base_app'))
		expect(deleteCall).toBeTruthy()
		expect(deleteCall[0]).toContain('where id = $1')
		expect(deleteCall[1]).toEqual(['app001'])
	})
})
