/**
 * CF-POC-01 最小 Worker
 *
 * 静态资源由 Workers Static Assets 优先返回；本脚本只在静态未命中时执行。
 * 多应用 History 回退通过 env.ASSETS.fetch() 取对应应用的 index.html。
 * 本轮不代理生产 /api，不写生产数据库。
 */
const HISTORY_APPS = ['404', 'admin', 'ai', 'cards', 'case', 'color', 'gis', 'jndv', 'qjt', 'share']

// 已知静态资源扩展名：未命中时返回 404，绝不回退成 HTML。
const ASSET_EXTENSIONS = new Set([
	'js',
	'mjs',
	'css',
	'map',
	'json',
	'jsonl',
	'png',
	'jpg',
	'jpeg',
	'gif',
	'svg',
	'ico',
	'webp',
	'avif',
	'woff',
	'woff2',
	'ttf',
	'otf',
	'eot',
	'wasm',
	'glb',
	'gltf',
	'tflite',
	'bcmap',
	'ftl',
	'nes',
	'task',
	'mp3',
	'wav',
	'ogg',
	'mp4',
	'webm',
	'pdf',
	'zip',
	'doc',
	'docx',
	'xls',
	'xlsx',
	'ppt',
	'pptx',
	'txt',
	'md',
])

function json(data, status = 200) {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	})
}

function app_for_path(pathname) {
	const clean = pathname.replace(/\/+$/, '') || '/'
	for (const app of HISTORY_APPS) {
		if (clean === `/${app}` || clean.startsWith(`/${app}/`)) return app
	}
	return null
}

function looks_like_asset(pathname) {
	const last = pathname.split('/').pop() || ''
	const dot = last.lastIndexOf('.')
	if (dot <= 0) return false
	return ASSET_EXTENSIONS.has(last.slice(dot + 1).toLowerCase())
}

async function not_found(env, url, request) {
	const asset = await env.ASSETS.fetch(new URL('/404.html', url))
	if (asset.status === 404) {
		return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
	}
	return new Response(asset.body, {
		status: 404,
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
	})
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url)
		const path = url.pathname

		if (path === '/__cf/health') {
			return json({ ok: true, platform: 'cloudflare-workers', timestamp: Date.now() })
		}

		if (path === '/__cf/perf') {
			// Workers 运行时没有可靠的请求级 CPU 时间 API；不伪造。
			return json({ ok: true, platform: 'cloudflare-workers', timestamp: Date.now(), cpuTimeMs: null, cpuTimeAvailable: false })
		}

		if (path === '/__cf/headers') {
			return json({
				ok: true,
				method: request.method,
				path,
				cfRay: request.headers.get('cf-ray') || null,
				protocol: url.protocol.replace(':', ''),
				timestamp: Date.now(),
			})
		}

		if (path === '/__cf/error') {
			return json({ ok: false, platform: 'cloudflare-workers', error: 'intentional POC error' }, 500)
		}

		// 本轮不把测试域名变成生产 API 的通用代理。
		if (path === '/api' || path.startsWith('/api/')) {
			return json({ ok: false, code: -1, msg: 'CF POC 未配置生产 API 代理' }, 503)
		}

		// 静态命中时 Worker 不会被调用；这里再查一次仅用于兜底/未来 run_worker_first。
		const direct = await env.ASSETS.fetch(request)
		if (direct.status !== 404) {
			direct.headers.set('x-cf-poc', 'static')
			return direct
		}

		// 缺失的静态资源必须 404，不能回退成应用 HTML。
		if (looks_like_asset(path)) {
			return new Response('Not Found', {
				status: 404,
				headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
			})
		}

		const app = app_for_path(path)
		if (app) {
			const asset = await env.ASSETS.fetch(new URL(`/${app}/index.html`, url))
			if (asset.status === 200) {
				const headers = new Headers(asset.headers)
				headers.set('content-type', 'text/html; charset=utf-8')
				headers.set('cache-control', 'no-store')
				headers.set('x-cf-poc', `app:${app}`)
				return new Response(asset.body, { status: 200, headers })
			}
		}

		return not_found(env, url, request)
	},
}
