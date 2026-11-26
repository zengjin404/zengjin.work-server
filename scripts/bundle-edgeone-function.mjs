/**
 * 条件方案：把 Cloud Functions 入口打成自包含单文件
 *
 * 仅当 EdgeOne 实测函数包 >100MB，或构建器无法解析 package.json#imports
 * 的 `#api_util/*` 时启用。默认部署走平台构建器的依赖安装/打包。
 *
 * 使用前安装：bun add -d esbuild
 * 执行：bun run edgeone:bundle
 */
import { existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = path.join(REPO_ROOT, 'cloud-functions', 'api', '[[default]].js')
const OUT_DIR = path.join(REPO_ROOT, 'edgeone-function-dist')
const OUTFILE = path.join(OUT_DIR, 'api', '[[default]].js')

async function main() {
	let esbuild
	try {
		esbuild = await import('esbuild')
	} catch {
		throw new Error('缺少 esbuild。请先执行 `bun add -d esbuild`，再运行 `bun run edgeone:bundle`。')
	}

	if (!existsSync(ENTRY)) throw new Error(`入口不存在: ${ENTRY}`)
	await mkdir(path.dirname(OUTFILE), { recursive: true })

	await esbuild.build({
		entryPoints: [ENTRY],
		outfile: OUTFILE,
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node20',
		sourcemap: false,
		legalComments: 'none',
		external: ['pg-native'],
		plugins: [
			{
				name: 'api-util-alias',
				setup(build) {
					build.onResolve({ filter: /^#api_util\// }, args => ({
						path: path.join(REPO_ROOT, 'api_util', args.path.slice('#api_util/'.length)),
					}))
				},
			},
		],
	})

	const info = await stat(OUTFILE)
	console.log(`✓ 自包含函数入口已生成: ${OUTFILE}`)
	console.log(`  大小: ${(info.size / 1024 / 1024).toFixed(2)} MB`)
	console.log('  部署时请把 edgeone-function-dist/api/[[default]].js 作为 cloud-functions/api/[[default]].js 使用，并保留 package.json。')
}

main().catch(error => {
	console.error(`✗ 函数打包失败: ${error.message}`)
	process.exitCode = 1
})
