import { requireAdmin } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import db from '#api_util/db.js'

const actions = {
	// 原公开查询 GET /api/share/info 已迁至 Worker 的 GET /share/info/:shareCode
	// (Worker 为云分享唯一业务后端), 本模块现已无公开 GET 接口, get 仅保留分发占位
	get: {},
	post: {},
}

// shareCode 字符集: 去除易混淆的 0/o/1/l (保留 i)
const CODE_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789'
// 站长后台分享生成 4 位; 用户自助分享由 Worker 生成 6 位 (双轨刻意设计, 勿统一)
const CODE_LENGTH = 4

// 分享服务 Worker 地址(非机密, 可在环境变量覆盖)
const workerBase = (process.env.SHARE_ADMIN_WORKER_URL || process.env.SHARE_WORKER_URL || 'https://share.zengjin.work').replace(/\/+$/, '')
// Worker 内部调用密钥(机密, 与 Worker 侧 SHARE_ADMIN_SECRET 保持一致)
const workerAdminSecret = process.env.SHARE_ADMIN_SECRET || ''

/**
 * 调用 Worker 解析 OneDrive 分享链接, 获取云端文件元数据
 * 约定契约: POST {workerBase}/internal/share/resolve
 *   请求头: X-Share-Admin-Secret
 *   请求体: { shareUrl }
 *   响应体: { driveItemId, fileName, fileSize, mimeType, webUrl }
 * 仅服务端调用, 返回结果只允许在服务端落库, 不直接透传前端
 */
