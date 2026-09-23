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

// 查询
crud.get.select = async options => {
	const { table, fields, valids, joins, query, body } = options

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

		const [res, res2] = await Promise.all([
			db.query(`select ${fieldStr} from ${table} ${joinStr} ${whereStr} order by ${table}.id desc limit ${size} offset ${offset}`, binds),
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
	const { table, fields, valids, joins, query, body } = options

	body.id = base.getId()
	body.createtime = base.getTime()

	let checkValidsRes = base.checkValids(body, valids)
	if (checkValidsRes) {
		return base.respFailure({
			msg: `必要字段缺失：${checkValidsRes}`,
		})
	}

	const binds = []
	fields.forEach((field, i) => {
		binds.push(base.formatDbBind(body[field]))
	})

	try {
		const quotedCols = fields.map(quoteCol).join(',')
		const res = await db.query(`insert into ${table} (${quotedCols}) values (${fields.map((_, i) => `$${i + 1}`).join(',')}) returning id`, binds)
		if (res?.rowCount) {
			return base.respSuccess({
				msg: '新增成功',
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
	const { table, fields, valids, joins, query, body } = options

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
		if (successIds.length == ids.length) {
			return base.respSuccess({
				msg: `编辑成功`,
				data: successIds.join(','),
			})
		}
		if (successIds.length) {
			return base.respSuccess({
				msg: `编辑成功 ${successIds.length} 条，失败 ${ids.length - successIds.length} 条`,
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
