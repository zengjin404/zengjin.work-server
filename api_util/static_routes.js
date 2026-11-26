/**
 * 多子应用静态路由决策
 *
 * 与前端实际路由模式对应（以 apps/<app> 实际磁盘资源或显式配置为依据）：
 *  - History：404 / admin / ai / cards / case / color / gis / jndv / qjt / share
 *  - Hash 或单页：其余已构建子应用
 *  - index 是首页，单独映射到根 index.html
 *
 * 注意：
 *  - G1 防护：普通 rewrite 与静态资源的优先级 EdgeOne 官方未明确，
 *    因此为 History 应用保留 /app/assets/* 身份重写，并按实际存在情况
 *    仅对真正拥有 audio/ 或 sw.js 的应用生成对应规则。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_APPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps')

export const ROOT_APP = 'index'
export const NOT_FOUND_APP = '404'

export const HISTORY_APPS = ['404', 'admin', 'ai', 'cards', 'case', 'color', 'gis', 'jndv', 'qjt', 'share']

export const BARE_APPS = ['camera', 'char', 'cursor', 'demo', 'fa', 'fa6', 'key', 'llq', 'mic', 'on', 'qrcode', 'seal', 'storage', 'sub', 'tileset', 'time']

export const MIME_EXTENSIONS = {
	glb: 'model/gltf-binary',
	jsonl: 'application/x-ndjson',
	task: 'application/octet-stream',
	tflite: 'application/octet-stream',
	bcmap: 'application/octet-stream',
	ftl: 'application/octet-stream',
	nes: 'application/octet-stream',
	mjs: 'text/javascript; charset=utf-8',
	wasm: 'application/wasm',
	woff2: 'font/woff2',
}

function page_apps(apps) {
	// 404 也是 History 应用，需要自己的深链回退；同时去重避免重复生成同一应用规则；只有根应用单独映射到 /
	return [...new Set(apps)].filter(app => app !== ROOT_APP)
}

/**
 * 依据实际应用目录或显式配置，判定应用需要生成的特殊资源身份重写开关
 * @param {string} app
 * @param {{ apps_dir?: string, app_assets?: Record<string, { assets?: boolean, audio?: boolean, sw?: boolean }> }} [options]
 * @returns {{ assets: boolean, audio: boolean, sw: boolean }}
 */
export function inspect_app_assets(app, options = {}) {
	const explicit = options.app_assets?.[app]
	const appsDir = options.apps_dir || DEFAULT_APPS_DIR
	const appDir = path.join(appsDir, app)
	const hasAppDir = existsSync(appDir)

	const hasAssets = typeof explicit?.assets === 'boolean' ? explicit.assets : hasAppDir ? existsSync(path.join(appDir, 'assets')) : true
	const hasAudio = typeof explicit?.audio === 'boolean' ? explicit.audio : hasAppDir && existsSync(path.join(appDir, 'audio'))
	const hasSw = typeof explicit?.sw === 'boolean' ? explicit.sw : hasAppDir && existsSync(path.join(appDir, 'sw.js'))

	return {
		assets: Boolean(hasAssets),
		audio: Boolean(hasAudio),
		sw: Boolean(hasSw),
	}
}

/**
 * 生成 EdgeOne `rewrites` 表。
 *
 * 默认不生成 `/*` → `/404/index.html`：单一通配会把不存在的 .js/.css
 * 也返回成 HTML，违反“静态资源 404 不能伪装成页面”的验收要求。
 * 404 兜底优先交给平台的自定义 404 页（edgeone-dist/404.html）或控制台配置；
 * 只有确认平台能按状态码区分时，才显式传 { include_404: true }。
 *
 * @param {string[]} [apps] 已构建且含 index.html 的应用名
 * @param {{
 *   include_404?: boolean,
 *   history_apps?: string[],
 *   apps_dir?: string,
 *   app_assets?: Record<string, { assets?: boolean, audio?: boolean, sw?: boolean }>
 * }} [options]
 * @returns {Array<{source: string, destination: string}>}
 */
