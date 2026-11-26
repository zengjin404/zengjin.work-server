import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

async function source(relative) {
	return readFile(path.join(ROOT, relative), 'utf8')
}

describe('EdgeOne 入口回归', () => {
	it('api/_doc.js 不在模块顶层读取 package.json', async () => {
		const text = await source('api/_doc.js')
		const module_scope = text.split('export default async function main')[0]
		expect(module_scope).not.toContain('const packageJson')
		expect(module_scope).not.toContain('swagger-jsdoc')
		expect(text).toContain('function read_doc_file')
		expect(text).toContain('export default async function main')
	})

	it('api/index.js 对 doc/firebase 使用动态 import', async () => {
		const text = await source('api/index.js')
		expect(text).toContain("await import('./_doc.js')")
		expect(text).toContain("await import('./_firebase.js')")
		expect(text).not.toContain("import docHandler from './_doc.js'")
	})

	it('api_util/ws.js 不再依赖未声明的 node-fetch', async () => {
		const text = await source('api_util/ws.js')
		expect(text).not.toContain("from 'node-fetch'")
		expect(text).not.toContain("import('node-fetch')")
		expect(text).toContain('globalThis.fetch')
	})

	it('api/_base/ai.js 不含硬编码 sk- Key', async () => {
		const text = await source('api/_base/ai.js')
		expect(text).not.toMatch(/sk-[A-Za-z0-9]{20,}/)
	})

	it('api/index.js 可以在无顶层 FS 读取的情况下被导入', async () => {
		const mod = await import('../../../api/index.js')
		expect(typeof mod.default).toBe('function')
	})

	it('api/_doc.js 可以在模块加载阶段被安全导入', async () => {
		const mod = await import('../../../api/_doc.js')
		expect(typeof mod.default).toBe('function')
	})

	it('edgeone 入口文件导出 Express 实例，并延迟加载 masterHandler', async () => {
		const text = await source('cloud-functions/api/[[default]].js')
		expect(text).toContain("import('../../api/index.js')")
		expect(text).not.toContain("import masterHandler from '../../api/index.js'")
		const mod = await import('../../../cloud-functions/api/[[default]].js')
		expect(typeof mod.default).toBe('function')
		expect(typeof mod.default.listen).toBe('function')
	})
})
