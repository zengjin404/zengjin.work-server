/**
 * api/_base/backup.js 鉴权与环境判定单元测试
 *
 * 覆盖：
 *  1. 本地开发回环地址免鉴权放行（localhost / 127.0.0.1 / ::1）
 *  2. 局域网 Host 及对端 IP 默认拒绝，仅在 BACKUP_ALLOW_LAN_DEV=1 显式开关时允许本地局域网调试
 *  3. 生产环境匿名 / 普通用户 / 管理员 / Cron（正确、错误、缺失密钥）
 *  4. 缺少 NODE_ENV、APP_ENV=production、EdgeOne/Vercel 环境变量、云代理请求头、HTTPS 与异常 Host 均 fail-closed
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateAccessToken } from '#api_util/jwt.js'

function create_mock_pool() {
	const query = vi.fn(async sql => {
		const text = String(sql).trim()
		const lower = text.toLowerCase()
		if (lower.includes('select count(*)')) return { rows: [{ count: '0' }], rowCount: 1 }
		return { rows: [], rowCount: 0 }
	})
	return {
		query,
		connect: vi.fn(async () => ({
			query,
			release: vi.fn(),
		})),
	}
}

const sourcePool = create_mock_pool()
const targetPool = create_mock_pool()

vi.mock('#api_util/db.js', () => ({
	default: sourcePool,
	getPool: vi.fn(name => (String(name).toLowerCase() === 'supabase' ? sourcePool : targetPool)),
}))

const { default: backupHandler, is_local_dev_backup_allowed } = await import('../../../api/_base/backup.js')

const ENV_KEYS = [
	'NODE_ENV',
	'APP_ENV',
	'BACKUP_ALLOW_LAN_DEV',
	'VERCEL',
	'VERCEL_ENV',
	'VERCEL_URL',
	'VERCEL_REGION',
	'EO_ENV',
	'EDGEONE',
	'EDGEONE_ENV',
	'EDGEONE_PAGES',
	'EO_PAGES_HOST',
	'EDGEONE_URL',
	'EDGEONE_PAGES_URL',
	'SCF_RUNTIME',
	'TENCENTCLOUD_RUNENV',
	'CF_PAGES',
	'CRON_SECRET',
	'JWT_SECRET',
	'DB',
]
let savedEnv = {}

function call_backup(req = {}) {
	const out = { status: 200, json: null }
	const resp = {
		status(code) {
			out.status = code
			return {
				json(data) {
					out.json = data
					return resp
				},
			}
		},
		json(data) {
			out.json = data
			return resp
		},
		setHeader() {},
		end() {},
	}
	return backupHandler({ method: 'GET', url: '/api/base/backup', query: {}, body: {}, headers: {}, ...req }, resp).then(() => out)
}

beforeEach(() => {
	savedEnv = {}
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key]
		delete process.env[key]
	}
	process.env.DB = 'supabase'
	process.env.JWT_SECRET = 'test-backup-jwt-secret-0123456789'
	process.env.CRON_SECRET = 'test-backup-cron-secret-0123456789'
	sourcePool.query.mockClear()
	sourcePool.connect.mockClear()
	targetPool.query.mockClear()
	targetPool.connect.mockClear()
})

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key]
		else process.env[key] = savedEnv[key]
	}
})

describe('backup.js 本地开发与生产鉴权边界', () => {
	it('1. 本地开发默认仅允许回环地址（localhost / 127.0.0.1 / ::1）免鉴权放行', async () => {
		process.env.NODE_ENV = 'development'

		const localhostRes = await call_backup({ headers: { host: 'localhost:10001' }, socket: { remoteAddress: '127.0.0.1' } })
		expect(localhostRes.status).toBe(200)
		expect(localhostRes.json?.code).toBe(0)

		expect(is_local_dev_backup_allowed({ headers: { host: 'localhost' } }, { NODE_ENV: 'development' })).toBe(true)
		expect(is_local_dev_backup_allowed({ headers: { host: '127.0.0.1:10001' } }, { NODE_ENV: 'development' })).toBe(true)
		expect(
			is_local_dev_backup_allowed({ headers: { host: '127.0.0.1' }, socket: { remoteAddress: '::ffff:127.0.0.1' } }, { NODE_ENV: 'development' }),
		).toBe(true)
		expect(is_local_dev_backup_allowed({ headers: { host: '[::1]:10001' }, socket: { remoteAddress: '::1' } }, { NODE_ENV: 'development' })).toBe(true)
		expect(is_local_dev_backup_allowed({ headers: { host: '::1' } }, { NODE_ENV: 'development' })).toBe(true)
	})

	it('2. 默认拒绝局域网 Host 与局域网对端 IP（即便伪造 Host: localhost）', async () => {
		process.env.NODE_ENV = 'development'

		for (const host of ['192.168.1.25:10001', '10.0.0.8:10001', '172.16.0.5:10001']) {
			expect(is_local_dev_backup_allowed({ headers: { host } }, { NODE_ENV: 'development' })).toBe(false)
			const res = await call_backup({ headers: { host } })
			expect(res.status).toBe(401)
		}

		// 其他局域网设备访问 0.0.0.0 并伪造 Host: localhost 也必须默认拒绝
		const spoofedLanPeer = await call_backup({
			headers: { host: 'localhost:10001' },
			socket: { remoteAddress: '::ffff:192.168.1.88' },
		})
		expect(spoofedLanPeer.status).toBe(401)
		expect(targetPool.connect).not.toHaveBeenCalled()
	})

	it('3. 仅在显式开启 BACKUP_ALLOW_LAN_DEV=1 时允许本地局域网调试，且公网与云环境仍拦截', async () => {
		// 非 "1" 值一律保持关闭
		expect(is_local_dev_backup_allowed({ headers: { host: '192.168.1.25:10001' } }, { NODE_ENV: 'development', BACKUP_ALLOW_LAN_DEV: '0' })).toBe(false)
		expect(is_local_dev_backup_allowed({ headers: { host: '192.168.1.25:10001' } }, { NODE_ENV: 'development', BACKUP_ALLOW_LAN_DEV: 'true' })).toBe(false)

		process.env.NODE_ENV = 'development'
		process.env.BACKUP_ALLOW_LAN_DEV = '1'

		expect(is_local_dev_backup_allowed({ headers: { host: '192.168.1.25:10001' } }, process.env)).toBe(true)
		expect(is_local_dev_backup_allowed({ headers: { host: '10.0.0.8:10001' } }, process.env)).toBe(true)
		expect(is_local_dev_backup_allowed({ headers: { host: '172.16.5.9:10001' } }, process.env)).toBe(true)

		const lanRes = await call_backup({
			headers: { host: '192.168.1.25:10001' },
			socket: { remoteAddress: '::ffff:192.168.1.88' },
		})
		expect(lanRes.status).toBe(200)
		expect(lanRes.json?.code).toBe(0)

		// 非私网段（172.32.x.x / 公网 IP / 公网域名 / 云环境 / APP_ENV=production）即使开启 LAN 开关也必须拒绝
		expect(is_local_dev_backup_allowed({ headers: { host: '172.32.0.1:10001' } }, process.env)).toBe(false)
		expect(is_local_dev_backup_allowed({ headers: { host: '8.8.8.8' } }, process.env)).toBe(false)
		expect(is_local_dev_backup_allowed({ headers: { host: 'zengjin.work' } }, process.env)).toBe(false)
		expect(is_local_dev_backup_allowed({ headers: { host: '192.168.1.25:10001' }, socket: { remoteAddress: '203.0.113.5' } }, process.env)).toBe(false)
		expect(is_local_dev_backup_allowed({ headers: { host: '192.168.1.25:10001' } }, { ...process.env, APP_ENV: 'production' })).toBe(false)
		expect(is_local_dev_backup_allowed({ headers: { host: '192.168.1.25:10001' } }, { ...process.env, EDGEONE: '1' })).toBe(false)
	})

	it('4. 生产环境匿名请求返回 401，不触发数据库备份', async () => {
		process.env.NODE_ENV = 'production'
		const res = await call_backup({ headers: { host: 'zengjin.work', 'x-forwarded-proto': 'https' } })
		expect(res.status).toBe(401)
		expect(targetPool.connect).not.toHaveBeenCalled()
	})

	it('5. 生产环境普通用户请求返回 403', async () => {
		process.env.NODE_ENV = 'production'
		const userToken = generateAccessToken({ userId: 'u1', username: 'normal_user' })
		const res = await call_backup({
			headers: { host: 'zengjin.work', 'x-forwarded-proto': 'https', authorization: `Bearer ${userToken}` },
		})
		expect(res.status).toBe(403)
		expect(targetPool.connect).not.toHaveBeenCalled()
	})

	it('6. 生产环境管理员手动备份允许执行', async () => {
		process.env.NODE_ENV = 'production'
		const adminToken = generateAccessToken({ userId: 'u0', username: 'admin' })
		const res = await call_backup({
			headers: { host: 'zengjin.work', 'x-forwarded-proto': 'https', authorization: `Bearer ${adminToken}` },
		})
		expect(res.status).toBe(200)
		expect(res.json?.code).toBe(0)
	})

	it('7. 生产环境 Cron 正确密钥允许执行，错误或缺失密钥返回 401', async () => {
		process.env.NODE_ENV = 'production'

		const okRes = await call_backup({
			headers: { host: 'zengjin.work', 'x-forwarded-proto': 'https', authorization: `Bearer ${process.env.CRON_SECRET}` },
		})
		expect(okRes.status).toBe(200)
		expect(okRes.json?.code).toBe(0)

		const wrongRes = await call_backup({
			headers: { host: 'zengjin.work', 'x-forwarded-proto': 'https', authorization: 'Bearer wrong-secret' },
		})
		expect(wrongRes.status).toBe(401)

		delete process.env.CRON_SECRET
		const missingRes = await call_backup({
			headers: { host: 'zengjin.work', 'x-forwarded-proto': 'https', authorization: 'Bearer undefined' },
		})
		expect(missingRes.status).toBe(401)
	})

	it('8. NODE_ENV 缺失、APP_ENV=production、云平台标识、云代理头与异常 Host 均 fail-closed', async () => {
		// NODE_ENV 缺失 / test
		expect(is_local_dev_backup_allowed({ headers: { host: 'localhost:10001' } }, {})).toBe(false)
		expect(is_local_dev_backup_allowed({ headers: { host: 'localhost:10001' } }, { NODE_ENV: 'test' })).toBe(false)
		const missingEnvRes = await call_backup({ headers: { host: 'localhost:10001' } })
		expect(missingEnvRes.status).toBe(401)

		// APP_ENV=production 即使 NODE_ENV=development 也拦截
		expect(is_local_dev_backup_allowed({ headers: { host: 'localhost:10001' } }, { NODE_ENV: 'development', APP_ENV: 'production' })).toBe(false)
		expect(is_local_dev_backup_allowed({ headers: { host: 'localhost:10001' } }, { NODE_ENV: 'development', APP_ENV: 'staging' })).toBe(false)

		// 所有云平台环境变量存在时必须拦截
		for (const key of [
			'VERCEL',
			'VERCEL_ENV',
			'VERCEL_URL',
			'VERCEL_REGION',
			'EDGEONE',
			'EO_ENV',
			'EDGEONE_ENV',
			'EDGEONE_PAGES',
			'EO_PAGES_HOST',
			'EDGEONE_URL',
			'SCF_RUNTIME',
			'TENCENTCLOUD_RUNENV',
			'CF_PAGES',
		]) {
			expect(is_local_dev_backup_allowed({ headers: { host: 'localhost:10001' } }, { NODE_ENV: 'development', [key]: '1' })).toBe(false)
		}

		// 云代理头 / HTTPS / 异常 Host / 转发链
		for (const headers of [
			{ host: '127.0.0.1:10001', 'eo-pages-host': 'edgeone-test.zengjin.work' },
			{ host: 'localhost:10001', 'eo-log-uuid': 'abc' },
			{ host: 'localhost:10001', 'x-vercel-id': 'hnd1::123' },
			{ host: 'localhost:10001', 'x-vercel-deployment-url': 'zengjin-work.vercel.app' },
			{ host: 'localhost:10001', 'cf-ray': '8a123' },
			{ host: 'localhost:10001', forwarded: 'for=127.0.0.1;proto=https' },
			{ host: 'localhost:10001', 'x-forwarded-proto': 'https' },
			{ host: 'localhost:10001', 'x-forwarded-proto': 'http, https' },
			{ host: 'localhost:10001', 'x-forwarded-host': '7890000.xyz' },
			{ host: 'localhost:10001', 'x-forwarded-for': '203.0.113.5' },
			{ host: 'localhost:10001', 'x-forwarded-for': 'localhost' },
			{ host: 'localhost:10001', 'x-real-ip': '203.0.113.5' },
			{ host: '7890000.xyz', 'x-forwarded-proto': 'https' },
			{ host: 'localhost:10001/evil' },
			{ host: 'localhost, evil.com' },
			{ host: 'localhost:70000' },
			{},
		]) {
			expect(is_local_dev_backup_allowed({ headers }, { NODE_ENV: 'development' })).toBe(false)
		}

		expect(is_local_dev_backup_allowed({ headers: { host: 'localhost:10001' }, socket: { encrypted: true } }, { NODE_ENV: 'development' })).toBe(false)

		process.env.NODE_ENV = 'development'
		const eoHeaderRes = await call_backup({ headers: { host: '127.0.0.1:10001', 'eo-pages-host': 'edgeone-test.zengjin.work' } })
		expect(eoHeaderRes.status).toBe(401)
		expect(targetPool.connect).not.toHaveBeenCalled()
	})
})
