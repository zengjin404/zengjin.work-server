import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clear_refresh_cookie, is_https, refresh_cookie } from '../../cookie.js'

const KEYS = ['COOKIE_SECURE', 'COOKIE_SAMESITE']
let saved = {}

beforeEach(() => {
	saved = {}
	for (const key of KEYS) {
		saved[key] = process.env[key]
		delete process.env[key]
	}
})

afterEach(() => {
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key]
		else process.env[key] = saved[key]
	}
})

function req(proto) {
	return { headers: proto ? { 'x-forwarded-proto': proto } : {}, socket: {} }
}

describe('refreshToken Cookie 属性', () => {
	it('HTTP 且无配置：SameSite=Lax，无 Secure，始终 HttpOnly/Path=/', () => {
		const cookie = refresh_cookie('abc', 100, req())
		expect(cookie).toContain('refreshToken=abc')
		expect(cookie).toContain('HttpOnly')
		expect(cookie).toContain('Path=/')
		expect(cookie).toContain('Max-Age=100')
		expect(cookie).toContain('SameSite=Lax')
		expect(cookie).not.toContain('Secure')
		expect(cookie).not.toContain('Domain=')
	})

	it('HTTPS：默认保持 Vercel 的 SameSite=None; Secure', () => {
		const cookie = refresh_cookie('abc', 100, req('https'))
		expect(cookie).toContain('SameSite=None')
		expect(cookie).toContain('Secure')
		expect(is_https(req('https'))).toBe(true)
	})

	it('COOKIE_SAMESITE=Lax 覆盖默认值，但 Secure 仍按协议设置', () => {
		process.env.COOKIE_SAMESITE = 'Lax'
		const cookie = refresh_cookie('abc', 100, req('https'))
		expect(cookie).toContain('SameSite=Lax')
		expect(cookie).toContain('Secure')
	})

	it('COOKIE_SECURE=0 强制不加密（仅用于本地）', () => {
		process.env.COOKIE_SECURE = '0'
		const cookie = refresh_cookie('abc', 100, req('https'))
		expect(cookie).not.toContain('Secure')
		expect(cookie).toContain('SameSite=Lax')
	})

	it('清除 Cookie 与设置 Cookie 使用同一组属性，Max-Age=0', () => {
		process.env.COOKIE_SAMESITE = 'Lax'
		const cookie = clear_refresh_cookie(req('https'))
		expect(cookie).toContain('refreshToken=')
		expect(cookie).toContain('Max-Age=0')
		expect(cookie).toContain('HttpOnly')
		expect(cookie).toContain('Path=/')
		expect(cookie).toContain('SameSite=Lax')
		expect(cookie).toContain('Secure')
	})
})
