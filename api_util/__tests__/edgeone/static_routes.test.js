import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { BARE_APPS, HISTORY_APPS, build_header_table, build_rewrite_table, inspect_app_assets, resolve_static_path } from '../../static_routes.js'

const APPS = [...HISTORY_APPS, ...BARE_APPS, 'index'].sort()

const tempDirs = []
afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true })
	}
})

describe('static_routes', () => {
	it('根路径与 /index 重定向', () => {
		expect(resolve_static_path('/', APPS)).toEqual({ type: 'file', path: '/index.html' })
		expect(resolve_static_path('/index', APPS)).toEqual({ type: 'redirect', path: '/' })
		expect(resolve_static_path('/index/', APPS)).toEqual({ type: 'redirect', path: '/' })
	})

	it('1. 现有全部 History 应用深链均回退到各自 index.html 且规则顺序正确', () => {
		const rules = build_rewrite_table(APPS)
		for (const app of HISTORY_APPS) {
			expect(resolve_static_path(`/${app}`, APPS)).toEqual({ type: 'file', path: `/${app}/index.html` })
			expect(resolve_static_path(`/${app}/`, APPS)).toEqual({ type: 'file', path: `/${app}/index.html` })
			expect(resolve_static_path(`/${app}/deep/nested/route?k=1`, APPS)).toEqual({ type: 'fallback', path: `/${app}/index.html` })

			const assetIndex = rules.findIndex(rule => rule.source === `/${app}/assets/*` && rule.destination === `/${app}/assets/:splat`)
			const pageIndex = rules.findIndex(rule => rule.source === `/${app}/*` && rule.destination === `/${app}/index.html`)
			expect(assetIndex).toBeGreaterThanOrEqual(0)
			expect(pageIndex).toBeGreaterThan(assetIndex)
		}
	})

	it('2. 仅对实际存在 audio/ 的应用生成 audio 规则（当前仅 cards）', () => {
		const rules = build_rewrite_table(APPS)
		const audioRules = rules.filter(rule => rule.source.endsWith('/audio/*'))
		expect(audioRules).toEqual([{ source: '/cards/audio/*', destination: '/cards/audio/:splat' }])

		const cardsAudioIdx = rules.findIndex(rule => rule.source === '/cards/audio/*')
		const cardsFallbackIdx = rules.findIndex(rule => rule.source === '/cards/*')
		expect(cardsAudioIdx).toBeGreaterThanOrEqual(0)
		expect(cardsAudioIdx).toBeLessThan(cardsFallbackIdx)
		expect(resolve_static_path('/cards/audio/lion.mp3', APPS)).toEqual({ type: 'file', path: '/cards/audio/lion.mp3' })

		for (const app of HISTORY_APPS.filter(item => item !== 'cards')) {
			expect(existsSync(path.join(process.cwd(), 'apps', app, 'audio'))).toBe(false)
			expect(rules.some(rule => rule.source === `/${app}/audio/*`)).toBe(false)
		}
	})

	it('3. 仅对实际存在 sw.js 的应用生成 Service Worker 规则（当前仅 cards）', () => {
		const rules = build_rewrite_table(APPS)
		const swRules = rules.filter(rule => rule.source.endsWith('/sw.js'))
		expect(swRules).toEqual([{ source: '/cards/sw.js', destination: '/cards/sw.js' }])

		const cardsSwIdx = rules.findIndex(rule => rule.source === '/cards/sw.js')
		const cardsFallbackIdx = rules.findIndex(rule => rule.source === '/cards/*')
		expect(cardsSwIdx).toBeGreaterThanOrEqual(0)
		expect(cardsSwIdx).toBeLessThan(cardsFallbackIdx)
		expect(resolve_static_path('/cards/sw.js', APPS)).toEqual({ type: 'file', path: '/cards/sw.js' })

		for (const app of HISTORY_APPS.filter(item => item !== 'cards')) {
			expect(existsSync(path.join(process.cwd(), 'apps', app, 'sw.js'))).toBe(false)
			expect(rules.some(rule => rule.source === `/${app}/sw.js`)).toBe(false)
		}
	})

	it('4. 不存在的 JS/CSS 等静态资源不被错误回退为 HTML，且无 /* 兜底', () => {
		const rules = build_rewrite_table(APPS)
		expect(rules.some(rule => rule.source === '/*')).toBe(false)

		for (const assetUrl of [
			'/missing.js',
			'/missing.css',
			'/admin/assets/missing.js',
			'/cards/assets/missing.css',
			'/$base/font/Iosevka.woff2',
			'/$apps/admin/config.js',
		]) {
			expect(resolve_static_path(assetUrl, APPS)).toEqual({ type: 'file', path: assetUrl })
		}
		expect(resolve_static_path('/unknown', APPS)).toEqual({ type: 'not_found' })
		expect(resolve_static_path('/unknown/nested', APPS)).toEqual({ type: 'not_found' })
	})

	it('5. 规则生成结果精简后为 75 条且远低于 EdgeOne 100 条上限', () => {
		const rules = build_rewrite_table(APPS)
		expect(rules.length).toBe(75)
		expect(rules.length).toBeLessThanOrEqual(100)
		for (const rule of rules) {
			expect(rule.source.startsWith('/')).toBe(true)
			expect((rule.source.match(/\*/g) || []).length).toBeLessThanOrEqual(1)
			expect(rule.destination.includes('/apps/')).toBe(false)
		}
	})

	it('6. 新增普通应用或 History 应用时按真实目录或配置准确生成规则', async () => {
		const tempRoot = await mkdtemp(path.join(tmpdir(), 'static-routes-apps-'))
		tempDirs.push(tempRoot)

		// 新增普通应用（只有 index.html）
		await mkdir(path.join(tempRoot, 'newbare/assets'), { recursive: true })
		await writeFile(path.join(tempRoot, 'newbare/index.html'), '<html>bare</html>')

		// 新增 History 应用（带 assets 与 audio，但无 sw.js）
		await mkdir(path.join(tempRoot, 'newhist/assets'), { recursive: true })
		await mkdir(path.join(tempRoot, 'newhist/audio'), { recursive: true })
		await writeFile(path.join(tempRoot, 'newhist/index.html'), '<html>hist</html>')

		const customApps = ['index', 'newbare', 'newhist']
		const customHistory = ['newhist']
		const rules = build_rewrite_table(customApps, {
			apps_dir: tempRoot,
			history_apps: customHistory,
		})

		expect(rules).toEqual([
			{ source: '/', destination: '/index.html' },
			{ source: '/newbare', destination: '/newbare/index.html' },
			{ source: '/newbare/', destination: '/newbare/index.html' },
			{ source: '/newhist/assets/*', destination: '/newhist/assets/:splat' },
			{ source: '/newhist/audio/*', destination: '/newhist/audio/:splat' },
			{ source: '/newhist', destination: '/newhist/index.html' },
			{ source: '/newhist/', destination: '/newhist/index.html' },
			{ source: '/newhist/*', destination: '/newhist/index.html' },
		])
		expect(inspect_app_assets('newhist', { apps_dir: tempRoot })).toEqual({ assets: true, audio: true, sw: false })
		expect(resolve_static_path('/newbare/sub', customApps, { history_apps: customHistory })).toEqual({ type: 'not_found' })
		expect(resolve_static_path('/newhist/sub', customApps, { history_apps: customHistory })).toEqual({ type: 'fallback', path: '/newhist/index.html' })
	})

	it('Hash/单页应用只映射入口，不吞深链', () => {
		expect(resolve_static_path('/sub', APPS)).toEqual({ type: 'file', path: '/sub/index.html' })
		expect(resolve_static_path('/sub/', APPS)).toEqual({ type: 'file', path: '/sub/index.html' })
		expect(resolve_static_path('/sub/deep', APPS)).toEqual({ type: 'not_found' })
	})

	it('API 前缀不参与静态决策', () => {
		expect(resolve_static_path('/api/base/app/home', APPS)).toEqual({ type: 'api' })
		expect(resolve_static_path('/api', APPS)).toEqual({ type: 'api' })
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
