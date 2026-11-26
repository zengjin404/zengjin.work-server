/**
 * api/_doc.js 平台兼容性与 Swagger Server URL 安全边界测试
 *
 * 覆盖：
 *  1. PUBLIC_API_URL / API_BASE_URL 优先级与协议校验
 *  2. 本地开发环境（localhost / 127.0.0.1 / [::1] / 局域网 IP / 无头回退 / 忽略伪造 X-Forwarded-Proto）
 *  3. Vercel 环境（正式域、严格匹配的本项目 Preview 域、VERCEL_URL 精确约束、拒绝任意 *.vercel.app）
 *  4. EdgeOne 环境（7890000.xyz / edgeone-test.zengjin.work / 运行时显式声明域名、禁止 *.edgeone.* 通配信任）
 *  5. Host 与 X-Forwarded-Host 严格校验（防路径/查询/多值/非法端口注入与客户端代理头伪造）
 *  6. createSwaggerSpec 与 /api/doc/swagger.json 文档契约保持不变
 */
import { afterEach, describe, expect, it } from 'vitest'

import docHandler, { createSwaggerSpec, resolve_swagger_server_url } from '../../../api/_doc.js'

const ENV_KEYS = [
	'VERCEL',
	'VERCEL_ENV',
	'VERCEL_URL',
	'VERCEL_BRANCH_URL',
	'VERCEL_PROJECT_PRODUCTION_URL',
	'EDGEONE',
	'EO_ENV',
	'EDGEONE_ENV',
	'EO_PAGES_HOST',
	'EDGEONE_PAGES_URL',
	'EDGEONE_URL',
	'NODE_ENV',
	'APP_ENV',
	'PUBLIC_API_URL',
	'API_BASE_URL',
	'TRUSTED_API_HOSTS',
	'TRUST_PROXY',
]
const savedEnv = { ...process.env }

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key]
		else process.env[key] = savedEnv[key]
	}
})

