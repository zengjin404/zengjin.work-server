/**
 * api/_base/seal.js + api_util/seal_schema.js 单元测试
 *
 * 覆盖重点（都是「不信客户端」这条线上的具体断言）：
 *  - 归属只认会话：user_id 来自 Token，请求体里带 userId / createdAt 一律拒收
 *  - 时间只由服务端/库生成：createtime 写在 SQL 里
 *  - 记录永久保留：没有保留期字段、没有清理端点（cleanup 未匹配任何动作）
 *  - 白名单是拒收不是夹取：未知字段、越界数值、非法 shape、超深/超大载荷都过不去
 *  - demoMark 没有开关：一份带 enabled 的快照进不来（与前端「策略不是配置」对齐）
 *  - 幂等与限频：同 requestId 重放不重复插，窗口内超量直接挡回
 *
 * 与 app.test.js 同一套做法：运行时替换真实 db 单例的 query（不 vi.mock('#api_util/db.js')，
 * 避免与其它测试文件共享 mock 注册表），并在每个用例前 vi.resetModules() 重置模块级 dbInitialized。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { generateAccessToken } from '#api_util/jwt.js'

const db = (await import('#api_util/db.js')).default
const mockQuery = vi.fn()

beforeEach(() => {
	mockQuery.mockReset()
	db.query = (...args) => mockQuery(...args)
	vi.resetModules() // 重置 seal 模块级 dbInitialized，使建表逻辑每个用例都真实执行
})

/** 重新导入一份全新的 seal 模块，返回其 default handler */
async function load_seal() {
	return (await import('../../api/_base/seal.js')).default
}

/** 构造一次 HTTP 调用，返回 { status, json } */
async function call_api(handler, url, method, headers = {}, body = {}) {
	const out = {}
	const resp = {
		status(code) {
			out.status = code
			return { json: data => (out.json = data) }
		},
		setHeader() {},
		end() {},
	}
	const req = { url, method, query: {}, body, headers }
	await handler(req, resp)
	return out
}

const user_token = () => `Bearer ${generateAccessToken({ userId: 'u123', username: 'tester_zengjin' })}`
const admin_token = () => `Bearer ${generateAccessToken({ userId: 'admin001', username: 'admin' })}`

/** 建表阶段 3 条语句：CREATE TABLE + 用户索引 + 幂等唯一索引 */
function mock_ensure() {
	mockQuery
		.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
		.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE INDEX (user_id, createtime)
		.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE UNIQUE INDEX (user_id, request_id)
}

/**
 * 一份合法配置
 *
 * 字段与边界必须与前端 apps/seal/utils/seal-defaults.js 的 sanitize_config 输出、以及
 * api_util/seal_schema.js 的 CONFIG_SPEC 三方一致 —— 这份 fixture 就是那个契约的样本。
 */
