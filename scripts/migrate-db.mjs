#!/usr/bin/env node
/**
 * 数据库结构迁移 CLI（默认只读检查，必须显式 --apply 才写库）
 *
 * 用法：
 *   node --env-file=.env scripts/migrate-db.mjs            # 等价 --check
 *   node --env-file=.env scripts/migrate-db.mjs --check    # 只读，有待执行迁移时退出码 1
 *   node --env-file=.env scripts/migrate-db.mjs --apply    # 执行迁移并记录版本
 *
 * 说明：
 *   - 不挂到 build / start 钩子，避免部署时隐式改库；
 *   - --apply 使用会话级咨询锁，多实例同时执行时只有一个真正跑迁移；
 *   - 迁移失败不写版本，修复后可安全重放（ensure 均幂等）。
 */
import { MIGRATIONS, run_migrations } from '../api_util/schema_migrations.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const check = args.includes('--check')
const help = args.includes('--help') || args.includes('-h')
const unknown = args.filter(arg => !['--apply', '--check', '--help', '-h'].includes(arg))

function print_help() {
	console.log(`数据库结构迁移

用法:
  node --env-file=.env scripts/migrate-db.mjs            只读检查（默认）
  node --env-file=.env scripts/migrate-db.mjs --check    只读检查；有待执行迁移时退出码为 1
  node --env-file=.env scripts/migrate-db.mjs --apply    执行迁移并写入 schema_migrations

选项:
  --check   只读检查，不取锁、不建表、不执行迁移
  --apply   显式执行迁移
  --help    显示帮助

共 ${MIGRATIONS.length} 个基线迁移。`)
}

if (help) {
	print_help()
	process.exit(0)
}
if (unknown.length) {
	console.error(`未知参数: ${unknown.join(' ')}`)
	print_help()
	process.exit(1)
}
if (apply && check) {
	console.error('--apply 与 --check 不能同时使用')
	process.exit(1)
}

// 参数校验通过后再加载数据库模块，避免 --help 也去读 DB_* 配置
const { default: db } = await import('../api_util/db.js')

if (!db) {
	console.error('缺少数据库连接配置。请确认已通过 --env-file 加载 DB_* 环境变量。')
	process.exit(1)
}
// 执行器持有一个连接做咨询锁/版本写入，ensure 函数还会从池里再取连接
if (Number(db.options?.max || 10) < 2) {
	console.error('迁移至少需要 2 个数据库连接（咨询锁 1 个 + ensure 查询 1 个），请检查 DB_POOL_MAX。')
	process.exit(1)
}

let client
try {
	client = await db.connect()

	if (apply) {
		const result = await run_migrations({ client })
		if (!result.ran.length) {
			console.log(`[migrate] 无待执行迁移（已执行 ${result.applied.length}/${MIGRATIONS.length}）`)
		} else {
			console.log(`[migrate] 本次执行 ${result.ran.length} 个迁移：${result.ran.map(migration => migration.version).join(', ')}`)
		}
	} else {
		const result = await run_migrations({ client, checkOnly: true })
		const done = MIGRATIONS.length - result.pending.length
		console.log(`[migrate] 已执行 ${done}/${MIGRATIONS.length} 个迁移`)
		if (result.pending.length) {
			console.log('[migrate] 待执行：')
			for (const migration of result.pending) {
				console.log(`  - ${migration.version}  ${migration.description}`)
			}
			console.log('[migrate] 如需执行，请显式运行：node --env-file=.env scripts/migrate-db.mjs --apply')
			process.exitCode = 1
		} else {
			console.log('[migrate] 数据库结构已是最新')
		}
	}
} catch (error) {
	console.error(`[migrate] 失败: ${error.message}`)
	process.exitCode = 1
} finally {
	client?.release()
	await db.end().catch(error => {
		console.error(`[migrate] 关闭连接池失败: ${error.message}`)
	})
}
