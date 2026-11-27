import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const source = relative => readFile(path.join(ROOT, relative), 'utf8')

// ensure 函数已导出给部署期迁移使用；请求路径不得再调用
const ENSURE_CASES = [
	['api/_base/user.js', 'ensure_avatarColumn'],
	['api/_base/app.js', 'ensure_dbInitialized_async'],
	['api/_base/ai.js', 'ensure_dbInitialized_async'],
	['api/_base/seal.js', 'ensure_dbInitialized_async'],
	['api/_cards.js', 'ensure_dbInitialized_async'],
	['api/_dphxb.js', 'ensure_dbInitialized_async'],
	['api/_fa.js', 'ensure_dbInitialized_async'],
	['api/_jndv.js', 'ensure_dbInitialized_async'],
	['api/_music.js', 'init_table_async'],
	['api/_sub.js', 'ensure_tables_exist'],
]

describe('数据库 ensure 已移出普通请求路径', () => {
	for (const [file, name] of ENSURE_CASES) {
		it(`${file} 导出 ${name} 且不再自行调用`, async () => {
			const text = await source(file)
			expect(text).toContain(`export async function ${name}(`)
			expect(text).not.toMatch(new RegExp(`await\\s+${name}\\s*\\(`))
		})
	}

	it('通知模块 ensure 仅在部署期迁移中调用', async () => {
		const store = await source('api_util/notification_store.js')
		const notification = await source('api/_base/notification.js')
		const cardsGap = await source('api_util/cards_gap.js')

		expect(store).toContain('export async function ensure_notification_db_async(')
		expect(notification).not.toContain('ensure_notification_db_async(')
		expect(cardsGap).not.toContain('ensure_notification_db_async(')
	})

	it('迁移清单覆盖全部基线 ensure（防止新增模块忘记登记）', async () => {
		const text = await source('api_util/schema_migrations.js')
		const imported = [...text.matchAll(/await import\('\.\.\/(api\/[^']+)'\)/g)].map(match => match[1])
		expect(new Set(imported).size).toBe(imported.length)
		expect(imported).toEqual([
			'api/_base/user.js',
			'api/_base/app.js',
			'api/_base/ai.js',
			'api/_cards.js',
			'api/_dphxb.js',
			'api/_fa.js',
			'api/_jndv.js',
			'api/_music.js',
			'api/_sub.js',
			'api/_base/seal.js',
		])
		expect(text).toContain("await import('./notification_store.js')")
	})
})
