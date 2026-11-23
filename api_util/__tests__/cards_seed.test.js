/**
 * api_util/cards_seed.js 种子完整性测试
 *
 * 目标：内容数据是「可真实体验」的交付物，不是随手写的假数据。
 * 执行方案二彻底 ID 化，直接使用 base.getId() 主键 id，分类引用 category_id，无业务编码。
 * 覆盖 2026-11-23 全量重建数据集（9 大分类，129 张卡片）。
 */
import { describe, expect, it } from 'vitest'

import { SEED_CATEGORY_COUNT, SEED_ITEM_COUNT, seed_categories, seed_items, validate_seed } from '#api_util/cards_seed.js'

describe('cards_seed — 初始内容', () => {
	it('种子自检无错误', () => {
		expect(validate_seed()).toEqual([])
	})

	it('包含 9 个核心分类与 130 张卡片', () => {
		expect(SEED_CATEGORY_COUNT).toBe(9)
		expect(seed_categories).toHaveLength(9)
		expect(SEED_ITEM_COUNT).toBe(130)
		expect(seed_items).toHaveLength(130)
	})

	it('各分类卡片数量符合设计规范', () => {
		const expectedCounts = {
			动物: 15,
			食物: 24,
			交通工具: 12,
			生活用品: 14,
			大自然: 12,
			数字: 11,
			颜色: 11,
			形状: 11,
			反义词: 20,
		}

		for (const cat of seed_categories) {
			const count = seed_items.filter(item => item.category_id === cat.id).length
			expect(count, `${cat.name} 卡片数量`).toBe(expectedCounts[cat.name])
		}
	})

	it('id 唯一且长度符合表结构 (<= 20)', () => {
		const ids = new Set(seed_items.map(item => item.id))
		expect(ids.size).toBe(seed_items.length)
		expect(seed_items.every(item => item.id.length <= 20)).toBe(true)
	})

	it('中文卡拼音与英文完整', () => {
		const chineseCards = seed_items.filter(item => /[一-龥]/.test(item.label))
		expect(chineseCards.every(item => item.pinyin)).toBe(true)
		expect(seed_items.every(item => item.en_label)).toBe(true)
	})

	it('种子不携带前端渲染字段，视觉只能来自后台素材', () => {
		expect(seed_items.every(item => !('render_config' in item) && !('render_type' in item))).toBe(true)
	})
})
