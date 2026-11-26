/**
 * 组装 EdgeOne 静态产物
 *
 * 目标：把 server 仓现有的 apps/、$base/、$apps/ 和根级图标组装成
 * edgeone-dist/，并让物理路径与前端构建时的绝对 URL 对齐：
 *
 *   浏览器 /admin/assets/x.js  →  edgeone-dist/admin/assets/x.js
 *   浏览器 /$base/font/x.woff2 →  edgeone-dist/$base/font/x.woff2
 *
 * 注意：不能把 apps/ 整体复制成 edgeone-dist/apps/，否则 /admin/* 会 404。
 * 也不能把 api/、api_util/、.env、node_modules 等后端内容放进静态根。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 平台口径是 25 MB（十进制），这里按 25,000,000 字节保守校验
const MAX_FILE_BYTES = 25 * 1000 * 1000
const MANIFEST_NAME = 'edgeone-manifest.json'

const ROOT_FILES = ['favicon.ico', 'favicon.svg', 'favicon-96x96.png', 'apple-touch-icon.png', 'og-cover.png']

const PARTIAL_APPS_ALLOWLIST = new Set(['music'])

const FORBIDDEN_PREFIXES = ['api/', 'api_util/', 'node_modules/', '.git/']
const FORBIDDEN_BASENAMES = new Set(['.env', '.env.local', '.env.production', '.env.development'])

// $apps/$base 里的测试目录与备份目录不属于运行时资源，不能发布到 CDN
const SHARED_EXCLUDES = [/(^|\/)__tests__(\/|$)/, /(^|\/)[^/]+\.bak(\/|$)/]

function to_posix(value) {
	return value.split(path.sep).join('/')
}

function make_shared_filter(root, excluded) {
	return src => {
		const relative = to_posix(path.relative(root, src))
		if (!relative || relative === '.') return true
		if (SHARED_EXCLUDES.some(pattern => pattern.test(relative))) {
			excluded.push(relative)
			return false
		}
		return true
	}
}

async function walk(dir, base = dir) {
	const entries = await readdir(dir, { withFileTypes: true })
	const files = []
	for (const entry of entries) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await walk(full, base)))
		} else if (entry.isFile()) {
			files.push(to_posix(path.relative(base, full)))
		}
	}
	return files.sort()
}

async function sha256_file(file) {
	const hash = createHash('sha256')
	hash.update(await readFile(file))
	return hash.digest('hex')
}

function assert_no_forbidden(relative_path) {
	const normalized = relative_path.replace(/\\/g, '/')
	if (FORBIDDEN_BASENAMES.has(path.posix.basename(normalized))) {
		throw new Error(`静态产物中出现禁止文件: ${relative_path}`)
	}
	if (FORBIDDEN_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
		throw new Error(`静态产物中出现后端/依赖目录: ${relative_path}`)
	}
}

async function copy_root_files(src_root, out_dir, warnings) {
	for (const name of ROOT_FILES) {
		const src = path.join(src_root, name)
		if (!existsSync(src)) {
			warnings.push(`根级静态文件缺失（跳过）: ${name}`)
			continue
		}
		await cp(src, path.join(out_dir, name))
	}
}

/**
 * @param {{ src_root?: string, out_dir?: string, hash_mode?: 'all'|'size', dry_run?: boolean }} [options]
 */
