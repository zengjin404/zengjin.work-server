/**
 * api/_cards.js 单元测试
 *
 * 覆盖重点：
 *  - 公开内容接口：版本未变直接返回 unchanged；版本变化返回分类 / 卡片 / 素材
 *  - 种子幂等：数量不足时用 ON CONFLICT DO NOTHING 补齐
 *  - 进度同步：必须登录；同 key 去重；SQL 用 LEAST / GREATEST 幂等合并
 *  - 管理端：普通用户 403、管理员可写；分类下仍有卡片时禁止删除
 *  - 统计：事件白名单、同请求内重复事件聚合、游客对局不落个人明细
 *
 * 关键：所有 SQL 均经 mock 的 db.query 记录，验证参数化与过滤条件。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { seed_categories } from '#api_util/cards_seed.js'
import { generateAccessToken } from '#api_util/jwt.js'

const db = (await import('#api_util/db.js')).default
const mockQuery = vi.fn()

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
	db.query = (...args) => mockQuery(...args)

	mockQuery.mockImplementation(async (sql, binds = []) => {
		const text = String(sql).trim()
		for (const rule of rules) {
			const hit = rule(text, binds)
			if (hit !== undefined) return hit
		}

		if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX') || text.startsWith('ALTER TABLE')) return EMPTY
		if (text.includes('INSERT INTO cards_content_version')) return EMPTY
		if (text.includes('SELECT seed_version')) return { rows: [{ seed_version: '3' }] }
		if (text.includes('SELECT version, category_version')) return { rows: [{ version: '7', category_version: '1', item_version: '1', asset_version: '1' }] }
		return EMPTY
	})

	vi.resetModules()
})

async function load_cards_module() {
	return await import('../../api/_cards.js')
}

async function load_cards() {
	return (await load_cards_module()).default
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

describe('cards 公开内容接口', () => {
	it('版本一致时直接返回 unchanged，不拉取分类和卡片', async () => {
		const handler = await load_cards()
		rules.push(text => (text.includes('SELECT version, category_version') ? { rows: [{ version: '9' }] } : undefined))

		const res = await call_api(handler, '/api/cards/content/bootstrap', 'GET', { query: { version: '9' } })

		expect(res.status).toBe(200)
		expect(res.json.code).toBe(0)
		expect(res.json.data).toEqual({ version: 9, unchanged: true })
		expect(mockQuery.mock.calls.some(call => sqlOf(call).includes('FROM cards_category c'))).toBe(false)
	})

	it('版本变化时返回已发布分类、卡片与素材', async () => {
		const handler = await load_cards()
		rules.push(text => {
			if (text.includes('SELECT c.id, c.name')) return { rows: [{ id: 'cc_animal', name: '小动物', item_count: '6' }] }
			if (text.includes('SELECT i.id, i.category_id')) {
				return {
					rows: [
						{
							id: 'ci0001',
							card_key: 'animal_cat',
							category_code: 'animal',
							label: '猫',
						},
					],
				}
			}
			if (text.includes('FROM cards_asset a')) return { rows: [{ card_key: 'animal_cat', asset_type: 'sound', asset_url: '/a.mp3' }] }
			return undefined
		})

		const res = await call_api(handler, '/api/cards/content/bootstrap', 'GET')

		expect(res.json.code).toBe(0)
		expect(res.json.data.unchanged).toBe(false)
		expect(res.json.data.categories).toHaveLength(1)
		expect(res.json.data.items).toHaveLength(1)
		expect(res.json.data.assets).toHaveLength(1)

		const contentSql = mockQuery.mock.calls.map(sqlOf).find(text => text.includes('FROM cards_item i') && text.includes('ORDER BY c.sort_order'))
		expect(contentSql).toContain('i.publish_status = 1')
		expect(contentSql).toContain('c.publish_status = 1')
		expect(contentSql).toContain('i.is_enabled = true')
	})

	it('seed_version 为 0 时执行一次种子，并用 ON CONFLICT 保证可重入', async () => {
		const cardsModule = await load_cards_module()
		rules.push(text => {
			if (text.includes('SELECT seed_version')) return { rows: [{ seed_version: '0' }] }
			if (text === 'SELECT id, code FROM cards_category') return { rows: [{ id: 'cc_animal', code: 'animal' }] }
			return undefined
		})

		await cardsModule.ensure_dbInitialized_async()

		const categoryInserts = mockQuery.mock.calls.filter(call => sqlOf(call).includes('INSERT INTO cards_category'))
		const itemInserts = mockQuery.mock.calls.filter(call => sqlOf(call).includes('INSERT INTO cards_item'))
		expect(categoryInserts.length).toBe(9)
		expect(itemInserts.length).toBe(174)
		expect(sqlOf(categoryInserts[0])).toContain('ON CONFLICT DO NOTHING')
		expect(sqlOf(itemInserts[0])).toContain('ON CONFLICT DO NOTHING')
		expect(itemInserts[0][1][1]).toBe(seed_categories[0].id)
		expect(mockQuery.mock.calls.some(call => sqlOf(call).includes('INSERT INTO cards_asset'))).toBe(true)
		// 种子完成后写标记，避免管理员删除的内容被「数量不足」逻辑复活
		const seedUpdate = mockQuery.mock.calls.find(call => sqlOf(call).includes('SET seed_version = 3'))
		expect(seedUpdate).toBeTruthy()
	})

	it('seed_version 为 2 时执行第三阶段迁移，幂等补齐 88 条语音资产', async () => {
		const cardsModule = await load_cards_module()
		rules.push(text => {
			if (text.includes('SELECT seed_version')) return { rows: [{ seed_version: '2' }] }
			return undefined
		})

		await cardsModule.ensure_dbInitialized_async()

		const assetInserts = mockQuery.mock.calls.filter(call => sqlOf(call).includes('INSERT INTO cards_asset'))
		expect(assetInserts.length).toBe(88) // 仅插入 88 条语音资产，不重复插入 78 条 emoji 资产
		expect(sqlOf(assetInserts[0])).toContain('ON CONFLICT DO NOTHING')
		const seedUpdate = mockQuery.mock.calls.find(call => sqlOf(call).includes('SET seed_version = 3'))
		expect(seedUpdate).toBeTruthy()
	})

	it('seed_version 已完成时不再补种，管理员删除的内容不会被复活', async () => {
		const handler = await load_cards()
		await call_api(handler, '/api/cards/content/version', 'GET')
		expect(mockQuery.mock.calls.some(call => sqlOf(call).includes('INSERT INTO cards_category'))).toBe(false)
		expect(mockQuery.mock.calls.some(call => sqlOf(call).includes('INSERT INTO cards_item'))).toBe(false)
	})
})

describe('cards 用户进度', () => {
	it('未登录同步返回 401，且不写库', async () => {
		const handler = await load_cards()
		const res = await call_api(handler, '/api/cards/progress/sync', 'POST', {
			body: { items: [{ cardKey: 'animal_cat', exploredAt: '2026-11-01 10:00:00' }] },
		})

		expect(res.status).toBe(401)
		expect(mockQuery.mock.calls.some(call => sqlOf(call).includes('INSERT INTO cards_user_progress'))).toBe(false)
	})

	it('登录后同步使用 LEAST / GREATEST 幂等合并，并返回合并结果', async () => {
		const handler = await load_cards()
		rules.push(text => {
			if (text.includes('INSERT INTO cards_user_progress')) return { rows: [], rowCount: 1 }
			if (text.includes('SELECT card_id, explored_at, last_explored_at, favorite_at') || text.includes('SELECT card_key')) {
				return { rows: [{ card_id: 'animal_cat', explored_at: '2026-11-01 09:00:00', last_explored_at: '2026-11-02 09:00:00', favorite_at: null }] }
			}
			if (text.includes('SELECT play_mode, COUNT(*)')) {
				return {
					rows: [
						{ play_mode: 'connect', count: '5' },
						{ play_mode: 'memory', count: '2' },
					],
				}
			}
			return undefined
		})

		const res = await call_api(handler, '/api/cards/progress/sync', 'POST', {
			headers: { Authorization: user_token() },
			body: {
				items: [
					{ cardKey: 'animal_cat', exploredAt: '2026-11-01 10:00:00', lastExploredAt: '2026-11-02 09:00:00' },
					{ cardKey: 'animal_cat', exploredAt: '2026-11-01 09:00:00', lastExploredAt: '2026-11-01 20:00:00' },
				],
			},
		})

		expect(res.json.code).toBe(0)
		expect(res.json.data.items[0].cardKey).toBe('animal_cat')
		expect(res.json.data.playStats).toEqual({ connect: 5, memory: 2 })

		const upserts = mockQuery.mock.calls.filter(call => sqlOf(call).includes('INSERT INTO cards_user_progress'))
		expect(upserts).toHaveLength(1) // 同 key 去重
		expect(sqlOf(upserts[0])).toContain('LEAST(cards_user_progress.explored_at, EXCLUDED.explored_at)')
		expect(sqlOf(upserts[0])).toContain('GREATEST(cards_user_progress.last_explored_at, EXCLUDED.last_explored_at)')
		// 去重后首次探索取更早、最近探索取更晚
		expect(upserts[0][1][3]).toBe('2026-11-01 09:00:00')
		expect(upserts[0][1][4]).toBe('2026-11-02 09:00:00')
	})

	it('非法 cardKey 被白名单拒绝', async () => {
		const handler = await load_cards()
		const res = await call_api(handler, '/api/cards/progress/sync', 'POST', {
			headers: { Authorization: user_token() },
			body: { items: [{ cardKey: '../../etc/passwd', exploredAt: '2026-11-01 10:00:00' }] },
		})

		expect(res.json.code).toBe(-1)
		expect(res.json.msg).toContain('卡片标识不合法')
		expect(mockQuery.mock.calls.some(call => sqlOf(call).includes('INSERT INTO cards_user_progress'))).toBe(false)
	})
})

describe('cards 管理端', () => {
	it('普通登录用户不能新增分类（403）', async () => {
		const handler = await load_cards()
		const res = await call_api(handler, '/api/cards/admin/category/insert', 'POST', {
			headers: { Authorization: user_token() },
			body: { code: 'test_cat', name: '测试分类' },
		})

		expect(res.status).toBe(403)
		expect(mockQuery.mock.calls.some(call => sqlOf(call).includes('INSERT INTO cards_category'))).toBe(false)
	})

	it('管理员新增分类后自增内容版本', async () => {
		const handler = await load_cards()
		rules.push(text => {
			if (text.includes('INSERT INTO cards_category')) return { rows: [], rowCount: 1 }
			if (text.includes('UPDATE cards_content_version')) return { rows: [], rowCount: 1 }
			return undefined
		})

		const res = await call_api(handler, '/api/cards/admin/category/insert', 'POST', {
			headers: { Authorization: admin_token() },
			body: { code: 'test_cat', name: '测试分类', theme_color: '#ff8800', sort_order: 10 },
		})

		expect(res.json.code).toBe(0)
		const insert = mockQuery.mock.calls.find(call => sqlOf(call).includes('INSERT INTO cards_category'))
		expect(insert[1]).toContain('测试分类')
		const version = mockQuery.mock.calls.find(call => sqlOf(call).includes('UPDATE cards_content_version'))
		expect(sqlOf(version)).toContain('category_version = category_version + 1')
	})

	it('分类下仍有卡片时禁止删除', async () => {
		const handler = await load_cards()
		rules.push(text => {
			if (text.includes('SELECT COUNT(*) AS total FROM cards_item WHERE category_id = $1')) return { rows: [{ total: '3' }] }
			return undefined
		})

		const res = await call_api(handler, '/api/cards/admin/category/delete', 'POST', {
			headers: { Authorization: admin_token() },
			body: { id: 'cc_animal' },
		})

		expect(res.json.code).toBe(-1)
		expect(res.json.msg).toContain('还有卡片')
		expect(mockQuery.mock.calls.some(call => sqlOf(call).startsWith('DELETE FROM cards_category'))).toBe(false)
	})

	it('卡片管理列表返回主图素材与排序权重', async () => {
		const handler = await load_cards()
		rules.push(text => {
			if (text.includes('SELECT i.*, c.name AS category_name')) {
				return {
					rows: [
						{
							id: 'ci0001',
							label: '小猫',
							sort_order: 10,
							primary_asset_type: 'image',
							primary_asset_url: 'https://drive.zengjin.work/cat.webp',
							primary_emoji: '',
						},
					],
				}
			}
			if (text.includes('SELECT COUNT(*) AS total FROM cards_item')) return { rows: [{ total: '1' }] }
			return undefined
		})

		const res = await call_api(handler, '/api/cards/admin/item/select', 'GET', {
			headers: { Authorization: admin_token() },
			query: { current: 1, pageSize: 20 },
		})

		expect(res.json.code).toBe(0)
		expect(res.json.data[0].primary_asset_url).toBe('https://drive.zengjin.work/cat.webp')
		expect(res.json.data[0].sort_order).toBe(10)
		const selectCall = mockQuery.mock.calls.find(call => sqlOf(call).includes('SELECT i.*, c.name AS category_name'))
		expect(sqlOf(selectCall)).toContain('primary_asset_url')
		expect(sqlOf(selectCall)).toContain('ORDER BY c.sort_order ASC NULLS LAST, i.sort_order ASC')
	})

	it('新增卡片保存基本信息与适用玩法', async () => {
		const handler = await load_cards()
		rules.push((text, binds) => {
			if (text.includes('SELECT id, name FROM cards_category WHERE id = ')) return { rows: [{ id: 'cc_animal', name: '小动物' }] }
			if (text.startsWith('INSERT INTO cards_item')) return { rows: [], rowCount: 1 }
			return undefined
		})

		const res = await call_api(handler, '/api/cards/admin/item/insert', 'POST', {
			headers: { Authorization: admin_token() },
			body: { category_id: 'cc_animal', label: '兔子', en_label: 'rabbit', play_modes: ['recognize'] },
		})

		expect(res.json.code).toBe(0)
		const insertCall = mockQuery.mock.calls.find(call => sqlOf(call).startsWith('INSERT INTO cards_item'))
		expect(insertCall[1][1]).toBe('cc_animal')
		expect(sqlOf(insertCall)).not.toContain('render_config')
	})

	it('编辑卡片时 assets 为全量替换（先删后插）', async () => {
		const handler = await load_cards()
		rules.push(text => {
			if (text.startsWith('UPDATE cards_item')) return { rows: [], rowCount: 1 }
			if (text.startsWith('DELETE FROM cards_asset')) return { rows: [], rowCount: 1 }
			if (text.includes('INSERT INTO cards_asset')) return { rows: [], rowCount: 1 }
			return undefined
		})

		const res = await call_api(handler, '/api/cards/admin/item/update', 'POST', {
			headers: { Authorization: admin_token() },
			body: {
				id: 'ci0001',
				label: '小猫',
				assets: [{ asset_type: 'image', asset_url: 'https://drive.zengjin.work/upload/cat.webp', mime_type: 'image/webp' }],
			},
		})

		expect(res.json.code).toBe(0)
		const updateCall = mockQuery.mock.calls.find(call => sqlOf(call).startsWith('UPDATE cards_item'))
		expect(sqlOf(updateCall)).toContain('label = $1')
		expect(sqlOf(updateCall)).toContain('WHERE id = $3')
		expect(updateCall[1][0]).toBe('小猫')
		expect(updateCall[1][2]).toBe('ci0001')
		const deleteCall = mockQuery.mock.calls.find(call => sqlOf(call).startsWith('DELETE FROM cards_asset'))
		expect(deleteCall[1]).toEqual(['ci0001'])
		const insertCall = mockQuery.mock.calls.find(call => sqlOf(call).includes('INSERT INTO cards_asset'))
		expect(insertCall[1][1]).toBe('ci0001')
		expect(insertCall[1][3]).toContain('cat.webp')
	})
})

describe('cards 统计与对局', () => {
	it('拒绝不支持的统计事件类型', async () => {
		const handler = await load_cards()
		const res = await call_api(handler, '/api/cards/stats/event', 'POST', { body: { events: [{ type: 'track_child', objectId: 'x' }] } })

		expect(res.json.code).toBe(-1)
		expect(res.json.msg).toContain('统计事件类型不支持')
		expect(mockQuery.mock.calls.some(call => sqlOf(call).includes('INSERT INTO cards_stats_daily'))).toBe(false)
	})

	it('同一请求内的重复事件合并为一次 upsert', async () => {
		const handler = await load_cards()
		rules.push(text => (text.includes('INSERT INTO cards_stats_daily') ? { rows: [], rowCount: 1 } : undefined))

		const res = await call_api(handler, '/api/cards/stats/event', 'POST', {
			body: {
				events: [
					{ type: 'card_view', objectId: 'animal_cat' },
					{ type: 'card_view', objectId: 'animal_cat' },
					{ type: 'hall_view', objectId: '' },
				],
			},
		})

		expect(res.json.code).toBe(0)
		const upserts = mockQuery.mock.calls.filter(call => sqlOf(call).includes('INSERT INTO cards_stats_daily'))
		expect(upserts).toHaveLength(2)
		const cardView = upserts.find(call => call[1][0] === 'card_view')
		expect(cardView[1][2]).toBe(2)
	})

	it('游客完成对局只进匿名聚合，不写个人明细', async () => {
		const handler = await load_cards()
		rules.push(text => (text.includes('INSERT INTO cards_stats_daily') ? { rows: [], rowCount: 1 } : undefined))

		const res = await call_api(handler, '/api/cards/play/finish', 'POST', {
			body: { mode: 'memory', requestId: 'req-12345678', totalPairs: 4, completedPairs: 4, duration: 42, result: 'completed' },
		})

		expect(res.json.code).toBe(0)
		expect(mockQuery.mock.calls.some(call => sqlOf(call).includes('INSERT INTO cards_play_record'))).toBe(false)
		const stats = mockQuery.mock.calls.find(call => sqlOf(call).includes('INSERT INTO cards_stats_daily'))
		expect(stats[1][0]).toBe('game_finish')
		expect(stats[1][1]).toBe('memory')
	})

	it('登录用户对局使用 requestId 幂等写入', async () => {
		const handler = await load_cards()
		rules.push(text => {
			if (text.includes('INSERT INTO cards_play_record')) return { rows: [{ id: 'rec1' }], rowCount: 1 }
			if (text.includes('INSERT INTO cards_stats_daily')) return { rows: [], rowCount: 1 }
			return undefined
		})

		const res = await call_api(handler, '/api/cards/play/finish', 'POST', {
			headers: { Authorization: user_token() },
			body: { mode: 'connect', requestId: 'req-87654321', totalPairs: 4, completedPairs: 4, duration: 30, result: 'completed' },
		})

		expect(res.json.code).toBe(0)
		const insert = mockQuery.mock.calls.find(call => sqlOf(call).includes('INSERT INTO cards_play_record'))
		expect(sqlOf(insert)).toContain('ON CONFLICT (request_id) DO NOTHING')
		expect(insert[1][2]).toBe('user001')
	})
})

describe('cards 用户认知设置', () => {
	it('读取设置需要登录', async () => {
		const handler = await load_cards()
		const res = await call_api(handler, '/api/cards/settings/get', 'GET')
		expect(res.status).toBe(401)
	})

	it('登录用户没有记录时返回 settings: null', async () => {
		const handler = await load_cards()
		rules.push(text => (text.includes('SELECT settings FROM cards_user_setting') ? { rows: [], rowCount: 0 } : undefined))

		const res = await call_api(handler, '/api/cards/settings/get', 'GET', { headers: { Authorization: user_token() } })

		expect(res.json.code).toBe(0)
		expect(res.json.data.settings).toBeNull()
	})

	it('保存设置按 user_id 幂等 upsert，只认会话身份', async () => {
		const handler = await load_cards()
		rules.push(text => (text.includes('INSERT INTO cards_user_setting') ? { rows: [], rowCount: 1 } : undefined))

		const res = await call_api(handler, '/api/cards/settings/save', 'POST', {
			headers: { Authorization: user_token() },
			body: {
				userId: 'forged',
				settings: {
					cognitionPreset: 'literacy',
					gameCognitionModes: { recognize: 'inherit', matching: 'visual', memory: 'inherit' },
					gameOptions: { matching: { pairCount: 5 }, memory: { pairCount: 8, previewEnabled: false } },
				},
			},
		})

		expect(res.json.code).toBe(0)
		expect(res.json.data.settings.cognitionPreset).toBe('literacy')
		expect(res.json.data.settings.gameOptions.matching.pairCount).toBe(5)

		const insert = mockQuery.mock.calls.find(call => sqlOf(call).includes('INSERT INTO cards_user_setting'))
		expect(sqlOf(insert)).toContain('ON CONFLICT (user_id) DO UPDATE')
		expect(insert[1][0]).toBe('user001')
		expect(insert[1][1]).toContain('"cognitionPreset":"literacy"')
	})

	it('非法字段安全回退，不阻断保存', async () => {
		const handler = await load_cards()
		rules.push(text => (text.includes('INSERT INTO cards_user_setting') ? { rows: [], rowCount: 1 } : undefined))

		const res = await call_api(handler, '/api/cards/settings/save', 'POST', {
			headers: { Authorization: user_token() },
			body: { settings: { cognitionPreset: 'hacker', gameOptions: { memory: { pairCount: 99, previewEnabled: 'yes' } } } },
		})

		expect(res.json.code).toBe(0)
		expect(res.json.data.settings.cognitionPreset).toBe('visual')
		expect(res.json.data.settings.gameOptions.memory.pairCount).toBe(6)
		expect(res.json.data.settings.gameOptions.memory.previewEnabled).toBe(true)
	})
})

describe('cards 用户认知设置 — 身份边界', () => {
	it('Token 缺少 userId 时设置接口拒绝执行', async () => {
		const handler = await load_cards()
		const token = `Bearer ${generateAccessToken({ username: 'nobody' })}`

		const getRes = await call_api(handler, '/api/cards/settings/get', 'GET', { headers: { Authorization: token } })
		expect(getRes.json.code).toBe(-1)
		expect(getRes.json.msg).toContain('认证信息异常')

		const saveRes = await call_api(handler, '/api/cards/settings/save', 'POST', {
			headers: { Authorization: token },
			body: { settings: { cognitionPreset: 'literacy' } },
		})
		expect(saveRes.json.code).toBe(-1)
		expect(saveRes.json.msg).toContain('认证信息异常')
		const settingCalls = mockQuery.mock.calls.filter(call => sqlOf(call).includes('cards_user_setting') && !sqlOf(call).startsWith('CREATE TABLE'))
		expect(settingCalls).toHaveLength(0)
	})
})

describe('cards 数据库约束', () => {
	it('初始化时为素材主图创建部分唯一索引', async () => {
		const cardsModule = await load_cards_module()
		await cardsModule.ensure_dbInitialized_async()

		const indexCall = mockQuery.mock.calls.find(call => sqlOf(call).includes('idx_cards_asset_primary'))
		expect(indexCall).toBeTruthy()
		expect(sqlOf(indexCall)).toContain('UNIQUE INDEX')
		expect(sqlOf(indexCall)).toContain('WHERE is_primary')

		// 建唯一索引前先把历史多主图收敛为一张，避免存量数据导致启动失败
		const sqlList = mockQuery.mock.calls.map(sqlOf)
		const normalizeIndex = sqlList.findIndex(sql => sql.includes('UPDATE') && sql.includes('is_primary = false'))
		const uniqueIndex = sqlList.findIndex(sql => sql.includes('idx_cards_asset_primary'))
		expect(normalizeIndex).toBeGreaterThanOrEqual(0)
		expect(normalizeIndex).toBeLessThan(uniqueIndex)
	})
})
