import dns from 'dns'
import pkg from 'pg'

import base from './base.js'

// 强制 Node.js (v17+) 在 DNS 解析时优先使用 IPv4，避免延迟
dns.setDefaultResultOrder('ipv4first')

const { Pool } = pkg

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
		idleTimeoutMillis: 10000, // 10秒空闲主动回收，防止复用已被云端 PgBouncer 掐断的死连接
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

		// 监听连接池异常（避免空闲连接被服务端断开时触发未捕获异常）
		pool.on('error', err => {
			console.warn(`[DB Pool ${key}] 空闲连接已自动回收:`, err.message)
		})

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
					perf.db_ms += performance.now() - started
					perf.db_calls++
				}
			}
		}

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
