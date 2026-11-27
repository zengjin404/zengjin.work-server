import { describe, expect, it, vi } from 'vitest'

// 若总入口仍静态加载业务模块，这条 mock 会在导入阶段直接抛错
vi.mock('../../../api/_cards.js', () => {
	throw new Error('cards 模块不应在 demo / 404 路由中被加载')
})

const masterHandler = (await import('../../../api/index.js')).default

function make_resp() {
	const out = { status: 200, body: null }
	const resp = {
		status(code) {
			out.status = code
			return resp
		},
		json(data) {
			out.body = data
			return resp
		},
		setHeader() {},
		end() {},
	}
	return { resp, out }
}

async function dispatch(url, method = 'GET') {
	const { resp, out } = make_resp()
	await masterHandler({ url, method, headers: {}, query: {} }, resp)
	return out
}

describe('api/index.js — 路由分发回归', () => {
	it('demo/hello 无需数据库即可返回，且不会加载 cards 模块', async () => {
		const out = await dispatch('/api/demo/hello')
		expect(out.status).toBe(200)
		expect(out.body.message).toContain('你好世界')
	})

	it('未知顶级模块返回 404', async () => {
		const out = await dispatch('/api/not_exists/hello')
		expect(out.status).toBe(404)
		expect(out.body.error).toContain('未知系统级模块')
	})

	it('base 未挂载子模块返回 404', async () => {
		const out = await dispatch('/api/base/not_exists/select')
		expect(out.status).toBe(404)
		expect(out.body.error).toContain('未识别或未挂载的业务模块')
	})

	it('zone 未挂载实体返回 404', async () => {
		const out = await dispatch('/api/zone/not_exists/class/select')
		expect(out.status).toBe(404)
		expect(out.body.error).toContain('未识别或未挂载的接口模块')
	})

	it('admin/notification 未登录返回 401（仅加载通知模块）', async () => {
		const out = await dispatch('/api/admin/notification/select')
		expect(out.status).toBe(401)
		expect(out.body.code).toBe(-1)
	})

	it('base/user/me 未登录返回 401', async () => {
		const out = await dispatch('/api/base/user/me')
		expect(out.status).toBe(401)
		expect(out.body.code).toBe(-1)
	})
})
