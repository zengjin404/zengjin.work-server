/**
 * api/_base/app.js 单元测试
 *
 * 覆盖：
 *  - 首页公开列表只返回 public + show + status
 *  - 管理端 CRUD 必须是管理员
 *  - 分类写入只接受六大正式分类，旧分类 / 未定义分类被拒绝
 *  - >2 分类允许保存但返回提醒
 *  - 元数据审查接口
 *  - 分类迁移标记存在时不再覆盖现有分类
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { generateAccessToken } from '#api_util/jwt.js'

const db = (await import('#api_util/db.js')).default
const mockQuery = vi.fn()
const release = vi.fn()

const EMPTY = { rows: [], rowCount: 0 }
const admin_token = () => `Bearer ${generateAccessToken({ userId: 'admin001', username: 'admin' })}`
const user_token = () => `Bearer ${generateAccessToken({ userId: 'user001', username: 'tester' })}`

let rules = []

function sqlOf(call) {
	return String(call[0]).trim()
}

beforeEach(() => {
	rules = []
	mockQuery.mockReset()
	release.mockReset()
	db.query = (...args) => mockQuery(...args)
	db.connect = async () => ({ query: (...args) => mockQuery(...args), release })

	mockQuery.mockImplementation(async (sql, binds = []) => {
		const text = String(sql).trim()
		for (const rule of rules) {
			const hit = rule(text, binds)
			if (hit !== undefined) return hit
		}

		if (text.startsWith('CREATE') || text.startsWith('ALTER')) return EMPTY
		if (text.includes("SET id = 'cameracapture'")) return EMPTY
		if (text.includes('SELECT COUNT(*) AS total FROM base_app')) return { rows: [{ total: '1' }] }
		if (text.includes('SELECT COUNT(*) FROM base_app')) return { rows: [{ count: '100' }] }
		if (text.includes('SELECT 1 FROM base_app_migration')) return { rows: [{ exists: 1 }] }
		if (text.includes('FROM base_app') && text.includes('WHERE show = true')) return { rows: [], rowCount: 0 }
		if (text.includes('SELECT id, name, title, category, visibility')) return { rows: [], rowCount: 0 }
		if (text.startsWith('SELECT * FROM base_app')) return { rows: [], rowCount: 0 }
		const lower = text.toLowerCase()
		if (lower.startsWith('insert into base_app')) return { rows: [], rowCount: 1 }
		if (lower.startsWith('update base_app')) return { rows: [], rowCount: 1 }
		if (lower.startsWith('delete from base_app')) return { rows: [], rowCount: 1 }
		if (text.startsWith('BEGIN') || text.startsWith('COMMIT') || text.startsWith('ROLLBACK')) return EMPTY
		return EMPTY
	})

	vi.resetModules()
})

async function load_app_module() {
	return await import('../../api/_base/app.js')
}

async function load_app() {
	return (await load_app_module()).default
}

async function call_api(handler, url, method = 'GET', { headers = {}, body = {}, query = {} } = {}) {
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
	await handler(req, resp)
	return out
}

describe('app.get.home — 公开应用清单', () => {
	it('只返回 public + show=true + status=1，并按推荐/排序输出', async () => {
		const handler = await load_app()
		rules.push((text, binds) => {
			if (text.includes('FROM base_app') && text.includes('WHERE show = true')) {
				return { rows: [{ name: 'ai', title: 'Zen AI 对话', category: 'efficiency' }], rowCount: 1 }
			}
			return undefined
		})

		const res = await call_api(handler, '/api/base/app/home')

		expect(res.json.code).toBe(0)
		expect(res.json.data).toHaveLength(1)
		const homeSql = mockQuery.mock.calls.map(sqlOf).find(text => text.includes('WHERE show = true'))
		expect(homeSql).toContain(`COALESCE(visibility, 'public') = 'public'`)
		expect(homeSql).toContain('ORDER BY featured DESC, sort DESC, createtime ASC')
	})
})

describe('app 管理端 — 鉴权', () => {
	it('未登录查询返回 401', async () => {
		const handler = await load_app()
		const res = await call_api(handler, '/api/base/app/select')
		expect(res.status).toBe(401)
	})

	it('管理员查询按排序权重降序，同权重按应用标识排序', async () => {
		const handler = await load_app()
		rules.push((text, binds) => {
			if (text.includes('from base_app') && text.includes('limit')) return { rows: [], rowCount: 0 }
			if (text.includes('count(*) as total from base_app')) return { rows: [{ total: '0' }] }
			return undefined
		})

		const res = await call_api(handler, '/api/base/app/select?page=1&size=10', 'GET', { headers: { authorization: admin_token() } })

		expect(res.json.code).toBe(0)
		const selectSql = mockQuery.mock.calls.map(sqlOf).find(text => text.includes('from base_app') && text.includes('limit'))
		expect(selectSql.toLowerCase()).toContain(
			'order by base_app.featured desc, base_app.show desc, base_app.status desc, base_app.sort desc, base_app.name asc',
		)
	})

	it('普通登录用户查询返回 403', async () => {
		const handler = await load_app()
		const res = await call_api(handler, '/api/base/app/select', 'GET', { headers: { authorization: user_token() } })
		expect(res.status).toBe(403)
		expect(res.json.msg).toContain('无操作权限')
	})
})

describe('app 写入 — 分类校验', () => {
	it('非法分类被拒绝', async () => {
		const handler = await load_app()
		const res = await call_api(handler, '/api/base/app/insert', 'POST', {
			headers: { authorization: admin_token() },
			body: { name: 'bad', title: '坏应用', category: 'unknown_cat' },
		})
		expect(res.json.code).toBe(-1)
		expect(res.json.msg).toContain('未定义或已停用的分类')
	})

	it('旧分类不允许继续写入', async () => {
		const handler = await load_app()
		const res = await call_api(handler, '/api/base/app/insert', 'POST', {
			headers: { authorization: admin_token() },
			body: { name: 'legacy', title: '旧分类应用', category: 'daily' },
		})
		expect(res.json.code).toBe(-1)
		expect(res.json.msg).toContain('daily')
	})

	it('合法分类会去重并按输入顺序保存', async () => {
		const handler = await load_app()
		const res = await call_api(handler, '/api/base/app/insert', 'POST', {
			headers: { authorization: admin_token() },
			body: { name: 'good', title: '好应用', category: ['media', 'efficiency', 'media'], visibility: 'public' },
		})
		expect(res.json.code).toBe(0)
		const insertCall = mockQuery.mock.calls.find(call => sqlOf(call).startsWith('insert into base_app'))
		expect(insertCall).toBeTruthy()
		expect(insertCall[1]).toContain('media,efficiency')
	})

	it('超过两个分类允许保存但返回提醒', async () => {
		const handler = await load_app()
		const res = await call_api(handler, '/api/base/app/insert', 'POST', {
			headers: { authorization: admin_token() },
			body: { name: 'many', title: '多分类应用', category: ['efficiency', 'media', 'dev'] },
		})
		expect(res.json.code).toBe(0)
		expect(res.json.msg).toContain('3 个分类')
	})

	it('可见性只允许 public / private / admin', async () => {
		const handler = await load_app()
		const res = await call_api(handler, '/api/base/app/update', 'POST', {
			headers: { authorization: admin_token() },
			body: { id: 'app001', visibility: 'hidden' },
		})
		expect(res.json.code).toBe(-1)
		expect(res.json.msg).toContain('public / private / admin')
	})
})

describe('app 元数据审查', () => {
	it('返回汇总、分类统计与问题列表', async () => {
		const handler = await load_app()
		rules.push((text, binds) => {
			if (text.includes('SELECT id, name, title, category, visibility')) {
				return {
					rows: [
						{ id: 'a1', name: 'ai', title: 'AI', category: 'efficiency', visibility: 'public', status: 1, show: true },
						{ id: 'a2', name: 'bad', title: '坏应用', category: 'daily', visibility: 'public', status: 1, show: true },
					],
					rowCount: 2,
				}
			}
			return undefined
		})

		const res = await call_api(handler, '/api/base/app/validate', 'GET', { headers: { authorization: admin_token() } })
		expect(res.json.code).toBe(0)
		expect(res.json.data.summary.total).toBe(2)
		expect(res.json.data.summary.invalidCategoryRecords).toBe(1)
		expect(res.json.data.issues.some(issue => issue.code === 'app_category_legacy_in_use')).toBe(true)
	})
})

describe('app 分类迁移（部署期执行）', () => {
	it('迁移标记存在时不再扫描并覆盖应用分类', async () => {
		const appModule = await load_app_module()
		await appModule.ensure_dbInitialized_async()
		const migrationScan = mockQuery.mock.calls.map(sqlOf).find(text => text.includes('SELECT id, name, category, visibility, show FROM base_app'))
		expect(migrationScan).toBeFalsy()
	})

	it('迁移标记不存在时按归属清单更新并写入标记', async () => {
		const appModule = await load_app_module()
		rules.push((text, binds) => {
			if (text.includes('SELECT 1 FROM base_app_migration')) return { rows: [] }
			if (text.includes('SELECT id, name, category, visibility, show FROM base_app')) {
				return { rows: [{ id: 'a1', name: 'camera', category: 'dev', visibility: 'public', show: true }], rowCount: 1 }
			}
			return undefined
		})

		await appModule.ensure_dbInitialized_async()

		const updateCall = mockQuery.mock.calls.find(call => sqlOf(call).includes('UPDATE base_app SET category = $1'))
		expect(updateCall).toBeTruthy()
		expect(updateCall[1][0]).toBe('system')

		const markerCall = mockQuery.mock.calls.find(call => sqlOf(call).includes('INSERT INTO base_app_migration'))
		expect(markerCall).toBeTruthy()
	})
})
