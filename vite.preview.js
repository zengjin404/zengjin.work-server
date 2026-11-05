import basicSsl from '@vitejs/plugin-basic-ssl'
import chalk from 'chalk'
import fs from 'node:fs/promises'
import { resolve } from 'path'
import { preview } from 'vite'

const serverAppsDir = resolve(process.cwd(), './apps')
let serverApps = []
try {
	serverApps = await fs.readdir(serverAppsDir).then(items => items.filter(item => /^[a-zA-Z0-9]+$/.test(item)))
} catch (e) {
	console.log(chalk.yellow(`警告：读取 apps 目录失败，请确保 apps 目录存在编译产物。`))
}

let config = {
	build: {
		outDir: '.',
	},
	plugins: [
		basicSsl(),
		{
			name: 'mpa-preview-fallback',
			configurePreviewServer(server) {
				const middleware = async (req, res, next) => {
					const fullUrl = req.url ?? ''
					const url = fullUrl.split('?')[0]

					// 根路径直达 index 应用
					if (url === '/' || url === '') {
						req.url = '/apps/index/index.html'
						return next()
					}

					// 过滤：API 接口、或已带有 apps 前缀的请求
					if (!url || url.startsWith('/api/') || url.startsWith('/apps/')) {
						return next()
					}

					// 提取子应用名（第一段路径），兼容有无尾斜杠两种形式
					const match = url.match(/^\/([a-zA-Z0-9]+)(\/|$)/)
					if (!match) return next()
					const app = match[1]

					// 确保只处理属于子应用的请求，防止误伤平级的其它资源
					if (!serverApps.includes(app)) {
						const accept = req.headers.accept || ''
						const isPageHtml = accept.includes('text/html')
						if (isPageHtml && !/\.\w+$/.test(url)) {
							req.url = '/apps/404/index.html'
						}
						return next()
					}

					// 静态资源与页面路由分离式重塑
					if (/\.\w+$/.test(url)) {
						// 静态资源：透明指向物理编译产物 /apps/[app]/...
						req.url = `/apps${req.url}`
					} else {
						// 页面路由及深度路由：直接呈递对应应用的 index.html
						req.url = `/apps/${app}/index.html`
					}
					return next()
				}

				server.middlewares.use(middleware)
				// 强行夺取 Connect 链第一顺位控制权，防止被前面的默认静态服务截胡抛出 404
				try {
					const stack = server.middlewares.stack
					if (stack && stack.length > 0) {
						const item = stack.pop()
						stack.unshift(item)
					}
				} catch (e) {
					console.error('Failed to unshift Connect middleware:', e)
				}
			},
		},
	],
	preview: {
		port: 10002,
		host: true,
		proxy: {
			'/api/': {
				target: 'http://localhost:10001/',
				changeOrigin: true,
				secure: false,
			},
		},
	},
}

try {
	const server = await preview(config)
	server.printUrls()
} catch (e) {
	console.log(chalk.red(`预览失败，${e}`))
}
