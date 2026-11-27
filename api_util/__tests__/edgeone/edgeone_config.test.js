import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { HISTORY_APPS, build_rewrite_table, inspect_app_assets } from '../../static_routes.js'

const CONFIG_PATH = path.resolve(process.cwd(), 'edgeone.json')

describe('edgeone.json 配置契约', () => {
	it('构建命令与输出目录和准备脚本一致', async () => {
		const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
		expect(config.buildCommand).toBe('bun scripts/prepare-edgeone.mjs')
		expect(config.outputDirectory).toBe('edgeone-dist')
		expect(config.nodeVersion).toBe('20.18.0')
		expect(config.cloudFunctions?.nodejs?.maxDuration).toBe(120)
	})

	it('rewrites / headers 不超过平台限制', async () => {
		const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
		expect(config.rewrites.length).toBeLessThanOrEqual(100)
		expect(config.headers.length).toBeLessThanOrEqual(30)
		expect(config.redirects.length).toBeLessThanOrEqual(100)
	})

	it('每个 History 应用都有深链回退，特殊资源按真实存在按需生成且顺序在前', async () => {
		const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
		const sources = new Set(config.rewrites.map(rule => rule.source))
		for (const app of HISTORY_APPS) {
			const flags = inspect_app_assets(app)
			expect(sources.has(`/${app}/*`)).toBe(true)
			const pageIndex = config.rewrites.findIndex(rule => rule.source === `/${app}/*`)

			if (flags.assets) {
				expect(sources.has(`/${app}/assets/*`)).toBe(true)
				const assetIndex = config.rewrites.findIndex(rule => rule.source === `/${app}/assets/*`)
				expect(assetIndex).toBeLessThan(pageIndex)
			}
			expect(sources.has(`/${app}/audio/*`)).toBe(flags.audio)
			if (flags.audio) {
				const audioIndex = config.rewrites.findIndex(rule => rule.source === `/${app}/audio/*`)
				expect(audioIndex).toBeLessThan(pageIndex)
			}
			expect(sources.has(`/${app}/sw.js`)).toBe(flags.sw)
			if (flags.sw) {
				const swIndex = config.rewrites.findIndex(rule => rule.source === `/${app}/sw.js`)
				expect(swIndex).toBeLessThan(pageIndex)
			}
		}
		for (const rule of config.rewrites) {
			expect(rule.source.startsWith('/')).toBe(true)
			expect((rule.source.match(/\*/g) || []).length).toBeLessThanOrEqual(1)
			expect(rule.destination).not.toContain('/apps/')
		}
		expect(config.rewrites).toEqual(build_rewrite_table())
	})

	it('www 自定义域名 301 重定向到主站，且置于 redirects 首位', async () => {
		const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
		expect(config.redirects[0]).toEqual({ source: '$wwwhost', destination: '$host', statusCode: 301 })
		// 防止误配成反向规则造成 www ↔ 主站循环
		expect(config.redirects.some(rule => rule.source === '$host' && rule.destination === '$wwwhost')).toBe(false)
	})

	it('默认不使用 /* 兜底，避免把不存在的 .js 返回成 HTML', async () => {
		const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
		expect(config.rewrites.some(rule => rule.source === '/*')).toBe(false)
	})

	it('Service Worker 响应头存在', async () => {
		const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
		const sw = config.headers.find(item => item.source === '/cards/sw.js')
		expect(sw).toBeTruthy()
		expect(sw.headers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: 'Service-Worker-Allowed', value: '/cards' }),
				expect.objectContaining({ key: 'Cache-Control', value: 'no-cache' }),
			]),
		)
	})

	it('定时任务使用 GET + Asia/Shanghai，且只配置保活', async () => {
		const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
		expect(config.schedules.length).toBe(1)
		const job = config.schedules[0]
		expect(job.path).toBe('/api/base/keepalive/supabase')
		expect(job.method).toBe('GET')
		expect(job.timezone).toBe('Asia/Shanghai')
		expect(job.cron).toBe('0 3 * * *')
		expect(config.schedules.some(item => item.path.includes('/backup'))).toBe(false)
	})

	it('header key/value 为 ASCII 且在长度限制内', async () => {
		const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
		for (const item of config.headers) {
			for (const header of item.headers) {
				expect(header.key.length).toBeGreaterThanOrEqual(1)
				expect(header.key.length).toBeLessThanOrEqual(100)
				expect(header.value.length).toBeGreaterThanOrEqual(1)
				expect(header.value.length).toBeLessThanOrEqual(1000)
				expect(/^[\x20-\x7e]+$/.test(header.value)).toBe(true)
			}
		}
	})
})