describe('api/_doc.js Swagger Server URL 安全与平台兼容', () => {
	it('1. PUBLIC_API_URL > API_BASE_URL > 请求推导，优先级明确且过滤非法协议', () => {
		expect(
			resolve_swagger_server_url(
				{ headers: { host: 'localhost:10001' } },
				{ PUBLIC_API_URL: 'https://api-doc.zengjin.work/', API_BASE_URL: 'https://fallback.zengjin.work/' },
			),
		).toBe('https://api-doc.zengjin.work/api')

		expect(
			resolve_swagger_server_url({ headers: { host: 'localhost:10001' } }, { PUBLIC_API_URL: '   ', API_BASE_URL: 'https://api-alt.zengjin.work/api/' }),
		).toBe('https://api-alt.zengjin.work/api')

		expect(resolve_swagger_server_url({ headers: { host: 'localhost:10001' } }, { PUBLIC_API_URL: 'javascript:alert(1)', NODE_ENV: 'development' })).toBe(
			'http://localhost:10001/api',
		)
	})

	it('2. 本地开发环境：支持回环/局域网 Host，且不被伪造的 X-Forwarded-Proto/Host 诱导', () => {
		expect(resolve_swagger_server_url({ headers: { host: 'localhost:10001' }, socket: {} }, { NODE_ENV: 'development' })).toBe('http://localhost:10001/api')
		expect(resolve_swagger_server_url({ headers: { host: '[::1]:10001' }, socket: {} }, { NODE_ENV: 'development' })).toBe('http://[::1]:10001/api')
		expect(resolve_swagger_server_url({ headers: { host: '192.168.0.106:10001' }, socket: {} }, { NODE_ENV: 'development' })).toBe(
			'http://192.168.0.106:10001/api',
		)

		// 本地明文请求即使携带伪造 X-Forwarded-Proto: https 或 X-Forwarded-Host 也不受诱导
		expect(
			resolve_swagger_server_url(
				{ headers: { host: 'localhost:10001', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.com' }, socket: {} },
				{ NODE_ENV: 'development' },
			),
		).toBe('http://localhost:10001/api')

		// 本地 TLS socket 真实加密时输出 https
		expect(resolve_swagger_server_url({ headers: { host: 'localhost:10001' }, socket: { encrypted: true } }, { NODE_ENV: 'development' })).toBe(
			'https://localhost:10001/api',
		)

		const fallbackUrl = resolve_swagger_server_url({ headers: {}, socket: {} }, { NODE_ENV: 'development' })
		expect(fallbackUrl).toMatch(/^http:\/\/.+:10001\/api$/)
	})

	it('3. Vercel 环境：正式域与本项目 Preview 域放行，严格拒绝任意 *.vercel.app 与跨部署域', () => {
		expect(resolve_swagger_server_url({ headers: { host: 'zengjin.work', 'x-forwarded-proto': 'https' } }, { VERCEL: '1', NODE_ENV: 'production' })).toBe(
			'https://zengjin.work/api',
		)

		// 无 VERCEL_URL 时仅放行本项目命名空间的单一子域
		expect(
			resolve_swagger_server_url(
				{ headers: { host: 'zengjin-server-git-poc.vercel.app', 'x-forwarded-proto': 'https' } },
				{ VERCEL: '1', NODE_ENV: 'production' },
			),
		).toBe('https://zengjin-server-git-poc.vercel.app/api')

		// 任意其他 *.vercel.app 与多级子域必须拒绝，安全回退
		for (const untrustedVercel of ['evil.vercel.app', 'phishing-zengjin.vercel.app', 'zengjin-work.evil.vercel.app']) {
			expect(resolve_swagger_server_url({ headers: { host: untrustedVercel } }, { VERCEL: '1', NODE_ENV: 'production' })).toBe('https://zengjin.work/api')
		}

		// 若平台注入当前部署 VERCEL_URL，仅认本部署自身域名
		const pinnedEnv = { VERCEL: '1', NODE_ENV: 'production', VERCEL_URL: 'zengjin-work-abc123.vercel.app' }
		expect(resolve_swagger_server_url({ headers: { host: 'zengjin-work-abc123.vercel.app' } }, pinnedEnv)).toBe(
			'https://zengjin-work-abc123.vercel.app/api',
		)
		expect(resolve_swagger_server_url({ headers: { host: 'zengjin-server-other.vercel.app' } }, pinnedEnv)).toBe('https://zengjin.work/api')

		// 非 Vercel 环境绝不信任任何 *.vercel.app
		expect(resolve_swagger_server_url({ headers: { host: 'zengjin-server-git-poc.vercel.app' } }, { NODE_ENV: 'production', EDGEONE: '1' })).toBe(
			'https://zengjin.work/api',
		)
	})

	it('4. EdgeOne 与测试域名：严格放行已备案域与显式配置，禁止 *.edgeone.* 通配信任', () => {
		expect(
			resolve_swagger_server_url(
				{ headers: { host: 'edgeone-test.zengjin.work', 'x-forwarded-proto': 'https' } },
				{ NODE_ENV: 'production', APP_ENV: 'production' },
			),
		).toBe('https://edgeone-test.zengjin.work/api')

		expect(resolve_swagger_server_url({ headers: { host: '7890000.xyz' } }, { NODE_ENV: 'production', APP_ENV: 'production' })).toBe(
			'https://7890000.xyz/api',
		)
		expect(resolve_swagger_server_url({ headers: { host: 'test.7890000.xyz' } }, { NODE_ENV: 'production', APP_ENV: 'production' })).toBe(
			'https://test.7890000.xyz/api',
		)

		// 形似测试域名的前缀/后缀欺骗必须拒绝
		for (const fakeDomain of ['evil-7890000.xyz', '7890000.xyz.evil.com', 'evil-zengjin.work', 'zengjin.work.attacker.com']) {
			expect(resolve_swagger_server_url({ headers: { host: fakeDomain } }, { NODE_ENV: 'production', EDGEONE: '1' })).toBe('https://zengjin.work/api')
		}

		// 默认不得通配信任 *.edgeone.app / *.edgeone-pages.com / *.pages.edgeone.ai，也不信客户端 eo-pages-host 头
		for (const untrustedEo of ['evil.edgeone.app', 'attacker.edgeone-pages.com', 'phishing.pages.edgeone.ai', 'evil.edgeone.cn']) {
			expect(
				resolve_swagger_server_url(
					{ headers: { host: untrustedEo, 'eo-pages-host': untrustedEo } },
					{ NODE_ENV: 'production', APP_ENV: 'production', EDGEONE: '1' },
				),
			).toBe('https://zengjin.work/api')
		}

		// 即使误配置 TRUSTED_API_HOSTS=*.edgeone.* 或 *.edgeone.app 或 *.vercel.app，也不得生效
		expect(
			resolve_swagger_server_url(
				{ headers: { host: 'evil.edgeone.app' } },
				{ NODE_ENV: 'production', TRUSTED_API_HOSTS: '*.edgeone.*,*.edgeone.app,*.vercel.app,*' },
			),
		).toBe('https://zengjin.work/api')

		// 仅当平台环境变量 EO_PAGES_HOST / EDGEONE_PAGES_URL 或 TRUSTED_API_HOSTS 精确声明当前预览域名时才允许
		expect(
			resolve_swagger_server_url(
				{ headers: { host: 'zengjin-poc-123.edgeone.app' } },
				{ NODE_ENV: 'production', EDGEONE: '1', EO_PAGES_HOST: 'zengjin-poc-123.edgeone.app' },
			),
		).toBe('https://zengjin-poc-123.edgeone.app/api')

		expect(
			resolve_swagger_server_url(
				{ headers: { host: 'zengjin-poc-123.pages.edgeone.ai' } },
				{ NODE_ENV: 'production', TRUSTED_API_HOSTS: 'zengjin-poc-123.pages.edgeone.ai' },
			),
		).toBe('https://zengjin-poc-123.pages.edgeone.ai/api')
	})

	it('5. 严格拦截畸形 Host 注入、不可信 X-Forwarded-Host、云端本地回环与协议降级伪造', () => {
		// 即使带了可信 Host，也不受伪造 X-Forwarded-Host 影响
		expect(
			resolve_swagger_server_url(
				{ headers: { host: 'zengjin.work', 'x-forwarded-host': 'evil.com', 'x-forwarded-proto': 'https' } },
				{ NODE_ENV: 'production' },
			),
		).toBe('https://zengjin.work/api')

		// 畸形 Host（路径、参数、userinfo、多值逗号、数组、非法端口、非法 IPv4）必须全部拒绝
		for (const malformedHost of [
			'zengjin.work/evil',
			'zengjin.work?redirect=evil.com',
			'zengjin.work#frag',
			'attacker@zengjin.work',
			'zengjin.work, evil.com',
			['zengjin.work', 'evil.com'],
			'zengjin.work:65536',
			'zengjin.work:0',
			'zengjin.work:abc',
			'999.1.1.1',
		]) {
			expect(resolve_swagger_server_url({ headers: { host: malformedHost, 'x-forwarded-proto': 'https' } }, { NODE_ENV: 'production' })).toBe(
				'https://zengjin.work/api',
			)
		}

		// 客户端伪造 X-Forwarded-Proto: http 试图降级公网域时，仍固定输出 https
		expect(resolve_swagger_server_url({ headers: { host: '7890000.xyz', 'x-forwarded-proto': 'http' } }, { NODE_ENV: 'production' })).toBe(
			'https://7890000.xyz/api',
		)

		// 云端环境下伪造 Host: localhost / 127.0.0.1 / 内网 IP 绝不输出回环或私网地址
		for (const cloudSpoofLocal of ['localhost:10001', '127.0.0.1:10001', '[::1]:10001', '192.168.1.10:10001']) {
			expect(resolve_swagger_server_url({ headers: { host: cloudSpoofLocal } }, { NODE_ENV: 'production', EDGEONE: '1' })).toBe(
				'https://zengjin.work/api',
			)
		}

		// X-Forwarded-Host 仅在可信代理/网关条件下使用：
		// (a) 本地开发（非可信代理）即使 Host 异常也不读 X-Forwarded-Host
		const localUntrustedForward = resolve_swagger_server_url(
			{ headers: { host: 'evil.com', 'x-forwarded-host': '7890000.xyz' }, socket: {} },
			{ NODE_ENV: 'development' },
		)
		expect(localUntrustedForward).not.toContain('evil.com')
		expect(localUntrustedForward).not.toContain('7890000.xyz')

		// (b) 云端直连不可信公网 Host（非网关内网 Host 且无 TRUST_PROXY=1）时不信任 X-Forwarded-Host
		expect(
			resolve_swagger_server_url({ headers: { host: 'evil.com', 'x-forwarded-host': '7890000.xyz' } }, { NODE_ENV: 'production', APP_ENV: 'production' }),
		).toBe('https://zengjin.work/api')

		// (c) 可信平台网关改写内部 host 并透传白名单 x-forwarded-host 时正确还原
		expect(
			resolve_swagger_server_url(
				{ headers: { host: 'internal-runtime.local', 'x-forwarded-host': '7890000.xyz', 'x-forwarded-proto': 'https' } },
				{ NODE_ENV: 'production', APP_ENV: 'production' },
			),
		).toBe('https://7890000.xyz/api')
	})

	it('6. createSwaggerSpec 与 /api/doc/swagger.json 保持原有文档元信息并绑定动态 Server URL', async () => {
		const spec = await createSwaggerSpec('_', {
			headers: { host: '7890000.xyz', 'x-forwarded-proto': 'https' },
		})
		expect(spec.openapi).toBe('3.0.0')
		expect(spec.info?.title).toBe('api.zengjin.work')
		expect(spec.info?.version).toBe('1.0.0')
		expect(spec.servers).toEqual([{ url: 'https://7890000.xyz/api' }])
		expect(spec).toHaveProperty('paths')

		// 模拟 EdgeOne 下端到端访问 swagger.json
		delete process.env.VERCEL
		process.env.NODE_ENV = 'production'
		process.env.APP_ENV = 'production'
		let body = ''
		const res = {
			statusCode: 200,
			headers: {},
			setHeader(k, v) {
				this.headers[k] = v
			},
			end(chunk) {
				body = String(chunk || '')
			},
		}
		await docHandler(
			{
				url: '/api/doc/swagger.json',
				headers: {
					host: 'edgeone-test.zengjin.work',
					'x-forwarded-proto': 'http',
					'x-forwarded-host': 'evil.edgeone.app',
					cookie: 'apiDocPassword=123456',
				},
			},
			res,
		)
		const parsed = JSON.parse(body)
		expect(parsed.openapi).toBe('3.0.0')
		expect(parsed.info?.title).toBe('api.zengjin.work')
		expect(parsed.servers).toEqual([{ url: 'https://edgeone-test.zengjin.work/api' }])
	})
})
