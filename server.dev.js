import chalk from 'chalk'
import express from 'express'

import masterHandler from './api/index.js'

const app = express()
const PORT = process.env.PORT || 10001

// 中间件：解析 JSON body 和 URL 编码 body
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Vercel 会在收到请求时处理 CORS，因此本地需要自己加一下，
// 特别是 Vite preview 环境下访问 :10001
app.use((req, res, next) => {
	res.header('Access-Control-Allow-Origin', '*')
	res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
	res.header(
		'Access-Control-Allow-Headers',
		'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization',
	)

	if (req.method === 'OPTIONS') {
		return res.sendStatus(200)
	}
	next()
})

// 模拟 Vercel 的路由转发
app.all('/api/*', async (req, res) => {
	// 在 Express 中，如果有 querystring，req.url 也会包含它
	try {
		await masterHandler(req, res)
	} catch (error) {
		console.error(chalk.red(`[Dev Server Error] ${req.url}:`), error)
		if (!res.headersSent) {
			res.status(500).json({ error: 'Local Dev Server Error', details: error.message })
		}
	}
})

// 启动服务
app.listen(PORT, '0.0.0.0', () => {
	console.log(chalk.green(`\n🚀 Local Fast Dev Server is running at http://localhost:${PORT}`))
	console.log(chalk.blue(`💡 此服务常驻内存，数据库连接池会被复用，从而解决开发环境下由于频繁冷启动/重建连接带来的慢请求问题。\n`))
})
