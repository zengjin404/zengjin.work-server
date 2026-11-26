import { describe, expect, it } from 'vitest'

import { is_cron_authorized } from '../../cron_auth.js'

const SECRET = 'test-cron-secret-0123456789'

function req({ headers = {}, url = '/', query, body } = {}) {
	return { headers, url, query, body }
}

describe('is_cron_authorized', () => {
	it('CRON_SECRET 未配置时一律拒绝，包括 Bearer undefined', () => {
		const env = {}
		expect(is_cron_authorized(req({ headers: { authorization: 'Bearer undefined' } }), env).ok).toBe(false)
		expect(is_cron_authorized(req({ headers: { authorization: 'Bearer ' } }), env).ok).toBe(false)
		expect(is_cron_authorized(req({ query: { cron_token: '' } }), env).ok).toBe(false)
	})

	it('正确 Bearer 通过，错误 Bearer 拒绝', () => {
		expect(is_cron_authorized(req({ headers: { authorization: `Bearer ${SECRET}` } }), { CRON_SECRET: SECRET }).ok).toBe(true)
		expect(is_cron_authorized(req({ headers: { authorization: 'Bearer wrong' } }), { CRON_SECRET: SECRET }).ok).toBe(false)
	})

	it('x-cron-secret 通道', () => {
		expect(is_cron_authorized(req({ headers: { 'x-cron-secret': SECRET } }), { CRON_SECRET: SECRET }).ok).toBe(true)
		expect(is_cron_authorized(req({ headers: { 'x-cron-secret': 'wrong' } }), { CRON_SECRET: SECRET }).ok).toBe(false)
	})

	it('query cron_token 通道', () => {
		expect(is_cron_authorized(req({ url: `/?cron_token=${SECRET}` }), { CRON_SECRET: SECRET }).ok).toBe(true)
		expect(is_cron_authorized(req({ url: '/?cron_token=wrong' }), { CRON_SECRET: SECRET }).ok).toBe(false)
	})

	it('body cronSecret 通道', () => {
		expect(is_cron_authorized(req({ body: { cronSecret: SECRET } }), { CRON_SECRET: SECRET }).ok).toBe(true)
		expect(is_cron_authorized(req({ body: { cronSecret: 'wrong' } }), { CRON_SECRET: SECRET }).ok).toBe(false)
	})

	it('长度不同的输入不会抛异常（先摘要再比较）', () => {
		expect(() => is_cron_authorized(req({ headers: { authorization: 'Bearer x' } }), { CRON_SECRET: SECRET })).not.toThrow()
		expect(is_cron_authorized(req({ headers: { authorization: 'Bearer x' } }), { CRON_SECRET: SECRET }).ok).toBe(false)
	})

	it('返回命中通道，便于日志排查', () => {
		expect(is_cron_authorized(req({ headers: { authorization: `Bearer ${SECRET}` } }), { CRON_SECRET: SECRET }).channel).toBe('bearer')
		expect(is_cron_authorized(req({ headers: { 'x-cron-secret': SECRET } }), { CRON_SECRET: SECRET }).channel).toBe('header')
		expect(is_cron_authorized(req({ url: `/?cron_token=${SECRET}` }), { CRON_SECRET: SECRET }).channel).toBe('query')
		expect(is_cron_authorized(req({ body: { cronSecret: SECRET } }), { CRON_SECRET: SECRET }).channel).toBe('body')
	})
})
