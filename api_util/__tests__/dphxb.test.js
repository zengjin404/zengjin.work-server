import { beforeEach, describe, expect, it, vi } from 'vitest'

import { generateAccessToken } from '#api_util/jwt.js'

import { DphxbPayloadError, sanitize_game_payload } from '../dphxb_schema.js'

const db = (await import('#api_util/db.js')).default
const mockQuery = vi.fn()

beforeEach(() => {
	mockQuery.mockReset()
	db.query = (...args) => mockQuery(...args)
	vi.resetModules()
})

async function load_dphxb() {
	return (await import('../../api/_dphxb.js')).default
}

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

const user_token = () => `Bearer ${generateAccessToken({ userId: 'u_tester_dphxb', username: 'chess_master' })}`

function make_valid_payload(overrides = {}) {
	return {
		requestId: 'req_dphxb_test_001',
		mode: 'pve',
		playerSide: 'cannon',
		aiDifficulty: 'normal',
		winner: 'draw',
		endReason: 'repetition',
		endReasonText: '相同局面累计出现三次，判和！',
		totalPlies: 2,
		cannonsRemaining: 2,
		soldiersRemaining: 17,
		ruleVersion: '1.0.0',
		isNormalFinish: true,
		startedAt: '2026-10-18 10:00:00',
		endedAt: '2026-10-18 10:05:30',
		gameData: {
			initialPieces: [
				{ id: 'c1', side: 'cannon', x: 2, y: 0 },
				{ id: 'c2', side: 'cannon', x: 3, y: 0 },
			],
			finalPieces: [
				{ id: 'c1', side: 'cannon', x: 2, y: 3 },
				{ id: 'c2', side: 'cannon', x: 3, y: 0 },
			],
			moves: [
				{
					ply: 1,
					side: 'cannon',
					type: 'capture',
					from: { x: 2, y: 1, algebraic: 'C2' },
					to: { x: 2, y: 3, algebraic: 'C4' },
					capturedPieceId: 's1',
					soldiersRemaining: 17,
					cannonsRemaining: 2,
					noProgressCount: 0,
				},
				{
					ply: 2,
					side: 'soldier',
					type: 'move',
					from: { x: 0, y: 3, algebraic: 'A4' },
					to: { x: 0, y: 2, algebraic: 'A3' },
					capturedPieceId: null,
					soldiersRemaining: 17,
					cannonsRemaining: 2,
					noProgressCount: 1,
				},
			],
		},
		...overrides,
	}
}

