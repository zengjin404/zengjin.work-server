import dayjs from 'dayjs'

import { checkAuth } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import db from '#api_util/db.js'

const actions = {
	get: {},
	post: {},
}

// 缓存数据库表存在状态，避免重复检查
let hasCheckedDb = false

/**
 * 自动检测并初始化数据库表
 */
export async function ensure_tables_exist() {
	if (hasCheckedDb) return
	let client
	try {
		const checkSubSql = `SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'sub');`
		const subCheckRes = await db.query(checkSubSql)
		const subExists = subCheckRes.rows[0].exists

		if (!subExists) {
			console.log('检测到订阅周期管家数据表不存在，正在初始化数据库...')

			// 事务必须固定在同一连接上；连接池的 db.query 每次可能取到不同连接
			client = await db.connect()
			await client.query('BEGIN')

			const createSubTableSql = `
				CREATE TABLE IF NOT EXISTS sub (
					id              VARCHAR(20) PRIMARY KEY,
					user_id         VARCHAR(20) NOT NULL,
					name            VARCHAR(100) NOT NULL,
					period_type     VARCHAR(20) NOT NULL,
					period_value    INT NOT NULL,
					start_time      DATE NOT NULL,
					end_time        DATE NOT NULL,
					remind_time     DATE NOT NULL,
					warn_time       DATE NOT NULL,
					category        VARCHAR(50) DEFAULT '',
					tags            VARCHAR(200) DEFAULT '',
					price           NUMERIC(10, 2) DEFAULT 0,
					currency        VARCHAR(10) DEFAULT 'CNY',
					url             VARCHAR(255) DEFAULT '',
					remark          TEXT DEFAULT '',
					"insertTime"    TIMESTAMPTZ DEFAULT NOW(),
					"updateTime"    TIMESTAMPTZ,
					"deleteTime"    TIMESTAMPTZ
				);
			`
			await client.query(createSubTableSql)

			const createHistoryTableSql = `
				CREATE TABLE IF NOT EXISTS sub_history (
					id              VARCHAR(20) PRIMARY KEY,
					sub_id          VARCHAR(20) NOT NULL REFERENCES sub(id),
					user_id         VARCHAR(20) NOT NULL,
					action_type     VARCHAR(20) NOT NULL,
					change_desc     TEXT DEFAULT '',
					"insertTime"    TIMESTAMPTZ DEFAULT NOW()
				);
			`
			await client.query(createHistoryTableSql)

			const createIndexSql1 = `CREATE INDEX IF NOT EXISTS idx_sub_user_deleteTime ON sub (user_id, "deleteTime");`
			const createIndexSql2 = `CREATE INDEX IF NOT EXISTS idx_sub_history_subId ON sub_history (sub_id);`
			await client.query(createIndexSql1)
			await client.query(createIndexSql2)

			await client.query('COMMIT')
			console.log('订阅周期管家数据库初始化成功！')
		}
		hasCheckedDb = true
	} catch (error) {
		console.error('自动初始化数据库失败:', error)
		try {
			await client?.query('ROLLBACK')
		} catch (rbError) {}
		// 迁移执行器依赖异常判断失败，不能吞掉错误后误记版本
		throw error
	} finally {
		client?.release()
	}
}

/**
 * 查询订阅列表 (动作对齐 SQL 动词 select)
 */
