import base from './base.js'
import db from './db.js'

// Postgres 保留关键字清单，用作列名时必须转义为 "col" 规避语法错误（如 desc / user / order 等）
const PG_RESERVED = new Set([
	'all',
	'any',
	'asc',
	'case',
	'check',
	'column',
	'constraint',
	'default',
	'desc',
	'else',
	'end',
	'foreign',
	'from',
	'group',
	'key',
	'limit',
	'offset',
	'order',
	'primary',
	'select',
	'table',
	'then',
	'user',
	'when',
	'where',
])

function quoteCol(field) {
	if (!field) return field
	const raw = String(field).trim()
	return PG_RESERVED.has(raw.toLowerCase()) || raw.startsWith('"') ? `"${raw.replace(/"/g, '')}"` : raw
}

const crud = {
	get: {},
	post: {},
}

/**
 * 组装 ORDER BY 子句
 *
 * 默认按主键倒序（入库倒序）。调用方可用 order 覆盖：
 *   order: [{ field: 'sort', dir: 'asc' }, { field: 'name', dir: 'asc' }]
 * 为防注入，字段必须出现在该模块的 fields 白名单中，方向只接受 asc / desc，其余项静默忽略。
 */
function build_order(table, fields, order) {
	const parts = []
	for (const item of Array.isArray(order) ? order : []) {
		if (!item || !fields.includes(item.field)) continue
		const dir = String(item.dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc'
		parts.push(`${table}.${quoteCol(item.field)} ${dir}`)
	}
	return parts.length ? parts.join(', ') : `${table}.id desc`
}

// 查询
crud.get.select = async options => {
	const { table, fields, valids, joins, query, body, order } = options

	const page = Number(query.page || query.current) || 0
	const size = Math.min(Number(query.size || query.pageSize) || 0, 100000)
	if (page <= 0 || size <= 0) {
		return base.respFailure({
			msg: '页码参数无效',
		})
	}

	const wheres = []
	const binds = []
	let bindIndex = 1
	fields.forEach((field, i) => {
		let val = base.formatDbBind(query[field])
		if (val) {
			const col = quoteCol(field)
			wheres.push(`${table}.${col} ilike $${bindIndex}`)
			binds.push(`%${base.formatDbBind(query[field])}%`)
			bindIndex++
		}
	})
	const whereStr = wheres.length ? `where ${wheres.join(' and ')}` : ''

	let fieldStr = `${table}.*`
	let joinStr = ''
	if (joins?.length) {
		joins.forEach((join, i) => {
			const tb = join.table.split(' ').at(-1)
			fieldStr += join.fields.map(field => `, ${tb}.${quoteCol(field)} as ${tb}_${field}`).join('')
			joinStr += `left join ${join.table} on ${table}.${join.on} `
		})
	}

	try {
		const offset = (page - 1) * size

		const orderStr = build_order(table, fields, order)
		const [res, res2] = await Promise.all([
			db.query(`select ${fieldStr} from ${table} ${joinStr} ${whereStr} order by ${orderStr} limit ${size} offset ${offset}`, binds),
			db.query(`select count(*) as total from ${table} ${whereStr}`, binds),
		])

		let total = Number(res2?.rows?.[0]?.total) || 0
		if (res?.rowCount) {
			return base.respSuccess({
				msg: '查询成功',
				total: total,
				data: base.formatDbRows(res.rows),
			})
		}
		return base.respSuccess({
			msg: '查询成功',
			total: total,
			data: [],
		})
	} catch (error) {
		return base.respFailure({
			msg: `查询失败：${error.message}`,
			total: 0,
			data: [],
		})
	}
}

// 详情
crud.get.detail = async options => {
	const { table, fields, valids, joins, query, body } = options

	if (!query.id) {
		return base.respFailure({
			msg: 'id 参数缺失',
		})
	}

	let fieldStr = `${table}.*`
	let joinStr = ''
	if (joins?.length) {
		joins.forEach((join, i) => {
			const tb = join.table.split(' ').at(-1)
			fieldStr += join.fields.map(field => `, ${tb}.${quoteCol(field)} ${tb}_${field}`).join('')
			joinStr += `left join ${join.table} on ${table}.${join.on} `
		})
	}

	try {
		const res = await db.query(`select ${fieldStr} from ${table} ${joinStr} where ${table}.id = $1`, [query.id])
		if (res?.rowCount) {
			return base.respSuccess({
				msg: '查询成功',
				data: base.formatDbRows(res.rows)[0],
			})
		}
		return base.respSuccess({
			msg: '查询成功',
			data: {},
		})
	} catch (error) {
		return base.respFailure({
			msg: `查询失败：${error.message}`,
			data: {},
		})
	}
}

// 新增
crud.post.insert = async options => {
	const { table, fields, valids, joins, query, body, extraMsg = '' } = options

	body.id = base.getId()
	body.createtime = base.getTime()

	let checkValidsRes = base.checkValids(body, valids)
	if (checkValidsRes) {
		return base.respFailure({
			msg: `必要字段缺失：${checkValidsRes}`,
		})
	}

	// 仅绑定 body 实际提供的字段，未提供的列交给数据库 DEFAULT / NULL 兜底。
	// 不能把 undefined 绑成 ''——非文本列会直接报错，例如 base_app.updatetime (TIMESTAMPTZ)
	// 报 invalid input syntax for type timestamp with time zone: ""
	const cols = []
	const binds = []
	fields.forEach(field => {
		if (body[field] == null) return
		cols.push(quoteCol(field))
		binds.push(base.formatDbBind(body[field]))
	})

	try {
		const res = await db.query(`insert into ${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning id`, binds)
		if (res?.rowCount) {
			return base.respSuccess({
				msg: extraMsg ? `新增成功（${extraMsg}）` : '新增成功',
				data: body.id,
			})
		}
		throw new Error('未知错误')
	} catch (error) {
		return base.respFailure({
			msg: `新增失败：${error.message}`,
		})
	}
}

// 修改
crud.post.update = async options => {
	const { table, fields, valids, joins, query, body, extraMsg = '' } = options

	if (!body.id) {
		return base.respFailure({
			msg: 'id 参数缺失',
		})
	}
	let ids = body.id.split(',')

	delete body.id
	body.updatetime = base.getTime()

	const updates = []
	const binds = []
	fields.forEach(field => {
		if (body[field] != null) {
			const col = quoteCol(field)
			updates.push(`${col} = $${updates.length + 1}`)
			binds.push(base.formatDbBind(body[field]))
		}
	})
	if (!updates.length) {
		return base.respFailure({
			msg: '字段无效',
		})
	}

	try {
		const successIds = []
		for (const id of ids) {
			const res = await db.query(
				`update ${table} set ${updates.map((update, i) => update.replace('?', `$${i + 1}`)).join(', ')} where id = $${updates.length + 1}`,
				[...binds, id],
			)
			if (res?.rowCount) {
				successIds.push(id)
			}
		}
		const suffix = extraMsg ? `（${extraMsg}）` : ''
		if (successIds.length == ids.length) {
			return base.respSuccess({
				msg: `编辑成功${suffix}`,
				data: successIds.join(','),
			})
		}
		if (successIds.length) {
			return base.respSuccess({
				msg: `编辑成功 ${successIds.length} 条，失败 ${ids.length - successIds.length} 条${suffix}`,
				data: successIds.join(','),
			})
		}
		throw new Error('未知错误')
	} catch (error) {
		return base.respFailure({
			msg: `编辑失败：${error.message}`,
		})
	}
}

// 删除
crud.post.delete = async options => {
	const { table, fields, valids, joins, query, body } = options

	if (!body.id) {
		return base.respFailure({
			msg: 'id 参数缺失',
		})
	}
	let ids = body.id.split(',')

	try {
		const successIds = []
		for (const id of ids) {
			const res = await db.query(`delete from ${table} where id = $1`, [id])

			// sql执行完成(包括找不到数据)即算成功
			if (res?.rowCount != null) {
				successIds.push(id)
			}
		}
		if (successIds.length == ids.length) {
			return base.respSuccess({
				msg: `删除成功`,
				data: successIds.join(','),
			})
		}
		if (successIds.length) {
			return base.respSuccess({
				msg: `删除成功 ${successIds.length} 条，失败 ${ids.length - successIds.length} 条`,
				data: successIds.join(','),
			})
		}
		throw new Error('未知错误')
	} catch (error) {
		return base.respFailure({
			msg: `删除失败：${error.message}`,
		})
	}
}

export default crud