describe('dphxb_schema - 校验与清洗', () => {
	it('合法载荷清洗后字段自洽且补全默认值与残局计算', () => {
		const raw = make_valid_payload()
		const res = sanitize_game_payload(raw)

		expect(res.requestId).toBe('req_dphxb_test_001')
		expect(res.mode).toBe('pve')
		expect(res.winner).toBe('draw')
		expect(res.soldiersRemaining).toBe(17)
		expect(res.gameData.moves).toHaveLength(2)
		expect(res.participants).toHaveLength(2)
		expect(res.enteredEndgameAtPly).toBeNull() // 17 枚兵未进入 <= 2 残局
		expect(res.endgamePlies).toBe(0)
		expect(res.minSoldiersRemaining).toBe(17)
	})

	it('自动将历史模式 pvp 映射为 pvp_local', () => {
		const raw = make_valid_payload({ mode: 'pvp' })
		const res = sanitize_game_payload(raw)
		expect(res.mode).toBe('pvp_local')
	})

	it('拒绝无效的 requestId', () => {
		expect(() => sanitize_game_payload(make_valid_payload({ requestId: '' }))).toThrow(DphxbPayloadError)
		expect(() => sanitize_game_payload(make_valid_payload({ requestId: 'a'.repeat(65) }))).toThrow(DphxbPayloadError)
	})

	it('拒绝无效的胜方或模式', () => {
		expect(() => sanitize_game_payload(make_valid_payload({ winner: 'unknown' }))).toThrow(DphxbPayloadError)
		expect(() => sanitize_game_payload(make_valid_payload({ mode: 'invalid_mode' }))).toThrow(DphxbPayloadError)
	})

	it('大炮获胜时若小兵剩余数大于0则拒收', () => {
		expect(() => sanitize_game_payload(make_valid_payload({ winner: 'cannon', soldiersRemaining: 2 }))).toThrow(DphxbPayloadError)
	})

	it('双炮被困绝杀时胜方若不是小兵则拒收', () => {
		expect(() =>
			sanitize_game_payload(
				make_valid_payload({
					winner: 'cannon',
					endReason: 'cannons_trapped',
					soldiersRemaining: 0,
				}),
			),
		).toThrow(DphxbPayloadError)
	})

	it('走法坐标越界时拒收', () => {
		const raw = make_valid_payload({
			gameData: {
				moves: [
					{
						ply: 1,
						side: 'cannon',
						type: 'move',
						from: { x: 2, y: 0 },
						to: { x: 2, y: 6 }, // 超过最大坐标 5
					},
				],
			},
		})
		expect(() => sanitize_game_payload(raw)).toThrow(DphxbPayloadError)
	})

	it('大炮普通移动斜移时拒收（大炮仅能正交移动）', () => {
		const raw = make_valid_payload({
			totalPlies: 1,
			gameData: {
				moves: [
					{
						ply: 1,
						side: 'cannon',
						type: 'move',
						from: { x: 2, y: 0 },
						to: { x: 3, y: 1 }, // 斜向移动非法
					},
				],
			},
		})
		expect(() => sanitize_game_payload(raw)).toThrow('正交移动')
	})

	it('小兵尝试发起炮击吃子时拒收', () => {
		const raw = make_valid_payload({
			totalPlies: 2,
			gameData: {
				moves: [
					{
						ply: 1,
						side: 'cannon',
						type: 'move',
						from: { x: 2, y: 0 },
						to: { x: 2, y: 1 },
						soldiersRemaining: 18,
					},
					{
						ply: 2,
						side: 'soldier',
						type: 'capture', // 非法
						from: { x: 2, y: 3 },
						to: { x: 2, y: 1 },
						capturedPieceId: 'c1',
					},
				],
			},
		})
		expect(() => sanitize_game_payload(raw)).toThrow('小兵方不能发起炮击吃子')
	})

	it('行棋未遵守交替原则时拒收', () => {
		const raw = make_valid_payload({
			totalPlies: 2,
			gameData: {
				moves: [
					{
						ply: 1,
						side: 'cannon',
						type: 'move',
						from: { x: 2, y: 0 },
						to: { x: 2, y: 1 },
						soldiersRemaining: 18,
					},
					{
						ply: 2,
						side: 'cannon', // 连续两次大炮，未轮换
						type: 'move',
						from: { x: 2, y: 1 },
						to: { x: 2, y: 2 },
						soldiersRemaining: 18,
					},
				],
			},
		})
		expect(() => sanitize_game_payload(raw)).toThrow('未遵守交替行棋规则')
	})

	it('残局统计口径计算：正确识别中间进入 <= 2 残局的步数与持续步数', () => {
		const raw = make_valid_payload({
			totalPlies: 2,
			soldiersRemaining: 2,
			gameData: {
				moves: [
					{
						ply: 1,
						side: 'cannon',
						type: 'capture',
						from: { x: 2, y: 1 },
						to: { x: 2, y: 3 },
						capturedPieceId: 's1',
						soldiersRemaining: 2, // 模拟前序吃子后降至 2
					},
					{
						ply: 2,
						side: 'soldier',
						type: 'move',
						from: { x: 0, y: 3 },
						to: { x: 0, y: 2 },
						soldiersRemaining: 2,
					},
				],
			},
		})
		// 覆盖期望初始为 3 兵进入的残局
		const res = sanitize_game_payload({
			...raw,
			soldiersRemaining: 18,
			gameData: {
				moves: [
					{
						ply: 1,
						side: 'cannon',
						type: 'move',
						from: { x: 2, y: 0 },
						to: { x: 2, y: 1 },
						soldiersRemaining: 18,
					},
					{
						ply: 2,
						side: 'soldier',
						type: 'move',
						from: { x: 0, y: 3 },
						to: { x: 0, y: 2 },
						soldiersRemaining: 18,
					},
				],
			},
		})
		expect(res.enteredEndgameAtPly).toBeNull()

		// 模拟无行棋纯终局载荷残局计算
		const emptyMovesRes = sanitize_game_payload({
			...raw,
			totalPlies: 50,
			soldiersRemaining: 1,
			gameData: { moves: [] },
		})
		expect(emptyMovesRes.enteredEndgameAtPly).toBe(50)
		expect(emptyMovesRes.endgamePlies).toBe(1)
		expect(emptyMovesRes.minSoldiersRemaining).toBe(1)
	})

	it('即使前端伪造 userId，也不会被纳入清洗对象', () => {
		const raw = make_valid_payload({ userId: 'attacker_hacked_id' })
		const res = sanitize_game_payload(raw)
		expect(res.userId).toBeUndefined()
	})
})