actions.get.select = async options => {
	const { query, userId } = options
	const keyword = query.name || ''
	const category = query.category || ''
	const status = query.status || ''
	const page = Number(query.page || 1)
	const size = Number(query.size || 10)
	const orderBy = query.orderBy || 'emergency' // emergency (默认), start_time, end_time, price, name
	const order = query.order || 'asc' // asc, desc

	let sql = `SELECT * FROM sub WHERE user_id = $1 AND "deleteTime" IS NULL`
	const binds = [userId]

	if (keyword) {
		binds.push(`%${keyword}%`)
		sql += ` AND name ILIKE $${binds.length}`
	}
	if (category) {
		binds.push(category)
		sql += ` AND category = $${binds.length}`
	}

	try {
		const res = await db.query(sql, binds)
		const rows = base.formatDbRows(res.rows)

		// 统一使用北京时间作为当天日期对比基准
		const todayStr = base.getTime().substring(0, 10)
		const today = dayjs(todayStr)

		// 状态计算与指标填充
		let list = rows.map(item => {
			const start = dayjs(item.start_time).format('YYYY-MM-DD')
			const end = dayjs(item.end_time).format('YYYY-MM-DD')
			const warn = dayjs(item.warn_time).format('YYYY-MM-DD')
			const remind = dayjs(item.remind_time).format('YYYY-MM-DD')

			let statusVal = 'normal'
			let leftDays = dayjs(end).diff(today, 'day')

			if (todayStr > end) {
				statusVal = 'expired'
			} else if (todayStr >= warn) {
				statusVal = 'warn'
			} else if (todayStr >= remind) {
				statusVal = 'remind'
			}

			const startDay = dayjs(start)
			const endDay = dayjs(end)
			const totalDays = endDay.diff(startDay, 'day') || 1
			const usedDays = today.diff(startDay, 'day')
			const progress = Math.max(0, Math.min(1, usedDays / totalDays))

			return {
				...item,
				status: statusVal,
				leftDays,
				progress,
			}
		})

		// 内存状态筛选
		if (status) {
			list = list.filter(item => item.status === status)
		}

		// 排序规则辅助函数：提取中英文拼音首字母排序键，支持 A-Z 统一混排
		const getSortKey = str => {
			if (!str) return ''
			const s = String(str).trim()
			const ch = s[0]
			if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase() + s.slice(1)
			if (/[0-9]/.test(ch)) return ' ' + ch + s.slice(1)

			// 拼音首字母区间边界 (通过 zh-Hans-CN 拼音对照归入 A-Z)
			const initials = 'ABCDEFGHJKLMNOPQRSTWXYZ'
			const boundaries = [
				'芭',
				'擦',
				'搭',
				'蛾',
				'发',
				'噶',
				'哈',
				'击',
				'喀',
				'垃',
				'妈',
				'拿',
				'哦',
				'啪',
				'期',
				'然',
				'撒',
				'塌',
				'挖',
				'昔',
				'压',
				'匝',
			]
			for (let i = boundaries.length - 1; i >= 0; i--) {
				if (ch.localeCompare(boundaries[i], 'zh-Hans-CN') >= 0) {
					return initials[i + 1] + s
				}
			}
			return 'A' + s
		}

		// 排序规则：每种排序项内嵌其最自然的业务方向
		const statusPriority = { expired: 4, warn: 3, remind: 2, normal: 1 }
		list.sort((a, b) => {
			if (orderBy === 'progress') {
				// 1. 按使用进度: 进度轴越满越靠前 (降序)，进度相同按剩余天数少的在前
				const diff = b.progress - a.progress
				return diff !== 0 ? diff : a.leftDays - b.leftDays
			} else if (orderBy === 'end_time' || orderBy === 'left_days') {
				// 2. 按剩余天数/到期日期: 越早到期/剩余天数越少越靠前 (升序)
				return a.leftDays - b.leftDays
			} else if (orderBy === 'price') {
				// 3. 按订阅费用: 费用越贵越靠前 (降序)
				return Number(b.price) - Number(a.price)
			} else if (orderBy === 'name') {
				// 4. 按服务名称: 中英文拼音首字母统一混排 A-Z (升序)
				return getSortKey(a.name).localeCompare(getSortKey(b.name), 'zh-Hans-CN', { numeric: true })
			} else if (orderBy === 'emergency') {
				const priA = statusPriority[a.status] || 0
				const priB = statusPriority[b.status] || 0
				if (priA !== priB) {
					return priB - priA
				}
				return a.leftDays - b.leftDays
			}
			return 0
		})

		// 计算年化订阅费用与统计概况 (各项订阅折算成年度费用整体相加)
		const stats = {
			totalAnnualCost: 0,
			totalMonthlyCost: 0,
			byCurrency: {},
			totalCount: rows.length,
			activeCount: 0,
			remindCount: 0,
			warnCount: 0,
			expiredCount: 0,
		}

		rows.forEach(item => {
			const price = Number(item.price) || 0
			const val = Number(item.period_value) || 1
			const type = item.period_type
			const cur = item.currency || 'CNY'

			const statusItem = list.find(l => l.id === item.id)
			const itemStatus = statusItem ? statusItem.status : 'normal'
			if (itemStatus === 'expired') stats.expiredCount++
			else if (itemStatus === 'warn') stats.warnCount++
			else if (itemStatus === 'remind') stats.remindCount++
			else stats.activeCount++

			if (price > 0) {
				let annual = 0
				if (type === 'day') annual = (price * 365) / val
				else if (type === 'week') annual = (price * 52) / val
				else if (type === 'month') annual = (price * 12) / val
				else if (type === 'quarter') annual = (price * 4) / val
				else if (type === 'year') annual = price / val
				else if (type === 'custom') {
					const start = dayjs(item.start_time)
					const end = dayjs(item.end_time)
					const days = Math.abs(end.diff(start, 'day')) || 1
					annual = (price * 365) / days
				}
				stats.byCurrency[cur] = (stats.byCurrency[cur] || 0) + annual
			}
		})

		stats.totalAnnualCost = stats.byCurrency['CNY'] || Object.values(stats.byCurrency)[0] || 0
		stats.totalMonthlyCost = stats.totalAnnualCost / 12
		const total = list.length
		const offset = (page - 1) * size
		const pagedData = list.slice(offset, offset + size)

		return base.respSuccess({
			msg: '查询成功',
			stats,
			total,
			data: pagedData,
		})
	} catch (error) {
		return base.respFailure({ msg: `查询失败：${error.message}` })
	}
}

