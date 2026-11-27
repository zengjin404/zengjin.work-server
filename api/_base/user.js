import jwt from 'jsonwebtoken'

import { requireAuth } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import { clear_refresh_cookie, refresh_cookie } from '#api_util/cookie.js'
import { decryptPassword, encryptPassword, hashToken } from '#api_util/crypto.js'
import db from '#api_util/db.js'
import { generateAccessToken, generateRefreshToken } from '#api_util/jwt.js'

/**
 * 自动确保 base_user 表中存在 avatar 字段并纠正桶域名
 */
let avatarColumnChecked = false
export async function ensure_avatarColumn() {
	if (avatarColumnChecked) return
	try {
		await db.query('ALTER TABLE base_user ADD COLUMN IF NOT EXISTS avatar TEXT')
		await db
			.query(
				`UPDATE base_user SET avatar = REPLACE(avatar, 'https://drive.zengjin.work/avatar/', 'https://file.zengjin.work/avatar/') WHERE avatar LIKE 'https://drive.zengjin.work/avatar/%'`,
			)
			.catch(() => {})
		avatarColumnChecked = true
	} catch (err) {
		console.error('[DB] 自动检查/增加 avatar 字段:', err.message)
		// 迁移执行器依赖异常判断失败，不能吞掉错误后误记版本
		throw err
	}
}

/**
 * 用户及身份认证相关接口
 * GET  /api/base/user/me
 * POST /api/base/user/login
 * POST /api/base/user/logout
 * POST /api/base/user/refresh
 * POST /api/base/user/update_password
 * POST /api/base/user/update_profile
 * POST /api/base/user/update_phone
 * POST /api/base/user/send_sms_code
 * POST /api/base/user/verify_sms_code
 * POST /api/base/user/register
 */