describe('api/_dphxb.js - 对局结算与撤回接口', () => {
	function mock_db_init() {
		mockQuery
			.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
			.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE ADD COLUMNS
			.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UNIQUE INDEX request_id
			.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INDEX user_id
			.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INDEX mode
			.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INDEX winner
			.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INDEX endgame
	}

	it('建表语句使用 TIMESTAMP 无时区并带 Asia/Shanghai', async () => {
		mock_db_init()
		mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }) // count recent
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'record_123' }], rowCount: 1 }) // insert

		const handler = await load_dphxb()
		await call_api(handler, '/api/dphxb/finish', 'POST', {}, make_valid_payload())

		const createSql = mockQuery.mock.calls[0][0]
		expect(createSql).toContain('CREATE TABLE IF NOT EXISTS public.dphxb_game_record')
		expect(createSql).toContain("createtime              TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')")
	})

	it('登录用户正常保存，user_id 取自 Token', async () => {
		mock_db_init()
		mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }) // count recent
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rec_auth_001' }], rowCount: 1 }) // insert

		const handler = await load_dphxb()
		const res = await call_api(
			handler,
			'/api/dphxb/finish',
			'POST',
			{
				authorization: user_token(),
			},
			make_valid_payload({ requestId: 'auth_game_1' }),
		)

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(0)
		expect(res.json.data.id).toBe('rec_auth_001')
		expect(res.json.data.repeated).toBe(false)

		// 检查 INSERT 参数中的 user_id 是 Token 解出的 userId
		const insertCall = mockQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO public.dphxb_game_record'))
		expect(insertCall).toBeTruthy()
		expect(insertCall[1][3]).toBe('u_tester_dphxb')
	})

	it('未登录用户正常保存，user_id 存为 null', async () => {
		mock_db_init()
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rec_anon_001' }], rowCount: 1 }) // insert

		const handler = await load_dphxb()
		const res = await call_api(handler, '/api/dphxb/finish', 'POST', {}, make_valid_payload({ requestId: 'anon_game_1' }))

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(0)
		expect(res.json.data.id).toBe('rec_anon_001')

		const insertCall = mockQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO public.dphxb_game_record'))
		expect(insertCall[1][3]).toBeNull()
	})

	it('幂等重试命中：返回已存在记录 ID，标记 repeated: true', async () => {
		mock_db_init()
		mockQuery.mockResolvedValueOnce({ rows: [] }) // ON CONFLICT DO NOTHING 返回空 rows
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing_id_999' }] }) // 回查已有行

		const handler = await load_dphxb()
		const res = await call_api(handler, '/api/dphxb/finish', 'POST', {}, make_valid_payload({ requestId: 'dup_req_1' }))

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(0)
		expect(res.json.data.id).toBe('existing_id_999')
		expect(res.json.data.repeated).toBe(true)
		expect(res.json.msg).toContain('已存在')
	})

	it('终局后悔棋替代机制：传入 supersededRequestId 时自动标记旧记录失效并建立关联', async () => {
		mock_db_init()
		mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }) // count recent
		mockQuery.mockResolvedValueOnce({ rowCount: 1 }) // UPDATE superseded
		mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rec_new_branch' }], rowCount: 1 }) // insert

		const handler = await load_dphxb()
		const res = await call_api(
			handler,
			'/api/dphxb/finish',
			'POST',
			{ authorization: user_token() },
			make_valid_payload({
				requestId: 'req_new_002',
				supersededRequestId: 'req_old_001',
			}),
		)

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(0)

		const updateCall = mockQuery.mock.calls.find(c => String(c[0]).includes('UPDATE public.dphxb_game_record SET is_superseded = true'))
		expect(updateCall).toBeTruthy()
		expect(updateCall[1][1]).toBe('req_old_001')
	})

	it('actions.post.revoke 能够主动将指定对局标记为失效', async () => {
		mock_db_init()
		mockQuery.mockResolvedValueOnce({ rowCount: 1 }) // UPDATE

		const handler = await load_dphxb()
		const res = await call_api(handler, '/api/dphxb/revoke', 'POST', {}, { requestId: 'req_to_revoke' })

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(0)
		expect(res.json.data.superseded).toBe(true)

		const revokeCall = mockQuery.mock.calls.find(c => String(c[0]).includes('UPDATE public.dphxb_game_record SET is_superseded = true'))
		expect(revokeCall).toBeTruthy()
		expect(revokeCall[1][0]).toBe('req_to_revoke')
	})

	it('登录用户限频拦截：一分钟超过 15 局时拦截', async () => {
		mock_db_init()
		mockQuery.mockResolvedValueOnce({ rows: [{ total: '15' }] }) // 达到 15 局

		const handler = await load_dphxb()
		const res = await call_api(
			handler,
			'/api/dphxb/finish',
			'POST',
			{
				authorization: user_token(),
			},
			make_valid_payload(),
		)

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(-1)
		expect(res.json.msg).toContain('过于频繁')
	})
})
