import { requireAuth } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import db from '#api_util/db.js'

const table = 'music'
const valids = ['title', 'audioUrl']

let tableInited = false

/**
 * 自动初始化表结构（幂等）
 */
async function init_table_async() {
	if (tableInited) return
	try {
		await db.query(`
			CREATE TABLE IF NOT EXISTS "${table}" (
				"id" VARCHAR(32) PRIMARY KEY,
				"title" VARCHAR(255) NOT NULL,
				"coverUrl" TEXT,
				"audioUrl" TEXT NOT NULL,
				"duration" INTEGER DEFAULT 0,
				"releaseDate" VARCHAR(20),
				"lyric" TEXT,
				"lyricType" VARCHAR(10) DEFAULT 'static',
				"isFavorite" BOOLEAN DEFAULT false,
				"status" BOOLEAN DEFAULT true,
				"createtime" TIMESTAMPTZ DEFAULT NOW(),
				"updatetime" TIMESTAMPTZ,
				"createTime" TIMESTAMPTZ DEFAULT NOW(),
				"updateTime" TIMESTAMPTZ,
				"deleteTime" TIMESTAMPTZ
			);
		`)
		tableInited = true
	} catch (error) {
		console.error('初始化 music 表失败:', error)
	}
}

const actions = {
	get: {
		// 歌曲列表 (前台/后台通用)
		select: async ({ query } = {}) => {
			await init_table_async()
			query = query || base.getReqInfo().query || {}
			const page = parseInt(query.page || query.current) || 1
			const pageSize = parseInt(query.pageSize || query.size) || 100
			const offset = (page - 1) * pageSize

			const wheres = ['"deleteTime" IS NULL']
			const binds = []
			let idx = 1

			// 状态筛选：前台默认只查询上架状态 (status=true)
			if (query.status !== undefined && query.status !== '') {
				wheres.push(`"status" = $${idx}`)
				binds.push(query.status === 'true' || query.status === true)
				idx++
			} else if (query.isAdmin !== 'true') {
				wheres.push(`"status" = true`)
			}

			// 收藏筛选
			if (query.type === 'favorite') {
				wheres.push(`"isFavorite" = true`)
			}

			// 关键词搜索
			if (query.keyword) {
				wheres.push(`"title" ILIKE $${idx}`)
				binds.push(`%${query.keyword}%`)
				idx++
			}

			const whereStr = wheres.length ? `WHERE ${wheres.join(' AND ')}` : ''

			// 排序处理：默认为发布日期降序 (releaseDate DESC)，支持按名称排序 (title ASC)
			let orderBy = '"releaseDate" DESC NULLS LAST, "createTime" DESC'
			if (query.sort === 'az') {
				orderBy = '"title" ASC'
			} else if (query.sort === 'new') {
				orderBy = '"releaseDate" DESC NULLS LAST, "createTime" DESC'
			}

			try {
				const countRes = await db.query(`SELECT COUNT(*) FROM "${table}" ${whereStr}`, binds)
				const total = parseInt(countRes.rows[0]?.count || 0)

				const listRes = await db.query(`SELECT * FROM "${table}" ${whereStr} ORDER BY ${orderBy} LIMIT $${idx} OFFSET $${idx + 1}`, [
					...binds,
					pageSize,
					offset,
				])

				const data = base.formatDbRows(listRes.rows)
				return base.respSuccess({ data, total })
			} catch (error) {
				return base.respFailure({ msg: `查询歌曲列表失败: ${error.message}` })
			}
		},

		// 歌曲详情
		detail: async ({ query } = {}) => {
			await init_table_async()
			query = query || base.getReqInfo().query || {}
			if (!query.id) return base.respFailure({ msg: 'id 参数缺失' })

			try {
				const res = await db.query(`SELECT * FROM "${table}" WHERE id = $1 AND "deleteTime" IS NULL`, [query.id])
				if (!res.rowCount) return base.respFailure({ msg: '歌曲不存在或已下架' })

				const data = base.formatDbRows(res.rows)[0]
				return base.respSuccess({ data })
			} catch (error) {
				return base.respFailure({ msg: `查询详情失败: ${error.message}` })
			}
		},
	},

	post: {
		// 新增歌曲
		insert: requireAuth(async ({ body } = {}) => {
			await init_table_async()
			body = body || base.getReqInfo().body || {}
			const notMatch = base.checkValids(body, valids)
			if (notMatch) {
				return base.respFailure({ msg: `缺少必填项：${notMatch}` })
			}

			const id = base.getId()
			const now = base.getTime()
			const title = body.title?.trim() || ''
			const coverUrl = body.coverUrl?.trim() || null
			const audioUrl = body.audioUrl?.trim() || ''
			const duration = parseInt(body.duration) || 0
			const releaseDate = body.releaseDate || null
			const lyric = body.lyric || null
			const lyricType = body.lyricType || 'static'
			const isFavorite = body.isFavorite === true || body.isFavorite === 'true'
			const status = body.status !== false && body.status !== 'false'

			try {
				await db.query(
					`INSERT INTO "${table}" (
						"id", "title", "coverUrl", "audioUrl", "duration", "releaseDate",
						"lyric", "lyricType", "isFavorite", "status", "createTime", "createtime"
					) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
					[id, title, coverUrl, audioUrl, duration, releaseDate, lyric, lyricType, isFavorite, status, now, now],
				)
				return base.respSuccess({ msg: '新增成功', data: id })
			} catch (error) {
				return base.respFailure({ msg: `新增失败: ${error.message}` })
			}
		}),

		// 更新歌曲
		update: requireAuth(async ({ body } = {}) => {
			await init_table_async()
			body = body || base.getReqInfo().body || {}
			if (!body?.id) return base.respFailure({ msg: 'id 参数缺失' })

			const notMatch = base.checkValids(body, valids)
			if (notMatch) {
				return base.respFailure({ msg: `缺少必填项：${notMatch}` })
			}

			const now = base.getTime()
			const title = body.title?.trim() || ''
			const coverUrl = body.coverUrl?.trim() || null
			const audioUrl = body.audioUrl?.trim() || ''
			const duration = parseInt(body.duration) || 0
			const releaseDate = body.releaseDate || null
			const lyric = body.lyric || null
			const lyricType = body.lyricType || 'static'
			const isFavorite = body.isFavorite === true || body.isFavorite === 'true'
			const status = body.status !== false && body.status !== 'false'

			try {
				const res = await db.query(
					`UPDATE "${table}" SET
						"title" = $1,
						"coverUrl" = $2,
						"audioUrl" = $3,
						"duration" = $4,
						"releaseDate" = $5,
						"lyric" = $6,
						"lyricType" = $7,
						"isFavorite" = $8,
						"status" = $9,
						"updateTime" = $10,
						"updatetime" = $11
					WHERE "id" = $12 AND "deleteTime" IS NULL RETURNING "id"`,
					[title, coverUrl, audioUrl, duration, releaseDate, lyric, lyricType, isFavorite, status, now, now, body.id],
				)
				if (!res.rowCount) return base.respFailure({ msg: '歌曲不存在或已删除' })
				return base.respSuccess({ msg: '更新成功', data: body.id })
			} catch (error) {
				return base.respFailure({ msg: `更新失败: ${error.message}` })
			}
		}),

		// 软删除歌曲
		delete: requireAuth(async ({ body } = {}) => {
			await init_table_async()
			body = body || base.getReqInfo().body || {}
			if (!body?.id) return base.respFailure({ msg: 'id 参数缺失' })
			const ids = String(body.id).split(',')
			const deleteTime = base.getTime()

			try {
				const res = await db.query(`UPDATE "${table}" SET "deleteTime" = $1 WHERE id = ANY($2::text[])`, [deleteTime, ids])
				return base.respSuccess({ msg: '删除成功', data: ids.join(',') })
			} catch (error) {
				return base.respFailure({ msg: `删除失败: ${error.message}` })
			}
		}),

		// 切换收藏状态
		toggleFavorite: async ({ body } = {}) => {
			await init_table_async()
			body = body || base.getReqInfo().body || {}
			if (!body?.id) return base.respFailure({ msg: 'id 参数缺失' })

			try {
				const isFav = body.isFavorite === true || body.isFavorite === 'true'
				const res = await db.query(`UPDATE "${table}" SET "isFavorite" = $1 WHERE id = $2 AND "deleteTime" IS NULL RETURNING *`, [isFav, body.id])
				if (!res.rowCount) return base.respFailure({ msg: '歌曲不存在' })

				return base.respSuccess({
					data: base.formatDbRows(res.rows)[0],
					msg: isFav ? '已加入收藏' : '已取消收藏',
				})
			} catch (error) {
				return base.respFailure({ msg: `更新收藏状态失败: ${error.message}` })
			}
		},

		// 切换上下架状态 (后台管理用)
		toggleStatus: requireAuth(async ({ body } = {}) => {
			await init_table_async()
			body = body || base.getReqInfo().body || {}
			if (!body?.id) return base.respFailure({ msg: 'id 参数缺失' })

			try {
				const status = body.status === true || body.status === 'true'
				const res = await db.query(`UPDATE "${table}" SET "status" = $1 WHERE id = $2 AND "deleteTime" IS NULL RETURNING *`, [status, body.id])
				if (!res.rowCount) return base.respFailure({ msg: '歌曲不存在' })

				return base.respSuccess({
					data: base.formatDbRows(res.rows)[0],
					msg: status ? '已上架' : '已下架',
				})
			} catch (error) {
				return base.respFailure({ msg: `更新上下架状态失败: ${error.message}` })
			}
		}),
	},
}

export default async function (req, resp) {
	base.req = req
	base.resp = resp
	const { method, action, query, body } = base.getReqInfo()

	try {
		if (actions[method]?.[action]) {
			return await actions[method][action]({ req, resp, query, body })
		}
		return base.respFailure({ msg: `未匹配的动作：${method} ${action}` })
	} catch (error) {
		return base.respFailure({ msg: `服务器内部错误: ${error.message}` })
	}
}
