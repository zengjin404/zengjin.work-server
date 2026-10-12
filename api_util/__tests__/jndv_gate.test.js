/**
 * jndv 前置问答门单元测试
 *
 *   bunx vitest run
 *
 * 这道门的契约有三条不能破：
 *   1. 答案只活在 api_util/jndv_gate.js，**任何响应体里都不许出现**（含题干接口）；
 *   2. 未登录答对给一张自签凭证，已登录答对落库，两条路都不能互相污染（不写库的别写、该写库的别漏）；
 *   3. 凭证是唯一的放行依据之一，伪造/过期/改版一律当没通过。
 * 所以下面除了行为断言，还专门锁了一条「响应 JSON 里不出现答案字面量」的回归。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock 数据库操作：默认实现按 SQL 给形状，免得建表流程里的 COUNT(*) 读到 undefined
const mockQuery = vi.fn(async sql => {
	// COUNT(*) 是 ensure_dbInitialized_async 里唯一会被读结果的一步，返回非零即可跳过补种子
	if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { rows: [{ count: '34' }], rowCount: 1 }
	return { rows: [], rowCount: 0 }
})

vi.mock('../db.js', () => ({
	default: {
		query: (...args) => mockQuery(...args),
	},
}))

vi.mock('../auth_middleware.js', () => ({
	checkAuth: vi.fn(async () => false),
	// 问答门用的「登录可选」认证：无 Token 返回 null，不写响应
	verifyAuth: vi.fn(async req => {
		if (req?.headers?.authorization?.includes('valid-token')) {
			req.user = { userId: 'u_gate_1', username: 'tester_gate' }
			return req.user
		}
		return null
	}),
}))

const base = (await import('../base.js')).default
const { check_answer, gate_public_info, jndv_gate, verify_jndv_ticket } = await import('../jndv_gate.js')
const jndvHandler = (await import('../../api/_jndv.js')).default

const mockJson = vi.fn().mockImplementation(data => data)
const mockStatus = vi.fn().mockReturnValue({ json: mockJson })

const RIGHT_ANSWER = jndv_gate.answers[0]

function make_req({ method = 'GET', url = '/api/jndv/gate', body = {}, headers = {} } = {}) {
	return { method, url, query: {}, body, headers }
}

/** 打一次接口并取回响应体（base.respSuccess/respFailure 都是 HTTP 200 + {code,msg,...}） */
async function call(req) {
	await jndvHandler(req, { status: mockStatus })
	return mockJson.mock.calls[mockJson.mock.calls.length - 1][0]
}

/** 从 mock 的调用记录里找写 jndv_unlock 的那次查询 */
function unlock_writes() {
	return mockQuery.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO public.jndv_unlock'))
}

/** 取一张真实有效的通过凭证（走一遍未登录答对的路） */
async function fetch_ticket() {
	const res = await call(make_req({ method: 'POST', body: { answer: RIGHT_ANSWER }, headers: { 'x-forwarded-for': 'ip-ticket' } }))
	return res.data.ticket
}

beforeEach(() => {
	mockQuery.mockClear()
	mockJson.mockClear()
	mockStatus.mockClear()
	base.resp = { status: mockStatus }
})

describe('答案判定：check_answer()', () => {
	it('认得出名单里的每一位', () => {
		jndv_gate.answers.forEach(name => expect(check_answer(name)).toBe(true))
	})

	it('容忍首尾空格、姓名中间夹空格、大小写（英文/拼音写法）', () => {
		expect(check_answer(`  ${RIGHT_ANSWER}  `)).toBe(true)
		expect(check_answer(RIGHT_ANSWER.split('').join(' '))).toBe(true)
		expect(check_answer('ABC')).toBe(false) // 反例：非名单内容
	})

	it('一次填了多位符合条件的同事，任一位命中即通过', () => {
		expect(check_answer(`${jndv_gate.answers[0]}、${jndv_gate.answers[1]}`)).toBe(true)
		expect(check_answer(`${jndv_gate.answers[0]}, ${jndv_gate.answers[2]}`)).toBe(true)
	})

	it('错答案、空答案一律不通过', () => {
		expect(check_answer('张三')).toBe(false)
		expect(check_answer('')).toBe(false)
		expect(check_answer(undefined)).toBe(false)
		expect(check_answer(null)).toBe(false)
	})
})

describe('下发内容：gate_public_info()', () => {
	it('只出题干/提示/版本，答案名单绝不跟着出门', () => {
		const info = gate_public_info()
		expect(Object.keys(info).sort()).toEqual(['hint', 'question', 'version'])
		const serialized = JSON.stringify(info)
		jndv_gate.answers.forEach(name => expect(serialized).not.toContain(name))
	})
})

