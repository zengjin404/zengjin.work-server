import { readFileSync } from 'node:fs'

const DATA_URL = new URL('../data.json', import.meta.url)

// 参考色库是手工维护的静态数据：用计数与结构断言锁住基线。
// 增删色值时必须同步更新这里的契约，避免误删、重复或格式漂移。
function read_groups() {
	return JSON.parse(readFileSync(DATA_URL, 'utf8'))
}

function collect_swatches(groups) {
	return groups.flatMap(group => group.list.flatMap(bar => bar.list))
}

describe('color 参考色库数据契约', () => {
	const groups = read_groups()

	it('23 个来源组，组名唯一且都有来源链接', () => {
		expect(groups).toHaveLength(23)
		expect(new Set(groups.map(group => group.name)).size).toBe(23)
		for (const group of groups) {
			expect(group.name).toBeTruthy()
			expect(group.link).toMatch(/^https?:\/\//)
			expect(group.list.length).toBeGreaterThan(0)
			expect(new Set(group.list.map(bar => bar.name)).size).toBe(group.list.length)
		}
	})

	it('301 个色条，组级主色索引不越界', () => {
		const bars = groups.flatMap(group => group.list)
		expect(bars).toHaveLength(301)
		for (const group of groups) {
			if (group.main == null) continue
			expect(Number.isInteger(group.main)).toBe(true)
			for (const bar of group.list) {
				expect(group.main).toBeGreaterThanOrEqual(0)
				expect(group.main).toBeLessThan(bar.list.length)
			}
		}
	})

	it('2587 个槽位 = 2494 HEX + 46 渐变 + 41 分隔符 + 6 空位', () => {
		const swatches = collect_swatches(groups)
		const hex = swatches.filter(value => value.startsWith('#'))
		const gradients = swatches.filter(value => value.startsWith('linear-gradient('))

		expect(swatches).toHaveLength(2587)
		expect(hex).toHaveLength(2494)
		expect(gradients).toHaveLength(46)
		expect(swatches.filter(value => value === 'hr')).toHaveLength(41)
		expect(swatches.filter(value => value === '')).toHaveLength(6)

		for (const value of hex) {
			expect(value).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
		}
		for (const value of gradients) {
			expect(value.match(/#/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
		}
	})

	it('大小写并存的中文名字段原样保留（nameZH 100 / namezh 13）', () => {
		const bars = groups.flatMap(group => group.list)
		expect(bars.filter(bar => 'nameZH' in bar)).toHaveLength(100)
		expect(bars.filter(bar => 'namezh' in bar)).toHaveLength(13)
		expect(bars.some(bar => 'nameZH' in bar && 'namezh' in bar)).toBe(false)
	})

	it('3 个暗色组与对应亮色组同名（后缀 (dark)）', () => {
		const names = new Set(groups.map(group => group.name))
		const darkGroups = groups.filter(group => group.name.endsWith(' (dark)'))

		expect(darkGroups).toHaveLength(3)
		for (const group of darkGroups) {
			expect(names.has(group.name.replace(' (dark)', ''))).toBe(true)
		}
	})
})