/**
 * 订阅详情 (动作对齐 SQL 动词 select)
 */
actions.get.detail = async options => {
	const { query, userId } = options
	if (!query.id) {
		return base.respFailure({ msg: 'id 参数缺失' })
	}
	try {
		const res = await db.query(`SELECT * FROM sub WHERE id = $1 AND user_id = $2 AND "deleteTime" IS NULL`, [query.id, userId])
		if (res.rowCount) {
			return base.respSuccess({
				data: base.formatDbRows(res.rows)[0],
			})
		}
		return base.respFailure({ msg: '订阅不存在' })
	} catch (error) {
		return base.respFailure({ msg: `获取详情失败：${error.message}` })
	}
}

/**
 * 新增订阅 (动作对齐 SQL 动词 insert)
 */
actions.post.insert = async options => {
	const { body, userId } = options
	const valids = 'name,period_type,period_value,start_time,end_time,remind_time,warn_time'.split(',')
	let checkValidsRes = base.checkValids(body, valids)
	if (checkValidsRes) {
		return base.respFailure({ msg: `必要字段缺失：${checkValidsRes}` })
	}

	const id = base.getId()
	const fields =
		'id,user_id,name,period_type,period_value,start_time,end_time,remind_time,warn_time,category,tags,price,currency,url,remark,"insertTime"'.split(',')

	body.id = id
	body.user_id = userId
	body.insertTime = base.getTime()

	const updates = []
	const binds = []
	fields.forEach(field => {
		const key = field.replace(/"/g, '')
		updates.push(field)
		binds.push(base.formatDbBind(body[key]))
	})

	try {
		await db.query('BEGIN')

		const insertSubSql = `INSERT INTO sub (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`
		await db.query(insertSubSql, binds)

		// 变更历史记录
		const historyId = base.getId()
		const insertHistorySql = `INSERT INTO sub_history (id, sub_id, user_id, action_type, change_desc, "insertTime") VALUES ($1, $2, $3, $4, $5, $6)`
		await db.query(insertHistorySql, [historyId, id, userId, 'insert', '创建订阅周期记录', base.getTime()])

		await db.query('COMMIT')
		return base.respSuccess({ msg: '新增成功', data: id })
	} catch (error) {
		await db.query('ROLLBACK')
		return base.respFailure({ msg: `新增失败：${error.message}` })
	}
}

/**
 * 编辑修改订阅 (动作对齐 SQL 动词 update)
 */
actions.post.update = async options => {
	const { body, userId } = options
	if (!body.id) {
		return base.respFailure({ msg: 'id 参数缺失' })
	}

	try {
		// 查询原记录做变更审计
		const oldRes = await db.query(`SELECT * FROM sub WHERE id = $1 AND user_id = $2 AND "deleteTime" IS NULL`, [body.id, userId])
		if (!oldRes.rowCount) {
			return base.respFailure({ msg: '订阅不存在' })
		}
		const oldRow = base.formatDbRows(oldRes.rows)[0]

		const fields = 'name,period_type,period_value,start_time,end_time,remind_time,warn_time,category,tags,price,currency,url,remark'.split(',')
		const updates = []
		const binds = []
		const changes = []

		fields.forEach(field => {
			if (body[field] !== undefined) {
				let oldVal = oldRow[field]
				let newVal = body[field]

				if (['start_time', 'end_time', 'remind_time', 'warn_time'].includes(field)) {
					oldVal = oldVal ? dayjs(oldVal).format('YYYY-MM-DD') : ''
					newVal = newVal ? dayjs(newVal).format('YYYY-MM-DD') : ''
				}

				if (String(oldVal) !== String(newVal)) {
					updates.push(`"${field}" = $${updates.length + 1}`)
					binds.push(base.formatDbBind(body[field]))

					const fieldZhNames = {
						name: '服务名称',
						period_type: '周期类型',
						period_value: '周期值',
						start_time: '开始日期',
						end_time: '结束日期',
						remind_time: '提醒日期',
						warn_time: '告警日期',
						category: '分类',
						tags: '标签',
						price: '价格',
						currency: '币种',
						url: '官网链接',
						remark: '备注',
					}
					changes.push(`${fieldZhNames[field] || field} 由 "${oldVal}" 变更为 "${newVal}"`)
				}
			}
		})

		if (updates.length === 0) {
			return base.respSuccess({ msg: '无数据变更', data: body.id })
		}

		// 判定是否续期：结束时间延后即算作续订动作
		let isRenew = false
		if (body.end_time) {
			const oldEnd = dayjs(oldRow.end_time).format('YYYY-MM-DD')
			const newEnd = dayjs(body.end_time).format('YYYY-MM-DD')
			if (dayjs(newEnd).isAfter(dayjs(oldEnd))) {
				isRenew = true
			}
		}

		const updateTime = base.getTime()
		updates.push(`"updateTime" = $${updates.length + 1}`)
		binds.push(updateTime)

		await db.query('BEGIN')

		const updateSql = `UPDATE sub SET ${updates.join(', ')} WHERE id = $${updates.length + 1} AND user_id = $${updates.length + 2}`
		await db.query(updateSql, [...binds, body.id, userId])

		// 写入审计日志
		const historyId = base.getId()
		const actionType = isRenew ? 'renew' : 'update'
		const changeDesc = (isRenew ? '【续期成功】' : '【信息变更】') + changes.join('；')

		const insertHistorySql = `INSERT INTO sub_history (id, sub_id, user_id, action_type, change_desc, "insertTime") VALUES ($1, $2, $3, $4, $5, $6)`
		await db.query(insertHistorySql, [historyId, body.id, userId, actionType, changeDesc, updateTime])

		await db.query('COMMIT')
		return base.respSuccess({ msg: '编辑成功', data: body.id })
	} catch (error) {
		await db.query('ROLLBACK')
		return base.respFailure({ msg: `编辑失败：${error.message}` })
	}
}

/**
 * 软删除订阅 (动作对齐 SQL 动词 delete)
 */
actions.post.delete = async options => {
	const { body, userId } = options
	if (!body.id) {
		return base.respFailure({ msg: 'id 参数缺失' })
	}
	const deleteTime = base.getTime()
	try {
		await db.query('BEGIN')

		const res = await db.query(`UPDATE sub SET "deleteTime" = $1 WHERE id = $2 AND user_id = $3 AND "deleteTime" IS NULL`, [deleteTime, body.id, userId])
		if (!res.rowCount) {
			await db.query('ROLLBACK')
			return base.respFailure({ msg: '订阅不存在或已被删除' })
		}

		const historyId = base.getId()
		const insertHistorySql = `INSERT INTO sub_history (id, sub_id, user_id, action_type, change_desc, "insertTime") VALUES ($1, $2, $3, $4, $5, $6)`
		await db.query(insertHistorySql, [historyId, body.id, userId, 'delete', '注销/删除订阅记录', deleteTime])

		await db.query('COMMIT')
		return base.respSuccess({ msg: '删除成功', data: body.id })
	} catch (error) {
		await db.query('ROLLBACK')
		return base.respFailure({ msg: `删除失败：${error.message}` })
	}
}

/**
 * 查询变更历史 (动作对齐 SQL 动词 select)
 */
actions.get.history = async options => {
	const { query, userId } = options
	if (!query.sub_id) {
		return base.respFailure({ msg: 'sub_id 参数缺失' })
	}
	try {
		// 所属权校验
		const checkRes = await db.query(`SELECT 1 FROM sub WHERE id = $1 AND user_id = $2`, [query.sub_id, userId])
		if (!checkRes.rowCount) {
			return base.respFailure({ msg: '无权访问该订阅历史' })
		}

		const res = await db.query(`SELECT * FROM sub_history WHERE sub_id = $1 AND user_id = $2 ORDER BY "insertTime" DESC`, [query.sub_id, userId])
		return base.respSuccess({
			data: base.formatDbRows(res.rows),
		})
	} catch (error) {
		return base.respFailure({ msg: `查询历史失败：${error.message}` })
	}
}

export default async (req, resp) => {
	base.req = req
	base.resp = resp

	const { method, action, query, body } = base.getReqInfo()

	// 身份校验拦截
	if (!(await checkAuth(req, resp))) {
		return
	}
	const userId = req.user.userId

	// 自动运行数据库建表检测

	try {
		if (actions[method]?.[action]) {
			return await actions[method][action]({ query, body, userId })
		} else {
			return base.respFailure({ msg: '请求的方法无效' })
		}
	} catch (error) {
		return base.respFailure({ msg: `服务端出错：${error.message}` })
	}
}