function make_config() {
	const font = 'SimSun, "宋体", serif'
	return {
		version: 1,
		templateId: 'round-demo',
		shape: 'circle',
		color: '#C83232',
		preview: { background: 'checkerboard', showGuides: false },
		output: { size: 512, transparent: true, backgroundColor: '#FFFFFF' },
		mainText: {
			visible: true,
			text: '示例演示科技有限公司',
			fontFamily: font,
			fontWeight: 700,
			fontSize: 48,
			letterSpacing: 2,
			radius: 110,
			startAngle: -90,
			scaleX: 1,
			offsetX: 0,
			offsetY: 0,
		},
		subText: {
			visible: false,
			text: '',
			fontFamily: font,
			fontWeight: 400,
			fontSize: 18,
			letterSpacing: 1,
			radius: 130,
			startAngle: -60,
			scaleX: 1,
			offsetX: 0,
			offsetY: 0,
		},
		sampleCode: { visible: false, text: '', fontFamily: font, fontWeight: 400, fontSize: 14, letterSpacing: 1, radius: 90, offsetX: 0, offsetY: 0 },
		bottomText: {
			visible: true,
			text: '演示样章',
			fontFamily: font,
			fontWeight: 500,
			fontSize: 20,
			letterSpacing: 4,
			scaleX: 1,
			scaleY: 1,
			offsetX: 0,
			offsetY: 60,
		},
		centerText: { visible: false, text: '', fontFamily: font, fontWeight: 400, fontSize: 40, letterSpacing: 0, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
		centerSymbol: { visible: true, mode: 'star', customChar: '', fontFamily: font, size: 60, fontWeight: 400, offsetX: 0, offsetY: 0 },
		borders: {
			outer: { visible: true, color: '#C83232', width: 4, inset: 6, dashed: false, segments: 60, gapRatio: 3 },
			inner: { visible: true, color: '#C83232', width: 1.5, gap: 10 },
			center: { visible: false, color: '#C83232', width: 2, radius: 60 },
		},
		effects: {
			noise: { enabled: true, intensity: 20, seed: 12345 },
			edgeWear: { enabled: true, intensity: 15, seed: 999 },
			scratches: { enabled: false, intensity: 10, seed: 7 },
		},
		demoMark: { text: '演示样章', opacity: 0.22, rotation: -25 },
	}
}

/** 一份合法外壳；overrides 用于构造各种非法载荷 */
function make_payload(overrides = {}) {
	const config = make_config()
	return {
		eventType: 'clean_export_requested',
		templateId: config.templateId,
		shape: config.shape,
		outputFormat: 'png',
		outputSize: config.output.size,
		rendererVersion: '1',
		requestId: 'm9k2p1x-4f7a2b9c',
		configSnapshot: config,
		...overrides,
	}
}

const insert_calls = () => mockQuery.mock.calls.filter(c => String(c[0]).includes('INSERT INTO public.base_seal_export_log'))

describe('seal.record — 导出记录写入', () => {
	it('未登录时被认证中间件拦下：写真实 401，且一条写库语句都不发', async () => {
		const sealHandler = await load_seal()
		mock_ensure()

		const res = await call_api(sealHandler, '/api/base/seal/record', 'POST', {}, make_payload())

		expect(res.status).toBe(401)
		expect(res.json.code).toBe(-1)
		expect(insert_calls()).toHaveLength(0)
	})

	it('登录用户写入成功：user_id 取自 Token、时间由 SQL 生成、只回 recordId', async () => {
		const sealHandler = await load_seal()
		mock_ensure()
		mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }) // 限频计数
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rec001' }] }) // INSERT ... RETURNING id

		const res = await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, make_payload())

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(0)
		expect(res.json.data).toEqual({ recordId: 'rec001' })

		const [sql, params] = insert_calls()[0]
		// 归属来自会话：第 2 个参数是 Token 里的 userId，请求体里没有能覆盖它的位置
		expect(params[1]).toBe('u123')
		// 幂等键唯一索引 + DO NOTHING：同一次导出的重放不会变成两条
		expect(sql).toContain('ON CONFLICT (user_id, request_id) DO NOTHING')
		// 服务端时间：now() 只出现一次(createtime 的默认值)，客户端没有任何字段能影响它；
		// 也没有任何「到期时间」列 —— 记录一旦写入就永久保留
		expect(sql.match(/now\(\) AT TIME ZONE 'Asia\/Shanghai'/g)).toHaveLength(1)
		expect(sql).not.toContain('retention')
		// 参数恰好 10 个：没有任何额外的数值/日期参数能被塞进来
		expect(params).toHaveLength(10)
		// 参数数组里不该出现任何日期字面量（时间只能来自库）
		expect(params.some(v => typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v))).toBe(false)
		// 快照以 JSON 字符串入库（jsonb 列），且就是白名单走出来的那一份
		expect(JSON.parse(params[9]).demoMark).toEqual({ text: '演示样章', opacity: 0.22, rotation: -25 })
	})

	it('请求体里自报身份/时间的字段一律拒收（身份与时序只由服务端决定）', async () => {
		const sealHandler = await load_seal()
		mock_ensure()

		// 逐个字段单独试：一次塞三个的话，只要有一个被拦就够了，另外两个白名单有没有漏就测不出来
		for (const field of ['userId', 'username', 'createdAt', 'createtime', 'timestamp', 'ip', 'userAgent']) {
			const res = await call_api(
				sealHandler,
				'/api/base/seal/record',
				'POST',
				{ authorization: user_token() },
				make_payload({ [field]: 'attacker-supplied' }),
			)

			expect(res.status).toBe(200)
			expect(res.json.code).toBe(-1)
			expect(res.json.reason).toBe('invalid_payload')
			expect(res.json.msg).toContain('含未知字段: ' + field)
		}

		expect(insert_calls()).toHaveLength(0)
	})

	it('未知字段过不去：连 demoMark 里塞一个 enabled 都会被拒（策略不是配置）', async () => {
		const sealHandler = await load_seal()
		mock_ensure()

		const payload = make_payload()
		payload.configSnapshot.demoMark.enabled = false

		const res = await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, payload)

		expect(res.json.code).toBe(-1)
		expect(res.json.msg).toContain('demoMark 含未知字段: enabled')
		expect(insert_calls()).toHaveLength(0)
	})

	it('越界数值与非法形状：拒收而不是夹取（夹取会把构造的请求洗成正常记录）', async () => {
		const sealHandler = await load_seal()
		mock_ensure()
		mockQuery.mockResolvedValue({ rows: [{ total: '0' }] })

		const tooBig = make_payload()
		tooBig.configSnapshot.mainText.fontSize = 999
		const resBig = await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, tooBig)
		expect(resBig.json.code).toBe(-1)
		expect(resBig.json.msg).toContain('超出范围 6 ~ 90')

		const badShape = make_payload({ shape: 'hexagon' })
		const resShape = await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, badShape)
		expect(resShape.json.code).toBe(-1)
		expect(resShape.json.msg).toContain('payload.shape')

		// 非十六进制颜色（前端会产出 #RRGGBB / #RRGGBBAA 两种，别的都不认）
		const badColor = make_payload()
		badColor.configSnapshot.color = 'red'
		const resColor = await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, badColor)
		expect(resColor.json.code).toBe(-1)

		expect(insert_calls()).toHaveLength(0)
	})

	it('外壳与快照必须自洽：templateId / shape / outputSize 对不上就拒收', async () => {
		const sealHandler = await load_seal()
		mock_ensure()

		// 三项都要单独试：外壳值本身都是合法枚举，只有「与快照不一致」这一条能拦下它们，
		// 少一项就少一道 —— 列上是 A、快照里是 B 的记录比没有记录还糟
		const cases = [
			{ override: { outputSize: 2048 }, message: 'outputSize 与配置快照不一致' },
			{ override: { shape: 'square' }, message: 'shape 与配置快照不一致' },
			{ override: { templateId: 'tpl-other' }, message: 'templateId 与配置快照不一致' },
		]

		for (const item of cases) {
			const res = await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, make_payload(item.override))
			expect(res.json.code).toBe(-1)
			expect(res.json.msg).toContain(item.message)
		}

		expect(insert_calls()).toHaveLength(0)
	})

	it('超深与超大载荷在解构前就被挡下', async () => {
		const sealHandler = await load_seal()
		mock_ensure()

		// 深度：payload → a → b → c → d → e，超过上限 5
		const deep = make_payload()
		deep.configSnapshot.extra = { a: { b: { c: { d: 1 } } } }
		const resDeep = await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, deep)
		expect(resDeep.json.code).toBe(-1)
		expect(resDeep.json.msg).toContain('嵌套层数超过上限')

		// 体积：往合法字段里灌长文本，先撞 40/60 字上限也不要紧，这里要的是 64KB 那道闸
		const huge = make_payload()
		huge.configSnapshot.mainText.text = 'x'.repeat(70 * 1024)
		const resHuge = await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, huge)
		expect(resHuge.json.code).toBe(-1)
		expect(resHuge.json.msg).toContain('载荷超过 64KB 上限')

		expect(insert_calls()).toHaveLength(0)
	})

	it('限频：窗口内记录数到顶时挡回，且不再写库', async () => {
		const sealHandler = await load_seal()
		mock_ensure()
		mockQuery.mockResolvedValueOnce({ rows: [{ total: '10' }] })

		const res = await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, make_payload())

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(-1)
		expect(res.json.reason).toBe('rate_limited')
		expect(insert_calls()).toHaveLength(0)

		// 计数本身要按用户+时间窗过滤，且用参数化绑定（不把 userId 拼进 SQL）
		const [sql, params] = mockQuery.mock.calls[3]
		expect(sql).toContain('WHERE user_id = $1 AND createtime > (now() AT TIME ZONE')
		expect(params).toEqual(['u123', 60])
	})

	it('幂等命中：同 requestId 重放不重复插，取回原记录 id 并照常放行', async () => {
		const sealHandler = await load_seal()
		mock_ensure()
		mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] }) // 限频计数
		mockQuery.mockResolvedValueOnce({ rows: [] }) // INSERT ... DO NOTHING 没插进去
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rec_old' }] }) // 取回已存在那条

		const res = await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, make_payload())

		expect(res.json.code).toBe(0)
		expect(res.json.data.recordId).toBe('rec_old')
		// 只尝试了一次插入：幂等靠唯一索引 + ON CONFLICT，不靠重试
		expect(insert_calls()).toHaveLength(1)
		// 调用序：0~2 建表 / 3 限频计数 / 4 INSERT / 5 取回已存在那条
		expect(mockQuery.mock.calls[5][0]).toContain('WHERE user_id = $1 AND request_id = $2')
	})

	it('库异常时不泄露内部细节：统一回一句通用提示', async () => {
		const sealHandler = await load_seal()
		mock_ensure()
		mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] })
		mockQuery.mockRejectedValueOnce(new Error('relation "public.base_seal_export_log" does not exist'))

		const res = await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, make_payload())

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(-1)
		expect(res.json.msg).toBe('服务暂时不可用, 请稍后重试')
		expect(res.json.msg).not.toContain('base_seal_export_log')
	})
})

