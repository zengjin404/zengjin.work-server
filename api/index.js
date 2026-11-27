import base from '#api_util/base.js'

/**
 * API 总入口
 *
 * 重要：这里不要在顶层静态 import 业务 handler。
 * EdgeOne/Vercel 的函数冷启动会加载整个模块图；静态 import 会让
 * `/api/demo/hello` 也加载 AI/Cards/用户/七牛等无关依赖。
 * 每个 case 使用字面量 `import('./_xxx.js')`，保证打包器能静态追踪，
 * 同时由 ESM 模块缓存保证同一实例内只执行一次。
 */

function create_perf() {
	return {
		start: performance.now(),
		route: '',
		import_ms: 0,
		handler_ms: 0,
		db_ms: 0,
		db_calls: 0,
		acquire_ms: 0,
		acquire_calls: 0,
		connect_ms: 0,
		connect_calls: 0,
	}
}

function log_perf(req, perf) {
	const total_ms = performance.now() - perf.start
	if (total_ms < 500 && process.env.PERF_LOG !== '1') return
	// 只记录公开路由、方法、耗时；不记录 query、body、Header、Token、SQL 参数。
	// query_ms 为派生值（db_ms - acquire_ms），并行查询时是求和口径，不代表墙钟。
	const query_ms = Math.max(0, perf.db_ms - perf.acquire_ms)
	console.log(
		`[api-perf] route=${perf.route || 'unknown'} method=${req.method} import_ms=${perf.import_ms.toFixed(1)} handler_ms=${perf.handler_ms.toFixed(1)} db_ms=${perf.db_ms.toFixed(1)} query_ms=${query_ms.toFixed(1)} acquire_ms=${perf.acquire_ms.toFixed(1)} connect_ms=${perf.connect_ms.toFixed(1)} db_calls=${perf.db_calls} acquire_calls=${perf.acquire_calls} connect_calls=${perf.connect_calls} total_ms=${total_ms.toFixed(1)}`,
	)
}

function safe_dispatch_error(error) {
	const message = String(error?.message || '')
	if (/Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/i.test(message)) return '模块加载失败'
	return process.env.NODE_ENV === 'development' ? message : '路由分发异常'
}

export default async function masterHandler(req, res) {
	const perf = create_perf()

	return base.storage.run({ req, resp: res, perf }, async () => {
		// 无论部署后还是 Vercel 本地 Dev，通过 vercel.json 的 rewrite 打过来的请求
		// 其 req.url 保持原始状态，例如: "/api/zone/mzl/student/select?current=1"
		const urlWithoutQuery = req.url.split('?')[0]
		// 分割路径: ['','api','zone','mzl','student','select']
		const segments = urlWithoutQuery.split('/')

		// segment[2] 必定是顶级模块名如 'demo', 'note', 'zone'
		const targetModule = segments[2]
		// array 的截取获得后面的动作 ['mzl', 'student', 'select']
		const fullAction = segments.slice(2)
		perf.route = targetModule || ''

		// 平台可能不预解析 query（例如裸 Node 运行时）；补齐后再挂 action
		if (!req.query || typeof req.query !== 'object') {
			req.query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams)
		}

		// 把 action 参数挂在 req.query 上，完美兼容内部 _demo 等已经成型的结构
		req.query.action = fullAction

		/**
		 * 动态加载并执行 handler。
		 * loader 必须是 `() => import('./literal.js')`，不能把路径拼成变量，
		 * 否则 EdgeOne/Vercel 的打包器可能无法静态追踪模块。
		 */
		const call = async loader => {
			const import_start = performance.now()
			const { default: handler } = await loader()
			const import_end = performance.now()
			perf.import_ms += import_end - import_start
			try {
				return await handler(req, res)
			} finally {
				perf.handler_ms += performance.now() - import_end
			}
		}

		try {
			switch (targetModule) {
				case 'note':
					return await call(() => import('./_note.js'))

				case 'demo':
					return await call(() => import('./_demo.js'))

				case 'firebase':
					// Firebase 已封版且 firebase-admin 体积大，按需加载
					return await call(() => import('./_firebase.js'))

				case 'base': {
					const subModule = fullAction[1] // 例如 'login' 或者是 'dict'
					perf.route = `base/${subModule || ''}`
					if (subModule === 'user') return await call(() => import('./_base/user.js'))
					if (subModule === 'dict') return await call(() => import('./_base/dict.js'))
					if (subModule === 'translate') return await call(() => import('./_base/translate.js'))
					if (subModule === 'keepalive') return await call(() => import('./_base/keepalive.js'))
					if (subModule === 'storage') return await call(() => import('./_base/storage.js'))
					if (subModule === 'wsdemo') return await call(() => import('./_base/wsdemo.js'))
					if (subModule === 'ai') return await call(() => import('./_base/ai.js'))
					if (subModule === 'app') return await call(() => import('./_base/app.js'))
					if (subModule === 'backup') return await call(() => import('./_base/backup.js'))
					if (subModule === 'seal') return await call(() => import('./_base/seal.js'))

					return res.status(404).json({ error: `base 基础网关拦截: 未识别或未挂载的业务模块 '${subModule}'` })
				}

				case 'admin': {
					// 后台公共能力：当前挂载全局消息通知中心
					const adminModule = fullAction[1]
					perf.route = `admin/${adminModule || ''}`
					if (adminModule === 'notification') return await call(() => import('./_base/notification.js'))
					return res.status(404).json({ error: `admin 后台网关拦截: 未识别或未挂载的管理模块 '${adminModule}'` })
				}

				case 'cards':
					return await call(() => import('./_cards.js'))

				case 'file':
					return await call(() => import('./_file.js'))

				case 'doc':
					// 文档模块会读取包内静态文件，按需加载
					return await call(() => import('./_doc.js'))

				case 'dphxb':
					return await call(() => import('./_dphxb.js'))

				case 'fa':
					return await call(() => import('./_fa.js'))

				case 'fc':
					return await call(() => import('./_fc.js'))

				case 'sub':
					return await call(() => import('./_sub.js'))

				case 'share':
					return await call(() => import('./_share.js'))

				case 'music':
					return await call(() => import('./_music.js'))

				case 'jndv':
					return await call(() => import('./_jndv.js'))

				case 'zone': {
					const zoneName = fullAction[1] // 'mzl'
					const entity = fullAction[2] // 'class' 或 'student'
					perf.route = `zone/${zoneName || ''}/${entity || ''}`

					if (zoneName === 'mzl') {
						if (entity === 'class') return await call(() => import('./_zone/mzl/class.js'))
						if (entity === 'student') return await call(() => import('./_zone/mzl/student.js'))
					}
					return res.status(404).json({ error: `zone 开发区网关拦截: 未识别或未挂载的接口模块 '${zoneName}/${entity}'` })
				}

				default:
					return res.status(404).json({ error: `总路由架构降级拦截: 未知系统级模块 '${targetModule || '空'}'`, path: req.url })
			}
		} catch (error) {
			console.error('[API Gateway] dispatch error:', error)
			return res.status(500).json({ error: '网关路由分发环境崩溃', details: safe_dispatch_error(error) })
		} finally {
			log_perf(req, perf)
		}
	})
}
