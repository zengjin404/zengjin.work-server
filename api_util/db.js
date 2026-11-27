import dns from 'dns'
import pkg from 'pg'

import base from './base.js'

// 强制 Node.js (v17+) 在 DNS 解析时优先使用 IPv4，避免延迟
dns.setDefaultResultOrder('ipv4first')

const { Pool } = pkg

// PERFORMANCE-03 实测：空闲 30s/5min 后首个 DB 请求多 405–462ms，与连接被回收后重建相符。
// 60s 覆盖常见后台再次操作间隔；更长会占用更多 Supabase 连接（实例数 × DB_POOL_MAX）。
export const DB_IDLE_TIMEOUT_MS = 60000

// 1. 获取当前默认数据库标识 (如 'neon' 或 'supabase')
const DEFAULT_KEY = (process.env.DB || 'neon').toUpperCase()

/**
 * 获取连接池配置
 * @param {string} key - 数据库标识前缀
 */
function getPoolConfig(key) {
	const prefix = `DB_${key}_`
	const host = process.env[`${prefix}HOST`]

	if (!host) {
		console.error(`错误: 缺少数据库 [${key}] 的连接配置。请检查环境变量 ${prefix}HOST 等。`)
		return null
	}

	return {
		host,
		port: process.env[`${prefix}PORT`] || 5432,
		user: process.env[`${prefix}USER`],
		password: process.env[`${prefix}PASSWORD`],
		database: process.env[`${prefix}NAME`] || 'postgres',
		max: Number(process.env.DB_POOL_MAX || 10),
		idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
		connectionTimeoutMillis: 5000,
		keepAlive: true,
		keepAliveInitialDelayMillis: 10000,
		ssl: {
			require: true,
			rejectUnauthorized: false,
		},
	}
}

// 2. 全局连接池注册表（用于单例缓存）
if (!global.dbPools) {
	global.dbPools = {}
}

/**
 * 给连接池挂请求级计时与断线重试（幂等，重复调用不会重复包装）
 *
 * 口径：
 *   - db_ms        pool.query 总耗时（含 acquire + SQL + 结果），并行查询按各自耗时相加；
 *   - acquire_ms   pool.connect 等待/建连耗时（db_ms 的子集，用于定位连接池等待）；
 *   - connect_ms   新建物理连接的耗时近似值（acquire_ms 的子集，仅当池内连接数增加时记录）；
 *   - db_calls / acquire_calls / connect_calls 对应次数。
 *
 * 注意：connect_ms 通过 totalCount 前后变化判断是否新建连接，并发场景下是近似值；
 * 不记录 SQL 文本、参数、连接串、密码或用户信息。
 */
export function instrument_pool(pool, key) {
	if (pool.__zj_instrumented) return pool
	Object.defineProperty(pool, '__zj_instrumented', { value: true })

	// 监听连接池异常（避免空闲连接被服务端断开时触发未捕获异常）
	pool.on('error', err => {
		console.warn(`[DB Pool ${key}] 空闲连接已自动回收:`, err.message)
	})

	const rawConnect = pool.connect.bind(pool)
	pool.connect = function (...args) {
		const perf = base.storage.getStore()?.perf
		if (!perf) return rawConnect(...args)

		const started = performance.now()
		const total_before = pool.totalCount
		let recorded = false
		const record_acquire = () => {
			if (recorded) return
			recorded = true
			const elapsed = performance.now() - started
			perf.acquire_ms = (perf.acquire_ms || 0) + elapsed
			perf.acquire_calls = (perf.acquire_calls || 0) + 1
			if (pool.totalCount > total_before) {
				perf.connect_ms = (perf.connect_ms || 0) + elapsed
				perf.connect_calls = (perf.connect_calls || 0) + 1
			}
		}

		const callback = args[0]
		if (typeof callback === 'function') {
			args[0] = (...callback_args) => {
				record_acquire()
				callback(...callback_args)
			}
			return rawConnect(...args)
		}

		return rawConnect(...args).then(
			client => {
				record_acquire()
				return client
			},
			error => {
				record_acquire()
				throw error
			},
		)
	}

	// 增强 pool.query 自动重试 1 次机制（防止云端 Pooler 短暂切断导致偶发报错）
	// 同时把普通查询耗时累加到请求级 perf（仅日志，不改 SQL / 连接池参数）
	const rawQuery = pool.query.bind(pool)
	pool.query = async function (...args) {
		const perf = base.storage.getStore()?.perf
		const started = perf ? performance.now() : 0
		try {
			try {
				return await rawQuery(...args)
			} catch (err) {
				const isConnDrop =
					err.message &&
					(err.message.includes('Connection terminated') ||
						err.message.includes('connection terminated') ||
						err.message.includes('closed') ||
						err.message.includes('ECONNRESET'))
				if (isConnDrop) {
					console.warn(`[DB Pool ${key}] 底层连接被云端切断，正在自动重建并重试查询...`)
					return await rawQuery(...args)
				}
				throw err
			}
		} finally {
			if (perf) {
				perf.db_ms = (perf.db_ms || 0) + performance.now() - started
				perf.db_calls = (perf.db_calls || 0) + 1
			}
		}
	}

	return pool
}

/**
 * 获取指定的数据库连接池
 * @param {string} name - 数据库标识 (如 'neon', 'supabase')
 * @returns {Pool} pg 连接池实例
 */
export function getPool(name) {
	const key = name.toUpperCase()
	if (!global.dbPools[key]) {
		const config = getPoolConfig(key)
		if (!config) return null
		const pool = new Pool(config)
		instrument_pool(pool, key)
		global.dbPools[key] = pool
		console.log(`已初始化数据库连接池: [${key}]`)
	}
	return global.dbPools[key]
}

// 默认导出：指向 .env 中 DB 变量指定的那个库
const db = getPool(DEFAULT_KEY)

// 打印当前主库状态
if (db) {
	const isProd = process.env.APP_ENV === 'production' || (process.env.NODE_ENV === 'production' && process.env.VERCEL_ENV === 'production')
	console.log(`数据库就绪: [${DEFAULT_KEY}] | 环境: ${isProd ? '生产' : '开发'}`)
}

export default db