describe('seal 表结构 — 只存该存的', () => {
	it('建表 SQL：无时区 TIMESTAMP + 北京时间默认值，且没有任何图片/网络标识列', async () => {
		const sealHandler = await load_seal()
		mock_ensure()
		mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] })
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rec001' }] })

		await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, make_payload())

		const createSql = String(mockQuery.mock.calls[0][0])
		expect(createSql).toContain('CREATE TABLE IF NOT EXISTS public.base_seal_export_log')
		expect(createSql).toContain('config_snapshot  JSONB NOT NULL')
		expect(createSql).toContain("createtime       TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')")
		// 不用 timestamptz：列里存的就是北京时间字面值，理由见 _jndv.js 的定案注释
		expect(createSql).not.toContain('TIMESTAMPTZ')
		expect(createSql).not.toContain('timestamp with time zone')

		// 首版不存图片本体，也不存 IP / UA / 指纹 / 图片 URL
		for (const banned of ['image', 'url', 'ip', 'user_agent', 'fingerprint', 'username']) {
			expect(createSql.toLowerCase()).not.toContain(banned)
		}

		// 幂等键必须是唯一索引，否则 ON CONFLICT 没有落点
		const uniqueSql = String(mockQuery.mock.calls[2][0])
		expect(uniqueSql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_base_seal_export_log_request')
		expect(uniqueSql).toContain('(user_id, request_id)')
	})
})

