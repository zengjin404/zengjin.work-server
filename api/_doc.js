import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 兼容 ESM 的 __dirname 实现
 *
 * 注意：不要在模块顶层读取 package.json / swagger HTML。
 * EdgeOne Cloud Functions 会把入口打成单文件，运行时并不保留这些源文件；
 * 顶层同步读取会直接让整个函数冷启动失败。
 */
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function read_doc_file(relative) {
	try {
		return fs.readFileSync(path.join(__dirname, relative), 'utf8')
	} catch {
		return null
	}
}

function send_unavailable(res, message) {
	res.statusCode = 503
	res.setHeader('Content-Type', 'application/json; charset=utf-8')
	res.end(JSON.stringify({ code: -1, msg: message }))
}

/**
 * 文档入口配置
 * - key 作为 action（/api/doc/:action）使用
 * - 数组为对应扫描的文件路径（相对当前文件所在目录 /api）
 */
const docs = {
	_: ['note.js'],
	mzl: ['zone/mzl/class.js', 'zone/mzl/student.js'],
}

/**
 * API 文档入口（ESM 导出）
 * - 负责：登录校验、action 解析、返回 swagger.json 或 HTML 页面
 * - 说明：在 Vercel 本地 dev 或服务端 Node 环境下均可工作
 * @param {import('http').IncomingMessage} req Node/Vercel 请求对象
 * @param {import('http').ServerResponse} res Node/Vercel 响应对象
 */
export default async function main(req, res) {
	try {
		// 解析 Cookies 并校验密码
		const cookies = parseCookies(req)
		const password = cookies.apiDocPassword
		const correctPassword = '123456' // 访问密码（可按需修改）

		let action = ''
		const urlObj = new URL(req.url || '/', 'http://localhost')
		const isSwaggerJson = urlObj.pathname.endsWith('/swagger.json') || urlObj.searchParams.has('__swagger_json')

		// 解析 action：兼容 /api/doc/swagger.json?action=xxx 和 /api/doc/xxx 两种形式
		if (isSwaggerJson) {
			action = urlObj.searchParams.get('action') || ''
		} else {
			const urlParts = req.url.split('/').filter(Boolean)
			const docIndex = urlParts.indexOf('doc')
			if (docIndex !== -1 && urlParts.length > docIndex + 1) {
				action = urlParts[docIndex + 1]
			}
		}

		// 清理 action 并校验有效性
		action = action.replace(/[\/\?]+$/, '').trim()
		if (!docs[action]) {
			action = ''
		}

		// 未登录且不是 swagger-ui 静态资源时，返回登录页
		if (!action && password !== correctPassword && !req.url.includes('plugin/')) {
			// 读取并回填登录页；单文件运行时可能没有该文件
			const loginHtml = read_doc_file('_base/swagger_login.html')
			if (!loginHtml) return send_unavailable(res, 'Swagger 登录页未随函数打包，请下线该文档端点或改用 includeFiles')

			res.setHeader('Content-Type', 'text/html; charset=utf-8')
			res.end(loginHtml.replace('${correctPassword}', correctPassword))
			return
		}

		// 调试日志
		console.log('Action:', action)
		console.log('Docs config:', docs)

		// 生成 swagger.json
		const swaggerSpec = action && docs[action] ? await createSwaggerSpec(action, req) : await createSwaggerSpec(undefined, req)

		// 如果是请求 swagger.json，返回 JSON；否则返回 HTML 页面
		if (isSwaggerJson) {
			res.setHeader('Content-Type', 'application/json; charset=utf-8')
			res.setHeader('Access-Control-Allow-Origin', '*')
			res.end(JSON.stringify(swaggerSpec))
		} else {
			const html = read_doc_file('_base/swagger.html')
			if (!html) return send_unavailable(res, 'Swagger 页面未随函数打包，请下线该文档端点或改用 includeFiles')
			res.setHeader('Content-Type', 'text/html; charset=utf-8')
			res.end(html)
		}
	} catch (error) {
		console.error('Error in main:', error)
		// 使用通用方式返回 500，避免依赖特定框架原型链
		res.statusCode = 500
		res.setHeader('Content-Type', 'application/json; charset=utf-8')
		res.end(
			JSON.stringify({
				error: 'Internal Server Error',
				message: error.message,
				stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
			}),
		)
	}
}

