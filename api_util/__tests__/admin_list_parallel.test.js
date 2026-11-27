import { beforeEach, describe, expect, it, vi } from 'vitest'

import { generateAccessToken } from '#api_util/jwt.js'

const db = (await import('#api_util/db.js')).default
const mockQuery = vi.fn()

beforeEach(() => {
	mockQuery.mockReset()
	db.query = (...args) => mockQuery(...args)
})

function make_resp() {
	const out = { status: 200, json: null }
	const resp = {
		status(code) {
			out.status = code
			return resp
		},
		json(data) {
			out.json = data
			return resp
		},
		setHeader() {},
		end() {},
	}
	return { resp, out }
}

async function call(handler, url, headers = {}) {
	const { resp, out } = make_resp()
	await handler({ url, method: 'GET', query: {}, headers }, resp)
	return out
}

const admin_token = () => `Bearer ${generateAccessToken({ userId: 'admin001', username: 'admin', role: 'admin' })}`

function deferred_queries() {
	const pending = new Map()
	const started = []
	const start = (key, sql) => {
		started.push(key)
		return new Promise(resolve => pending.set(key, () => resolve(sql)))
	}
	return { pending, started, start }
}

describe('后台列表查询并行化', () => {
	it('AI 模型列表：count 与 list 同时发出，响应结构不变', async () => {
		const ai = (await import('../../api/_base/ai.js')).default
		const q = deferred_queries()
		mockQuery.mockImplementation(sql => {
			if (sql.includes('SELECT COUNT(*)') && sql.includes('base_ai m JOIN')) return q.start('count', { rows: [{ count: '2' }] })
			if (sql.includes('SELECT m.id')) return q.start('list', { rows: [{ id: 'm1', name: 'DeepSeek' }] })
			return Promise.resolve({ rows: [] })
		})

		const promise = call(ai, '/api/base/ai/admin_models?current=1&pageSize=20', { authorization: admin_token() })
		await new Promise(resolve => setImmediate(resolve))
		expect(q.started).toEqual(['count', 'list'])

		q.pending.get('count')()
		q.pending.get('list')()
		const out = await promise

		expect(out.status).toBe(200)
		expect(out.json.code).toBe(0)
		expect(out.json.total).toBe(2)
		expect(out.json.data).toHaveLength(1)
	})

	it('AI 服务商列表：count 与 list 同时发出', async () => {
		const ai = (await import('../../api/_base/ai.js')).default
		const q = deferred_queries()
		mockQuery.mockImplementation(sql => {
			if (sql.includes('SELECT p.id')) return q.start('list', { rows: [{ id: 'p1', name: 'DeepSeek' }] })
			if (sql.includes('SELECT COUNT(*)') && sql.includes('base_ai_provider')) return q.start('count', { rows: [{ count: '1' }] })
			return Promise.resolve({ rows: [] })
		})

		const promise = call(ai, '/api/base/ai/admin_providers?current=1&pageSize=20', { authorization: admin_token() })
		await new Promise(resolve => setImmediate(resolve))
		expect(q.started).toEqual(['count', 'list'])

		q.pending.get('count')()
		q.pending.get('list')()
		const out = await promise
		expect(out.json.code).toBe(0)
		expect(out.json.total).toBe(1)
	})

	it('FC 列表：count 与 list 并行，分类查询在 list 返回后才发出', async () => {
		const fc = (await import('../../api/_fc.js')).default
		const q = deferred_queries()
		mockQuery.mockImplementation(sql => {
			if (sql.includes('SELECT COUNT(*) FROM fc')) return q.start('count', { rows: [{ count: '1' }] })
			if (sql.includes('FROM fc') && sql.includes('LIMIT')) return q.start('list', { rows: [{ id: 'g1', name: '马里奥' }] })
			if (sql.includes('fc_category_link')) return q.start('category', { rows: [{ fcId: 'g1', id: 'c1', name: '动作' }] })
			return Promise.resolve({ rows: [] })
		})

		const promise = call(fc, '/api/fc/select?page=1&pageSize=20')
		await new Promise(resolve => setImmediate(resolve))
		expect(q.started).toEqual(['count', 'list'])

		q.pending.get('count')()
		q.pending.get('list')()
		await new Promise(resolve => setImmediate(resolve))
		expect(q.started).toEqual(['count', 'list', 'category'])

		q.pending.get('category')()
		const out = await promise
		expect(out.json.code).toBe(0)
		expect(out.json.total).toBe(1)
		expect(out.json.data[0].categories).toEqual([{ id: 'c1', name: '动作' }])
	})

	it('音乐列表：count 与 list 同时发出', async () => {
		const music = (await import('../../api/_music.js')).default
		const q = deferred_queries()
		mockQuery.mockImplementation(sql => {
			if (sql.includes('SELECT COUNT(*)') && sql.includes('"music"')) return q.start('count', { rows: [{ count: '1' }] })
			if (sql.includes('SELECT * FROM "music"')) return q.start('list', { rows: [{ id: 's1', title: '歌' }] })
			return Promise.resolve({ rows: [] })
		})

		const promise = call(music, '/api/music/select?isAdmin=true&page=1&pageSize=20')
		await new Promise(resolve => setImmediate(resolve))
		expect(q.started).toEqual(['count', 'list'])

		q.pending.get('count')()
		q.pending.get('list')()
		const out = await promise
		expect(out.json.code).toBe(0)
		expect(out.json.total).toBe(1)
	})

	it('AI 空结果：count=0 且 data=[]，不伪造记录', async () => {
		const ai = (await import('../../api/_base/ai.js')).default
		mockQuery.mockImplementation(sql => {
			if (sql.includes('SELECT COUNT(*)')) return Promise.resolve({ rows: [{ count: '0' }] })
			return Promise.resolve({ rows: [] })
		})

		const out = await call(ai, '/api/base/ai/admin_models?current=3&pageSize=20', { authorization: admin_token() })
		expect(out.json.code).toBe(0)
		expect(out.json.total).toBe(0)
		expect(out.json.data).toEqual([])
	})

	it('AI 筛选/分页绑定不变：count 不带分页，list 追加 pageSize/offset', async () => {
		const ai = (await import('../../api/_base/ai.js')).default
		const calls = []
		mockQuery.mockImplementation((sql, binds) => {
			calls.push({ sql, binds })
			if (sql.includes('SELECT COUNT(*)')) return Promise.resolve({ rows: [{ count: '1' }] })
			return Promise.resolve({ rows: [{ id: 'm1', name: 'DeepSeek' }] })
		})

		const out = await call(ai, '/api/base/ai/admin_models?name=deep&status=1&current=2&pageSize=10', { authorization: admin_token() })
		expect(out.json.code).toBe(0)
		const count = calls.find(call => call.sql.includes('SELECT COUNT(*)'))
		const list = calls.find(call => call.sql.includes('SELECT m.id'))
		expect(count.binds).toEqual(['%deep%', 1])
		expect(list.binds).toEqual(['%deep%', 1, 10, 10])
	})

	it('FC 空列表：不查询分类，返回 total=0 与空数组', async () => {
		const fc = (await import('../../api/_fc.js')).default
		const calls = []
		mockQuery.mockImplementation(sql => {
			calls.push(sql)
			if (sql.includes('SELECT COUNT(*) FROM fc')) return Promise.resolve({ rows: [{ count: '0' }] })
			if (sql.includes('LIMIT')) return Promise.resolve({ rows: [] })
			if (sql.includes('fc_category_link')) return Promise.resolve({ rows: [] })
			return Promise.resolve({ rows: [] })
		})

		const out = await call(fc, '/api/fc/select?page=1&pageSize=20')
		expect(out.json.code).toBe(0)
		expect(out.json.total).toBe(0)
		expect(out.json.data).toEqual([])
		expect(calls.some(sql => sql.includes('fc_category_link'))).toBe(false)
	})

	it('并行查询任一失败时仍走原错误响应，不返回半成品', async () => {
		const ai = (await import('../../api/_base/ai.js')).default
		mockQuery.mockImplementation(sql => {
			if (sql.includes('SELECT COUNT(*)')) return Promise.reject(new Error('count failed'))
			return Promise.reject(new Error('list failed'))
		})

		const out = await call(ai, '/api/base/ai/admin_models?current=1&pageSize=20', { authorization: admin_token() })
		expect(out.json.code).toBe(-1)
		expect(out.json.msg).toContain('获取模型失败')
	})
})
