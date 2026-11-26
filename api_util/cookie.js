/**
 * refreshToken Cookie 属性统一生成
 *
 * 背景：原实现用 `NODE_ENV === 'production' && VERCEL_ENV === 'production'`
 * 判断是否加 `SameSite=None; Secure`。EdgeOne 不提供 VERCEL_ENV，会退化为
 * `SameSite=Lax` 且缺少 Secure。这里改为按请求协议判断，平台中立。
 *
 * 默认行为与 Vercel 生产保持一致：HTTPS → SameSite=None; Secure。
 * EdgeOne 同源部署建议显式设置 COOKIE_SAMESITE=Lax，减少跨站携带面。
 * Cookie 始终不设置 Domain，保持 host-only，测试域与正式域天然隔离。
 */

const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60

export function is_https(req) {
	if (process.env.COOKIE_SECURE === '1') return true
	if (process.env.COOKIE_SECURE === '0') return false

	const forwarded = String(req?.headers?.['x-forwarded-proto'] || '')
		.split(',')[0]
		.trim()
		.toLowerCase()
	if (forwarded) return forwarded === 'https'

	return Boolean(req?.socket?.encrypted)
}

export function refresh_cookie(value, max_age = DEFAULT_MAX_AGE, req) {
	const secure = is_https(req)
	const same_site = process.env.COOKIE_SAMESITE || (secure ? 'None' : 'Lax')
	const parts = [`refreshToken=${value}`, 'HttpOnly', 'Path=/', `Max-Age=${max_age}`, `SameSite=${same_site}`]
	if (secure) parts.push('Secure')
	return parts.join('; ')
}

export function clear_refresh_cookie(req) {
	return refresh_cookie('', 0, req)
}
