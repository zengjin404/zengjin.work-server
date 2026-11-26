import base from '#api_util/base.js'
import { is_cron_authorized } from '#api_util/cron_auth.js'
import curd from '#api_util/crud.js'
import { getPool } from '#api_util/db.js'

const actions = { ...curd }

const fields = 'id,target,createtime'.split(',')
const valids = []
const joins = {}

actions.get.supabase = async options => {
	const { table, fields, valids, joins, query, body, action } = options

	// 获取指定的 supabase 连接池，无论当前主库是什么
	const db = getPool('supabase')
	if (!db) {
		return base.respFailure({ msg: 'supabase数据库配置未找到' })
	}

	query.id = base.getId()
	query.createtime = base.getTime()
	query.target = action

	const binds = []
	fields.forEach((field, i) => {
		binds.push(base.formatDbBind(query[field]))
	})

	try {
		// 插入记录
		const resInsert = await db.query(
			`insert into ${table} (${fields.join(',')}) values (${fields.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
			binds,
		)
		if (!resInsert?.rowCount) {
			throw new Error('插入返回为空')
		}

		// 查询该条记录以确认写入成功
		const resSelect = await db.query(`select * from ${table} where id = $1`, [query.id])
		if (!resSelect?.rowCount) {
			throw new Error('查询返回为空')
		}

		return base.respSuccess({
			msg: 'supabase数据库保活执行成功',
			data: base.formatDbRows(resSelect.rows)[0],
		})
	} catch (error) {
		return base.respFailure({
			msg: `supabase数据库保活执行失败：${error.message}`,
		})
	}
}

export default async (req, resp) => {
	base.req = req
	base.resp = resp

	// 默认保持匿名可执行（兼容现有 Vercel Cron）。
	// EdgeOne 上如需收紧，设置 KEEPALIVE_REQUIRE_AUTH=1，并通过 x-cron-secret/payload 传密钥。
	if (process.env.KEEPALIVE_REQUIRE_AUTH === '1' && !is_cron_authorized(req).ok) {
		return resp.status(401).json({ code: -1, msg: '未授权：保活任务需要有效 CRON_SECRET' })
	}

	const { table, method, action, query, body } = base.getReqInfo()

	try {
		if (actions[method]?.[action]) {
			return await actions[method][action]({ table, fields, valids, joins, query, body, action })
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
