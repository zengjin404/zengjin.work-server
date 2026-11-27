import { describe, expect, it } from 'vitest'

import { MIGRATIONS, SCHEMA_LOCK_KEY, get_applied_versions, run_migrations } from '../../schema_migrations.js'

/** 内存版 pg client：只实现迁移执行器用到的语句，不连真实数据库 */
function make_client({ has_table = false, applied = [], fail_insert_on = null } = {}) {
	const state = {
		has_table,
		applied: [...applied],
		inserts: [],
		queries: [],
		locked: false,
	}

	const client = {
		state,
		async query(sql, params = []) {
			const text = String(sql).replace(/\s+/g, ' ').trim()
			state.queries.push({ text, params })

			if (text.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
				state.has_table = true
				return { rows: [] }
			}
			if (text.startsWith('SELECT version FROM schema_migrations')) {
				if (!state.has_table) {
					const error = new Error('relation "schema_migrations" does not exist')
					error.code = '42P01'
					throw error
				}
				return { rows: state.applied.map(version => ({ version })) }
			}
			if (text.startsWith('SELECT pg_advisory_lock')) {
				state.locked = true
				return { rows: [{ pg_advisory_lock: null }] }
			}
			if (text.startsWith('SELECT pg_advisory_unlock')) {
				state.locked = false
				return { rows: [{ pg_advisory_unlock: true }] }
			}
			if (text.startsWith('INSERT INTO schema_migrations')) {
				if (params[0] === fail_insert_on) throw new Error('insert failed')
				state.inserts.push(params[0])
				state.applied.push(params[0])
				return { rows: [] }
			}
			throw new Error(`未预期的 SQL: ${text}`)
		},
	}

	return client
}

function make_migration(version, calls, { fail = false } = {}) {
	return {
		version,
		description: `测试迁移 ${version}`,
		async run() {
			calls.push(version)
			if (fail) throw new Error(`迁移失败: ${version}`)
		},
	}
}

describe('schema_migrations — 版本表读取', () => {
	it('版本表不存在时返回空集（兼容首次部署）', async () => {
		const client = make_client({ has_table: false })
		const applied = await get_applied_versions(client)
		expect([...applied]).toEqual([])
	})

	it('非 undefined_table 错误必须原样抛出，不能当成空库', async () => {
		const client = {
			async query() {
				const error = new Error('permission denied')
				error.code = '42501'
				throw error
			},
		}
		await expect(get_applied_versions(client)).rejects.toThrow('permission denied')
	})
})

describe('schema_migrations — 执行器', () => {
	it('checkOnly 只读：不建表、不取锁、不执行迁移，且列全待执行项', async () => {
		const client = make_client({ has_table: false })
		const calls = []
		const migrations = [make_migration('v1', calls), make_migration('v2', calls)]

		const result = await run_migrations({ client, migrations, checkOnly: true, log: () => {} })

		expect(result.applied).toEqual([])
		expect(result.pending.map(migration => migration.version)).toEqual(['v1', 'v2'])
		expect(result.ran).toEqual([])
		expect(calls).toEqual([])
		expect(client.state.locked).toBe(false)
		expect(client.state.has_table).toBe(false)
		expect(client.state.inserts).toEqual([])
	})

	it('apply 只执行未记录版本，成功后逐条写版本并释放咨询锁', async () => {
		const client = make_client({ has_table: true, applied: ['v1'] })
		const calls = []
		const migrations = [make_migration('v1', calls), make_migration('v2', calls)]

		const result = await run_migrations({ client, migrations, log: () => {} })

		expect(calls).toEqual(['v2'])
		expect(result.ran.map(migration => migration.version)).toEqual(['v2'])
		expect(result.pending).toEqual([])
		expect(client.state.inserts).toEqual(['v2'])
		expect(client.state.locked).toBe(false)

		const lock_call = client.state.queries.find(query => query.text.startsWith('SELECT pg_advisory_lock'))
		expect(lock_call.params).toEqual([SCHEMA_LOCK_KEY])
	})

	it('没有待执行迁移时不取锁、不建表', async () => {
		const client = make_client({ has_table: true, applied: ['v1', 'v2'] })
		const migrations = [make_migration('v1', []), make_migration('v2', [])]

		const result = await run_migrations({ client, migrations, log: () => {} })

		expect(result.ran).toEqual([])
		expect(client.state.queries.some(query => query.text.startsWith('SELECT pg_advisory_lock'))).toBe(false)
		expect(client.state.queries.some(query => query.text.startsWith('CREATE TABLE'))).toBe(false)
	})

	it('首次 apply 会创建版本表，并用表内已记录版本再次去重', async () => {
		const client = make_client({ has_table: false })
		const calls = []
		const migrations = [make_migration('v1', calls)]

		await run_migrations({ client, migrations, log: () => {} })

		expect(client.state.has_table).toBe(true)
		expect(calls).toEqual(['v1'])
		expect(client.state.inserts).toEqual(['v1'])
	})

	it('迁移失败时不写该版本，且咨询锁必定释放', async () => {
		const client = make_client({ has_table: true })
		const calls = []
		const migrations = [make_migration('v1', calls), make_migration('v2', calls, { fail: true })]

		await expect(run_migrations({ client, migrations, log: () => {} })).rejects.toThrow('迁移失败: v2')

		expect(calls).toEqual(['v1', 'v2'])
		// v1 成功已记录；v2 失败不得记录，修复后可重放
		expect(client.state.inserts).toEqual(['v1'])
		expect(client.state.locked).toBe(false)
	})

	it('写入版本记录失败时同样不留下该版本，并释放锁', async () => {
		const client = make_client({ has_table: true, fail_insert_on: 'v1' })
		const migrations = [make_migration('v1', [])]

		await expect(run_migrations({ client, migrations, log: () => {} })).rejects.toThrow('insert failed')

		expect(client.state.inserts).toEqual([])
		expect(client.state.applied).toEqual([])
		expect(client.state.locked).toBe(false)
	})
})

describe('schema_migrations — 基线清单', () => {
	it('版本号唯一、描述非空、按版本号升序排列', () => {
		const versions = MIGRATIONS.map(migration => migration.version)
		expect(new Set(versions).size).toBe(versions.length)
		expect([...versions].sort()).toEqual(versions)
		expect(MIGRATIONS.every(migration => migration.description.trim().length > 0)).toBe(true)
	})

	it('每个基线迁移都有可执行 run 函数', () => {
		expect(MIGRATIONS.length).toBeGreaterThan(0)
		expect(MIGRATIONS.every(migration => typeof migration.run === 'function')).toBe(true)
	})
})
