import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SECRET_PATTERNS, scan_manifest_for_secrets } from '../../../scripts/verify-edgeone-dist.mjs'

const created = []

async function temp_dir() {
	const dir = await mkdtemp(path.join(tmpdir(), 'edgeone-secret-'))
	created.push(dir)
	return dir
}

afterEach(async () => {
	for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('静态产物密钥扫描', () => {
	it('能识别 OpenAI 风格密钥', async () => {
		const dir = await temp_dir()
		await writeFile(path.join(dir, 'a.js'), `const key = "sk-${'a'.repeat(40)}"`)
		await expect(scan_manifest_for_secrets({ files: [{ path: 'a.js' }] }, dir)).rejects.toThrow(/openai-style-key/)
	})

	it('能识别私钥、云厂商 AK、数据库密码', async () => {
		const dir = await temp_dir()
		await writeFile(path.join(dir, 'a.js'), '-----BEGIN PRIVATE KEY-----')
		await writeFile(path.join(dir, 'b.js'), `AKID${'a'.repeat(32)}`)
		await writeFile(path.join(dir, 'c.js'), 'npg_' + 'abcdefghijklmnop')
		for (const file of ['a.js', 'b.js', 'c.js']) {
			await expect(scan_manifest_for_secrets({ files: [{ path: file }] }, dir)).rejects.toThrow(/疑似密钥泄漏/)
		}
	})

	it('跳过第三方插件目录与二进制扩展', async () => {
		const dir = await temp_dir()
		await mkdir(path.join(dir, '$base/plugin/pdfjs'), { recursive: true })
		await writeFile(path.join(dir, '$base/plugin/pdfjs/a.js'), `AKID${'a'.repeat(32)}`)
		await writeFile(path.join(dir, 'a.wasm'), `AKID${'a'.repeat(32)}`)
		await expect(scan_manifest_for_secrets({ files: [{ path: '$base/plugin/pdfjs/a.js' }, { path: 'a.wasm' }] }, dir)).resolves.toBeUndefined()
	})

	it('干净文件通过', async () => {
		const dir = await temp_dir()
		await writeFile(path.join(dir, 'a.js'), 'console.log("ok")')
		await expect(scan_manifest_for_secrets({ files: [{ path: 'a.js' }] }, dir)).resolves.toBeUndefined()
	})

	it('规则清单包含关键类型', () => {
		const names = SECRET_PATTERNS.map(item => item.name)
		expect(names).toEqual(expect.arrayContaining(['private-key', 'tencent-secret-id', 'aliyun-access-key', 'openai-style-key', 'db-credential-url']))
	})
})
