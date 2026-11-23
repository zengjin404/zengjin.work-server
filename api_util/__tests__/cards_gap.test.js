/**
 * CARDS 内容缺口资格判断与自动消警测试
 *
 * 重点：
 *  - 视觉身份去重：同 URL 不同 query / 同 Emoji 复制记录不能凑多图
 *  - 三种认知模式与三个玩法的资格口径
 *  - 自动消警只在完整开局条件满足时发生
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = (await import('#api_util/db.js')).default
const mockQuery = vi.fn()

const EMPTY = { rows: [], rowCount: 0 }

function sqlOf(call) {
	return String(call[0]).trim()
}

beforeEach(() => {
	mockQuery.mockReset()
	db.query = (...args) => mockQuery(...args)
	mockQuery.mockResolvedValue(EMPTY)
	vi.resetModules()
})

async function load_gap() {
	return await import('#api_util/cards_gap.js')
}

const image = (url, extra = {}) => ({ asset_type: 'image', asset_url: url, is_enabled: true, is_random: true, ...extra })
const emoji = (char, extra = {}) => ({ asset_type: 'emoji', asset_url: `emoji:${char}`, is_enabled: true, is_random: true, ...extra })

describe('cards_gap — 视觉身份', () => {
	it('同一图片仅 query / hash 不同视为同一视觉', async () => {
		const { get_asset_visual_key } = await load_gap()
		const a = get_asset_visual_key(image('https://cdn.test/cat.webp?a=1'))
		const b = get_asset_visual_key(image('https://cdn.test/cat.webp?b=2#x'))
		expect(a).toBe(b)
	})

	it('同 Emoji 换 id / 换 URL 形式仍视为同一视觉', async () => {
		const { get_asset_visual_key } = await load_gap()
		expect(get_asset_visual_key(emoji('🐱'))).toBe(get_asset_visual_key({ id: 'other', asset_type: 'emoji', asset_url: 'emoji:🐱' }))
	})

	it('不同图片与不同 Emoji 是不同视觉', async () => {
		const { get_asset_visual_key } = await load_gap()
		expect(get_asset_visual_key(image('https://cdn.test/cat.webp'))).not.toBe(get_asset_visual_key(image('https://cdn.test/dog.webp')))
		expect(get_asset_visual_key(emoji('🐱'))).not.toBe(get_asset_visual_key(emoji('🐶')))
	})
})

describe('cards_gap — 单卡资格', () => {
	it('固定图片只要求有效视觉', async () => {
		const { evaluate_card_qualification } = await load_gap()
		expect(
			evaluate_card_qualification(
				{ label: '猫', play_modes: 'recognize,connect,memory' },
				[image('https://cdn.test/cat.webp')],
				'fixed_image',
				'recognize',
			),
		).toEqual({
			eligible: true,
			reason: '',
		})
		expect(evaluate_card_qualification({ label: '猫' }, [], 'fixed_image', 'recognize').reason).toBe('no_valid_visual')
	})

	it('随机图片下连一连 / 翻一翻要求至少两个视觉不同的可随机素材', async () => {
		const { evaluate_card_qualification } = await load_gap()
		const one = evaluate_card_qualification(
			{ label: '猫' },
			[image('https://cdn.test/cat.webp'), image('https://cdn.test/cat.webp?v=2')],
			'random_image',
			'connect',
		)
		expect(one.eligible).toBe(false)
		expect(one.reason).toBe('insufficient_visual_variants')

		const two = evaluate_card_qualification(
			{ label: '猫' },
			[image('https://cdn.test/cat.webp'), image('https://cdn.test/cat2.webp')],
			'random_image',
			'connect',
		)
		expect(two.eligible).toBe(true)
	})

	it('随机图片下认一认只需一张有效视觉', async () => {
		const { evaluate_card_qualification } = await load_gap()
		expect(evaluate_card_qualification({ label: '猫' }, [image('https://cdn.test/cat.webp')], 'random_image', 'recognize').eligible).toBe(true)
	})

	it('图文关联同时要求中文名称与视觉', async () => {
		const { evaluate_card_qualification } = await load_gap()
		expect(evaluate_card_qualification({ label: '' }, [image('https://cdn.test/cat.webp')], 'image_text', 'recognize').reason).toBe('missing_chinese_name')
		expect(evaluate_card_qualification({ label: '猫' }, [], 'image_text', 'recognize').reason).toBe('no_valid_visual')
		expect(evaluate_card_qualification({ label: '猫' }, [image('https://cdn.test/cat.webp')], 'image_text', 'recognize').eligible).toBe(true)
	})

	it('卡片未启用当前玩法时不计入资格', async () => {
		const { evaluate_card_qualification } = await load_gap()
		expect(
			evaluate_card_qualification({ label: '猫', play_modes: 'recognize' }, [image('https://cdn.test/cat.webp')], 'fixed_image', 'connect').reason,
		).toBe('play_mode_unsupported')
	})
})

describe('cards_gap — 分类资格与自动消警', () => {
	it('分类没有卡片时返回 no_cards', async () => {
		const { evaluate_cards_content_gap_async } = await load_gap()
		mockQuery.mockImplementation(async sql => {
			const text = String(sql)
			if (text.includes('FROM cards_item i') && text.includes('SELECT i.id')) return { rows: [] }
			if (text.includes('FROM cards_asset a')) return { rows: [] }
			return EMPTY
		})

		const result = await evaluate_cards_content_gap_async({ categoryId: 'cc_animal', playMode: 'connect', imageMode: 'fixed_image' })
		expect(result.available).toBe(false)
		expect(result.availableCount).toBe(0)
		expect(result.reason).toBe('no_cards')
	})

	it('满足开局条件时 available 为 true', async () => {
		const { evaluate_cards_content_gap_async } = await load_gap()
		mockQuery.mockImplementation(async sql => {
			const text = String(sql)
			if (text.includes('FROM cards_item i') && text.includes('SELECT i.id'))
				return { rows: [{ id: 'ci1', card_key: 'cat', label: '猫', play_modes: 'connect', category_id: 'cc_animal' }] }
			if (text.includes('FROM cards_asset a'))
				return { rows: [{ card_id: 'ci1', asset_type: 'image', asset_url: 'https://cdn.test/cat.webp', is_enabled: true, is_random: true }] }
			return EMPTY
		})

		const result = await evaluate_cards_content_gap_async({ categoryId: 'cc_animal', playMode: 'connect', imageMode: 'random_image' })
		expect(result.available).toBe(false)

		mockQuery.mockImplementation(async sql => {
			const text = String(sql)
			if (text.includes('FROM cards_item i') && text.includes('SELECT i.id'))
				return { rows: [{ id: 'ci1', card_key: 'cat', label: '猫', play_modes: 'connect', category_id: 'cc_animal' }] }
			if (text.includes('FROM cards_asset a')) {
				return {
					rows: [
						{ card_id: 'ci1', asset_type: 'image', asset_url: 'https://cdn.test/cat.webp', is_enabled: true, is_random: true },
						{ card_id: 'ci1', asset_type: 'image', asset_url: 'https://cdn.test/cat2.webp', is_enabled: true, is_random: true },
					],
				}
			}
			return EMPTY
		})

		const recovered = await evaluate_cards_content_gap_async({ categoryId: 'cc_animal', playMode: 'connect', imageMode: 'random_image' })
		expect(recovered.available).toBe(true)
		expect(recovered.availableCount).toBe(1)
	})

	it('内容达到条件后自动把原通知标记为已解决', async () => {
		const { resolve_cards_content_gaps_async } = await load_gap()
		const updates = []

		mockQuery.mockImplementation(async (sql, binds = []) => {
			const text = String(sql)
			if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return EMPTY
			if (text.includes('INSERT INTO admin_notification_setting')) return EMPTY
			if (text.includes('SELECT value FROM admin_notification_setting')) return { rows: [{ value: true }] }
			if (text.includes('SELECT id, dedupe_key, metadata')) {
				return {
					rows: [
						{
							id: 'n1',
							dedupe_key: 'cards:cc_animal:connect:fixed_image',
							metadata: { categoryId: 'cc_animal', playMode: 'connect', imageMode: 'fixed_image' },
						},
					],
				}
			}
			if (text.includes('FROM cards_item i') && text.includes('SELECT i.id'))
				return { rows: [{ id: 'ci1', card_key: 'cat', label: '猫', play_modes: 'connect', category_id: 'cc_animal' }] }
			if (text.includes('FROM cards_asset a'))
				return { rows: [{ card_id: 'ci1', asset_type: 'image', asset_url: 'https://cdn.test/cat.webp', is_enabled: true, is_random: true }] }
			if (text.includes(`UPDATE admin_notification`) && text.includes(`SET status = 'resolved'`)) {
				updates.push(binds[0])
				return { rows: [{ id: binds[0] }] }
			}
			return EMPTY
		})

		const result = await resolve_cards_content_gaps_async({ categoryIds: ['cc_animal'], reason: 'test' })
		expect(result.resolved).toBe(1)
		expect(updates).toEqual(['n1'])
	})

	it('只有图片但没有中文名称时图文关联缺口不会被误消警', async () => {
		const { resolve_cards_content_gaps_async } = await load_gap()
		let resolved = false

		mockQuery.mockImplementation(async sql => {
			const text = String(sql)
			if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return EMPTY
			if (text.includes('INSERT INTO admin_notification_setting')) return EMPTY
			if (text.includes('SELECT value FROM admin_notification_setting')) return { rows: [{ value: true }] }
			if (text.includes('SELECT id, dedupe_key, metadata')) {
				return {
					rows: [
						{
							id: 'n2',
							dedupe_key: 'cards:cc_animal:connect:image_text',
							metadata: { categoryId: 'cc_animal', playMode: 'connect', imageMode: 'image_text' },
						},
					],
				}
			}
			if (text.includes('FROM cards_item i') && text.includes('SELECT i.id'))
				return { rows: [{ id: 'ci1', card_key: 'cat', label: '', play_modes: 'connect', category_id: 'cc_animal' }] }
			if (text.includes('FROM cards_asset a'))
				return { rows: [{ card_id: 'ci1', asset_type: 'image', asset_url: 'https://cdn.test/cat.webp', is_enabled: true, is_random: true }] }
			if (text.includes(`SET status = 'resolved'`)) {
				resolved = true
				return EMPTY
			}
			return EMPTY
		})

		const result = await resolve_cards_content_gaps_async({ categoryIds: ['cc_animal'], reason: 'test' })
		expect(result.resolved).toBe(0)
		expect(resolved).toBe(false)
	})

	it('开关关闭时只停止新上报，不自动解决历史通知', async () => {
		const { resolve_cards_content_gaps_async } = await load_gap()
		let resolved = false

		mockQuery.mockImplementation(async sql => {
			const text = String(sql)
			if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return EMPTY
			if (text.includes('INSERT INTO admin_notification_setting')) return EMPTY
			if (text.includes('SELECT value FROM admin_notification_setting')) return { rows: [{ value: false }] }
			if (text.includes(`SET status = 'resolved'`)) {
				resolved = true
				return EMPTY
			}
			return EMPTY
		})

		const result = await resolve_cards_content_gaps_async({ categoryIds: ['cc_animal'], reason: 'test' })
		expect(result.disabled).toBe(true)
		expect(result.resolved).toBe(0)
		expect(resolved).toBe(false)
	})
})
