import base from '#api_util/base.js'
import db from '#api_util/db.js'

// 七牛管理仅在删除/清理文件的动作中需要；fc/select 不应加载 qiniu
const get_provider = () => import('#api_util/_storage_provider.js').then(module => module.default)

const BUCKET = 'cdn'
const actions = { get: {}, post: {} }

// ============================== 用户前台（无需鉴权） ==============================

/** 游戏列表（分页） */
actions.get.select = async ({ query }) => {
	const page = parseInt(query.page) || 1
	const pageSize = parseInt(query.pageSize) || 24
	const offset = (page - 1) * pageSize
	const sortMap = {
		hot: '"playCount" DESC',
		az: 'name ASC',
		new: '"insertTime" DESC',
	}
	const orderBy = sortMap[query.sort] || sortMap.new

	const wheres = ['"deleteTime" IS NULL']
	const binds = []
	let idx = 1

	// 分类筛选
	if (query.categoryId) {
		wheres.push(`id IN (SELECT "fcId" FROM fc_category_link WHERE "categoryId" = $${idx})`)
		binds.push(query.categoryId)
		idx++
	}

	// 关键词搜索（名称 / 别称 / 厂家）
	if (query.keyword) {
		const kw = `%${query.keyword}%`
		wheres.push(`(name ILIKE $${idx} OR maker ILIKE $${idx + 1} OR id IN (SELECT "fcId" FROM fc_alias WHERE alias ILIKE $${idx + 2}))`)
		binds.push(kw, kw, kw)
		idx += 3
	}

	const whereStr = wheres.length ? `WHERE ${wheres.join(' AND ')}` : ''

	try {
		// 总数与列表互不依赖，并行发出；分类查询依赖列表 id，保留在之后串行
		const [countRes, listRes] = await Promise.all([
			db.query(`SELECT COUNT(*) FROM fc ${whereStr}`, binds),
			db.query(
				`SELECT id, name, cover, maker, "playerCount", "playCount", sort, "insertTime"
				 FROM fc ${whereStr}
				 ORDER BY sort DESC, ${orderBy}
				 LIMIT $${idx} OFFSET $${idx + 1}`,
				[...binds, pageSize, offset],
			),
		])
		const total = parseInt(countRes.rows[0].count)

		// 批量查分类（用于卡片展示前 2 个分类标签）
		const ids = listRes.rows.map(r => r.id)
		let categoryMap = {}
		if (ids.length) {
			const catRes = await db.query(
				`SELECT cl."fcId", c.id, c.name
				 FROM fc_category_link cl
				 JOIN fc_category c ON cl."categoryId" = c.id
				 WHERE cl."fcId" = ANY($1)`,
				[ids],
			)
			catRes.rows.forEach(r => {
				if (!categoryMap[r.fcId]) categoryMap[r.fcId] = []
				categoryMap[r.fcId].push({ id: r.id, name: r.name })
			})
		}

		const data = base.formatDbRows(listRes.rows).map(r => ({
			...r,
			categories: categoryMap[r.id] || [],
		}))

		return base.respSuccess({ data, total })
	} catch (error) {
		return base.respFailure({ msg: `查询失败: ${error.message}` })
	}
}

/** 游戏详情（聚合分类/标签/别称/图片） */
actions.get.detail = async ({ query }) => {
	if (!query.id) return base.respFailure({ msg: 'id 参数缺失' })

	try {
		// 主表
		const gameRes = await db.query('SELECT * FROM fc WHERE id = $1', [query.id])
		if (!gameRes.rowCount) return base.respFailure({ msg: '游戏不存在' })
		const game = base.formatDbRows(gameRes.rows)[0]

		// 别称
		const aliasRes = await db.query('SELECT id, alias FROM fc_alias WHERE "fcId" = $1', [query.id])
		game.aliases = aliasRes.rows.map(r => r.alias)

		// 分类
		const catRes = await db.query(
			`SELECT c.id, c.name FROM fc_category_link cl
			 JOIN fc_category c ON cl."categoryId" = c.id
			 WHERE cl."fcId" = $1`,
			[query.id],
		)
		game.categories = catRes.rows

		// 标签
		const tagRes = await db.query(
			`SELECT t.id, t.name FROM fc_tag_link tl
			 JOIN fc_tag t ON tl."tagId" = t.id
			 WHERE tl."fcId" = $1`,
			[query.id],
		)
		game.tags = tagRes.rows

		// 图片
		const imgRes = await db.query('SELECT id, url, sort FROM fc_img WHERE "fcId" = $1 ORDER BY sort', [query.id])
		game.imgs = imgRes.rows

		return base.respSuccess({ data: game })
	} catch (error) {
		return base.respFailure({ msg: `查询失败: ${error.message}` })
	}
}