describe('seal 没有清理入口 — 记录一旦写入就永久保留', () => {
	it('cleanup 不是任何动作：连管理员来也只回「未匹配」，且一条 SQL 都不发', async () => {
		const sealHandler = await load_seal()
		mock_ensure()

		const res = await call_api(sealHandler, '/api/base/seal/cleanup', 'POST', { authorization: admin_token() })

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(-1)
		expect(res.json.msg).toBe('请求类型或方法无效')
		// 删不掉才是设计意图：保留策略已整体移除，清理不留在应用里
		expect(mockQuery.mock.calls.some(c => /DELETE|retention/i.test(String(c[0])))).toBe(false)
	})

	it('SQL 层不留残留：没有 retention 字段、没有 DELETE、索引恰好两条', async () => {
		const sealHandler = await load_seal()
		mock_ensure()
		mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] })
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rec001' }] })

		await call_api(sealHandler, '/api/base/seal/record', 'POST', { authorization: user_token() }, make_payload())

		const all_sql = mockQuery.mock.calls.map(c => String(c[0])).join('\n')
		expect(all_sql).not.toMatch(/retention|interval '1 day'|DELETE/i)
		expect(all_sql.match(/CREATE INDEX/g)).toHaveLength(1) // 用户索引
		expect(all_sql.match(/CREATE UNIQUE INDEX/g)).toHaveLength(1) // 幂等唯一索引
		expect(all_sql).not.toContain('idx_base_seal_export_log_retention')
	})
})