export function build_rewrite_table(apps = [...new Set([...HISTORY_APPS, ...BARE_APPS, ROOT_APP, NOT_FOUND_APP])], options = {}) {
	const historySet = new Set(options.history_apps || HISTORY_APPS)
	const rules = [{ source: '/', destination: '/index.html' }]

	for (const app of page_apps(apps)) {
		if (historySet.has(app)) {
			// G1 防护：先放身份重写，命中真实静态资源后保持指向物理文件，不被 /* 吞掉。
			// 只为实际存在对应资源（或显式声明）的应用生成 rules，避免无谓消耗配额。
			const flags = inspect_app_assets(app, options)
			if (flags.assets) rules.push({ source: `/${app}/assets/*`, destination: `/${app}/assets/:splat` })
			if (flags.audio) rules.push({ source: `/${app}/audio/*`, destination: `/${app}/audio/:splat` })
			if (flags.sw) rules.push({ source: `/${app}/sw.js`, destination: `/${app}/sw.js` })
		}
		rules.push({ source: `/${app}`, destination: `/${app}/index.html` })
		rules.push({ source: `/${app}/`, destination: `/${app}/index.html` })
		if (historySet.has(app)) {
			rules.push({ source: `/${app}/*`, destination: `/${app}/index.html` })
		}
	}

	if (options.include_404) {
		rules.push({ source: '/*', destination: `/${NOT_FOUND_APP}/index.html` })
	}

	return rules
}

/**
 * 生成响应头表：Service Worker 作用域 + 常见二进制/MIME 扩展。
 * @returns {Array<{source: string, headers: Array<{key: string, value: string}>}>}
 */
export function build_header_table() {
	const headers = [
		{
			source: '/cards/sw.js',
			headers: [
				{ key: 'Service-Worker-Allowed', value: '/cards' },
				{ key: 'Cache-Control', value: 'no-cache' },
			],
		},
		{
			source: '/cards/index.html',
			headers: [{ key: 'Cache-Control', value: 'no-cache' }],
		},
	]

	for (const [ext, mime] of Object.entries(MIME_EXTENSIONS)) {
		headers.push({ source: `/*.${ext}`, headers: [{ key: 'Content-Type', value: mime }] })
	}

	return headers
}

/**
 * 纯函数化静态决策，供单测与部署前自检使用。
 * @param {string} url 请求路径（可含 query）
 * @param {string[]} [apps] 已构建且含 index.html 的应用名
 * @param {{ history_apps?: string[] }} [options]
 * @returns {{ type: 'api'|'file'|'redirect'|'fallback'|'not_found', path?: string }}
 */
export function resolve_static_path(url, apps = [...new Set([...HISTORY_APPS, ...BARE_APPS, ROOT_APP, NOT_FOUND_APP])], options = {}) {
	const historyApps = options.history_apps || HISTORY_APPS
	const pathname = String(url || '/').split('?')[0]
	if (pathname === '/api' || pathname.startsWith('/api/')) return { type: 'api' }
	if (pathname === '/' || pathname === '') return { type: 'file', path: '/index.html' }
	if (pathname === '/index' || pathname === '/index/') return { type: 'redirect', path: '/' }

	// $base / $apps 是共享静态目录，目录名以 $ 开头，不参与子应用名匹配
	if (pathname.startsWith('/$base/') || pathname.startsWith('/$apps/')) {
		return { type: 'file', path: pathname }
	}

	// 带扩展名一律按静态资源处理；真正的文件存在性由 CDN 判断（不存在由平台返回 404，不回退 HTML）
	if (/\.\w+$/.test(pathname)) return { type: 'file', path: pathname }

	const match = pathname.match(/^\/([a-zA-Z0-9]+)(\/|$)/)
	if (!match) return { type: 'not_found' }
	const app = match[1]

	if (!apps.includes(app)) return { type: 'not_found' }
	if (pathname === `/${app}` || pathname === `/${app}/`) return { type: 'file', path: `/${app}/index.html` }
	if (historyApps.includes(app)) return { type: 'fallback', path: `/${app}/index.html` }
	return { type: 'not_found' }
}
