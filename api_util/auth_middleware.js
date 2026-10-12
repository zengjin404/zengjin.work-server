import base from './base.js'
import { verifyAccessToken } from './jwt.js'

/**
 * 认证中间件
 * 用于保护需要登录才能访问的API接口
 */

/**
 * 校验认证状态
 * @param {Object} req
 * @param {Object} resp
 * @returns {Promise<boolean>}
 */
export async function checkAuth(req, resp) {
	req = req || base.req
	resp = resp || base.resp
	try {
		// 从请求头获取token
		const authHeader = req?.headers?.authorization || req?.headers?.Authorization

		if (!authHeader) {
			resp.status(401).json({ code: -1, msg: '未提供认证令牌' })
			return false
		}

		// 检查Bearer格式
		const parts = authHeader.split(' ')
		if (parts.length !== 2 || parts[0] !== 'Bearer') {
			resp.status(401).json({ code: -1, msg: '认证令牌格式错误' })
			return false
		}

		const token = parts[1]

		// 验证token
		let decoded
		try {
			decoded = verifyAccessToken(token)
		} catch (error) {
			resp.status(401).json({ code: -1, msg: error.message || '认证令牌无效' })
			return false
		}

		// 将用户信息附加到请求对象，以便后续业务使用
		req.user = {
			userId: decoded.userId,
			username: decoded.username,
		}

		// 验证成功，放行
		return true
	} catch (error) {
		console.error('认证过程发生异常:', error)
		resp.status(500).json({ code: -1, msg: '服务器内部错误' })
		return false
	}
}

/**
 * 非写入式认证：有 Token 就认一下，没有或无效都只是返回 null
 *
 * checkAuth 在未登录时会**自己写 401**，只适合「必须登录」的接口；像 jndv 问答门这种
 * 「登录可选」（未登录答对同样放行）的场景不能用它 —— 会把正常的未登录访问写成一个错误响应。
 * 所以这里只解 Token、绝不碰 resp，认出来就顺手挂到 req.user 上（与 checkAuth 保持同一形状）。
 *
 * @param {Object} req
 * @returns {Promise<Object|null>} 认证成功返回 { userId, username }，否则 null
 */
export async function verifyAuth(req) {
	req = req || base.req
	try {
		const authHeader = req?.headers?.authorization || req?.headers?.Authorization
		if (!authHeader) return null

		const parts = authHeader.split(' ')
		if (parts.length !== 2 || parts[0] !== 'Bearer') return null

		let decoded
		try {
			decoded = verifyAccessToken(parts[1])
		} catch {
			return null
		}
		if (!decoded?.userId) return null

		req.user = {
			userId: decoded.userId,
			username: decoded.username,
		}
		return req.user
	} catch (error) {
		console.error('非写入式认证过程发生异常:', error)
		return null
	}
}

/**
 * 要求认证的中间件包装器
 * @param {Function} handler - 实际的处理函数
 * @returns {Function} 包装后的处理函数
 */
export function requireAuth(handler) {
	return async (args = {}) => {
		const req = args?.req || base.req
		const resp = args?.resp || base.resp
		const isAuth = await checkAuth(req, resp)
		if (isAuth) {
			return handler(args)
		}
	}
}

/**
 * 要求管理员认证的中间件包装器
 * 项目无角色体系, 内置超级管理员以 username === 'admin' 为唯一约定
 * 组合 requireAuth 之后额外校验管理员身份
 * @param {Function} handler - 实际的处理函数
 * @returns {Function} 包装后的处理函数
 */
export function requireAdmin(handler) {
	return requireAuth(async (args = {}) => {
		const resp = args?.resp || base.resp
		const req = args?.req || base.req
		if (req.user?.username !== 'admin') {
			return resp.status(403).json({ code: -1, msg: '无操作权限: 仅系统管理员可执行' })
		}
		return handler(args)
	})
}