/**
 * 解析 Cookies
 * @param {import('http').IncomingMessage} req
 * @returns {Record<string, string>}
 */
function parseCookies(req) {
	const cookies = {}
	const cookieHeader = req.headers.cookie
	if (cookieHeader) {
		cookieHeader.split(';').forEach(cookie => {
			const parts = cookie.split('=')
			const name = parts[0].trim()
			const value = parts[1] || ''
			cookies[name] = value.trim()
		})
	}
	return cookies
}

/**
 * 生成 Swagger 配置与文档
 * @param {string} [action]
 * @param {import('http').IncomingMessage} [req]
 * @returns {Promise<import('openapi-types').OpenAPIV3.Document>}
 */
export async function createSwaggerSpec(action, req) {
	// apiPath：当前文件所在的 /api 目录
	const apiPath = path.join(__dirname)

	const options = {
		definition: {
			openapi: '3.0.0',
			info: {
				title: 'api.zengjin.work',
				version: '1.0.0',
			},
			servers: [
				{
					url: resolve_swagger_server_url(req),
				},
			],
		},
		apis:
			action && docs[action]
				? docs[action].map(file => {
						// 打印实际扫描路径，便于排查 404 或注释未被识别
						console.log('scan:', path.join(apiPath, file))
						return path.join(apiPath, file)
					})
				: Object.values(docs)
						.flat()
						.map(file => {
							console.log('scan:', path.join(apiPath, file))
							return path.join(apiPath, file)
						}),
	}

	try {
		const { default: swaggerJsdoc } = await import('swagger-jsdoc')
		const spec = swaggerJsdoc(options)
		return spec
	} catch (error) {
		console.error('Error generating swagger spec:', error)
		return {
			openapi: '3.0.0',
			info: {
				title: 'Error',
				version: '1.0.0',
				description: `Error generating spec: ${error.message}`,
			},
			paths: {},
		}
	}
}

const PLATFORM_PROXY_ENV_KEYS = [
	'VERCEL',
	'VERCEL_ENV',
	'VERCEL_URL',
	'VERCEL_BRANCH_URL',
	'VERCEL_PROJECT_PRODUCTION_URL',
	'EDGEONE',
	'EO_ENV',
	'EDGEONE_ENV',
	'EDGEONE_PAGES',
	'EO_PAGES_HOST',
	'EDGEONE_PAGES_URL',
	'EDGEONE_URL',
	'SCF_RUNTIME',
	'TENCENTCLOUD_RUNENV',
]

const DISALLOWED_TRUSTED_WILDCARDS = new Set(['vercel.app', 'edgeone.app', 'edgeone-pages.com', 'pages.edgeone.ai'])

function read_header(headers, name) {
	if (!headers || typeof headers !== 'object') return undefined
	const lower = name.toLowerCase()
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) return headers[key]
	}
	return undefined
}

/**
 * 从 Host 头严格提取主机名（不接受多值逗号、路径、查询参数、用户信息或非法端口）
 * @param {string} rawHost
 * @returns {{ host: string, hostname: string } | null}
 */
