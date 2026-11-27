import { describe, expect, it } from 'vitest'

import base from '#api_util/base.js'
import { DB_IDLE_TIMEOUT_MS, instrument_pool } from '#api_util/db.js'

function make_perf() {
	return {
		db_ms: 0,
		db_calls: 0,
		acquire_ms: 0,
		acquire_calls: 0,
		connect_ms: 0,
		connect_calls: 0,
	}
}

function make_pool({ reused = false } = {}) {
	const pool = {
		totalCount: reused ? 1 : 0,
		on() {
			return pool
		},
		async connect() {
			if (!reused) pool.totalCount++
			return { id: pool.totalCount }
		},
		async query() {
			return { rows: [{ ok: 1 }] }
		},
	}
	return pool
}

describe('db pool instrumentation', () => {
	it('空闲超时延长到 60 秒（PERFORMANCE-03 证据）', () => {
		expect(DB_IDLE_TIMEOUT_MS).toBe(60000)
	})

	it('新建连接时记录 acquire / connect，查询记录 db', async () => {
		const pool = make_pool()
		instrument_pool(pool, 'TEST')
		const perf = make_perf()

		await base.storage.run({ perf }, async () => {
			const client = await pool.connect()
			expect(client).toBeTruthy()
			const result = await pool.query('SELECT 1')
			expect(result.rows[0].ok).toBe(1)
		})

		expect(perf.acquire_calls).toBe(1)
		expect(perf.connect_calls).toBe(1)
		expect(perf.acquire_ms).toBeGreaterThanOrEqual(0)
		expect(perf.connect_ms).toBeGreaterThanOrEqual(0)
		expect(perf.db_calls).toBe(1)
		expect(perf.db_ms).toBeGreaterThanOrEqual(0)
	})

	it('复用连接时 acquire 有记录但 connect 为 0', async () => {
		const pool = make_pool({ reused: true })
		instrument_pool(pool, 'TEST')
		const perf = make_perf()

		await base.storage.run({ perf }, async () => {
			await pool.connect()
		})

		expect(perf.acquire_calls).toBe(1)
		expect(perf.connect_calls).toBe(0)
		expect(perf.connect_ms).toBe(0)
	})

	it('支持 pg-pool 内部使用的 callback 形式，不改变回调参数', async () => {
		const pool = make_pool()
		pool.connect = callback => {
			pool.totalCount++
			setImmediate(() => callback(null, { id: 1 }, () => {}))
		}
		instrument_pool(pool, 'TEST')
		const perf = make_perf()

		const received = await base.storage.run({ perf }, () => {
			return new Promise(resolve => {
				pool.connect((error, client, release) => {
					expect(error).toBeNull()
					expect(client).toEqual({ id: 1 })
					expect(typeof release).toBe('function')
					release()
					resolve('done')
				})
			})
		})

		expect(received).toBe('done')
		expect(perf.acquire_calls).toBe(1)
		expect(perf.connect_calls).toBe(1)
	})

	it('断线重试只记一次 db_calls，且最终返回重试结果', async () => {
		const pool = make_pool()
		let attempts = 0
		pool.query = async () => {
			attempts++
			if (attempts === 1) throw new Error('Connection terminated unexpectedly')
			return { rows: [{ ok: 2 }] }
		}
		instrument_pool(pool, 'TEST')
		const perf = make_perf()

		const result = await base.storage.run({ perf }, () => pool.query('SELECT 2'))

		expect(attempts).toBe(2)
		expect(result.rows[0].ok).toBe(2)
		expect(perf.db_calls).toBe(1)
	})

	it('没有请求级 perf 时保持原行为', async () => {
		const pool = make_pool()
		instrument_pool(pool, 'TEST')
		await expect(pool.query('SELECT 1')).resolves.toBeTruthy()
	})

	it('重复 instrument 不会重复包装', async () => {
		const pool = make_pool()
		instrument_pool(pool, 'TEST')
		const connect = pool.connect
		const query = pool.query
		instrument_pool(pool, 'TEST')
		expect(pool.connect).toBe(connect)
		expect(pool.query).toBe(query)
	})
})
