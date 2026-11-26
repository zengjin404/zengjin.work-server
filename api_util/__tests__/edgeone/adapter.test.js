import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { create_edgeone_app } from '../../edgeone_app.js'

let server
let base

function start(handler) {
	const app = create_edgeone_app({ handler })
	return new Promise(resolve => {
		const instance = app.listen(0, '127.0.0.1', () => {
			const { port } = instance.address()
			resolve({ instance, base: `http://127.0.0.1:${port}` })
		})
	})
}

beforeAll(async () => {
	const handler = async (req, res) => {
		if (req.url.startsWith('/api/sse')) {
			res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
			res.write('data: one\n\n')
			setTimeout(() => {
				res.write('data: two\n\n')
				res.end()
			}, 20)
			return
		}
		if (req.url.startsWith('/api/boom')) throw new Error('boom')
		// 模拟 api/index.js 的写入：必须是可写 own property
		req.query.action = ['demo', 'echo']
		res.status(200).json({
			url: req.url,
			method: req.method,
			query: req.query,
			body: req.body,
			authorization: req.headers.authorization || '',
		})
	}
	const started = await start(handler)
	server = started.instance
	base = started.base
})

afterAll(async () => {
	await new Promise(resolve => server.close(resolve))
})

describe('EdgeOne Express 适配层', () => {
	it('还原被剥离的 /api 前缀，并保留 query', async () => {
		const res = await fetch(`${base}/echo?x=1&y=2`)
		const data = await res.json()
		expect(data.url).toBe('/api/echo?x=1&y=2')
		expect(data.query.x).toBe('1')
		expect(data.query.y).toBe('2')
	})

	it('req.query.action 写入后仍可读（own property 覆盖 Express getter）', async () => {
		const res = await fetch(`${base}/api/echo`)
		const data = await res.json()
		expect(data.query.action).toEqual(['demo', 'echo'])
	})

	it('解析 JSON body', async () => {
		const res = await fetch(`${base}/api/echo`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ a: 1, nested: { b: 2 } }),
		})
		const data = await res.json()
		expect(data.method).toBe('POST')
		expect(data.body).toEqual({ a: 1, nested: { b: 2 } })
	})

	it('解析 urlencoded body', async () => {
		const res = await fetch(`${base}/api/echo`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'a=1&b=2',
		})
		const data = await res.json()
		expect(data.body).toEqual({ a: '1', b: '2' })
	})

	it('OPTIONS 返回 200 与 CORS 头', async () => {
		const res = await fetch(`${base}/api/echo`, { method: 'OPTIONS' })
		expect(res.status).toBe(200)
		expect(res.headers.get('access-control-allow-origin')).toBe('*')
		expect(res.headers.get('access-control-allow-methods')).toContain('POST')
	})

	it('1MB JSON 可以通过', async () => {
		const payload = JSON.stringify({ text: 'x'.repeat(1024 * 1024) })
		const res = await fetch(`${base}/api/echo`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: payload,
		})
		expect(res.status).toBe(200)
	})

	it('超过 6MB 的 JSON 返回 413', async () => {
		const payload = JSON.stringify({ text: 'x'.repeat(6.5 * 1024 * 1024) })
		const res = await fetch(`${base}/api/echo`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: payload,
		})
		expect(res.status).toBe(413)
		const data = await res.json()
		expect(data.code).toBe(-1)
	})

	it('handler 抛错返回 500 JSON', async () => {
		const res = await fetch(`${base}/api/boom`)
		expect(res.status).toBe(500)
		const data = await res.json()
		expect(data.code).toBe(-1)
		expect(data.details).toContain('boom')
	})

	it('SSE 分块直通，不被适配层缓冲', async () => {
		const res = await fetch(`${base}/api/sse`)
		expect(res.headers.get('content-type')).toContain('text/event-stream')
		const reader = res.body.getReader()
		const decoder = new TextDecoder()
		let text = ''
		while (true) {
			const { value, done } = await reader.read()
			if (done) break
			text += decoder.decode(value, { stream: true })
		}
		expect(text).toContain('data: one')
		expect(text).toContain('data: two')
	})
})