/** 游玩计数 +1 */
actions.post.play = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	try {
		await db.query('UPDATE fc SET "playCount" = "playCount" + 1 WHERE id = $1', [body.id])
		return base.respSuccess({ msg: '计数成功' })
	} catch (error) {
		return base.respFailure({ msg: `计数失败: ${error.message}` })
	}
}

/** 分类列表 */
actions.get.category = async () => {
	try {
		const res = await db.query('SELECT id, name, sort FROM fc_category ORDER BY sort DESC, id')
		return base.respSuccess({ data: base.formatDbRows(res.rows) })
	} catch (error) {
		return base.respFailure({ msg: `查询失败: ${error.message}` })
	}
}

/** 标签列表 */
actions.get.tag = async () => {
	try {
		const res = await db.query('SELECT id, name FROM fc_tag ORDER BY id')
		return base.respSuccess({ data: base.formatDbRows(res.rows) })
	} catch (error) {
		return base.respFailure({ msg: `查询失败: ${error.message}` })
	}
}

/** Banner 列表 */
actions.get.banner = async () => {
	try {
		const res = await db.query('SELECT id, "fcId", image, link, sort FROM fc_banner WHERE "deleteTime" IS NULL ORDER BY sort DESC, id')
		return base.respSuccess({ data: base.formatDbRows(res.rows) })
	} catch (error) {
		return base.respFailure({ msg: `查询失败: ${error.message}` })
	}
}

// ============================== 管理后台（需鉴权） ==============================
// TODO: 接入 checkAuth 鉴权守卫，当前先跳过便于调试