export async function prepare_edgeone(options = {}) {
	const src_root = path.resolve(options.src_root || REPO_ROOT)
	const out_dir = path.resolve(options.out_dir || path.join(src_root, 'edgeone-dist'))
	const hash_mode = options.hash_mode || 'all'
	const dry_run = Boolean(options.dry_run)
	const warnings = []

	const apps_dir = path.join(src_root, 'apps')
	const base_dir = path.join(src_root, '$base')
	const apps_shared_dir = path.join(src_root, '$apps')

	for (const [label, dir] of [
		['apps', apps_dir],
		['$base', base_dir],
		['$apps', apps_shared_dir],
	]) {
		if (!existsSync(dir)) throw new Error(`缺少必要目录: ${label} (${dir})`)
	}

	if (!existsSync(path.join(apps_dir, 'index', 'index.html'))) throw new Error('缺少首页子应用 apps/index/index.html')
	if (!existsSync(path.join(apps_dir, '404', 'index.html'))) throw new Error('缺少 404 子应用 apps/404/index.html')

	const entries = await readdir(apps_dir, { withFileTypes: true })
	const app_names = entries
		.filter(entry => entry.isDirectory() && /^[a-zA-Z0-9]+$/.test(entry.name))
		.map(entry => entry.name)
		.sort()

	const apps_with_index = []
	const partial_apps = []
	for (const app of app_names) {
		if (existsSync(path.join(apps_dir, app, 'index.html'))) {
			apps_with_index.push(app)
		} else if (PARTIAL_APPS_ALLOWLIST.has(app)) {
			partial_apps.push(app)
			warnings.push(`部分产物（无 index.html，仅复制资源）: ${app}`)
		} else {
			throw new Error(`子应用缺少 index.html 且不在允许清单内: ${app}`)
		}
	}

	const excluded_shared = []

	if (!dry_run) {
		await rm(out_dir, { recursive: true, force: true })
		await mkdir(out_dir, { recursive: true })

		for (const app of app_names) {
			await cp(path.join(apps_dir, app), path.join(out_dir, app), { recursive: true })
		}

		await cp(base_dir, path.join(out_dir, '$base'), {
			recursive: true,
			filter: make_shared_filter(base_dir, excluded_shared),
		})
		await cp(apps_shared_dir, path.join(out_dir, '$apps'), {
			recursive: true,
			filter: make_shared_filter(apps_shared_dir, excluded_shared),
		})
		if (excluded_shared.length) {
			warnings.push(`已排除非运行时共享资源: ${[...new Set(excluded_shared)].sort().join(', ')}`)
		}
		await copy_root_files(src_root, out_dir, warnings)

		// 首页：根 / 直接返回首页应用的 HTML；其资源仍引用 /index/assets/*
		await cp(path.join(apps_dir, 'index', 'index.html'), path.join(out_dir, 'index.html'))
		// 平台原生 404 兜底（若控制台支持自定义 404 页）
		await cp(path.join(apps_dir, '404', 'index.html'), path.join(out_dir, '404.html'))
	}

	const files = dry_run ? [] : await walk(out_dir)
	const manifest_files = []
	let total_bytes = 0
	let max_file = { path: '', size: 0 }

	for (const relative of files) {
		assert_no_forbidden(relative)
		const full = path.join(out_dir, relative)
		const info = await stat(full)
		if (info.size > MAX_FILE_BYTES) {
			throw new Error(`单文件超过 25MB 限制: ${relative} (${(info.size / 1000 / 1000).toFixed(2)} MB)`)
		}
		total_bytes += info.size
		if (info.size > max_file.size) max_file = { path: relative, size: info.size }
		manifest_files.push({
			path: relative,
			size: info.size,
			sha256: hash_mode === 'all' ? await sha256_file(full) : null,
		})
	}

	const manifest = {
		generated_at: new Date().toISOString(),
		source_root: src_root,
		out_dir,
		hash_mode,
		apps_with_index,
		partial_apps,
		excluded_shared: [...new Set(excluded_shared)].sort(),
		file_count: manifest_files.length,
		total_bytes,
		max_file,
		files: manifest_files,
		warnings,
	}

	if (!dry_run) {
		await writeFile(path.join(src_root, MANIFEST_NAME), JSON.stringify(manifest, null, '\t') + '\n', 'utf8')
	}

	return manifest
}

function parse_cli_args(argv) {
	const out = {}
	for (const arg of argv.slice(2)) {
		if (arg === '--dry-run') out.dry_run = true
		else if (arg.startsWith('--out=')) out.out_dir = arg.slice('--out='.length)
		else if (arg === '--hash=size') out.hash_mode = 'size'
	}
	return out
}

const is_cli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (is_cli) {
	try {
		const args = parse_cli_args(process.argv)
		const manifest = await prepare_edgeone(args)
		const mb = (value => (value / 1000 / 1000).toFixed(2))(manifest.total_bytes)
		console.log(`✓ EdgeOne 静态产物已生成: ${manifest.out_dir}`)
		console.log(`  应用: ${manifest.apps_with_index.length} 个（含 index）；部分产物: ${manifest.partial_apps.join(',') || '无'}`)
		console.log(
			`  文件: ${manifest.file_count} 个；总大小: ${mb} MB；最大文件: ${manifest.max_file.path || '无'} (${(manifest.max_file.size / 1000 / 1000).toFixed(2)} MB)`,
		)
		for (const warning of manifest.warnings) console.warn(`  ! ${warning}`)
	} catch (error) {
		console.error(`✗ EdgeOne 静态产物生成失败: ${error.message}`)
		process.exitCode = 1
	}
}