async function resolve_shareUrl(shareUrl) {
	if (!workerAdminSecret) {
		throw new Error('分享服务尚未配置(SHARE_ADMIN_SECRET)')
	}
	let resp
	try {
		resp = await fetch(`${workerBase}/internal/share/resolve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-share-admin-secret': workerAdminSecret,
			},
			body: JSON.stringify({ shareUrl }),
			signal: AbortSignal.timeout(20 * 1000),
		})
	} catch (error) {
		throw new Error(`分享服务暂不可达: ${error.message}`)
	}

	const result = await resp.json().catch(() => ({}))
	if (!resp.ok || !result || result.driveItemId == null) {
		throw new Error(result?.msg || result?.message || `分享解析失败(HTTP ${resp.status})`)
	}
	return result
}

/**
 * 生成 shareCode (4位, 去混淆字符集), 唯一冲突时由调用方负责重试
 */
function gen_shareCode() {
	let code = ''
	for (let i = 0; i < CODE_LENGTH; i++) {
		code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
	}
	return code
}

/**
 * 规范化到期时间: 仅接受完整时刻 'YYYY-MM-DD HH:mm:ss'(几点失效由管理员决定, 不做隐式补末刻)
 * 空串/空值 = 永不过期(由调用方映射入库 NULL); 非法格式返回 null
 */
function norm_expiresAt(raw) {
	if (raw == null || String(raw).trim() === '') return ''
	const value = String(raw).trim()
	if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null
	return value
}

/**
 * 管理端: 分页查询分享列表 (关键字可搜文件名/分享码, 可按启用状态过滤)
 */
actions.post.select = async ({ query, body }) => {
	const params = { ...query, ...body }
	const keyword = String(params.keyword || '').trim()
	// enabled: 兼容 boolean / 'true' 'false' / '1' '0' / 空串(全部)
	const enabledRaw = params.enabled
	const enabled =
		enabledRaw === '' || enabledRaw == null || enabledRaw === 'undefined'
			? null
			: enabledRaw === true || enabledRaw === 'true' || enabledRaw === 1 || enabledRaw === '1'
	// sourceType: 按来源过滤 (admin = 站长后台分享, user = 用户自助分享), 空串 = 全部
	const sourceTypeRaw = String(params.sourceType || '').trim()
	const sourceType = sourceTypeRaw === 'admin' || sourceTypeRaw === 'user' ? sourceTypeRaw : null
	const page = Math.max(1, Number(params.page || params.current || 1))
	const size = Math.min(100, Math.max(1, Number(params.size || params.pageSize || 10)))
	const offset = (page - 1) * size

	const binds = []
	let where = 'WHERE 1 = 1'
	if (keyword) {
		binds.push(`%${keyword}%`)
		where += ` AND ("fileName" ILIKE $${binds.length} OR "shareCode" ILIKE $${binds.length})`
	}
	if (enabled !== null) {
		binds.push(enabled)
		where += ` AND enabled = $${binds.length}`
	}
	if (sourceType) {
		binds.push(sourceType)
		where += ` AND s."sourceType" = $${binds.length}`
	}

	const baseSelect = `
		SELECT s.id, s."shareCode", s."fileName", s."mimeType", s."fileSize", s.enabled,
			s.description, s."expiresAt", s."createTime", s."updateTime",
			s."sourceType", s."uploadStatus", s."downloadCount",
			bu.username AS "creatorName"
		FROM share s
		LEFT JOIN base_user bu ON bu.id = s."createdBy"
	`
	try {
		let res = await db.query(`${baseSelect} ${where} ORDER BY s."createTime" DESC LIMIT $${binds.length + 1} OFFSET $${binds.length + 2}`, [
			...binds,
			size,
			offset,
		])
		let rows = base.formatDbRows(res.rows)

		let totalRes = await db.query(`SELECT COUNT(*) AS count FROM share s ${where}`, binds)
		const total = Number(totalRes.rows[0].count || 0)

		const now = base.getTime()
		rows = rows.map(item => ({
			...item,
			expired: !!item.expiresAt && item.expiresAt < now,
		}))

		return base.respSuccess({ msg: '查询成功', total, data: rows })
	} catch (error) {
		// base_user 关联查询异常时降级为单表查询, 保证列表主流程可用
		try {
			let res = await db.query(
				`SELECT id, "shareCode", "fileName", "mimeType", "fileSize", enabled, description, "expiresAt", "createTime", "updateTime", "sourceType", "uploadStatus", "downloadCount" FROM share s ${where} ORDER BY "createTime" DESC LIMIT $${binds.length + 1} OFFSET $${binds.length + 2}`,
				[...binds, size, offset],
			)
			let rows = base.formatDbRows(res.rows)
			let totalRes = await db.query(`SELECT COUNT(*) AS count FROM share s ${where}`, binds)
			const now = base.getTime()
			rows = rows.map(item => ({ ...item, creatorName: '', expired: !!item.expiresAt && item.expiresAt < now }))
			return base.respSuccess({ msg: '查询成功', total: Number(totalRes.rows[0].count || 0), data: rows })
		} catch (error2) {
			return base.respFailure({ msg: `查询失败：${error2.message}` })
		}
	}
}

/**
 * 管理端: 解析分享链接预览 (调用 Worker 校验并取回文件名/大小, 不做落库)
 */
actions.post.preview = async ({ body }) => {
	const shareUrl = String(body.shareUrl || '').trim()
	if (!/^https?:\/\/.+/.test(shareUrl)) {
		return base.respFailure({ msg: '分享链接格式不正确' })
	}
	try {
		const meta = await resolve_shareUrl(shareUrl)
		return base.respSuccess({
			msg: '解析成功',
			data: {
				fileName: meta.fileName || '',
				fileSize: meta.fileSize || 0,
				mimeType: meta.mimeType || '',
			},
		})
	} catch (error) {
		return base.respFailure({ msg: `解析失败：${error.message}` })
	}
}

/**
 * 管理端: 新增分享 (调用 Worker 解析分享链接, 落库一条分享记录)
 * 删除/停用分享记录均不影响 OneDrive 源文件
 */
actions.post.insert = async ({ body }) => {
	const shareUrl = String(body.shareUrl || '').trim()
	if (!/^https?:\/\/.+/.test(shareUrl)) {
		return base.respFailure({ msg: '分享链接格式不正确' })
	}
	const description = String(body.description || '').trim()
	const expiresAt = norm_expiresAt(body.expiresAt)
	if (body.expiresAt && expiresAt === null) {
		return base.respFailure({ msg: '到期时间格式不正确(需为 YYYY-MM-DD HH:mm:ss, 留空为永不过期)' })
	}

	let meta
	try {
		meta = await resolve_shareUrl(shareUrl)
	} catch (error) {
		return base.respFailure({ msg: error.message })
	}

	const id = base.getId()
	const createTime = base.getTime()
	const createdBy = base.req.user?.userId || ''

	// shareCode 唯一冲突重试 (最长 10 次)
	for (let i = 0; i < 10; i++) {
		const shareCode = gen_shareCode()
		try {
			await db.query(
				`INSERT INTO share (id, "shareCode", "driveItemId", "fileName", "mimeType", "fileSize", enabled, "expiresAt", "createdBy", description, "createTime", "updateTime")
				 VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10, $10)`,
				[
					id,
					shareCode,
					meta.driveItemId,
					meta.fileName || '',
					meta.mimeType || '',
					meta.fileSize || 0,
					expiresAt || null,
					createdBy,
					description,
					createTime,
				],
			)
			return base.respSuccess({
				msg: '新增成功',
				data: {
					id,
					shareCode,
					fileName: meta.fileName || '',
					fileSize: meta.fileSize || 0,
					mimeType: meta.mimeType || '',
				},
			})
		} catch (error) {
			// 23505 = 唯一键冲突(shareCode 撞码), 换码重试
			if (error.code === '23505' && i < 9) continue
			return base.respFailure({ msg: `新增失败：${error.message}` })
		}
	}
	return base.respFailure({ msg: '新增失败：请重试' })
}

/**
 * 管理端: 编辑分享
 *
 * 可改字段白名单仅: fileName / description / expiresAt / enabled。
 * shareCode 与 driveItemId 在创建时确定, 编辑接口不接受、也绝不改写(即使请求体携带也会被忽略);
 * 公开页/下载 session 缓存的 driveItemId 因此始终保持指向创建时的源文件。
 */
actions.post.update = async ({ body }) => {
	const id = String(body.id || '').trim()
	if (!id) {
		return base.respFailure({ msg: 'id 参数缺失' })
	}

	const updates = []
	const binds = []
	const push = (field, value) => {
		updates.push(`"${field}" = $${updates.length + 1}`)
		binds.push(value)
	}

	// 到期时间: 允许清空(传空串)或赋值
	if (body.expiresAt !== undefined) {
		const expiresAt = norm_expiresAt(body.expiresAt)
		if (body.expiresAt && expiresAt === null) {
			return base.respFailure({ msg: '到期时间格式不正确(需为 YYYY-MM-DD HH:mm:ss, 留空为永不过期)' })
		}
		push('expiresAt', expiresAt || null)
	}
	if (body.description !== undefined) push('description', String(body.description || '').trim())
	if (body.fileName !== undefined) push('fileName', String(body.fileName || '').trim())
	if (body.enabled !== undefined) {
		const enabled = body.enabled === true || body.enabled === 1 || body.enabled === '1' || body.enabled === 'true'
		push('enabled', enabled)
	}

	if (!updates.length) {
		return base.respFailure({ msg: '无数据变更' })
	}

	binds.push(base.getTime())
	const updateSql = `UPDATE share SET ${updates.join(', ')}, "updateTime" = $${updates.length} WHERE id = $${updates.length + 1}`
	try {
		const res = await db.query(updateSql, [...binds, id])
		if (!res.rowCount) {
			return base.respFailure({ msg: '分享记录不存在' })
		}
		return base.respSuccess({ msg: '保存成功', data: id })
	} catch (error) {
		return base.respFailure({ msg: `保存失败：${error.message}` })
	}
}

/**
 * 管理端: 删除分享记录 (仅删除业务记录, 绝不删除 OneDrive 源文件)
 */
actions.post.delete = async ({ body }) => {
	const id = String(body.id || '').trim()
	if (!id) {
		return base.respFailure({ msg: 'id 参数缺失' })
	}
	try {
		const res = await db.query(`DELETE FROM share WHERE id = $1`, [id])
		if (!res.rowCount) {
			return base.respFailure({ msg: '分享记录不存在或已被删除' })
		}
		return base.respSuccess({ msg: '删除成功', data: id })
	} catch (error) {
		return base.respFailure({ msg: `删除失败：${error.message}` })
	}
}

export default async (req, resp) => {
	base.req = req
	base.resp = resp

	const { method, action, query, body } = base.getReqInfo()

	// 全部接口均要求管理员 (非 admin 返回 403)
	return requireAdmin(async () => {
		const handler = actions[method]?.[action]
		if (!handler) {
			return base.respFailure({ msg: '请求的方法无效' })
		}
		return handler({ query, body })
	})()
}
