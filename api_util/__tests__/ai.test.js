/**
 * api/_base/ai.js 单元测试
 *
 * 覆盖重点（冷启动 ensure 的存量迁移探测）：
 *  - 旧内联列 (domain/provider/url/key) 已被 DROP 的库，绝不能再 SELECT 这些列
 *    线上故障：column "domain" does not exist 让 /api/base/ai/models 直接返回「服务器处理崩溃」
 *  - 未迁移的存量库仍执行完整回填；清理中断态 (旧列只删了一半) 能补收敛
 *
 * 关键：db 查询全部走 mockQuery，按 SQL 文本分派，不依赖调用序号（ensure 会随分支伸缩）。
 * 注意：ai 模块持有模块级 dbInitialized 缓存，故每个用例前 vi.resetModules() 重新加载；
 *       db 单例由 global.dbPools 缓存，resetModules 后仍是同一个实例，运行时补丁持续生效。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = (await import('#api_util/db.js')).default
const mockQuery = vi.fn()

beforeEach(() => {
	mockQuery.mockReset()
	db.query = (...args) => mockQuery(...args)
	vi.resetModules() // 重置 ai 模块级 dbInitialized，使 ensure 每次用例都真实执行
})

/** 重新加载一份全新的 ai 模块，返回其 default handler */
async function load_ai() {
	return (await import('../../api/_base/ai.js')).default
}

/**
 * 按 SQL 文本分派 mock 结果
 * @param legacyCount  base_ai 旧内联列 (domain/provider/url/key) 尚存的数量
 * @param staleRows    未回链的存量模型行（仅 legacyCount=4 时会被查询）
 * @param orphanCount  providerId 仍为 NULL 的行数
 * @param providerHit  服务商是否已存在（true 则复用其 id，false 走 INSERT）
 */
function mock_db({
	legacyCount = 0,
	staleRows = [],
	orphanCount = '0',
	providerHit = false,
	aiCount = '32',
	modelRows = [{ id: 'm1', name: 'DeepSeek', domain: 'Deepseek' }],
} = {}) {
	mockQuery.mockImplementation(sql => {
		const s = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()

		if (s.includes('information_schema.columns')) {
			return Promise.resolve({ rows: [{ count: String(legacyCount) }], rowCount: 1 })
		}
		if (s.startsWith('select count(*) from base_ai where "providerid" is null')) {
			return Promise.resolve({ rows: [{ count: orphanCount }], rowCount: 1 })
		}
		if (s.startsWith('select count(*) from base_ai')) {
			return Promise.resolve({ rows: [{ count: aiCount }], rowCount: 1 })
		}
		if (s.startsWith('select id, domain, provider, url, key from base_ai')) {
			return Promise.resolve({ rows: staleRows, rowCount: staleRows.length })
		}
		if (s.startsWith('select id from base_ai_provider')) {
			return Promise.resolve({ rows: providerHit ? [{ id: 'p_exist' }] : [], rowCount: providerHit ? 1 : 0 })
		}
		if (s.startsWith('select m.id, m.name')) {
			return Promise.resolve({ rows: modelRows, rowCount: modelRows.length })
		}
		return Promise.resolve({ rows: [], rowCount: 0 })
	})
}

// 构造一次 HTTP 调用，记录 resp.status 与 body（模块内部会自行注入 base.req/base.resp）
async function call_api(handler, url, method = 'GET', body = {}, query = {}) {
	const out = {}
	const resp = {
		status(code) {
			out.status = code
			return { json: data => (out.json = data) }
		},
		setHeader() {},
		end() {},
	}
	await handler({ url, method, query, body, headers: {} }, resp)
	return out
}

// 全部 SQL 文本（小写压缩空白），便于断言「某类语句是否出现」
const sqlLog = () => mockQuery.mock.calls.map(c => String(c[0]).replace(/\s+/g, ' ').trim().toLowerCase())
const has_sql = pattern => sqlLog().some(s => s.includes(pattern))

describe('ai.get.models — 冷启动迁移探测', () => {
	it('旧列已清理的库（legacyCount=0）不得再 SELECT 旧列，接口正常返回', async () => {
		const aiHandler = await load_ai()
		mock_db({ legacyCount: 0 })

		const res = await call_api(aiHandler, '/api/base/ai/models')

		expect(res.json.code).toBe(0)
		expect(res.json.msg).not.toContain('服务器处理崩溃')
		expect(res.json.data).toHaveLength(1)
		// 修复核心：迁移探测声明旧列已不在，就不能再引用 domain/provider/url/key
		expect(has_sql('select id, domain, provider, url, key from base_ai')).toBe(false)
		expect(has_sql('drop column')).toBe(false)
	})

	it('未迁移的存量库（legacyCount=4）仍执行完整回填：建服务商 + 回链 providerId', async () => {
		const aiHandler = await load_ai()
		mock_db({
			legacyCount: 4,
			staleRows: [{ id: 'm1', domain: 'Deepseek', provider: 'openai', url: 'https://api.deepseek.com/chat/completions', key: 'sk-x' }],
		})

		await call_api(aiHandler, '/api/base/ai/models')

		expect(has_sql('select id, domain, provider, url, key from base_ai')).toBe(true)
		expect(has_sql('insert into base_ai_provider')).toBe(true)
		expect(has_sql('update base_ai set "providerid"')).toBe(true)
		// 回链完成 → 收紧 NOT NULL 并清理旧列
		expect(has_sql('alter table base_ai alter column "providerid" set not null')).toBe(true)
		expect(has_sql('drop column if exists domain')).toBe(true)
	})

	it('存量库已有同名服务商时复用其 id，不重复建服务商', async () => {
		const aiHandler = await load_ai()
		mock_db({
			legacyCount: 4,
			providerHit: true,
			staleRows: [{ id: 'm1', domain: 'X', provider: 'openai', url: 'https://x.com/v1', key: 'k1' }],
		})

		await call_api(aiHandler, '/api/base/ai/models')

		expect(has_sql('insert into base_ai_provider')).toBe(false)
		expect(has_sql('update base_ai set "providerid"')).toBe(true)
	})

	it('清理中断态（旧列只删了一部分）只补收尾，不回头 SELECT 旧列', async () => {
		const aiHandler = await load_ai()
		mock_db({ legacyCount: 2 })

		await call_api(aiHandler, '/api/base/ai/models')

		expect(has_sql('select id, domain, provider, url, key from base_ai')).toBe(false)
		expect(has_sql('drop column if exists domain')).toBe(true)
	})

	it('仍有未回链行时保留旧列，等下轮冷启动自愈（不静默破坏数据）', async () => {
		const aiHandler = await load_ai()
		mock_db({ legacyCount: 4, staleRows: [], orphanCount: '3' })

		await call_api(aiHandler, '/api/base/ai/models')

		expect(has_sql('drop column')).toBe(false)
		expect(has_sql('set not null')).toBe(false)
	})
})
