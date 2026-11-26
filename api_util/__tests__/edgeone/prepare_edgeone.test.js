import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { prepare_edgeone } from '../../../scripts/prepare-edgeone.mjs'

const created = []

async function create_fixture() {
	const dir = await mkdtemp(path.join(tmpdir(), 'edgeone-prepare-'))
	created.push(dir)

	await mkdir(path.join(dir, 'apps/index'), { recursive: true })
	await mkdir(path.join(dir, 'apps/admin/assets'), { recursive: true })
	await mkdir(path.join(dir, 'apps/404'), { recursive: true })
	await mkdir(path.join(dir, 'apps/music/assets'), { recursive: true })
	await mkdir(path.join(dir, '$base/font'), { recursive: true })
	await mkdir(path.join(dir, '$apps/admin'), { recursive: true })
	await mkdir(path.join(dir, '$apps/color/__tests__'), { recursive: true })
	await mkdir(path.join(dir, '$apps/fc.bak'), { recursive: true })

	await writeFile(path.join(dir, 'apps/index/index.html'), '<html>home</html>')
	await writeFile(path.join(dir, 'apps/admin/index.html'), '<html>admin</html>')
	await writeFile(path.join(dir, 'apps/admin/assets/main.js'), 'console.log(1)')
	await writeFile(path.join(dir, 'apps/admin/中文.js'), 'console.log("中文")')
	await writeFile(path.join(dir, 'apps/404/index.html'), '<html>404</html>')
	await writeFile(path.join(dir, 'apps/music/assets/a.js'), 'console.log("music")')
	await writeFile(path.join(dir, '$base/config.js'), 'window.$config={}')
	await writeFile(path.join(dir, '$base/font/Iosevka.woff2'), 'font')
	await writeFile(path.join(dir, '$apps/admin/config.js'), 'window.$config={app:"admin"}')
	await writeFile(path.join(dir, '$apps/color/__tests__/a.test.js'), 'test')
	await writeFile(path.join(dir, '$apps/fc.bak/a.js'), 'bak')
	await writeFile(path.join(dir, 'favicon.ico'), 'ico')

	return dir
}

afterEach(async () => {
	for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('prepare_edgeone', () => {
	it('把 apps/<app> 复制到静态根 <app>，并保留 $base/$apps/中文名', async () => {
		const dir = await create_fixture()
		const out_dir = path.join(dir, 'edgeone-dist')
		const manifest = await prepare_edgeone({ src_root: dir, out_dir, hash_mode: 'all' })

		expect(existsSync(path.join(out_dir, 'admin/index.html'))).toBe(true)
		expect(existsSync(path.join(out_dir, 'admin/assets/main.js'))).toBe(true)
		expect(existsSync(path.join(out_dir, 'admin/中文.js'))).toBe(true)
		expect(existsSync(path.join(out_dir, '$base/config.js'))).toBe(true)
		expect(existsSync(path.join(out_dir, '$base/font/Iosevka.woff2'))).toBe(true)
		expect(existsSync(path.join(out_dir, '$apps/admin/config.js'))).toBe(true)
		expect(existsSync(path.join(out_dir, '$apps/color/__tests__'))).toBe(false)
		expect(existsSync(path.join(out_dir, '$apps/fc.bak'))).toBe(false)
		expect(existsSync(path.join(out_dir, 'index.html'))).toBe(true)
		expect(existsSync(path.join(out_dir, '404.html'))).toBe(true)
		expect(existsSync(path.join(out_dir, 'apps'))).toBe(false)
		expect(manifest.excluded_shared).toEqual(expect.arrayContaining(['color/__tests__', 'fc.bak']))

		expect(await readFile(path.join(out_dir, 'index.html'), 'utf8')).toBe('<html>home</html>')
		expect(manifest.apps_with_index).toEqual(expect.arrayContaining(['index', 'admin', '404']))
		expect(manifest.partial_apps).toEqual(['music'])
		expect(manifest.warnings.join('\n')).toContain('music')
		expect(manifest.file_count).toBeGreaterThan(0)
		expect(manifest.files[0].sha256).toMatch(/^[a-f0-9]{64}$/)
	}, 20000)

	it('重复执行保持幂等', async () => {
		const dir = await create_fixture()
		const out_dir = path.join(dir, 'edgeone-dist')
		const first = await prepare_edgeone({ src_root: dir, out_dir })
		const second = await prepare_edgeone({ src_root: dir, out_dir })
		expect(second.file_count).toBe(first.file_count)
		expect(second.total_bytes).toBe(first.total_bytes)
	}, 20000)

	it('缺少 apps/index 时失败', async () => {
		const dir = await create_fixture()
		await rm(path.join(dir, 'apps/index/index.html'))
		await expect(prepare_edgeone({ src_root: dir, out_dir: path.join(dir, 'dist') })).rejects.toThrow(/缺少首页子应用/)
	})

	it('未知子应用缺少 index.html 时失败', async () => {
		const dir = await create_fixture()
		await mkdir(path.join(dir, 'apps/broken'), { recursive: true })
		await writeFile(path.join(dir, 'apps/broken/a.js'), 'x')
		await expect(prepare_edgeone({ src_root: dir, out_dir: path.join(dir, 'dist') })).rejects.toThrow(/缺少 index.html/)
	})

	it('静态产物中出现 .env 时失败', async () => {
		const dir = await create_fixture()
		await writeFile(path.join(dir, 'apps/admin/.env'), 'SECRET=1')
		await expect(prepare_edgeone({ src_root: dir, out_dir: path.join(dir, 'dist') })).rejects.toThrow(/禁止文件/)
	})

	it('单文件超过 25MB 时失败', async () => {
		const dir = await create_fixture()
		await writeFile(path.join(dir, 'apps/admin/assets/big.bin'), Buffer.alloc(25_100_000))
		await expect(prepare_edgeone({ src_root: dir, out_dir: path.join(dir, 'dist') })).rejects.toThrow(/超过 25MB/)
	}, 30000)
})
