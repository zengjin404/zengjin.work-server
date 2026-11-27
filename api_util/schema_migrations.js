/**
 * 数据库结构版本管理（部署期执行，不进入普通 API 请求路径）
 *
 * 背景：
 *   历史上各业务模块在「首个请求」里执行 ensure / CREATE TABLE / ALTER TABLE。
 *   EdgeOne 函数实例会冻结/回收，模块级初始化标记随之丢失，导致每次冷启动都可能
 *   重跑 20+ 次 DDL，把首请求耗时从百毫秒级拉到秒级。
 *
 * 本模块把现有 ensure 逻辑原样收敛为「版本化迁移」：
 *   - 只由 scripts/migrate-db.mjs 显式执行，API 请求不再触发 DDL；
 *   - schema_migrations 记录已执行版本，重复执行为 no-op；
 *   - 执行前取 PostgreSQL 会话级咨询锁，避免多实例并发迁移；
 *   - 迁移抛错时不写入版本，下次可安全重放（所有 ensure 均幂等）。
 *
 * 注意：这里不新增业务表结构，只复用各模块已有的 ensure 函数，保持现有行为不变。
 */

// 咨询锁 key：字符串经 hashtext 转 int4，避免手写魔法数字
export const SCHEMA_LOCK_KEY = 'zengjin.work:schema_migrations'

const MIGRATIONS_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS schema_migrations (
		version     VARCHAR(64) PRIMARY KEY,
		description TEXT NOT NULL DEFAULT '',
		applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)
`

/**
 * 基线迁移清单
 *
 * 版本号按「日期-序号」排列，执行顺序即数组顺序。
 * 每个 run() 内部再动态 import，保证 --check 模式不加载业务模块依赖。
 */
export const MIGRATIONS = [
	{
		version: '2026-11-27-01-base-user-avatar',
		description: 'base_user 补充 avatar 列并修正历史桶域名',
		async run() {
			const { ensure_avatarColumn } = await import('../api/_base/user.js')
			await ensure_avatarColumn()
		},
	},
	{
		version: '2026-11-27-02-base-app',
		description: 'base_app 建表、索引、封面列、分类与排序迁移、种子补齐',
		async run() {
			const { ensure_dbInitialized_async } = await import('../api/_base/app.js')
			await ensure_dbInitialized_async()
		},
	},
	{
		version: '2026-11-27-03-base-ai',
		description: 'base_ai / base_ai_provider 建表与存量服务商抽离迁移',
		async run() {
			const { ensure_dbInitialized_async } = await import('../api/_base/ai.js')
			await ensure_dbInitialized_async()
		},
	},
	{
		version: '2026-11-27-04-cards',
		description: '图卡分类 / 条目 / 素材表、索引与种子',
		async run() {
			const { ensure_dbInitialized_async } = await import('../api/_cards.js')
			await ensure_dbInitialized_async()
		},
	},
	{
		version: '2026-11-27-05-dphxb',
		description: 'dphxb 对局记录表、渐进字段与索引',
		async run() {
			const { ensure_dbInitialized_async } = await import('../api/_dphxb.js')
			await ensure_dbInitialized_async()
		},
	},
	{
		version: '2026-11-27-06-fa',
		description: 'fa_user_config 表与唯一索引',
		async run() {
			const { ensure_dbInitialized_async } = await import('../api/_fa.js')
			await ensure_dbInitialized_async()
		},
	},
	{
		version: '2026-11-27-07-jndv',
		description: 'jndv_seat / jndv_unlock 表、索引与时间列类型迁移',
		async run() {
			const { ensure_dbInitialized_async } = await import('../api/_jndv.js')
			await ensure_dbInitialized_async()
		},
	},
	{
		version: '2026-11-27-08-music',
		description: 'music 表结构初始化',
		async run() {
			const { init_table_async } = await import('../api/_music.js')
			await init_table_async()
		},
	},
	{
		version: '2026-11-27-09-sub',
		description: 'sub / sub_history 表与索引',
		async run() {
			const { ensure_tables_exist } = await import('../api/_sub.js')
			await ensure_tables_exist()
		},
	},
	{
		version: '2026-11-27-10-base-seal',
		description: 'base_seal_export_log 表与唯一索引',
		async run() {
			const { ensure_dbInitialized_async } = await import('../api/_base/seal.js')
			await ensure_dbInitialized_async()
		},
	},
	{
		version: '2026-11-27-11-admin-notification',
		description: '全局消息通知与设置表、索引',
		async run() {
			const { ensure_notification_db_async } = await import('./notification_store.js')
			await ensure_notification_db_async()
		},
	},
]

/** 创建版本表（仅 --apply 路径调用；--check 必须保持只读） */
export async function ensure_migrations_table(client) {
	await client.query(MIGRATIONS_TABLE_SQL)
}

/**
 * 读取已执行版本；版本表不存在时视为空集（兼容首次部署/只读检查）
 * @returns {Promise<Set<string>>}
 */
export async function get_applied_versions(client) {
	try {
		const result = await client.query('SELECT version FROM schema_migrations ORDER BY version')
		return new Set(result.rows.map(row => row.version))
	} catch (error) {
		if (error?.code === '42P01') return new Set() // undefined_table
		throw error
	}
}

/**
 * 执行迁移
 *
 * @param {Object} options
 * @param {import('pg').PoolClient} options.client 同一会话的连接（咨询锁需要）
 * @param {Array} [options.migrations] 迁移清单，默认 MIGRATIONS
 * @param {boolean} [options.checkOnly] 只读检查，不取锁、不建表、不执行
 * @param {(message: string) => void} [options.log] 日志输出
 * @returns {Promise<{applied: string[], pending: Array, ran: Array}>}
 */
export async function run_migrations({ client, migrations = MIGRATIONS, checkOnly = false, log = console.log } = {}) {
	if (!client) throw new Error('run_migrations 需要可用的数据库连接')

	const applied_before = await get_applied_versions(client)
	const pending_before = migrations.filter(migration => !applied_before.has(migration.version))

	if (checkOnly) {
		return { applied: [...applied_before], pending: pending_before, ran: [] }
	}
	if (!pending_before.length) {
		return { applied: [...applied_before], pending: [], ran: [] }
	}

	// 会话级咨询锁：同一时刻只允许一个迁移执行器；连接断开时自动释放
	await client.query('SELECT pg_advisory_lock(hashtext($1))', [SCHEMA_LOCK_KEY])
	try {
		// 取锁后重新读取，避免多个执行器同时通过上面的检查
		await ensure_migrations_table(client)
		const applied_locked = await get_applied_versions(client)
		const to_run = migrations.filter(migration => !applied_locked.has(migration.version))
		const ran = []

		for (const migration of to_run) {
			log(`[migrate] 开始 ${migration.version} — ${migration.description}`)
			const started = Date.now()
			await migration.run()
			// 只有迁移成功才记录版本；失败会抛出，finally 释放锁
			await client.query(`INSERT INTO schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`, [
				migration.version,
				migration.description,
			])
			ran.push(migration)
			log(`[migrate] 完成 ${migration.version}（${Date.now() - started}ms）`)
		}

		return { applied: [...applied_locked, ...ran.map(migration => migration.version)], pending: [], ran }
	} finally {
		await client.query('SELECT pg_advisory_unlock(hashtext($1))', [SCHEMA_LOCK_KEY]).catch(error => {
			log(`[migrate] 释放咨询锁失败: ${error.message}`)
		})
	}
}
