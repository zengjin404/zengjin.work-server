import { describe, expect, it } from 'vitest'

import { BARE_APPS, HISTORY_APPS, build_header_table, build_rewrite_table, resolve_static_path } from '../../static_routes.js'

const APPS = [
	'404',
	'admin',
	'ai',
	'camera',
	'cards',
	'case',
	'char',
	'color',
	'cursor',
	'demo',
	'fa',
	'fa6',
	'gis',
	'index',
	'jndv',
	'key',
	'llq',
	'mic',
	'on',
	'qjt',
	'qrcode',
	'seal',
	'share',
	'storage',
	'sub',
	'tileset',
	'time',
]

describe('static_routes', () => {
	it('根路径与 /index 重定向', () => {
		expect(resolve_static_path('/', APPS)).toEqual({ type: 'file', path: '/index.html' })
		expect(resolve_static_path('/index', APPS)).toEqual({ type: 'redirect', path: '/' })
		expect(resolve_static_path('/index/', APPS)).toEqual({ type: 'redirect', path: '/' })
	})

	it('History 应用深链回退到各自 index.html', () => {
		expect(resolve_static_path('/admin', APPS)).toEqual({ type: 'file', path: '/admin/index.html' })
		expect(resolve_static_path('/admin/', APPS)).toEqual({ type: 'file', path: '/admin/index.html' })
		expect(resolve_static_path('/admin/system/user', APPS)).toEqual({ type: 'fallback', path: '/admin/index.html' })
		expect(resolve_static_path('/cards/recognize?card=1', APPS)).toEqual({ type: 'fallback', path: '/cards/index.html' })
	})

	it('Hash/单页应用只映射入口，不吞深链', () => {
		expect(resolve_static_path('/sub', APPS)).toEqual({ type: 'file', path: '/sub/index.html' })
		expect(resolve_static_path('/sub/', APPS)).toEqual({ type: 'file', path: '/sub/index.html' })
		expect(resolve_static_path('/sub/deep', APPS)).toEqual({ type: 'not_found' })
	})

	it('带扩展名一律按静态资源处理', () => {
		expect(resolve_static_path('/admin/assets/x.js', APPS)).toEqual({ type: 'file', path: '/admin/assets/x.js' })
		expect(resolve_static_path('/cards/sw.js', APPS)).toEqual({ type: 'file', path: '/cards/sw.js' })
		expect(resolve_static_path('/$base/config.js', APPS)).toEqual({ type: 'file', path: '/$base/config.js' })
		expect(resolve_static_path('/$apps/admin/config.js', APPS)).toEqual({ type: 'file', path: '/$apps/admin/config.js' })
		expect(resolve_static_path('/missing.js', APPS)).toEqual({ type: 'file', path: '/missing.js' })
	})

	it('API 前缀不参与静态决策', () => {
		expect(resolve_static_path('/api/base/app/home', APPS)).toEqual({ type: 'api' })
		expect(resolve_static_path('/api', APPS)).toEqual({ type: 'api' })
	})

	it('未知应用无扩展名返回 not_found', () => {
		expect(resolve_static_path('/unknown', APPS)).toEqual({ type: 'not_found' })
		expect(resolve_static_path('/unknown/nested', APPS)).toEqual({ type: 'not_found' })
	})

	it('默认 rewrite 表不含 /* 兜底，且覆盖全部 History 应用', () => {
		const rules = build_rewrite_table(APPS)
		expect(rules.length).toBeLessThanOrEqual(100)
		expect(rules.some(rule => rule.source === '/*')).toBe(false)
		for (const app of HISTORY_APPS) {
			expect(rules.some(rule => rule.source === `/${app}/*` && rule.destination === `/${app}/index.html`)).toBe(true)
			expect(rules.some(rule => rule.source === `/${app}/assets/*` && rule.destination === `/${app}/assets/:splat`)).toBe(true)
			expect(rules.some(rule => rule.source === `/${app}/audio/*` && rule.destination === `/${app}/audio/:splat`)).toBe(true)
			expect(rules.some(rule => rule.source === `/${app}/sw.js` && rule.destination === `/${app}/sw.js`)).toBe(true)
			const assetIndex = rules.findIndex(rule => rule.source === `/${app}/assets/*`)
			const pageIndex = rules.findIndex(rule => rule.source === `/${app}/*`)
			expect(assetIndex).toBeLessThan(pageIndex)
		}
		for (const rule of rules) {
			expect(rule.source.startsWith('/')).toBe(true)
			expect((rule.source.match(/\*/g) || []).length).toBeLessThanOrEqual(1)
			expect(rule.destination.includes('/apps/')).toBe(false)
		}
	})

	it('显式 include_404 时才生成通配兜底', () => {
		const rules = build_rewrite_table(APPS, { include_404: true })
		expect(rules.some(rule => rule.source === '/*' && rule.destination === '/404/index.html')).toBe(true)
	})

	it('响应头包含 Service Worker 作用域与关键 MIME', () => {
		const headers = build_header_table()
		expect(headers.length).toBeLessThanOrEqual(30)
		const sw = headers.find(item => item.source === '/cards/sw.js')
		expect(sw.headers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: 'Service-Worker-Allowed', value: '/cards' }),
				expect.objectContaining({ key: 'Cache-Control', value: 'no-cache' }),
			]),
		)
		for (const ext of ['wasm', 'glb', 'jsonl', 'mjs', 'woff2']) {
			expect(headers.some(item => item.source === `/*.${ext}`)).toBe(true)
		}
	})

	it('BARE_APPS 与 HISTORY_APPS 不重叠', () => {
		for (const app of BARE_APPS) expect(HISTORY_APPS.includes(app)).toBe(false)
	})
})