const actions = {
	get: {
		/**
		 * 获取当前用户信息
		 */
		me: requireAuth(async ({ req }) => {
			const { userId } = req.user

			let users = []
			let error = null
			try {
				const result = await db.query('SELECT id, username, phone, nickname, avatar, "status", "createTime" FROM base_user WHERE id = $1 LIMIT 1', [
					userId,
				])
				users = result.rows
			} catch (err) {
				console.error('[User me error]:', err)
				// 兜底降级查询（防范某些旧库未包含 avatar）
				try {
					const fallbackRes = await db.query('SELECT id, username, phone, nickname, "status", "createTime" FROM base_user WHERE id = $1 LIMIT 1', [
						userId,
					])
					users = fallbackRes.rows
				} catch (fallbackErr) {
					error = fallbackErr
				}
			}

			if (error || !users || users.length === 0) {
				return base.respFailure({ msg: error ? `获取失败: ${error.message}` : '用户不存在' })
			}

			return base.respSuccess({
				msg: '获取成功',
				data: base.formatDbRows(users)[0],
			})
		}),

		/**
		 * 用户列表
		 */
		select: requireAuth(async ({ query }) => {
			const page = Number(query.current || 1)
			const size = Number(query.pageSize || 20)
			const offset = (page - 1) * size

			const wheres = []
			const binds = []
			if (query.username) {
				binds.push(`%${query.username}%`)
				wheres.push(`username ILIKE $${binds.length}`)
			}
			if (query.nickname) {
				binds.push(`%${query.nickname}%`)
				wheres.push(`nickname ILIKE $${binds.length}`)
			}
			if (query.status) {
				binds.push(query.status)
				wheres.push(`"status" = $${binds.length}`)
			}

			// 创建日期范围筛选
			if (query.createTimeStart) {
				binds.push(`${query.createTimeStart} 00:00:00`)
				wheres.push(`"createTime" >= $${binds.length}`)
			}
			if (query.createTimeEnd) {
				binds.push(`${query.createTimeEnd} 23:59:59`)
				wheres.push(`"createTime" <= $${binds.length}`)
			}

			// 在线状态筛选逻辑
			if (query.isOnline !== undefined && query.isOnline !== '') {
				const isOnline = Number(query.isOnline)
				// onlineIds 预期为以逗号分隔的字符串或数组（保持字符串ID，避免转Number导致12位36进制ID变成NaN）
				const onlineIds = (Array.isArray(query.onlineIds) ? query.onlineIds : (query.onlineIds || '').split(','))
					.map(id => String(id).trim())
					.filter(Boolean)

				if (isOnline === 1) {
					// 仅查询在线用户：如果当前没人在线，直接返回空，否则使用 IN
					if (onlineIds.length === 0) {
						wheres.push('1 = 0')
					} else {
						const placeholders = onlineIds
							.map(id => {
								binds.push(id)
								return `$${binds.length}`
							})
							.join(',')
						wheres.push(`id IN (${placeholders})`)
					}
				} else if (isOnline === 0) {
					// 仅查询离线用户：如果有人在线，使用 NOT IN
					if (onlineIds.length > 0) {
						const placeholders = onlineIds
							.map(id => {
								binds.push(id)
								return `$${binds.length}`
							})
							.join(',')
						wheres.push(`id NOT IN (${placeholders})`)
					}
				}
			}

			const whereStr = wheres.length ? `WHERE ${wheres.join(' AND ')}` : ''
			const sql = `SELECT id, username, phone, nickname, avatar, "status", "statusTime", "createTime", "updateTime" FROM base_user ${whereStr} ORDER BY "createTime" DESC LIMIT $${binds.length + 1} OFFSET $${binds.length + 2}`
			const countSql = `SELECT count(*) as total FROM base_user ${whereStr}`

			try {
				const [res, countRes] = await Promise.all([db.query(sql, [...binds, size, offset]), db.query(countSql, binds)])
				return base.respSuccess({
					data: base.formatDbRows(res.rows),
					total: Number(countRes.rows[0].total),
				})
			} catch (err) {
				return base.respFailure({ msg: `查询失败: ${err.message}` })
			}
		}),

		/**
		 * 用户详情
		 */
		detail: requireAuth(async ({ query }) => {
			if (!query.id) return base.respFailure({ msg: 'ID不能为空' })
			try {
				const res = await db.query(
					'SELECT id, username, phone, nickname, avatar, "status", "statusTime", "createTime", "updateTime" FROM base_user WHERE id = $1',
					[query.id],
				)
				if (res.rowCount === 0) return base.respFailure({ msg: '用户不存在' })
				return base.respSuccess({ data: base.formatDbRows(res.rows)[0] })
			} catch (err) {
				return base.respFailure({ msg: `获取失败: ${err.message}` })
			}
		}),

		/**
		 * 生成 ALTCHA 人机验证挑战
		 */
		challenge: async ({ req, resp }) => {
			const hmacKey = process.env.CRYPTO_SECRET
			if (!hmacKey) {
				console.error('ALTCHA 配置错误: CRYPTO_SECRET 未设置')
				return base.respFailure({ msg: '验证码服务配置错误' })
			}
			try {
				const { createChallenge } = await import('altcha-lib/v1')
				const challenge = await createChallenge({
					hmacKey,
					maxNumber: 100000, // 生成难度，越大计算时间越长
				})
				return resp.status(200).json(challenge)
			} catch (error) {
				console.error('ALTCHA 挑战生成失败:', error)
				return base.respFailure({ msg: '验证码服务不可用' })
			}
		},
	},

	post: {
		/**
		 * 登录
		 */
		login: async ({ req, resp, body }) => {
			const { username, password, altchaPayload, turnstileToken } = body

			const invalids = base.checkValids(body, ['username', 'password'])
			if (invalids) {
				return base.respFailure({ msg: `缺少必填参数: ${invalids}` })
			}

			// 优先使用 ALTCHA 验证
			if (altchaPayload) {
				const hmacKey = process.env.CRYPTO_SECRET
				if (!hmacKey) {
					console.error('ALTCHA 验证失败: CRYPTO_SECRET 未设置')
					return base.respFailure({ msg: '服务器安全配置错误' })
				}
				try {
					const { verifySolution } = await import('altcha-lib/v1')
					const isValid = await verifySolution(altchaPayload, hmacKey)
					if (!isValid) {
						return base.respFailure({ msg: '人机验证失败，请重试' })
					}
				} catch (err) {
					console.error('ALTCHA 验证异常:', err)
					return base.respFailure({ msg: '人机验证服务异常' })
				}
			}
			// 兼容旧版的 Turnstile 验证 (备份)
			else if (turnstileToken) {
				try {
					const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/x-www-form-urlencoded',
						},
						body: `secret=${process.env.TURNSTILE_SECRET_KEY}&response=${turnstileToken}`,
					})
					const verifyOutcome = await verifyRes.json()
					if (!verifyOutcome.success) {
						return base.respFailure({ msg: '人机验证失败，请重试' })
					}
				} catch (err) {
					console.error('Turnstile 验证异常:', err)
					return base.respFailure({ msg: '人机验证服务异常' })
				}
			}
			// 如果两个都没有传
			else {
				return base.respFailure({ msg: '请完成人机验证' })
			}

			let users = []
			let queryError = null
			try {
				const result = await db.query(
					'SELECT id, username, password, phone, nickname, avatar, "status", "createTime" FROM base_user WHERE username = $1 OR phone = $1 LIMIT 1',
					[username],
				)
				users = result.rows
			} catch (err) {
				try {
					const fallbackRes = await db.query(
						'SELECT id, username, password, phone, nickname, "status", "createTime" FROM base_user WHERE username = $1 OR phone = $1 LIMIT 1',
						[username],
					)
					users = fallbackRes.rows
				} catch (fallbackErr) {
					queryError = fallbackErr
				}
			}

			if (queryError || !users || users.length === 0) {
				return base.respFailure({ msg: '用户名或密码错误' })
			}

			const user = users[0]
			if (user.status === 0) {
				return base.respFailure({ msg: '该账号已被禁用，请联系管理员' })
			}

			let dbPassword
			try {
				dbPassword = decryptPassword(user.password)
			} catch (error) {
				return base.respFailure({ msg: '系统错误' })
			}

			if (dbPassword !== password) {
				return base.respFailure({ msg: '用户名或密码错误' })
			}

			const accessToken = generateAccessToken({ userId: user.id, username: user.username })
			const refreshToken = generateRefreshToken()
			const tokenHash = hashToken(refreshToken)

			const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
			const userAgent = req.headers['user-agent'] || ''
			const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''

			try {
				await db.query(
					'INSERT INTO base_user_session (user_id, "refreshTokenHash", "expireTime", "userAgent", "ipAddress") VALUES ($1, $2, $3, $4, $5)',
					[user.id, tokenHash, expiresAt.toISOString(), userAgent, ipAddress],
				)
			} catch (err) {
				console.error('保存 session 失败:', err)
			}

			resp.setHeader('Set-Cookie', refresh_cookie(refreshToken, 7 * 24 * 60 * 60, req))

			const formattedUser = base.formatDbRows(users)[0]
			return base.respSuccess({
				msg: '登录成功',
				data: {
					token: accessToken,
					info: {
						id: formattedUser.id,
						username: formattedUser.username,
						phone: formattedUser.phone,
						nickname: formattedUser.nickname,
						avatar: formattedUser.avatar || '',
						status: formattedUser.status,
						createTime: formattedUser.createTime,
					},
				},
			})
		},

		/**
		 * 退出登录
		 */
		logout: async ({ req, resp }) => {
			const cookies = req.headers.cookie || ''
			const refreshToken = cookies
				.split(';')
				.find(c => c.trim().startsWith('refreshToken='))
				?.split('=')[1]

			if (refreshToken) {
				const tokenHash = hashToken(refreshToken)
				try {
					await db.query('UPDATE base_user_session SET "revokeTime" = $1 WHERE "refreshTokenHash" = $2', [new Date().toISOString(), tokenHash])
				} catch (err) {
					console.error('更新 session 失败:', err)
				}
			}

			resp.setHeader('Set-Cookie', clear_refresh_cookie(req))
			return base.respSuccess({ msg: '退出成功' })
		},

		/**
		 * 刷新Token
		 */
		refresh: async ({ req, resp }) => {
			const cookies = req.headers.cookie || ''
			const refreshToken = cookies
				.split(';')
				.find(c => c.trim().startsWith('refreshToken='))
				?.split('=')[1]

			const clearCookie = clear_refresh_cookie(req)

			if (!refreshToken) {
				resp.setHeader('Set-Cookie', clearCookie)
				return resp.status(401).json({ code: -1, msg: '未提供刷新令牌' })
			}

			const tokenHash = hashToken(refreshToken)
			let sessions = []
			let queryError = null
			try {
				const result = await db.query('SELECT id, user_id, "expireTime", "revokeTime" FROM base_user_session WHERE "refreshTokenHash" = $1 LIMIT 1', [
					tokenHash,
				])
				sessions = result.rows
			} catch (err) {
				queryError = err
			}

			if (queryError || !sessions || sessions.length === 0 || sessions[0].revokeTime || new Date(sessions[0].expireTime) < new Date()) {
				resp.setHeader('Set-Cookie', clearCookie)
				return resp.status(401).json({ code: -1, msg: '刷新令牌无效或已过期' })
			}

			const session = sessions[0]
			let users = []
			let userError = null
			try {
				const result = await db.query('SELECT id, username FROM base_user WHERE id = $1 LIMIT 1', [session.user_id])
				users = result.rows
			} catch (err) {
				userError = err
			}

			if (userError || !users || users.length === 0) {
				resp.setHeader('Set-Cookie', clearCookie)
				return resp.status(401).json({ code: -1, msg: '用户不存在' })
			}

			const user = users[0]
			try {
				await db.query('UPDATE base_user_session SET "revokeTime" = $1 WHERE id = $2', [new Date().toISOString(), session.id])
			} catch (err) {
				console.error('更新 session 失败:', err)
			}

			const newAccessToken = generateAccessToken({ userId: user.id, username: user.username })
			const newRefreshToken = generateRefreshToken()
			const newTokenHash = hashToken(newRefreshToken)

			const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
			try {
				await db.query(
					'INSERT INTO base_user_session (user_id, "refreshTokenHash", "expireTime", "userAgent", "ipAddress") VALUES ($1, $2, $3, $4, $5)',
					[
						user.id,
						newTokenHash,
						expiresAt.toISOString(),
						req.headers['user-agent'] || '',
						req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
					],
				)
			} catch (err) {
				console.error('保存 session 失败:', err)
			}

			resp.setHeader('Set-Cookie', refresh_cookie(newRefreshToken, 7 * 24 * 60 * 60, req))

			return base.respSuccess({ msg: '刷新成功', data: { token: newAccessToken } })
		},

		/**
		 * 修改密码
		 */
		update_password: requireAuth(async ({ req, body }) => {
			const { passwordOld, passwordNew } = body
			const { userId } = req.user

			// 校验参数
			const invalids = base.checkValids(body, ['passwordOld', 'passwordNew'])
			if (invalids) {
				return base.respFailure({ msg: `缺少必填参数: ${invalids}` })
			}

			if (passwordNew.length < 8) {
				return base.respFailure({ msg: '新密码长度至少需8位' })
			}

			if (passwordOld === passwordNew) {
				return base.respFailure({ msg: '新密码不能与原密码相同' })
			}

			let users = []
			let queryError = null
			try {
				const result = await db.query('SELECT password FROM base_user WHERE id = $1 LIMIT 1', [userId])
				users = result.rows
			} catch (err) {
				queryError = err
			}

			if (queryError || !users || users.length === 0) {
				return base.respFailure({ msg: '用户不存在' })
			}

			const user = users[0]
			let dbPassword
			try {
				dbPassword = decryptPassword(user.password)
			} catch (error) {
				return base.respFailure({ msg: '系统解密错误' })
			}

			if (dbPassword !== passwordOld) {
				return base.respFailure({ msg: '原密码错误' })
			}

			// 更新密码
			const encryptedNewPassword = encryptPassword(passwordNew)
			let updateError = null
			try {
				await db.query('UPDATE base_user SET password = $1 WHERE id = $2', [encryptedNewPassword, userId])
			} catch (err) {
				updateError = err
			}

			if (updateError) {
				console.error('更新密码失败:', updateError)
				return base.respFailure({ msg: '修改密码失败，请稍后重试' })
			}

			// 修改成功后作废该用户所有的 Session
			try {
				await db.query('UPDATE base_user_session SET "revokeTime" = $1 WHERE user_id = $2 AND "revokeTime" IS NULL', [new Date().toISOString(), userId])
			} catch (err) {
				console.error('作废 session 失败:', err)
			}

			return base.respSuccess({ msg: '密码修改成功' })
		}),

		/**
		 * 更新个人资料（昵称、头像）
		 */
		update_profile: requireAuth(async ({ req, body }) => {
			const { userId } = req.user
			const { nickname, avatar } = body

			const binds = []
			const fields = []

			if (nickname !== undefined) {
				const cleanNickname = nickname.trim()
				if (cleanNickname.length > 30) {
					return base.respFailure({ msg: '昵称长度不能超过30个字符' })
				}
				binds.push(cleanNickname)
				fields.push(`nickname = $${binds.length}`)
			}

			if (avatar !== undefined) {
				binds.push(avatar.trim())
				fields.push(`avatar = $${binds.length}`)
			}

			if (fields.length === 0) {
				return base.respFailure({ msg: '未提供需要更新的资料项' })
			}

			try {
				binds.push(base.getTime())
				fields.push(`"updateTime" = $${binds.length}`)

				binds.push(userId)
				const sql = `UPDATE base_user SET ${fields.join(', ')} WHERE id = $${binds.length}`
				await db.query(sql, binds)

				// 查询更新后的最新信息
				const updated = await db.query('SELECT id, username, phone, nickname, avatar, "status", "createTime" FROM base_user WHERE id = $1 LIMIT 1', [
					userId,
				])
				return base.respSuccess({
					msg: '资料更新成功',
					data: base.formatDbRows(updated.rows)[0],
				})
			} catch (err) {
				console.error('更新个人资料失败:', err)
				return base.respFailure({ msg: `更新失败: ${err.message}` })
			}
		}),

		/**
		 * 换绑手机号
		 */
		update_phone: requireAuth(async ({ req, body }) => {
			const { userId } = req.user
			const { smsToken } = body

			if (!smsToken) {
				return base.respFailure({ msg: '缺少短信核验凭据' })
			}

			let phone = ''
			try {
				const decoded = jwt.verify(smsToken, process.env.JWT_SECRET)
				if (decoded.type !== 'sms_register' || !decoded.phone) {
					return base.respFailure({ msg: '短信核验凭据无效' })
				}
				phone = decoded.phone
			} catch (err) {
				return base.respFailure({ msg: '短信核验已过期，请重新获取验证码' })
			}

			try {
				// 查重：手机号是否已被其他账号占用
				const check = await db.query('SELECT id FROM base_user WHERE phone = $1 AND id != $2 LIMIT 1', [phone, userId])
				if (check.rowCount > 0) {
					return base.respFailure({ msg: '该手机号码已被其他账号绑定，请更换其他号码' })
				}

				await db.query('UPDATE base_user SET phone = $1, "updateTime" = NOW() WHERE id = $2', [phone, userId])

				const updated = await db.query('SELECT id, username, phone, nickname, avatar, "status", "createTime" FROM base_user WHERE id = $1 LIMIT 1', [
					userId,
				])
				return base.respSuccess({
					msg: '手机号换绑成功',
					data: base.formatDbRows(updated.rows)[0],
				})
			} catch (err) {
				console.error('换绑手机号失败:', err)
				return base.respFailure({ msg: `换绑失败: ${err.message}` })
			}
		}),

		/**
		 * 新增用户
		 */
		insert: requireAuth(async ({ body }) => {
			const { username, password, nickname, phone, status = 1 } = body
			if (!username || !password) return base.respFailure({ msg: '用户名和密码不能为空' })

			if (!/^(?!\d+$)[a-zA-Z0-9_]{2,20}$/.test(username)) {
				return base.respFailure({ msg: '用户名需为2-20位字母、数字或下划线，且不能为纯数字' })
			}

			if (password.length < 8) {
				return base.respFailure({ msg: '密码长度至少需8位' })
			}

			try {
				// 检查重复
				const check = await db.query('SELECT id FROM base_user WHERE username = $1', [username])
				if (check.rowCount > 0) return base.respFailure({ msg: '用户名已存在' })

				const id = base.getId()
				const createTime = base.getTime()
				const encryptedPassword = encryptPassword(password)

				await db.query('INSERT INTO base_user (id, username, password, nickname, phone, "status", "createTime") VALUES ($1, $2, $3, $4, $5, $6, $7)', [
					id,
					username,
					encryptedPassword,
					nickname || '',
					phone || '',
					status,
					createTime,
				])
				return base.respSuccess({ msg: '新增成功', data: id })
			} catch (err) {
				return base.respFailure({ msg: `新增失败: ${err.message}` })
			}
		}),

		/**
		 * 修改用户
		 */
		update: requireAuth(async ({ body }) => {
			const { id, username, password, nickname, phone, status } = body
			if (!id) return base.respFailure({ msg: 'ID不能为空' })

			try {
				// 防护：防止将系统管理员 admin 改名或禁用
				if (username && username !== 'admin') {
					const checkAdmin = await db.query('SELECT username FROM base_user WHERE id = $1', [id])
					if (checkAdmin.rows.length && checkAdmin.rows[0].username === 'admin') {
						return base.respFailure({ msg: '系统内置管理员(admin)不允许修改用户名' })
					}
				}
				if (status === 0) {
					const checkAdmin = await db.query('SELECT username FROM base_user WHERE id = $1', [id])
					if (checkAdmin.rows.length && checkAdmin.rows[0].username === 'admin') {
						return base.respFailure({ msg: '系统内置管理员(admin)不允许被禁用' })
					}
				}

				const fields = []
				const binds = []

				if (username) {
					if (!/^(?!\d+$)[a-zA-Z0-9_]{2,20}$/.test(username)) {
						return base.respFailure({ msg: '用户名需为2-20位字母、数字或下划线，且不能为纯数字' })
					}
					binds.push(username)
					fields.push(`username = $${binds.length}`)
				}
				if (password) {
					if (password.length < 8) {
						return base.respFailure({ msg: '密码长度至少需8位' })
					}
					binds.push(encryptPassword(password))
					fields.push(`password = $${binds.length}`)
				}
				if (nickname !== undefined) {
					binds.push(nickname)
					fields.push(`nickname = $${binds.length}`)
				}
				if (phone !== undefined) {
					binds.push(phone)
					fields.push(`phone = $${binds.length}`)
				}
				if (status !== undefined) {
					binds.push(status)
					fields.push(`"status" = $${binds.length}`)

					binds.push(base.getTime())
					fields.push(`"statusTime" = $${binds.length}`)
				}

				binds.push(base.getTime())
				fields.push(`"updateTime" = $${binds.length}`)

				if (fields.length === 1) return base.respFailure({ msg: '没有需要更新的内容' })

				binds.push(id)
				const sql = `UPDATE base_user SET ${fields.join(', ')} WHERE id = $${binds.length}`
				await db.query(sql, binds)
				return base.respSuccess({ msg: '更新成功' })
			} catch (err) {
				return base.respFailure({ msg: `更新失败: ${err.message}` })
			}
		}),

		/**
		 * 删除用户
		 */
		delete: requireAuth(async ({ body }) => {
			const { id } = body
			if (!id) return base.respFailure({ msg: 'ID不能为空' })
			const ids = id.toString().split(',')

			try {
				// 防护：防止删除系统管理员 admin
				const checkAdmin = await db.query(`SELECT username FROM base_user WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`, ids)
				if (checkAdmin.rows.some(row => row.username === 'admin')) {
					return base.respFailure({ msg: '系统内置管理员(admin)不允许被删除' })
				}

				await db.query(`DELETE FROM base_user WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`, ids)
				return base.respSuccess({ msg: '删除成功' })
			} catch (err) {
				return base.respFailure({ msg: `删除失败: ${err.message}` })
			}
		}),

		/**
		 * 发送短信验证码 (阿里云 Dypnsapi)
		 */
		send_sms_code: async ({ req, body }) => {
			const { phone, altchaPayload } = body

			const invalids = base.checkValids(body, ['phone'])
			if (invalids) {
				return base.respFailure({ msg: `缺少必填参数: ${invalids}` })
			}

			if (!/^1[3-9]\d{9}$/.test(phone)) {
				return base.respFailure({ msg: '请输入有效的11位手机号码' })
			}

			// 强制人机验证 (ALTCHA) 防刷
			if (!altchaPayload) {
				return base.respFailure({ msg: '请先完成人机验证' })
			}

			const hmacKey = process.env.CRYPTO_SECRET
			if (!hmacKey) {
				return base.respFailure({ msg: '服务器安全配置错误' })
			}

			try {
				const { verifySolution } = await import('altcha-lib/v1')
				const isValid = await verifySolution(altchaPayload, hmacKey)
				if (!isValid) {
					return base.respFailure({ msg: '人机验证失败，请重试' })
				}
			} catch (err) {
				console.error('ALTCHA 验证异常:', err)
				return base.respFailure({ msg: '人机验证服务异常' })
			}

			// 手机号查重：已注册号码直接拦截，避免浪费短信资费
			try {
				const exist = await db.query('SELECT id FROM base_user WHERE phone = $1 LIMIT 1', [phone])
				if (exist.rowCount > 0) {
					return base.respFailure({ msg: '该手机号码已注册，请直接登录' })
				}
			} catch (err) {
				console.error('查询手机号失败:', err)
			}

			// 调用阿里云发送短信（仅短信动作加载 @alicloud SDK）
			const { send_smsVerifyCode } = await import('#api_util/sms_alicloud.js')
			const smsRes = await send_smsVerifyCode(phone)
			if (!smsRes.success) {
				return base.respFailure({ msg: smsRes.msg })
			}

			return base.respSuccess({
				msg: '验证码已发送，10分钟内有效',
				data: smsRes.data,
			})
		},

		/**
		 * 核验短信验证码 (阿里云 Dypnsapi)
		 */
		verify_sms_code: async ({ body }) => {
			const { phone, code } = body

			const invalids = base.checkValids(body, ['phone', 'code'])
			if (invalids) {
				return base.respFailure({ msg: `缺少必填参数: ${invalids}` })
			}

			// 调用阿里云核验（仅短信动作加载 @alicloud SDK）
			const { check_smsVerifyCode } = await import('#api_util/sms_alicloud.js')
			const verifyRes = await check_smsVerifyCode(phone, code)
			if (!verifyRes.success) {
				return base.respFailure({ msg: verifyRes.msg })
			}

			// 核验成功，生成短效防篡改注册凭据 smsToken (15分钟有效)
			const secret = process.env.JWT_SECRET
			const smsToken = jwt.sign({ phone, type: 'sms_register', timestamp: Date.now() }, secret, { expiresIn: '15m' })

			return base.respSuccess({
				msg: '验证码核验成功',
				data: { smsToken },
			})
		},

		/**
		 * 手机号用户注册 (需携带核验通过的 smsToken)
		 */
		register: async ({ req, resp, body }) => {
			const { smsToken, username, password } = body

			const invalids = base.checkValids(body, ['smsToken', 'username', 'password'])
			if (invalids) {
				return base.respFailure({ msg: `缺少必填参数: ${invalids}` })
			}

			// 验证 smsToken
			let phone = ''
			const secret = process.env.JWT_SECRET
			try {
				const decoded = jwt.verify(smsToken, secret)
				if (decoded.type !== 'sms_register' || !decoded.phone) {
					return base.respFailure({ msg: '短信验证凭据无效，请重新验证' })
				}
				phone = decoded.phone
			} catch (err) {
				return base.respFailure({ msg: '短信验证已过期，请重新获取验证码' })
			}

			// 格式校验
			if (!/^(?!\d+$)[a-zA-Z0-9_]{2,20}$/.test(username)) {
				return base.respFailure({ msg: '用户名需为2-20位字母、数字或下划线，且不能为纯数字' })
			}
			if (password.length < 8) {
				return base.respFailure({ msg: '密码长度至少需8位' })
			}

			try {
				// 查重：用户名
				const checkUser = await db.query('SELECT id FROM base_user WHERE username = $1 LIMIT 1', [username])
				if (checkUser.rowCount > 0) {
					return base.respFailure({ msg: '该用户名已被占用，请更换' })
				}

				// 查重：手机号
				const checkPhone = await db.query('SELECT id FROM base_user WHERE phone = $1 LIMIT 1', [phone])
				if (checkPhone.rowCount > 0) {
					return base.respFailure({ msg: '该手机号已注册，请直接登录' })
				}

				const id = base.getId()
				const createTime = base.getTime()
				const encryptedPassword = encryptPassword(password)

				// 写入用户表：nickname 默认留空，由渲染层通过 nickname || username 兜底展示
				await db.query('INSERT INTO base_user (id, username, password, nickname, phone, "status", "createTime") VALUES ($1, $2, $3, $4, $5, $6, $7)', [
					id,
					username,
					encryptedPassword,
					'',
					phone,
					1,
					createTime,
				])

				// 注册成功，直接颁发 Token 自动登录
				const accessToken = generateAccessToken({ userId: id, username })
				const refreshToken = generateRefreshToken()
				const tokenHash = hashToken(refreshToken)

				const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
				const userAgent = req.headers['user-agent'] || ''
				const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''

				try {
					await db.query(
						'INSERT INTO base_user_session (user_id, "refreshTokenHash", "expireTime", "userAgent", "ipAddress") VALUES ($1, $2, $3, $4, $5)',
						[id, tokenHash, expiresAt.toISOString(), userAgent, ipAddress],
					)
				} catch (err) {
					console.error('保存 session 失败:', err)
				}

				resp.setHeader('Set-Cookie', refresh_cookie(refreshToken, 7 * 24 * 60 * 60, req))

				return base.respSuccess({
					msg: '注册成功',
					data: {
						token: accessToken,
						info: { id, username, phone, nickname: '', avatar: '', createTime },
					},
				})
			} catch (err) {
				console.error('注册异常:', err)
				return base.respFailure({ msg: `注册失败: ${err.message}` })
			}
		},
	},
}

export default async (req, resp) => {
	base.req = req
	base.resp = resp
	const { method, action, body, query } = base.getReqInfo()

	try {
		if (actions[method]?.[action]) {
			const handler = actions[method][action]
			// 这里的handler如果是由requireAuth包装的，它内部会自行处理校验和返回
			return await handler({ req, resp, body, query })
		}
		return base.respFailure({ msg: '无效的操作' })
	} catch (error) {
		console.error('接口处理错误:', error)
		return base.respFailure({ msg: `服务器内部错误: ${error.message}` })
	}
}
