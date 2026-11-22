/**
 * Admin 全局消息通知中心 API 测试
 *
 * 覆盖：
 *  - 管理端鉴权、列表筛选、未读统计、状态白名单
 *  - 公开上报：开关关闭 / 内容可用 / 真实缺口
 *  - 去重键由服务端构造，前端伪造值无效
 *  - 原子聚合 SQL 使用 ON CONFLICT，并在已解决时重新激活
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { generateAccessToken } from '#api_util/jwt.js'

const db = (await import('#api_util/db.js')).default
const mockQuery = vi.fn()

const EMPTY = { rows: [], rowCount: 0 }
const admin_token = () => `Bearer ${generateAccessToken({ userId: 'admin001', username: 'admin' })}`
const user_token = () => `Bearer ${generateAccessToken({ userId: 'user001', username: 'tester' })}`

function sqlOf(call) {
	return String(call[0]).trim()
}

beforeEach(() => {
	mockQuery.mockReset()
	db.query = (...args) => mockQuery(...args)

	mockQuery.mockImplementation(async (sql, binds) => {
		console.log('SQL:', String(sql), binds)
		const text = String(sql).trim()
		if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return EMPTY
		if (text.includes('INSERT INTO admin_notification_setting')) return EMPTY
		if (text.includes('SELECT value FROM admin_notification_setting')) return { rows: [{ value: false }] }
		return EMPTY
	})

	vi.resetModules()
})

async function load_notification() {
	return (await import('../../api/_base/notification.js')).default
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

describe('Admin 通知管理接口', () => {
	it('普通用户查询通知被拒绝', async () => {
		const handler = await load_notification()
		const res = await call_api(handler, '/api/admin/notification/select', 'GET', { headers: { authorization: user_token() } })
		expect(res.status).toBe(403)
		expect(res.json.msg).toContain('无操作权限')
	})

	it('管理员列表按最近发生时间倒序并返回总数', async () => {
		const handler = await load_notification()
		mockQuery.mockImplementation(async sql => {
			const text = String(sql)
			if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return EMPTY
			if (text.includes('INSERT INTO admin_notification_setting')) return EMPTY
			if (text.includes('SELECT COUNT(*) AS total FROM admin_notification')) return { rows: [{ total: '1' }] }
			if (text.includes('SELECT * FROM admin_notification')) {
				return { rows: [{ id: 'n1', title: '缺口', app_code: 'cards', category: 'missing_resource', status: 'pending', metadata: {} }] }
			}
			return EMPTY
		})

		const res = await call_api(handler, '/api/admin/notification/select?read=unread', 'GET', { headers: { authorization: admin_token() } })
		console.log('DEBUG res:', res.json)
		expect(res.json.code).toBe(0)
		expect(res.json.total).toBe(1)
		expect(res.json.data).toHaveLength(1)

		const listSql = mockQuery.mock.calls.map(sqlOf).find(text => text.includes('SELECT * FROM admin_notification'))
		expect(listSql).toContain('read_at IS NULL')
		expect(listSql).toContain('ORDER BY last_occurred_at DESC')
	})

	it('未读数量只依据 read_at IS NULL', async () => {
		const handler = await load_notification()
		mockQuery.mockImplementation(async sql => {
			const text = String(sql)
			if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return EMPTY
			if (text.includes('INSERT INTO admin_notification_setting')) return EMPTY
			if (text.includes('SELECT COUNT(*) AS total FROM admin_notification WHERE read_at IS NULL')) return { rows: [{ total: '7' }] }
			return EMPTY
		})

		const res = await call_api(handler, '/api/admin/notification/unread-count', 'GET', { headers: { authorization: admin_token() } })
		expect(res.json.data.count).toBe(7)
	})

	it('处理状态 SQL 显式声明参数类型，避免真实库 text / varchar 冲突', async () => {
		const handler = await load_notification()
		mockQuery.mockImplementation(async sql => {
			const text = String(sql)
			if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return EMPTY
			if (text.includes('INSERT INTO admin_notification_setting')) return EMPTY
			if (text.includes('UPDATE admin_notification') && text.includes('RETURNING id, status, resolved_at')) {
				return { rows: [{ id: 'n1', status: 'resolved', resolved_at: '2026-11-21 17:00:00' }] }
			}
			return EMPTY
		})

		const res = await call_api(handler, '/api/admin/notification/status', 'POST', {
			headers: { authorization: admin_token() },
			body: { id: 'n1', status: 'resolved' },
		})
		expect(res.json.code).toBe(0)

		const updateSql = mockQuery.mock.calls.map(sqlOf).find(text => text.includes('RETURNING id, status, resolved_at'))
		expect(updateSql).toContain('$2::varchar')
		expect(updateSql).toContain(`$2::varchar = 'resolved'`)
	})

	it('非法处理状态被拒绝', async () => {
		const handler = await load_notification()
		const res = await call_api(handler, '/api/admin/notification/status', 'POST', {
			headers: { authorization: admin_token() },
			body: { id: 'n1', status: 'archived' },
		})
		expect(res.json.code).toBe(-1)
		expect(res.json.msg).toContain('处理状态')
	})
})

describe('内容缺口公开上报', () => {
	it('开关关闭时不创建通知', async () => {
		const handler = await load_notification()
		const res = await call_api(handler, '/api/admin/notification/report', 'POST', {
			body: { appCode: 'cards', category: 'missing_resource', categoryId: 'cc_animal', playMode: 'connect', imageMode: 'fixed_image' },
		})

		expect(res.json.code).toBe(0)
		expect(res.json.data.accepted).toBe(false)
		expect(res.json.data.reason).toBe('disabled')
		expect(mockQuery.mock.calls.some(call => sqlOf(call).includes('INSERT INTO admin_notification\n'))).toBe(false)
	})

	it('前端伪造缺口但后端判定内容可用时拒绝创建', async () => {
		const handler = await load_notification()
		mockQuery.mockImplementation(async sql => {
			const text = String(sql)
			if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return EMPTY
			if (text.includes('INSERT INTO admin_notification_setting')) return EMPTY
			if (text.includes('SELECT value FROM admin_notification_setting')) return { rows: [{ value: true }] }
			if (text.includes('INSERT INTO admin_notification_rate')) return { rows: [{ count: 1 }] }
			if (text.includes('FROM cards_category') && text.includes('WHERE id = $1')) return { rows: [{ id: 'cc_animal', code: 'animal', name: '小动物' }] }
			if (text.includes('FROM cards_item i') && text.includes('SELECT i.id'))
				return { rows: [{ id: 'ci1', card_key: 'cat', label: '猫', play_modes: 'connect', category_id: 'cc_animal' }] }
			if (text.includes('FROM cards_asset a'))
				return { rows: [{ card_id: 'ci1', asset_type: 'image', asset_url: 'https://cdn.test/cat.webp', is_enabled: true, is_random: true }] }
			return EMPTY
		})

		const res = await call_api(handler, '/api/admin/notification/report', 'POST', {
			body: { appCode: 'cards', category: 'missing_resource', categoryId: 'cc_animal', playMode: 'connect', imageMode: 'fixed_image', dedupeKey: 'fake' },
		})

		expect(res.json.code).toBe(0)
		expect(res.json.data.accepted).toBe(false)
		expect(res.json.data.reason).toBe('content_available')
		expect(mockQuery.mock.calls.some(call => sqlOf(call).includes('INSERT INTO admin_notification\n'))).toBe(false)
	})

	it('真实缺口使用服务端去重键并原子聚合', async () => {
		const handler = await load_notification()
		mockQuery.mockImplementation(async (sql, binds = []) => {
			const text = String(sql)
			if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return EMPTY
			if (text.includes('INSERT INTO admin_notification_setting')) return EMPTY
			if (text.includes('SELECT value FROM admin_notification_setting')) return { rows: [{ value: true }] }
			if (text.includes('INSERT INTO admin_notification_rate')) return { rows: [{ count: 1 }] }
			if (text.includes('FROM cards_category') && text.includes('WHERE id = $1')) return { rows: [{ id: 'cc_animal', code: 'animal', name: '小动物' }] }
			if (text.includes('FROM cards_item i') && text.includes('SELECT i.id'))
				return { rows: [{ id: 'ci1', card_key: 'cat', label: '猫', play_modes: 'connect', category_id: 'cc_animal' }] }
			if (text.includes('FROM cards_asset a')) return { rows: [] }
			if (text.includes('INSERT INTO admin_notification') && !text.includes('admin_notification_setting') && !text.includes('admin_notification_rate')) {
				return { rows: [{ id: 'n1', status: 'pending', occurrence_count: '1', created: true }] }
			}
			return EMPTY
		})

		const res = await call_api(handler, '/api/admin/notification/report', 'POST', {
			body: {
				appCode: 'cards',
				category: 'missing_resource',
				categoryId: 'cc_animal',
				playMode: 'connect',
				imageMode: 'fixed_image',
				// 以下字段必须被服务端忽略
				dedupeKey: 'cards:fake',
				occurrenceCount: 999,
				status: 'resolved',
			},
		})

		expect(res.json.code).toBe(0)
		expect(res.json.data.accepted).toBe(true)
		expect(res.json.data.notification.id).toBe('n1')

		const upsertCall = mockQuery.mock.calls.find(
			call => /INSERT INTO admin_notification\b/.test(sqlOf(call)) && !sqlOf(call).includes('admin_notification_setting'),
		)
		expect(upsertCall).toBeTruthy()
		const upsertSql = sqlOf(upsertCall)
		expect(upsertSql).toContain('ON CONFLICT (dedupe_key) DO UPDATE')
		expect(upsertSql).toContain(`CASE WHEN admin_notification.status = 'resolved' THEN 'pending'`)
		expect(upsertCall[1]).toContain('cards:cc_animal:connect:fixed_image')
		expect(upsertCall[1]).not.toContain('cards:fake')
	})

	it('非法应用与非法类别被拒绝', async () => {
		const handler = await load_notification()
		mockQuery.mockImplementation(async sql => {
			const text = String(sql)
			if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return EMPTY
			if (text.includes('INSERT INTO admin_notification_setting')) return EMPTY
			if (text.includes('SELECT value FROM admin_notification_setting')) return { rows: [{ value: true }] }
			if (text.includes('INSERT INTO admin_notification_rate')) return { rows: [{ count: 1 }] }
			return EMPTY
		})

		const badApp = await call_api(handler, '/api/admin/notification/report', 'POST', {
			body: { appCode: 'evil', category: 'missing_resource', playMode: 'connect', imageMode: 'fixed_image' },
		})
		expect(badApp.json.code).toBe(-1)
		expect(badApp.json.msg).toContain('来源应用')

		const badCategory = await call_api(handler, '/api/admin/notification/report', 'POST', {
			body: { appCode: 'cards', category: 'system_notice', playMode: 'connect', imageMode: 'fixed_image' },
		})
		expect(badCategory.json.code).toBe(-1)
		expect(badCategory.json.msg).toContain('内容缺口')
	})
})
