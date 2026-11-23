import { describe, expect, it } from 'vitest'

import { audit_app_catalog, validate_app_record } from '#api_util/app_metadata.js'

describe('应用元数据单条校验', () => {
	it('合法公开应用无错误', () => {
		const result = validate_app_record({ id: 'a1', name: 'ai', title: 'AI', category: 'efficiency', visibility: 'public', status: 1, show: true })
		expect(result.categories).toEqual(['efficiency'])
		expect(result.issues.filter(issue => issue.severity === 'error')).toEqual([])
	})

	it('未定义分类是错误', () => {
		const result = validate_app_record({ id: 'a1', name: 'bad', category: 'unknown', visibility: 'public' })
		expect(result.issues.some(issue => issue.code === 'app_category_invalid' && issue.severity === 'error')).toBe(true)
	})

	it('公开应用没有分类是错误', () => {
		const result = validate_app_record({ id: 'a1', name: 'empty', category: '', visibility: 'public', show: true })
		expect(result.issues.some(issue => issue.code === 'app_category_empty' && issue.severity === 'error')).toBe(true)
	})

	it('超过两个分类是提醒', () => {
		const result = validate_app_record({ id: 'a1', name: 'many', category: 'efficiency,media,dev', visibility: 'public', show: true })
		expect(result.issues.some(issue => issue.code === 'app_category_too_many' && issue.severity === 'warning')).toBe(true)
	})

	it('私有应用仍上架时提醒', () => {
		const result = validate_app_record({ id: 'a1', name: 'private', category: 'efficiency', visibility: 'private', show: true })
		expect(result.issues.some(issue => issue.code === 'app_visibility_show_conflict')).toBe(true)
	})

	it('可见性非法是错误', () => {
		const result = validate_app_record({ id: 'a1', name: 'bad', category: 'efficiency', visibility: 'hidden', show: false })
		expect(result.issues.some(issue => issue.code === 'app_visibility_invalid' && issue.severity === 'error')).toBe(true)
	})
})

describe('应用目录全量审计', () => {
	it('统计公开 / 私有 / 管理员、无效分类与分类数量', () => {
		const report = audit_app_catalog([
			{ id: 'a1', name: 'ai', title: 'AI', category: 'efficiency', visibility: 'public', status: 1, show: true },
			{ id: 'a2', name: 'jndv', title: 'JNDV', category: 'efficiency', visibility: 'private', status: 1, show: false },
			{ id: 'a3', name: 'admin', title: '后台', category: 'dev', visibility: 'admin', status: 1, show: false },
			{ id: 'a4', name: 'bad', title: '坏应用', category: 'daily', visibility: 'public', status: 1, show: true },
		])

		expect(report.summary.total).toBe(4)
		expect(report.summary.public).toBe(2)
		expect(report.summary.private).toBe(1)
		expect(report.summary.admin).toBe(1)
		expect(report.summary.invalidCategoryRecords).toBe(1)
		expect(report.categoryStats.find(c => c.key === 'efficiency').count).toBe(2)
		expect(report.issues.some(issue => issue.code === 'app_category_legacy_in_use')).toBe(true)
	})

	it('空分类会输出 info 提醒', () => {
		const report = audit_app_catalog([{ id: 'a1', name: 'ai', title: 'AI', category: 'efficiency', visibility: 'public', show: true }])
		expect(report.issues.some(issue => issue.code === 'app_category_no_apps' && issue.severity === 'info')).toBe(true)
	})
})
