import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * 平台中立的定时任务鉴权
 *
 * 支持通道：
 *  - Authorization: Bearer <CRON_SECRET>  （Vercel Cron 自动注入）
 *  - x-cron-secret: <CRON_SECRET>         （EdgeOne 控制台/网关注入）
 *  - URL ?cron_token=<CRON_SECRET>        （平台只允许配置 URL 时的兜底）
 *  - body.cronSecret / body.cron_secret   （平台 schedules 支持 payload 时的兜底）
 *
 * 安全约束：
 *  - CRON_SECRET 未配置时一律拒绝，绝不接受 "Bearer undefined"
 *  - 所有比较先做 SHA-256 摘要，再 timingSafeEqual，避免长度差异与计时侧信道
 */

const DIGEST_BYTES = 32

function digest(value) {
	return createHash('sha256')
		.update(String(value ?? ''))
		.digest()
}

function safe_equal(input, expected) {
	if (!input || !expected) return false
	const a = digest(input)
	const b = digest(expected)
	return a.length === DIGEST_BYTES && b.length === DIGEST_BYTES && timingSafeEqual(a, b)
}

function read_header(req, name) {
	const headers = req?.headers || {}
	return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || ''
}

function read_query(req) {
	if (req?.query && typeof req.query === 'object') return req.query
	try {
		const url = new URL(req?.url || '/', 'http://localhost')
		return Object.fromEntries(url.searchParams.entries())
	} catch {
		return {}
	}
}

/**
 * @param {import('http').IncomingMessage & { query?: any, body?: any }} req
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: boolean, channel: string, reason?: string }}
 */
export function is_cron_authorized(req, env = process.env) {
	const secret = env.CRON_SECRET
	if (!secret) return { ok: false, channel: 'none', reason: 'CRON_SECRET 未配置' }

	const authorization = String(read_header(req, 'authorization') || '')
	const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
	if (bearer && safe_equal(bearer, secret)) return { ok: true, channel: 'bearer' }

	const header_secret = read_header(req, 'x-cron-secret')
	if (header_secret && safe_equal(header_secret, secret)) return { ok: true, channel: 'header' }

	const query = read_query(req)
	const query_secret = query.cron_token ?? query.cronToken ?? query.cronSecret ?? ''
	if (query_secret && safe_equal(query_secret, secret)) return { ok: true, channel: 'query' }

	const body_secret = req?.body?.cronSecret ?? req?.body?.cron_secret ?? ''
	if (body_secret && safe_equal(body_secret, secret)) return { ok: true, channel: 'body' }

	return { ok: false, channel: 'none', reason: '未提供有效密钥' }
}
