import {
	APP_CATEGORIES,
	APP_CATEGORY_KEYS,
	APP_LEGACY_CATEGORY_MAP,
	APP_VISIBILITY_VALUES,
	normalize_app_categories,
	split_app_categories,
} from '#api_util/app_categories.js'

/**
 * 应用元数据审计
 *
 * 只做静态数据检查，不臆测应用实际功能；功能归属冲突留待 AI / 人工审查。
 * 返回统一 severity：error / warning / info。
 */

function to_bool(value, fallback = false) {
	if (value == null) return fallback
	if (typeof value === 'boolean') return value
	if (value === 1 || value === '1' || value === 'true') return true
	if (value === 0 || value === '0' || value === 'false') return false
	return Boolean(value)
}

function push_issue(issues, severity, code, app, message, suggestion = '') {
	issues.push({
		severity,
		code,
		appId: app?.id || '',
		appName: app?.name || '',
		appTitle: app?.title || '',
		message,
		suggestion,
	})
}

/** 单条应用记录校验 */
export function validate_app_record(app = {}) {
	const issues = []
	const rawCategory = split_app_categories(app.category)
	const { categories, invalid, legacy } = normalize_app_categories(app.category, { allowLegacy: false })
	const visibility = String(app.visibility || 'public').toLowerCase()
	const show = to_bool(app.show, true)
	const status = Number(app.status ?? 1)

	if (rawCategory.length !== categories.length || invalid.length) {
		push_issue(
			issues,
			'error',
			'app_category_invalid',
			app,
			`分类包含未定义 / 已停用 / 重复项：${[...new Set([...invalid, ...legacy])].join(', ') || '重复分类'}`,
			'从统一分类字典中选择有效分类，并去掉重复项',
		)
	}
	if (!categories.length) {
		push_issue(issues, visibility === 'public' ? 'error' : 'warning', 'app_category_empty', app, '应用没有有效分类', '至少选择一个分类')
	}
	if (categories.length > 2) {
		push_issue(issues, 'warning', 'app_category_too_many', app, `应用归属 ${categories.length} 个分类`, '确认每个分类都能让用户合理预期找到该应用')
	}
	if (!APP_VISIBILITY_VALUES.includes(visibility)) {
		push_issue(issues, 'error', 'app_visibility_invalid', app, `可见范围非法：${visibility}`, '使用 public / private / admin')
	}
	if (visibility !== 'public' && show) {
		push_issue(
			issues,
			'warning',
			'app_visibility_show_conflict',
			app,
			`可见范围为 ${visibility} 但仍标记上架`,
			'非公开应用建议 show=false，公开列表只返回 public',
		)
	}
	if (status === 1 && !show) {
		push_issue(issues, 'info', 'app_unlisted', app, '应用处于启用但未上架状态', '确认这是预期的下架 / 未发布状态')
	}
	if (status === 0 && show) {
		push_issue(issues, 'warning', 'app_disabled_but_shown', app, '应用已禁用但仍标记上架', '禁用应用不应出现在公开列表')
	}

	return { categories, visibility, show, status, issues }
}

/** 全量应用目录审计 */
export function audit_app_catalog(apps = []) {
	const issues = []
	const categoryCounts = Object.fromEntries(APP_CATEGORY_KEYS.map(key => [key, 0]))
	const summary = {
		total: apps.length,
		public: 0,
		private: 0,
		admin: 0,
		shown: 0,
		hidden: 0,
		invalidCategoryRecords: 0,
		publicWithoutCategory: 0,
	}

	for (const app of apps) {
		const result = validate_app_record(app)
		issues.push(...result.issues)

		if (result.visibility === 'public') summary.public++
		else if (result.visibility === 'private') summary.private++
		else if (result.visibility === 'admin') summary.admin++

		if (result.show) summary.shown++
		else summary.hidden++

		if (result.issues.some(issue => issue.code === 'app_category_invalid')) summary.invalidCategoryRecords++
		if (result.visibility === 'public' && !result.categories.length) summary.publicWithoutCategory++

		for (const key of new Set(result.categories)) {
			if (key in categoryCounts) categoryCounts[key]++
		}
	}

	const categoryStats = APP_CATEGORIES.map(category => ({
		key: category.key,
		label: category.label,
		count: categoryCounts[category.key] || 0,
		status: category.status,
	}))

	for (const category of categoryStats) {
		if (!category.count) {
			issues.push({
				severity: 'info',
				code: 'app_category_no_apps',
				appId: '',
				appName: '',
				appTitle: '',
				message: `分类「${category.label}」目前没有应用`,
				suggestion: '确认该分类是否仍有保留价值，或考虑合并；不要为了数量均衡而制造归属',
			})
		}
	}

	for (const category of APP_CATEGORIES) {
		if (!category.inclusion?.length || !category.exclusion?.length) {
			issues.push({
				severity: 'info',
				code: 'app_category_definition_incomplete',
				appId: '',
				appName: '',
				appTitle: '',
				message: `分类「${category.label}」缺少收录或排除范围说明`,
				suggestion: '补齐 inclusion / exclusion，供 AI 与人工审查使用',
			})
		}
	}

	// 旧分类只应出现在迁移前的历史数据中
	const legacyKeys = Object.keys(APP_LEGACY_CATEGORY_MAP).filter(key => !APP_CATEGORY_KEYS.includes(key))
	for (const app of apps) {
		if (split_app_categories(app.category).some(key => legacyKeys.includes(key))) {
			issues.push({
				severity: 'error',
				code: 'app_category_legacy_in_use',
				appId: app.id,
				appName: app.name,
				appTitle: app.title,
				message: '仍在使用旧分类',
				suggestion: '执行分类迁移，改用六大正式分类',
			})
		}
	}

	return {
		generatedAt: new Date().toISOString(),
		summary,
		categoryStats,
		issues,
	}
}
