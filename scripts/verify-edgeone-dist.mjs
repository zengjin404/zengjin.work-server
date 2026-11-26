/**
 * 部署前独立复核 edgeone-dist
 *
 * 与 prepare 脚本分开：prepare 负责生成，verify 负责重新读取磁盘并核对，
 * 避免“生成脚本自己证明自己”。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { HISTORY_APPS, NOT_FOUND_APP } from '../api_util/static_routes.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(REPO_ROOT, 'edgeone-dist')
const MANIFEST = path.join(REPO_ROOT, 'edgeone-manifest.json')
const EDGEONE_JSON = path.join(REPO_ROOT, 'edgeone.json')
const MAX_FILE_BYTES = 25 * 1000 * 1000

const KEY_FILES = [
	'index.html',
	'404/index.html',
	'admin/index.html',
	'ai/index.html',
	'cards/index.html',
	'cards/sw.js',
	'$base/config.js',
	'$base/font/Iosevka.woff2',
	'$base/plugin/MediaPipe/wasm/vision_wasm_internal.wasm',
	'$base/plugin/pdfjs-4.9.155/build/pdf.worker.mjs',
	'$base/plugin/cesium.map.min.js',
	'$base/plugin/browser.min.js',
	'$apps/admin/config.js',
]

// 只扫描我们自己的文本资源；第三方插件目录（pdfjs/Cesium 等）含大量 base64，
// 会出现 AKID 之类的误报，不作为门禁范围。
const SCANNABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.map', '.txt', '.md', '.svg', '.vue'])

export const SECRET_PATTERNS = [
	{ name: 'private-key', pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
	{ name: 'tencent-secret-id', pattern: /AKID[A-Za-z0-9]{28,}/ },
	{ name: 'aliyun-access-key', pattern: /LTAI[A-Za-z0-9]{12,}/ },
	{ name: 'volcengine-access-key', pattern: /AKLT[A-Za-z0-9]{10,}/ },
	{ name: 'neon-password', pattern: /npg_[A-Za-z0-9]{10,}/ },
	{ name: 'openai-style-key', pattern: /sk-[A-Za-z0-9]{20,}/ },
	{ name: 'goeasy-rest-key', pattern: /PR-[a-f0-9]{20,}/ },
	{ name: 'tavily-key', pattern: /tvly-[A-Za-z0-9]{10,}/ },
	{ name: 'db-credential-url', pattern: /postgres(ql)?:\/\/[^"'\s]+:[^"'\s]+@/ },
	{
		name: 'env-secret-assignment',
		pattern: /(JWT_SECRET|CRYPTO_SECRET|DB_SUPABASE_PASSWORD|DB_NEON_PASSWORD|QINIU_SECRET_KEY|CRON_SECRET)\s*[:=]\s*["'][^"']{8,}/,
	},
]

function assert(condition, message) {
	if (!condition) throw new Error(message)
}

export async function scan_manifest_for_secrets(manifest, dist_root = DIST) {
	for (const file of manifest.files || []) {
		if (file.path.startsWith('$base/plugin/')) continue
		const ext = path.extname(file.path).toLowerCase()
		if (!SCANNABLE_EXTENSIONS.has(ext)) continue
		const text = await readFile(path.join(dist_root, file.path), 'utf8')
		for (const { name, pattern } of SECRET_PATTERNS) {
			if (pattern.test(text)) throw new Error(`疑似密钥泄漏 (${name}): ${file.path}`)
		}
	}
}

async function sha256_file(file) {
	const hash = createHash('sha256')
	hash.update(await readFile(file))
	return hash.digest('hex')
}

async function main() {
	assert(existsSync(DIST), '缺少 edgeone-dist，请先运行 bun run edgeone:prepare')
	assert(existsSync(MANIFEST), '缺少 edgeone-manifest.json，请先运行 bun run edgeone:prepare')
	assert(existsSync(EDGEONE_JSON), '缺少 edgeone.json')
	assert(!existsSync(path.join(DIST, 'apps')), 'edgeone-dist/apps 不应存在：子应用必须直接位于静态根下')
	for (const forbidden of ['api', 'api_util', 'node_modules', '.git']) {
		assert(!existsSync(path.join(DIST, forbidden)), `静态根中不应出现 ${forbidden}/`)
	}

	const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
	assert(Array.isArray(manifest.files) && manifest.files.length > 0, 'manifest.files 为空')

	for (const file of manifest.files) {
		const full = path.join(DIST, file.path)
		assert(!/(^|\/)__tests__(\/|$)/.test(file.path), `测试目录不应进入静态产物: ${file.path}`)
		assert(!/(^|\/)[^/]+\.bak(\/|$)/.test(file.path), `备份目录不应进入静态产物: ${file.path}`)
		assert(existsSync(full), `manifest 中的文件不存在: ${file.path}`)
		const info = await stat(full)
		assert(info.size === file.size, `文件大小不一致: ${file.path}`)
		assert(info.size <= MAX_FILE_BYTES, `文件超过 25MB: ${file.path}`)
		if (file.sha256) {
			const actual = await sha256_file(full)
			assert(actual === file.sha256, `文件哈希不一致: ${file.path}`)
		}
	}

	for (const key of KEY_FILES) {
		assert(existsSync(path.join(DIST, key)), `关键文件缺失: ${key}`)
	}

	await scan_manifest_for_secrets(manifest, DIST)

	const config = JSON.parse(await readFile(EDGEONE_JSON, 'utf8'))
	assert(Array.isArray(config.rewrites), 'edgeone.json 缺少 rewrites')
	assert(config.rewrites.length <= 100, `rewrites 超过 100 条: ${config.rewrites.length}`)
	assert(Array.isArray(config.headers) && config.headers.length <= 30, 'headers 缺失或超过 30 条')
	assert(config.outputDirectory === 'edgeone-dist', 'edgeone.json outputDirectory 必须为 edgeone-dist')

	const sources = new Set(config.rewrites.map(rule => rule.source))
	for (const app of HISTORY_APPS) {
		assert(sources.has(`/${app}/*`), `缺少 History 回退规则: /${app}/*`)
		assert(sources.has(`/${app}/assets/*`), `缺少静态资源身份规则: /${app}/assets/*`)
		assert(sources.has(`/${app}/audio/*`), `缺少静态资源身份规则: /${app}/audio/*`)
		assert(sources.has(`/${app}/sw.js`), `缺少静态资源身份规则: /${app}/sw.js`)
		const assetIndex = config.rewrites.findIndex(rule => rule.source === `/${app}/assets/*`)
		const pageIndex = config.rewrites.findIndex(rule => rule.source === `/${app}/*`)
		assert(assetIndex !== -1 && assetIndex < pageIndex, `资源身份规则必须位于页面回退之前: ${app}`)
	}
	for (const rule of config.rewrites) {
		assert(String(rule.source).startsWith('/'), `rewrite.source 必须以 / 开头: ${rule.source}`)
		assert((String(rule.source).match(/\*/g) || []).length <= 1, `rewrite.source 最多一个 *: ${rule.source}`)
		assert(!String(rule.destination).includes('/apps/'), `rewrite.destination 不应包含 /apps/: ${rule.destination}`)
	}
	assert(!sources.has('/*'), '默认不应使用 /* 兜底：会把不存在的 .js/.css 返回成 HTML；如需启用请显式确认')
	assert(sources.has('/'), '缺少根路径规则')
	assert(existsSync(path.join(DIST, `${NOT_FOUND_APP}/index.html`)), '404 子应用入口缺失')
	assert(existsSync(path.join(DIST, '404.html')), '缺少平台自定义 404 页 404.html')

	const sw = config.headers.find(item => item.source === '/cards/sw.js')
	assert(sw, '缺少 /cards/sw.js 响应头配置')
	assert(
		sw.headers.some(header => header.key === 'Service-Worker-Allowed' && header.value === '/cards'),
		'/cards/sw.js 缺少 Service-Worker-Allowed: /cards',
	)

	console.log('✓ edgeone-dist 复核通过')
	console.log(`  文件: ${manifest.file_count} 个；总大小: ${(manifest.total_bytes / 1000 / 1000).toFixed(2)} MB`)
	console.log(`  最大文件: ${manifest.max_file.path} (${(manifest.max_file.size / 1000 / 1000).toFixed(2)} MB)`)
	console.log(`  rewrites: ${config.rewrites.length} 条；headers: ${config.headers.length} 条`)
}

const is_cli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (is_cli) {
	main().catch(error => {
		console.error(`✗ edgeone-dist 复核失败: ${error.message}`)
		process.exitCode = 1
	})
}
