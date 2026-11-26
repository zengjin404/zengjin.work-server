import { create_edgeone_app } from '../../api_util/edgeone_app.js'

/**
 * EdgeOne Cloud Functions 唯一入口
 *
 * 文件路径决定挂载点：cloud-functions/api/[[default]].js → /api/*
 * 不要改成根级 cloud-functions/[[default]].js：那会挂到 /，
 * 与静态站点和 rewrite 竞争，属于高风险写法。
 *
 * 注意：这里必须延迟 import api/index.js。
 * api_util/db.js 在模块加载时就读取 process.env 并创建连接池；
 * Express 模式没有 context 参数，若运行时在模块加载后才注入环境变量，
 * 顶层静态 import 会把 db 固化成 null，且请求期无法恢复。
 * 延迟到首次请求再加载，是当前架构下唯一可做的兜底（G4 仍需实测）。
 */
let masterHandlerPromise

async function get_master_handler() {
	if (!masterHandlerPromise) {
		masterHandlerPromise = import('../../api/index.js').then(module => module.default)
	}
	return masterHandlerPromise
}

const app = create_edgeone_app({
	handler: async (req, res) => {
		const masterHandler = await get_master_handler()
		return masterHandler(req, res)
	},
})

export default app
