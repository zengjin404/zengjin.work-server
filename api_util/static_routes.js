/**
 * 多子应用静态路由决策
 *
 * 与前端实际路由模式对应（2026-11-26 实测构建产物）：
 *  - History：404 / admin / ai / cards / case / color / gis / jndv / qjt / share
 *  - Hash 或单页：其余已构建子应用
 *  - index 是首页，单独映射到根 index.html
 *  - music 当前无 index.html，属于部分产物，不参与回退
 *
 * 注意：这里只生成“页面型”回退规则，不生成 assets/audio 的身份重写。
 * 普通 rewrite 与静态资源的优先级 EdgeOne 官方未明确；POC 必须先验证 G1。
 */

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
	// 404 也是 History 应用，需要自己的深链回退；只有根应用单独映射到 /
	return apps.filter(app => app !== ROOT_APP)
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
 * @param {{ include_404?: boolean }} [options]
 * @returns {Array<{source: string, destination: string}>}
 */
export function build_rewrite_table(apps = [...HISTORY_APPS, ...BARE_APPS, ROOT_APP, NOT_FOUND_APP], options = {}) {
	const rules = [{ source: '/', destination: '/index.html' }]

	for (const app of page_apps(apps)) {
		if (HISTORY_APPS.includes(app)) {
			// G1 防护：普通 rewrite 若先于静态资源匹配，下面的 /* 回退会把 assets/audio/sw.js
			// 也改写成 HTML。先放身份重写，命中后仍指向原物理文件。
			rules.push({ source: `/${app}/assets/*`, destination: `/${app}/assets/:splat` })
			rules.push({ source: `/${app}/audio/*`, destination: `/${app}/audio/:splat` })
			rules.push({ source: `/${app}/sw.js`, destination: `/${app}/sw.js` })
		}
		rules.push({ source: `/${app}`, destination: `/${app}/index.html` })
		rules.push({ source: `/${app}/`, destination: `/${app}/index.html` })
		if (HISTORY_APPS.includes(app)) {
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
 * @param {string[]} apps 已构建且含 index.html 的应用名
 * @returns {{ type: 'api'|'file'|'redirect'|'fallback'|'not_found', path?: string }}
 */
export function resolve_static_path(url, apps = [...HISTORY_APPS, ...BARE_APPS, ROOT_APP, NOT_FOUND_APP]) {
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
	if (HISTORY_APPS.includes(app)) return { type: 'fallback', path: `/${app}/index.html` }
	return { type: 'not_found' }
}