function parse_valid_host(rawHost) {
	if (typeof rawHost !== 'string') return null
	const first = rawHost.trim()
	if (!first || /[\s,/\\?#@]/.test(first)) return null

	// IPv6 字面量：[::1] 或 [::1]:10001
	if (first.startsWith('[')) {
		const m = first.match(/^\[([a-fA-F0-9:.]+)\](?::([1-9]\d{0,4}))?$/)
		if (!m) return null
		if (m[2] && Number(m[2]) > 65535) return null
		const ip = m[1].toLowerCase()
		if (!net.isIPv6(ip)) return null
		return { host: first.toLowerCase(), hostname: ip }
	}

	const m = first.match(/^([a-zA-Z0-9.-]+)(?::([1-9]\d{0,4}))?$/)
	if (!m) return null
	if (m[2] && Number(m[2]) > 65535) return null
	const hostname = m[1].toLowerCase()
	if (hostname.length > 253 || hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')) return null

	if (net.isIPv4(hostname)) {
		return { host: first.toLowerCase(), hostname }
	}

	const labels = hostname.split('.')
	if (labels.length === 4 && labels.every(label => /^\d+$/.test(label))) return null
	if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
	if (labels.length > 1 && /^\d+$/.test(labels[labels.length - 1])) return null

	return { host: first.toLowerCase(), hostname }
}

function parse_env_hostname(rawValue) {
	const raw = String(rawValue || '').trim()
	if (!raw) return null
	const hostPart = raw.replace(/^https?:\/\//i, '').split('/')[0]
	return parse_valid_host(hostPart)?.hostname || null
}

function is_local_hostname(hostname, localIp) {
	if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true
	if (localIp && hostname === localIp.toLowerCase()) return true
	if (!net.isIPv4(hostname)) return false
	const parts = hostname.split('.').map(Number)
	if (parts[0] === 192 && parts[1] === 168) return true
	if (parts[0] === 10) return true
	if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
	return false
}

function is_trusted_vercel_host(hostname, env = process.env) {
	if (!hostname.endsWith('.vercel.app')) return false

	// Vercel 真实部署会注入当前实例的精确主机名；存在时只信任本部署自身域，防止同平台跨项目 Host 投毒
	const runtimeHosts = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL].map(parse_env_hostname).filter(Boolean)
	if (runtimeHosts.length > 0) {
		return runtimeHosts.includes(hostname)
	}

	// 未处于 Vercel 环境时，绝不信任任何 *.vercel.app
	if (!env.VERCEL && !env.VERCEL_ENV) return false

	// 仅允许本项目命名空间的单一子域，拒绝任意 *.vercel.app 与多级子域
	return /^(?:zengjin-work|zengjin-server)(?:-[a-z0-9-]+)?\.vercel\.app$/.test(hostname)
}

function is_trusted_edgeone_runtime_host(hostname, env = process.env) {
	// 仅信任平台环境变量显式声明的本实例域名，绝不对 *.edgeone.* 开放通配信任或盲信客户端请求头
	const runtimeHosts = [env.EO_PAGES_HOST, env.EDGEONE_PAGES_URL, env.EDGEONE_URL].map(parse_env_hostname).filter(Boolean)
	return runtimeHosts.includes(hostname)
}

function is_trusted_extra_host(hostname, env = process.env) {
	const extra = String(env.TRUSTED_API_HOSTS || '')
		.split(',')
		.map(s => s.trim().toLowerCase())
		.filter(Boolean)

	return extra.some(item => {
		if (!item.startsWith('*.')) {
			return parse_valid_host(item)?.hostname === hostname
		}
		const baseDomain = item.slice(2)
		// 禁止通配 *、*.edgeone.*、*.vercel.app、*.edgeone.app 等多租户共享根域或单段 TLD
		if (!baseDomain || baseDomain.includes('*')) return false
		if (baseDomain.startsWith('edgeone.') || baseDomain.includes('.edgeone.') || DISALLOWED_TRUSTED_WILDCARDS.has(baseDomain)) return false
		const baseParsed = parse_valid_host(baseDomain)
		if (!baseParsed || !baseParsed.hostname.includes('.')) return false
		return hostname.endsWith(`.${baseParsed.hostname}`)
	})
}

function is_trusted_hostname(hostname, env = process.env, localIp = '') {
	const cloudEnv = is_cloud_env(env)
	// 云端环境禁止通过伪造 localhost / 内网 IP 让 Swagger 输出本地回环或内网地址
	if (!cloudEnv && is_local_hostname(hostname, localIp)) return true
	if (hostname === 'zengjin.work' || hostname.endsWith('.zengjin.work')) return true
	if (hostname === '7890000.xyz' || hostname.endsWith('.7890000.xyz')) return true
	if (is_trusted_vercel_host(hostname, env)) return true
	if (is_trusted_edgeone_runtime_host(hostname, env)) return true
	return is_trusted_extra_host(hostname, env)
}

function is_internal_gateway_host(hostname) {
	if (!hostname) return true
	if (is_local_hostname(hostname, '')) return true
	return (
		hostname.endsWith('.local') ||
		hostname.endsWith('.internal') ||
		hostname.endsWith('.tencentcs.com') ||
		hostname.endsWith('.myqcloud.com') ||
		hostname.endsWith('.vercel-dns.com') ||
		hostname.endsWith('.edgeone.com') ||
		hostname.endsWith('.edgeone.app') ||
		hostname.endsWith('.edgeone-pages.com') ||
		hostname.endsWith('.pages.edgeone.ai')
	)
}

function is_trusted_proxy_request(req, env = process.env, directHost = null) {
	if (env?.TRUST_PROXY === '1') return true
	if (!is_cloud_env(env)) return false
	return !directHost || is_internal_gateway_host(directHost.hostname)
}

function is_cloud_env(env = process.env) {
	return Boolean(
		env.VERCEL ||
			env.VERCEL_ENV ||
			env.VERCEL_URL ||
			env.EDGEONE ||
			env.EO_ENV ||
			env.EDGEONE_ENV ||
			env.EDGEONE_PAGES ||
			env.EO_PAGES_HOST ||
			env.EDGEONE_PAGES_URL ||
			env.EDGEONE_URL ||
			env.SCF_RUNTIME ||
			env.TENCENTCLOUD_RUNENV ||
			env.APP_ENV === 'production' ||
			env.NODE_ENV === 'production',
	)
}

/**
 * 解析 Swagger Server URL（平台中立）：
 * 1. 优先使用显式配置的 PUBLIC_API_URL / API_BASE_URL（按序取首个合法 http/https URL）
 * 2. 否则使用严格校验通过的可信 Host；仅在可信云代理条件下才读取 X-Forwarded-Host（仍须过白名单）
 * 3. 公网可信域固定输出 https；本地开发按真实 TLS 连接输出协议；无合法可信请求头时安全回退
 * @param {import('http').IncomingMessage} [req]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolve_swagger_server_url(req, env = process.env) {
	const explicit = String(env?.PUBLIC_API_URL || '').trim() || String(env?.API_BASE_URL || '').trim()
	if (explicit) {
		try {
			const parsed = new URL(explicit)
			if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
				const trimmed = explicit.replace(/\/+$/, '')
				return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`
			}
		} catch {}
	}

	const localIp = getLocalIP()
	const headers = req?.headers || {}

	const directHost = parse_valid_host(read_header(headers, 'host'))
	const forwardedHost = parse_valid_host(read_header(headers, 'x-forwarded-host'))

	let trusted = null
	if (directHost && is_trusted_hostname(directHost.hostname, env, localIp)) {
		trusted = directHost
	} else if (forwardedHost && is_trusted_proxy_request(req, env, directHost) && is_trusted_hostname(forwardedHost.hostname, env, localIp)) {
		trusted = forwardedHost
	}

	if (trusted) {
		// 公网域始终走 https（忽略客户端伪造的 X-Forwarded-Proto: http 降级头）；本地开发仅依真实 TLS socket 判定
		const proto = is_local_hostname(trusted.hostname, localIp) ? (req?.socket?.encrypted ? 'https' : 'http') : 'https'
		return `${proto}://${trusted.host}/api`
	}

	if (is_cloud_env(env)) {
		return 'https://zengjin.work/api'
	}

	const port = getPortFromPackageJson()
	return `http://${localIp}:${port}/api`
}

/**
 * 获取本机 IP
 * @returns {string}
 */
function getLocalIP() {
	const interfaces = os.networkInterfaces()
	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name] || []) {
			// 跳过内部 IP 和非 IPv4
			if (iface.internal || iface.family !== 'IPv4') continue
			return iface.address
		}
	}
	return 'localhost'
}

/**
 * 从 package.json 的 scripts.serve 中解析端口；失败则回退到环境变量或 10001
 * @returns {string}
 */
function getPortFromPackageJson() {
	try {
		const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
		const serveScript = packageJson?.scripts?.serve || ''
		const portMatch = serveScript.match(/--listen\s+[0-9.]+:(\d+)/)
		if (portMatch && portMatch[1]) return portMatch[1]
	} catch {}
	return process.env.PORT || '10001'
}