describe('GET /api/jndv/gate - 判定是否已通过', () => {
	it('未登录且无凭证：不通过，并下发题干与提示', async () => {
		const res = await call(make_req())

		expect(mockStatus).toHaveBeenCalledWith(200)
		expect(res.code).toBe(0)
		expect(res.data.passed).toBe(false)
		expect(res.data.question).toBe(jndv_gate.question)
		expect(res.data.hint).toBe(jndv_gate.hint)
		expect(res.data.version).toBe(jndv_gate.version)
	})

	it('【回归锁】整份响应里不出现任何答案字面量', async () => {
		const res = await call(make_req())
		const serialized = JSON.stringify(res)
		jndv_gate.answers.forEach(name => expect(serialized).not.toContain(name))
	})

	it('已有有效凭证：放行，且不再重复下发题干', async () => {
		const ticket = await fetch_ticket()
		mockJson.mockClear()

		const res = await call(make_req({ headers: { 'x-jndv-pass': ticket } }))

		expect(res.data.passed).toBe(true)
		expect(res.data.question).toBeUndefined()
		expect(res.data.hint).toBeUndefined()
	})

	it('伪造的凭证不作数', async () => {
		const res = await call(make_req({ headers: { 'x-jndv-pass': 'not-a-real-ticket' } }))

		expect(res.data.passed).toBe(false)
		expect(verify_jndv_ticket('not-a-real-ticket')).toBe(false)
	})

	it('已登录且库中版本相符：无凭证也放行', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [{ gate_version: jndv_gate.version }], rowCount: 1 })

		const res = await call(make_req({ headers: { authorization: 'Bearer valid-token' } }))

		expect(res.data.passed).toBe(true)
		// 查的是当前登录用户
		const lookup = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('FROM public.jndv_unlock'))
		expect(lookup[1]).toEqual(['u_gate_1'])
	})

	it('已登录但库里是旧版本（改过题没重答）：仍不通过', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [{ gate_version: jndv_gate.version + 1 }], rowCount: 1 })

		const res = await call(make_req({ headers: { authorization: 'Bearer valid-token' } }))

		expect(res.data.passed).toBe(false)
		expect(res.data.question).toBe(jndv_gate.question)
	})
})

describe('POST /api/jndv/gate - 提交答案', () => {
	it('未登录答对：发一张能验过的凭证，且不写库', async () => {
		const res = await call(make_req({ method: 'POST', body: { answer: RIGHT_ANSWER }, headers: { 'x-forwarded-for': 'ip-anon-ok' } }))

		expect(res.code).toBe(0)
		expect(res.data.passed).toBe(true)
		expect(res.data.saved).toBe(false)
		expect(verify_jndv_ticket(res.data.ticket)).toBe(true)
		expect(unlock_writes()).toHaveLength(0)
	})

	it('已登录答对：标记落库（按 user_id upsert），并如实回报 saved', async () => {
		const res = await call(
			make_req({
				method: 'POST',
				body: { answer: ` ${RIGHT_ANSWER} ` },
				headers: { authorization: 'Bearer valid-token', 'x-forwarded-for': 'ip-user-ok' },
			}),
		)

		expect(res.code).toBe(0)
		expect(res.data.saved).toBe(true)
		expect(verify_jndv_ticket(res.data.ticket)).toBe(true)

		const writes = unlock_writes()
		expect(writes).toHaveLength(1)
		expect(writes[0][0]).toContain('ON CONFLICT (user_id)')
		// 值一律走参数，且用户身份取自 Token 而不是请求体
		expect(writes[0][1].slice(1)).toEqual(['u_gate_1', 'tester_gate', jndv_gate.version])
	})

	it('答错：不通过、不发凭证、不写库，也不透露是哪一项不满足', async () => {
		const res = await call(make_req({ method: 'POST', body: { answer: '张三' }, headers: { 'x-forwarded-for': 'ip-wrong' } }))

		expect(res.code).toBe(-1)
		expect(res.data).toBeUndefined()
		expect(unlock_writes()).toHaveLength(0)
		expect(res.msg).not.toContain('入职')
		expect(res.msg).not.toContain('在职')
	})

	it('同一 IP 连续答错超过上限后被限流，连正确答案也先拦下', async () => {
		const headers = { 'x-forwarded-for': 'ip-flood' }
		for (let i = 0; i < 5; i++) {
			await call(make_req({ method: 'POST', body: { answer: '张三' }, headers }))
		}

		const res = await call(make_req({ method: 'POST', body: { answer: RIGHT_ANSWER }, headers }))

		expect(res.code).toBe(-1)
		expect(res.msg).toContain('稍后再试')
	})
})

describe('POST /api/jndv/claim - 未登录答对后登录，补记到账号', () => {
	it('未登录：明确失败且不写库（用 verifyAuth 而非 checkAuth，不写成 401）', async () => {
		const ticket = await fetch_ticket()

		const res = await call(make_req({ method: 'POST', url: '/api/jndv/claim', body: { ticket } }))

		expect(mockStatus).toHaveBeenCalledWith(200)
		expect(res.code).toBe(-1)
		expect(res.msg).toContain('未登录')
		expect(unlock_writes()).toHaveLength(0)
	})

	it('已登录 + 有效凭证：补记成功', async () => {
		const ticket = await fetch_ticket()

		const res = await call(make_req({ method: 'POST', url: '/api/jndv/claim', body: { ticket }, headers: { authorization: 'Bearer valid-token' } }))

		expect(res.code).toBe(0)
		expect(res.data.passed).toBe(true)
		expect(unlock_writes()).toHaveLength(1)
	})

	it('凭证无效：拒绝且不写库（防止拿别人的话说自己通过了）', async () => {
		const res = await call(
			make_req({ method: 'POST', url: '/api/jndv/claim', body: { ticket: 'forged' }, headers: { authorization: 'Bearer valid-token' } }),
		)

		expect(res.code).toBe(-1)
		expect(unlock_writes()).toHaveLength(0)
	})
})
