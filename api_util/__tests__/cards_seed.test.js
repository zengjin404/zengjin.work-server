/**
 * api_util/cards_seed.js 种子完整性测试
 *
 * 目标：内容数据是「可真实体验」的交付物，不是随手写的假数据。
 * 任何新增卡片都必须通过：分类存在、card_key 合法且唯一、中文卡有拼音、渲染配置为对象。
 */
import { describe, expect, it } from 'vitest'

import { SEED_CATEGORY_COUNT, SEED_ITEM_COUNT, seed_categories, seed_items, validate_seed } from '#api_util/cards_seed.js'

describe('cards_seed — 初始内容', () => {
	it('种子自检无错误', () => {
		expect(validate_seed()).toEqual([])
	})

	it('包含 13 个分类与 110 张卡片', () => {
		expect(SEED_CATEGORY_COUNT).toBe(13)
		expect(seed_categories).toHaveLength(13)
		// 8 个生活认知 * 6 + 数字 10 + 字母 26 + 颜色 10 + 形状 8 + 大小 8
		expect(SEED_ITEM_COUNT).toBe(110)
		expect(seed_items).toHaveLength(110)
	})

	it('8 个生活认知分类各 6 张插画卡', () => {
		const lifeCodes = ['animal', 'fruit', 'vegetable', 'vehicle', 'food', 'life', 'toy', 'nature']
		for (const code of lifeCodes) {
			const list = seed_items.filter(item => item.category_code === code)
			expect(list, code).toHaveLength(6)
			expect(
				list.every(item => item.render_config.kind === 'illustration' && item.render_config.key === item.card_key),
				code,
			).toBe(true)
		}
	})

	it('数字 1~10、字母 A~Z 完整', () => {
		expect(seed_items.filter(item => item.category_code === 'number').map(item => item.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
		expect(seed_items.filter(item => item.category_code === 'letter').map(item => item.label)).toEqual('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))
	})

	it('card_key / id 唯一且长度符合表结构', () => {
		const keys = new Set(seed_items.map(item => item.card_key))
		const ids = new Set(seed_items.map(item => item.id))
		expect(keys.size).toBe(seed_items.length)
		expect(ids.size).toBe(seed_items.length)
		expect(seed_items.every(item => item.id.length <= 20)).toBe(true)
		expect(seed_items.every(item => item.card_key.length <= 60)).toBe(true)
	})

	it('生活卡拼音与英文不缺失', () => {
		const lifeItems = seed_items.filter(item => item.render_config.kind === 'illustration')
		expect(lifeItems.every(item => item.pinyin && item.en_label)).toBe(true)
	})

	it('渲染配置只使用受支持的 kind', () => {
		const allowed = new Set(['illustration', 'number', 'letter', 'color', 'shape', 'size'])
		expect(seed_items.every(item => allowed.has(item.render_config.kind))).toBe(true)
	})
})
