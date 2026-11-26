import express from 'express'

/**
 * EdgeOne Cloud Functions 的 Express 适配层
 *
 * 目标：把 EdgeOne 的请求无损交给现有 `masterHandler(req, res)`，
 * 不复制任何业务路由，不改现有响应结构。
 *
 * 关键点：
 *  - Express 4 的 `req.query` 是原型 getter；`api/index.js` 会执行
 *    `req.query.action = fullAction`，必须用 own property 覆盖，否则写入会丢。
 *  - EdgeOne 按目录挂载函数：`cloud-functions/api/[[default]].js` → `/api/*`，
 *    Express 看到的 `req.url` 可能已被剥离 `/api`；统一用 `originalUrl` 还原。
 *  - `masterHandler` 依赖 `req.body`，必须显式挂 json/urlencoded 解析器。
 *  - SSE 不额外包装，保留 writeHead/flushHeaders/write/end 直通。
 */

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
	'Access-Control-Allow-Headers':
		'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization',
}

function normalize_public_url(req) {
	const raw = req.headers['x-original-url'] || req.headers['x-forwarded-uri'] || req.originalUrl || req.url || '/'
	let url = String(raw)
	if (!url.startsWith('/')) url = '/' + url
	if (url === '/api' || url.startsWith('/api/') || url.startsWith('/api?')) return url
	return '/api' + url
}

function shadow_query(req) {
	const query = req.query && typeof req.query === 'object' ? req.query : {}
	Object.defineProperty(req, 'query', {
		value: { ...query },
		writable: true,
		configurable: true,
		enumerable: true,
	})
}

/**
 * @param {{ handler: (req: any, res: any) => any }} options
 * @returns {import('express').Express}
 */
export function create_edgeone_app({ handler } = {}) {
	if (typeof handler !== 'function') {
		throw new TypeError('create_edgeone_app 需要 handler(req, res) 函数')
	}

	const app = express()
	app.disable('x-powered-by')

	app.use(express.json({ limit: '6mb' }))
	app.use(express.urlencoded({ extended: true, limit: '6mb' }))

	app.use((req, res, next) => {
		for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value)
		if (req.method === 'OPTIONS') {
			res.status(200).end()
			return
		}
		next()
	})

	app.use(async (req, res) => {
		try {
			shadow_query(req)
			req.url = normalize_public_url(req)
			await handler(req, res)
		} catch (error) {
			console.error('[EdgeOne Adapter] handler error:', error)
			if (res.headersSent) {
				try {
					res.end()
				} catch {}
				return
			}
			res.status(500).json({ code: -1, msg: 'EdgeOne 适配层内部错误', details: error.message })
		}
	})

	// express.json/urlencoded 的解析错误（含 6MB 超限）走这里
	app.use((error, req, res, next) => {
		if (res.headersSent) return next(error)
		const tooLarge = error?.type === 'entity.too.large'
		res.status(tooLarge ? 413 : 400).json({
			code: -1,
			msg: tooLarge ? '请求体超过 6MB 限制' : '请求解析失败',
			details: error.message,
		})
	})

	return app
}