/** 新增游戏（一次到位，含文件 URL 与关联表同步） */
actions.post.insert = async ({ body }) => {
	if (!body.name) return base.respFailure({ msg: 'name 参数缺失' })

	try {
		// 验重：同名游戏不允许重复新增
		const dupRes = await db.query('SELECT id FROM fc WHERE name = $1 AND "deleteTime" IS NULL', [body.name])
		if (dupRes.rowCount) return base.respFailure({ msg: `游戏名称「${body.name}」已存在` })

		const now = base.getTime()
		const newId = base.getId()
		await db.query(
			`INSERT INTO fc (id, name, cover, maker, "playerCount", "releaseDate", summary, "romPath", sort, "keymapConfig", "keymapDesc", "insertTime")
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
			[
				newId,
				body.name,
				body.cover || '',
				body.maker || '',
				body.playerCount || '',
				body.releaseDate === '' ? null : body.releaseDate || null,
				body.summary || '',
				body.romPath || '',
				body.sort || 0,
				body.keymapConfig != null ? JSON.stringify(body.keymapConfig) : null,
				body.keymapDesc != null ? JSON.stringify(body.keymapDesc) : null,
				now,
			],
		)

		// 同步别称表
		if (body.aliases?.length) {
			for (const alias of body.aliases) {
				if (alias) await db.query('INSERT INTO fc_alias (id, "fcId", alias) VALUES ($1, $2, $3)', [base.getId(), newId, alias])
			}
		}
		// 同步分类关联
		if (body.categoryIds?.length) {
			for (const cid of body.categoryIds) {
				await db.query('INSERT INTO fc_category_link ("fcId", "categoryId") VALUES ($1, $2)', [newId, cid])
			}
		}
		// 同步标签关联
		if (body.tagIds?.length) {
			for (const tid of body.tagIds) {
				await db.query('INSERT INTO fc_tag_link ("fcId", "tagId") VALUES ($1, $2)', [newId, tid])
			}
		}
		// 同步图片表
		if (body.imgs?.length) {
			for (let i = 0; i < body.imgs.length; i++) {
				const img = body.imgs[i]
				if (img.url) {
					await db.query('INSERT INTO fc_img (id, "fcId", url, sort) VALUES ($1, $2, $3, $4)', [base.getId(), newId, img.url, img.sort ?? i])
				}
			}
		}

		return base.respSuccess({ msg: '新增成功', data: newId })
	} catch (error) {
		return base.respFailure({ msg: `新增失败: ${error.message}` })
	}
}

/** 更新游戏（含文件清理 + 关联表同步） */
actions.post.update = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	const provider = await get_provider()

	try {
		// 读取旧记录，用于文件对比
		const oldRes = await db.query('SELECT * FROM fc WHERE id = $1', [body.id])
		if (!oldRes.rowCount) return base.respFailure({ msg: '游戏不存在' })
		const oldRecord = oldRes.rows[0]

		// 更新主表
		const now = base.getTime()
		await db.query(
			`UPDATE fc SET
				name = $1, cover = $2, maker = $3, "playerCount" = $4, "releaseDate" = $5,
				summary = $6, "romPath" = $7, sort = $8, "keymapConfig" = $9, "keymapDesc" = $10,
				"updateTime" = $11
			 WHERE id = $12`,
			[
				body.name ?? oldRecord.name,
				body.cover ?? oldRecord.cover,
				body.maker ?? oldRecord.maker,
				body.playerCount ?? oldRecord.playerCount,
				body.releaseDate === '' ? null : (body.releaseDate ?? oldRecord.releaseDate),
				body.summary ?? oldRecord.summary,
				body.romPath ?? oldRecord.romPath,
				body.sort ?? oldRecord.sort,
				body.keymapConfig != null ? JSON.stringify(body.keymapConfig) : oldRecord.keymapConfig,
				body.keymapDesc != null ? JSON.stringify(body.keymapDesc) : oldRecord.keymapDesc,
				now,
				body.id,
			],
		)

		// 同步别称表（先删后插）
		if (body.aliases) {
			await db.query('DELETE FROM fc_alias WHERE "fcId" = $1', [body.id])
			for (const alias of body.aliases) {
				if (alias) await db.query('INSERT INTO fc_alias (id, "fcId", alias) VALUES ($1, $2, $3)', [base.getId(), body.id, alias])
			}
		}

		// 同步分类关联（先删后插）
		if (body.categoryIds) {
			await db.query('DELETE FROM fc_category_link WHERE "fcId" = $1', [body.id])
			for (const cid of body.categoryIds) {
				await db.query('INSERT INTO fc_category_link ("fcId", "categoryId") VALUES ($1, $2)', [body.id, cid])
			}
		}

		// 同步标签关联（先删后插）
		if (body.tagIds) {
			await db.query('DELETE FROM fc_tag_link WHERE "fcId" = $1', [body.id])
			for (const tid of body.tagIds) {
				await db.query('INSERT INTO fc_tag_link ("fcId", "tagId") VALUES ($1, $2)', [body.id, tid])
			}
		}

		// 同步图片表（先删后插）
		if (body.imgs) {
			await db.query('DELETE FROM fc_img WHERE "fcId" = $1', [body.id])
			for (let i = 0; i < body.imgs.length; i++) {
				const img = body.imgs[i]
				if (img.url) {
					await db.query('INSERT INTO fc_img (id, "fcId", url, sort) VALUES ($1, $2, $3, $4)', [base.getId(), body.id, img.url, img.sort ?? i])
				}
			}
		}

		// 文件清理：数据库写入成功后，删除被替换的旧文件（先写后删）
		const filesToDelete = []
		if (body.cover && oldRecord.cover && body.cover !== oldRecord.cover) {
			filesToDelete.push(extract_key(oldRecord.cover))
		}
		if (body.romPath && oldRecord.romPath && body.romPath !== oldRecord.romPath) {
			filesToDelete.push(extract_key(oldRecord.romPath))
		}
		// 异步清理旧文件，不阻塞响应
		for (const key of filesToDelete) {
			if (key) {
				try {
					await provider.deleteFile(BUCKET, key)
				} catch {}
			}
		}

		return base.respSuccess({ msg: '更新成功' })
	} catch (error) {
		return base.respFailure({ msg: `更新失败: ${error.message}` })
	}
}

/** 软删除游戏 */
actions.post.delete = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	const ids = body.id.toString().split(',').filter(Boolean)
	try {
		const now = base.getTime()
		for (const id of ids) {
			await db.query('UPDATE fc SET "deleteTime" = $1 WHERE id = $2', [now, id])
		}
		return base.respSuccess({ msg: `已移入回收站 ${ids.length} 条` })
	} catch (error) {
		return base.respFailure({ msg: `删除失败: ${error.message}` })
	}
}

/** 回收站列表 */
actions.get.selectDeleted = async ({ query }) => {
	const page = parseInt(query.page) || 1
	const pageSize = parseInt(query.pageSize) || 24
	const offset = (page - 1) * pageSize
	try {
		const countRes = await db.query('SELECT COUNT(*) FROM fc WHERE "deleteTime" IS NOT NULL')
		const total = parseInt(countRes.rows[0].count)
		const listRes = await db.query(
			`SELECT id, name, cover, maker, "playCount", "deleteTime"
			 FROM fc WHERE "deleteTime" IS NOT NULL
			 ORDER BY "deleteTime" DESC
			 LIMIT $1 OFFSET $2`,
			[pageSize, offset],
		)
		return base.respSuccess({ data: base.formatDbRows(listRes.rows), total })
	} catch (error) {
		return base.respFailure({ msg: `查询失败: ${error.message}` })
	}
}

/** 恢复软删除游戏 */
actions.post.restore = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	try {
		await db.query('UPDATE fc SET "deleteTime" = NULL WHERE id = $1', [body.id])
		return base.respSuccess({ msg: '恢复成功' })
	} catch (error) {
		return base.respFailure({ msg: `恢复失败: ${error.message}` })
	}
}

/** 硬删除（清除文件 + 关联数据 + 主表） */
actions.post.hardDelete = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	const provider = await get_provider()
	try {
		// 清理存储文件：列举 fc/{id}/ 前缀下所有文件
		try {
			const files = await provider.listFiles(BUCKET, { prefix: `fc/${body.id}/`, limit: 1000 })
			if (files?.items) {
				for (const file of files.items) {
					await provider.deleteFile(BUCKET, file.key)
				}
			}
		} catch {}

		// 删除所有关联表数据
		await db.query('DELETE FROM fc_alias WHERE "fcId" = $1', [body.id])
		await db.query('DELETE FROM fc_category_link WHERE "fcId" = $1', [body.id])
		await db.query('DELETE FROM fc_tag_link WHERE "fcId" = $1', [body.id])
		await db.query('DELETE FROM fc_img WHERE "fcId" = $1', [body.id])

		// 删除主表
		await db.query('DELETE FROM fc WHERE id = $1', [body.id])

		return base.respSuccess({ msg: '永久删除成功' })
	} catch (error) {
		return base.respFailure({ msg: `删除失败: ${error.message}` })
	}
}

/** 新增分类 */
actions.post.insertCategory = async ({ body }) => {
	if (!body.name) return base.respFailure({ msg: 'name 参数缺失' })
	try {
		const newId = base.getId()
		await db.query('INSERT INTO fc_category (id, name, sort) VALUES ($1, $2, $3) ', [newId, body.name, body.sort || 0])
		return base.respSuccess({ msg: '新增成功', data: newId })
	} catch (error) {
		return base.respFailure({ msg: `新增失败: ${error.message}` })
	}
}

/** 更新分类 */
actions.post.updateCategory = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	try {
		await db.query('UPDATE fc_category SET name = $1, sort = $2 WHERE id = $3', [body.name, body.sort || 0, body.id])
		return base.respSuccess({ msg: '更新成功' })
	} catch (error) {
		return base.respFailure({ msg: `更新失败: ${error.message}` })
	}
}

/** 删除分类 */
actions.post.deleteCategory = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	try {
		await db.query('DELETE FROM fc_category_link WHERE "categoryId" = $1', [body.id])
		await db.query('DELETE FROM fc_category WHERE id = $1', [body.id])
		return base.respSuccess({ msg: '删除成功' })
	} catch (error) {
		return base.respFailure({ msg: `删除失败: ${error.message}` })
	}
}

/** 新增标签 */
actions.post.insertTag = async ({ body }) => {
	if (!body.name) return base.respFailure({ msg: 'name 参数缺失' })
	try {
		const newId = base.getId()
		await db.query('INSERT INTO fc_tag (id, name) VALUES ($1, $2) ', [newId, body.name])
		return base.respSuccess({ msg: '新增成功', data: newId })
	} catch (error) {
		return base.respFailure({ msg: `新增失败: ${error.message}` })
	}
}

/** 更新标签 */
actions.post.updateTag = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	try {
		await db.query('UPDATE fc_tag SET name = $1 WHERE id = $2', [body.name, body.id])
		return base.respSuccess({ msg: '更新成功' })
	} catch (error) {
		return base.respFailure({ msg: `更新失败: ${error.message}` })
	}
}

/** 删除标签 */
actions.post.deleteTag = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	try {
		await db.query('DELETE FROM fc_tag_link WHERE "tagId" = $1', [body.id])
		await db.query('DELETE FROM fc_tag WHERE id = $1', [body.id])
		return base.respSuccess({ msg: '删除成功' })
	} catch (error) {
		return base.respFailure({ msg: `删除失败: ${error.message}` })
	}
}

/** 新增 Banner */
actions.post.insertBanner = async ({ body }) => {
	try {
		const now = base.getTime()
		const newId = base.getId()
		await db.query('INSERT INTO fc_banner (id, "fcId", image, link, sort, "insertTime") VALUES ($1, $2, $3, $4, $5, $6) ', [
			newId,
			body.fcId || null,
			body.image || '',
			body.link || '',
			body.sort || 0,
			now,
		])
		return base.respSuccess({ msg: '新增成功', data: newId })
	} catch (error) {
		return base.respFailure({ msg: `新增失败: ${error.message}` })
	}
}

/** 更新 Banner */
actions.post.updateBanner = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	const provider = await get_provider()
	try {
		const oldRes = await db.query('SELECT image FROM fc_banner WHERE id = $1', [body.id])
		await db.query('UPDATE fc_banner SET "fcId" = $1, image = $2, link = $3, sort = $4 WHERE id = $5', [
			body.fcId || null,
			body.image || '',
			body.link || '',
			body.sort || 0,
			body.id,
		])
		// 清理旧图片
		if (oldRes.rowCount && body.image && oldRes.rows[0].image && body.image !== oldRes.rows[0].image) {
			const oldKey = extract_key(oldRes.rows[0].image)
			if (oldKey)
				try {
					await provider.deleteFile(BUCKET, oldKey)
				} catch {}
		}
		return base.respSuccess({ msg: '更新成功' })
	} catch (error) {
		return base.respFailure({ msg: `更新失败: ${error.message}` })
	}
}

/** 删除 Banner（含文件清理） */
actions.post.deleteBanner = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	const provider = await get_provider()
	try {
		const oldRes = await db.query('SELECT image FROM fc_banner WHERE id = $1', [body.id])
		await db.query('DELETE FROM fc_banner WHERE id = $1', [body.id])
		// 清理图片文件
		if (oldRes.rowCount && oldRes.rows[0].image) {
			const key = extract_key(oldRes.rows[0].image)
			if (key)
				try {
					await provider.deleteFile(BUCKET, key)
				} catch {}
		}
		return base.respSuccess({ msg: '删除成功' })
	} catch (error) {
		return base.respFailure({ msg: `删除失败: ${error.message}` })
	}
}

// ============================== 厂商管理 ==============================

/** 厂商列表 */
actions.get.maker = async () => {
	try {
		const res = await db.query('SELECT id, name, sort FROM fc_maker ORDER BY sort DESC, id')
		return base.respSuccess({ data: base.formatDbRows(res.rows) })
	} catch (error) {
		return base.respFailure({ msg: `查询失败: ${error.message}` })
	}
}

/** 新增厂商 */
actions.post.insertMaker = async ({ body }) => {
	if (!body.name) return base.respFailure({ msg: 'name 参数缺失' })
	try {
		const newId = base.getId()
		await db.query('INSERT INTO fc_maker (id, name, sort) VALUES ($1, $2, $3) ', [newId, body.name, body.sort || 0])
		return base.respSuccess({ msg: '新增成功', data: newId })
	} catch (error) {
		return base.respFailure({ msg: `新增失败: ${error.message}` })
	}
}

/** 更新厂商 */
actions.post.updateMaker = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	try {
		await db.query('UPDATE fc_maker SET name = $1, sort = $2 WHERE id = $3', [body.name, body.sort || 0, body.id])
		return base.respSuccess({ msg: '更新成功' })
	} catch (error) {
		return base.respFailure({ msg: `更新失败: ${error.message}` })
	}
}

/** 删除厂商 */
actions.post.deleteMaker = async ({ body }) => {
	if (!body.id) return base.respFailure({ msg: 'id 参数缺失' })
	try {
		await db.query('DELETE FROM fc_maker WHERE id = $1', [body.id])
		return base.respSuccess({ msg: '删除成功' })
	} catch (error) {
		return base.respFailure({ msg: `删除失败: ${error.message}` })
	}
}

// ============================== 工具函数 ==============================

/** 从完整 CDN URL 中提取存储 Key（去除域名前缀） */
function extract_key(url) {
	if (!url) return ''
	try {
		return new URL(url).pathname.slice(1) // 去掉开头的 /
	} catch {
		return url // 如果不是合法 URL 则原样返回（可能本身就是 key）
	}
}

// ============================== 路由分发 ==============================

export default async (req, resp) => {
	base.req = req
	base.resp = resp
	const { method, action, query, body } = base.getReqInfo()

	try {
		if (actions[method]?.[action]) {
			return await actions[method][action]({ query, body })
		}
		return base.respFailure({ msg: `未知操作: ${action}` })
	} catch (error) {
		return base.respFailure({ msg: `服务器内部错误: ${error.message}` })
	}
}
