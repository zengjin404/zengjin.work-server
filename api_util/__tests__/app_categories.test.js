import { describe, expect, it } from 'vitest'

import {
	APP_CATEGORIES,
	APP_CATEGORY_KEYS,
	get_app_category_labels,
	is_valid_app_visibility,
	normalize_app_categories,
	validate_app_categories,
} from '#api_util/app_categories.js'

describe('应用分类字典', () => {
	it('六个正式分类齐全、ID / 名称唯一', () => {
		expect(APP_CATEGORIES).toHaveLength(6)
		expect(APP_CATEGORY_KEYS).toEqual(['efficiency', 'system', 'media', 'dev', 'play', 'gis'])
		expect(new Set(APP_CATEGORIES.map(c => c.key)).size).toBe(6)
		expect(new Set(APP_CATEGORIES.map(c => c.label)).size).toBe(6)
	})

	it('每个分类都有定位、收录与排除范围', () => {
		for (const category of APP_CATEGORIES) {
			expect(category.description).toBeTruthy()
			expect(category.inclusion.length).toBeGreaterThan(0)
			expect(category.exclusion.length).toBeGreaterThan(0)
			expect(category.status).toBe('active')
		}
	})
})

describe('分类归一化与校验', () => {
	it('去重并保留输入顺序', () => {
		expect(normalize_app_categories('media, efficiency,media').categories).toEqual(['media', 'efficiency'])
	})

	it('新写入拒绝旧分类', () => {
		const result = validate_app_categories('daily,kids')
		expect(result.errors.length).toBeGreaterThan(0)
		expect(result.errors[0]).toContain('daily')
		expect(result.errors[0]).toContain('kids')
	})

	it('迁移场景允许旧分类映射', () => {
		const result = validate_app_categories('daily,kids', { allowLegacy: true })
		expect(result.categories).toEqual(['efficiency', 'play'])
		expect(result.errors).toEqual([])
	})

	it('空分类 / 超过两个分类的规则', () => {
		expect(validate_app_categories('').errors).toContain('至少需要选择一个有效分类')
		const many = validate_app_categories('efficiency,media,dev')
		expect(many.errors).toEqual([])
		expect(many.warnings[0]).toContain('3 个分类')
	})

	it('可见性只接受 public / private / admin', () => {
		expect(is_valid_app_visibility('public')).toBe(true)
		expect(is_valid_app_visibility('admin')).toBe(true)
		expect(is_valid_app_visibility('hidden')).toBe(false)
	})

	it('展示标签自动映射旧分类', () => {
		expect(get_app_category_labels('daily,kids')).toEqual([
			{ key: 'efficiency', label: '效率工具', legacy: 'daily' },
			{ key: 'play', label: '休闲娱乐', legacy: 'kids' },
		])
	})
})
