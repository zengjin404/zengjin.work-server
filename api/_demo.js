import base from '#api_util/base.js'

const actions = {
	get: {},
	post: {},
}

/* 简单示例 */
actions.get.hello = async options => {
	const { req, resp, query, body } = options
	return resp.status(200).json({
		message: '你好世界! 这是通过合并路由返回的。',
		timestamp: new Date().toISOString(),
	})
}

/**
 * sayhello 方法：返回 Hello 消息
 * 仅用于演示动态路由 [action].js 的方法分发
 */
actions.get.sayhello = async options => {
	const now = base.getTime()
	return base.respSuccess({
		data: {
			info: 'Hello from /api/base/demo/sayhello',
			time: now,
		},
	})
}

/**
 * sayhi 方法：返回 Hi 消息
 * 仅用于演示动态路由 [action].js 的方法分发
 */
actions.get.sayhi = async options => {
	const now = base.getTime()
	return base.respSuccess({
		msg: '请求成功',
		data: {
			info: 'Hi from /api/base/demo/sayhi',
			time: now,
		},
	})
}

/* 鉴权测试 */
actions.get.auth = async options => {
	// 仅 auth 动作需要 JWT 鉴权，按需加载，避免 demo/hello 也加载 jsonwebtoken
	const { checkAuth } = await import('#api_util/auth_middleware.js')
	// 直接在此拦截。如果不通过，checkAuth 内部会自动执行 resp.status 并结束流返回 false
	if (!(await checkAuth(base.req, base.resp))) {
		return
	}

	try {
		const { userId, username } = base.req.user
		return base.respSuccess({
			msg: '操作成功。这是一个受保护的接口，只有登录用户才能访问。',
			data: {
				user: { userId, username },
				time: base.getTime(),
				random: Math.random(),
			},
		})
	} catch (error) {
		return base.respFailure({ msg: `服务器内部错误: ${error.message}` })
	}
}

// 这是被总开关包含在内的隐形控制器模块
export default async (req, resp) => {
	base.req = req
	base.resp = resp

	const { table, method, action, query, body } = base.getReqInfo()

	try {
		if (actions[method]?.[action]) {
			return await actions[method][action]({ req, resp, query, body })
		} else {
			return base.respFailure({
				msg: '请求类型或方法无效',
			})
		}
	} catch (error) {
		return base.respFailure({
			msg: `服务器内部错误: ${error.message}`,
		})
	}
}
