import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import swaggerJsdoc from 'swagger-jsdoc'

/**
 * 兼容 ESM 的 __dirname 实现
 */
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))

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
export default function main(req, res) {
	try {
		// 解析 Cookies 并校验密码
		const cookies = parseCookies(req)
		const password = cookies.apiDocPassword
		const correctPassword = '123456' // 访问密码（可按需修改）

		let action = ''
		const urlObj = new URL(req.url, `http://${req.headers.host}`)
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
			// 读取并回填登录页
			const loginHtml = fs.readFileSync(path.join(__dirname, '_base/swagger_login.html'), 'utf8').replace('${correctPassword}', correctPassword)

			res.setHeader('Content-Type', 'text/html; charset=utf-8')
			res.end(loginHtml)
			return
		}

		// 调试日志
		console.log('Action:', action)
		console.log('Docs config:', docs)

		// 生成 swagger.json
		const swaggerSpec = action && docs[action] ? createSwaggerSpec(action) : createSwaggerSpec()

		// 如果是请求 swagger.json，返回 JSON；否则返回 HTML 页面
		if (isSwaggerJson) {
			res.setHeader('Content-Type', 'application/json; charset=utf-8')
			res.setHeader('Access-Control-Allow-Origin', '*')
			res.end(JSON.stringify(swaggerSpec))
		} else {
			const html = fs.readFileSync(path.join(__dirname, '_base/swagger.html'), 'utf8')
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
 * @returns {import('openapi-types').OpenAPIV3.Document}
 */
function createSwaggerSpec(action) {
	// apiPath：当前文件所在的 /api 目录
	const apiPath = path.join(__dirname)

	const port = getPortFromPackageJson()
	const options = {
		definition: {
			openapi: '3.0.0',
			info: {
				title: 'api.zengjin.work',
				version: '1.0.0',
			},
			servers: [
				{
					// 生产与本地的区分（你可按需改为固定地址）
					url: process.env.VERCEL ? 'https://zengjin.work/api' : `http://${getLocalIP()}:${port}/api`,
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
		const serveScript = packageJson?.scripts?.serve || ''
		const portMatch = serveScript.match(/--listen\s+[0-9.]+:(\d+)/)
		if (portMatch && portMatch[1]) return portMatch[1]
	} catch {}
	return process.env.PORT || '10001'
}
