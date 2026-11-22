/**
 * api_util/cards_schema.js 入参白名单测试
 *
 * 重点守卫：
 *  - 北京时间字面值不能被服务器时区二次换算（老实现会 +8 小时）
 *  - 进度同 key 去重取最早/最晚
 *  - 渲染配置拒绝原型污染、超深与超大
 *  - 素材 URL / 类型白名单
 */
import { describe, expect, it } from 'vitest'

import {
	CardsPayloadError,
	sanitize_assets,
	sanitize_cognition_settings,
	sanitize_event_payload,
	sanitize_favorite_payload,
	sanitize_item_payload,
	sanitize_play_payload,
	sanitize_progress_payload,
	sanitize_render_config,
	sanitize_timestamp,
	suggest_card_key,
} from '#api_util/cards_schema.js'

describe('cards_schema — 卡片入参', () => {
	it('可以根据分类与文字自动生成 card_key', () => {
		expect(suggest_card_key('animal', { label: '兔子', en_label: 'rabbit' })).toBe('animal_rabbit')
		expect(suggest_card_key('number', { label: '1' })).toBe('number_1')
		expect(suggest_card_key('fruit', { label: '苹果', pinyin: 'píng guǒ' })).toBe('fruit_ping_guo')
		expect(suggest_card_key('', { label: '猫' })).toBe('card_card')
	})

	it('不再要求或接受前端渲染字段', () => {
		const payload = sanitize_item_payload({
			card_key: 'audit_card',
			category_id: 'cc_animal',
			label: '猫',
			play_modes: ['recognize'],
			render_type: 'svg',
			render_config: { kind: 'illustration', key: 'animal_cat' },
		})
		expect(payload.render_type).toBeUndefined()
		expect(payload.render_config).toBeUndefined()
		expect(payload.play_modes).toBe('recognize')
	})
})

describe('cards_schema — 时间', () => {
	it('北京时间字面值原样保留（不做时区二次换算）', () => {
		expect(sanitize_timestamp('2026-11-01 10:20:30')).toBe('2026-11-01 10:20:30')
		expect(sanitize_timestamp('2026-11-01T10:20:30')).toBe('2026-11-01 10:20:30')
	})

	it('拒绝非法格式、未来时间与 2000 年前的脏数据', () => {
		expect(() => sanitize_timestamp('not-a-date')).toThrow(CardsPayloadError)
		expect(() => sanitize_timestamp('2999-01-01 00:00:00')).toThrow('不能晚于当前时间')
		expect(sanitize_timestamp('0000-01-01 00:00:00')).toBe('')
		expect(sanitize_timestamp('')).toBe('')
	})
})

describe('cards_schema — 进度', () => {
	it('同一 cardKey 去重：首次取更早，最近取更晚', () => {
		const list = sanitize_progress_payload({
			items: [
				{ cardKey: 'animal_cat', exploredAt: '2026-11-02 10:00:00', lastExploredAt: '2026-11-03 10:00:00' },
				{ cardKey: 'animal_cat', exploredAt: '2026-11-01 08:00:00', lastExploredAt: '2026-11-05 10:00:00' },
			],
		})
		expect(list).toEqual([{ cardId: 'animal_cat', cardKey: 'animal_cat', exploredAt: '2026-11-01 08:00:00', lastExploredAt: '2026-11-05 10:00:00' }])
	})

	it('拒绝非法 cardKey 与超量批次', () => {
		expect(() => sanitize_progress_payload({ items: [{ cardKey: '../x', exploredAt: '2026-11-01 10:00:00' }] })).toThrow('卡片标识不合法')
		expect(() => sanitize_progress_payload({ items: new Array(501).fill({ cardKey: 'animal_cat' }) })).toThrow('最多同步 500 条')
	})

	it('最近探索早于首次探索时自动纠正', () => {
		const [item] = sanitize_progress_payload({
			items: [{ cardKey: 'animal_cat', exploredAt: '2026-11-05 10:00:00', lastExploredAt: '2026-11-01 10:00:00' }],
		})
		expect(item.exploredAt).toBe('2026-11-01 10:00:00')
		expect(item.lastExploredAt).toBe('2026-11-01 10:00:00')
	})
})

describe('cards_schema — 渲染配置与素材', () => {
	it('接受 JSON 字符串并解析为对象', () => {
		expect(sanitize_render_config('{"kind":"number","value":3}')).toEqual({ kind: 'number', value: 3 })
		expect(sanitize_render_config('')).toEqual({})
	})

	it('拒绝原型污染字段与过深嵌套', () => {
		expect(() => sanitize_render_config('{"__proto__":{"x":1}}')).toThrow('非法字段')
		const deep = { a: { b: { c: { d: { e: 1 } } } } }
		expect(() => sanitize_render_config(deep)).toThrow('嵌套过深')
	})

	it('素材只接受受支持类型与 http/绝对路径，支持 emoji 与主图标记', () => {
		const assets = sanitize_assets([
			{ asset_type: 'image', asset_url: 'https://drive.zengjin.work/a.webp', mime_type: 'image/webp', is_primary: true },
			{ asset_type: 'emoji', emoji: '🍎', is_random: true },
			{ asset_type: 'sound', asset_url: '/local/a.mp3' },
		])
		expect(assets).toHaveLength(3)
		expect(assets[0].sort_order).toBe(0)
		expect(assets[0].is_primary).toBe(true)
		expect(assets[1].asset_url).toBe('emoji:🍎')
		expect(assets[1].metadata.emoji).toBe('🍎')
		expect(() => sanitize_assets([{ asset_type: 'video', asset_url: 'https://x/y.mp4' }])).toThrow('素材类型不支持')
		expect(() => sanitize_assets([{ asset_type: 'image', asset_url: 'javascript:alert(1)' }])).toThrow('素材地址不合法')
	})

	it('事件与收藏只接受白名单值', () => {
		expect(sanitize_event_payload({ events: [{ type: 'card_view', objectId: 'animal_cat' }] })).toEqual([{ type: 'card_view', objectId: 'animal_cat' }])
		expect(() => sanitize_event_payload({ events: [{ type: 'click_child', objectId: '' }] })).toThrow('统计事件类型不支持')
		expect(sanitize_favorite_payload({ cardKey: 'animal_cat', favorite: true })).toEqual({ cardId: 'animal_cat', cardKey: 'animal_cat', favorite: true })
		expect(() => sanitize_favorite_payload({ cardKey: 'animal_cat', favorite: 'yes' })).toThrow('布尔值')
	})
})

describe('cards_schema — 对局', () => {
	it('完成数不能大于总数', () => {
		expect(() => sanitize_play_payload({ mode: 'memory', requestId: 'req-12345678', totalPairs: 4, completedPairs: 5, duration: 10 })).toThrow(
			'完成配对数不能大于总配对数',
		)
	})

	it('拒绝不支持的玩法与请求标识缺失', () => {
		expect(() => sanitize_play_payload({ mode: 'racing', requestId: 'req-12345678' })).toThrow('玩法不支持')
		expect(() => sanitize_play_payload({ mode: 'memory' })).toThrow('缺少请求标识')
	})
})

describe('cards_schema — 认知设置', () => {
	it('v2 合法设置原样收敛', () => {
		const settings = sanitize_cognition_settings({
			version: 2,
			globalMode: 'random_image',
			overrides: { recognize: 'inherit', connect: 'fixed_image', memory: 'image_text' },
			gameOptions: { connect: { pairCount: 5 }, memory: { pairCount: 10, previewEnabled: false } },
		})
		expect(settings.version).toBe(2)
		expect(settings.globalMode).toBe('random_image')
		expect(settings.overrides).toEqual({ recognize: 'inherit', connect: 'fixed_image', memory: 'image_text' })
		expect(settings.gameOptions.connect.pairCount).toBe(5)
		expect(settings.gameOptions.memory.pairCount).toBe(10)
		expect(settings.gameOptions.memory.previewEnabled).toBe(false)
	})

	it('旧版 v1 设置平滑迁移至 v2', () => {
		const settings = sanitize_cognition_settings({
			cognitionPreset: 'literacy',
			gameCognitionModes: { recognize: 'inherit', matching: 'visual', memory: 'literacy' },
			gameOptions: { matching: { pairCount: 5 }, memory: { pairCount: 8, previewEnabled: true } },
		})
		expect(settings.version).toBe(2)
		expect(settings.globalMode).toBe('image_text')
		expect(settings.overrides).toEqual({ recognize: 'inherit', connect: 'fixed_image', memory: 'image_text' })
		expect(settings.gameOptions.connect.pairCount).toBe(5)
	})

	it('随机图片覆盖在旧版别名中近似为 visual，与客户端序列化一致', () => {
		const settings = sanitize_cognition_settings({
			globalMode: 'image_text',
			overrides: { connect: 'random_image' },
		})
		expect(settings.overrides.connect).toBe('random_image')
		expect(settings.gameCognitionModes.matching).toBe('visual')
		expect(settings.cognitionPreset).toBe('literacy')
	})

	it('未知值与缺失字段回退默认值', () => {
		const settings = sanitize_cognition_settings({ cognitionPreset: 'x', gameCognitionModes: { memory: 'x' } })
		expect(settings.globalMode).toBe('fixed_image')
		expect(settings.overrides).toEqual({ recognize: 'inherit', connect: 'inherit', memory: 'inherit' })
		expect(settings.gameOptions.connect.pairCount).toBe(4)
		expect(settings.gameOptions.memory).toEqual({ pairCount: 6, previewEnabled: true })
	})

	it('拒绝非对象与超大载荷', () => {
		expect(() => sanitize_cognition_settings([])).toThrow('必须是对象')
		expect(() => sanitize_cognition_settings({ padding: 'x'.repeat(9000) })).toThrow('不能超过 8KB')
	})
})

describe('cards_schema — 素材主图与 id 完整性', () => {
	it('拒绝停用的主图', () => {
		expect(() => sanitize_assets([{ asset_type: 'image', asset_url: 'https://cdn/a.webp', is_primary: true, is_enabled: false }])).toThrow('主图不能停用')
	})

	it('非视觉素材不会被当作主图', () => {
		const assets = sanitize_assets([
			{ asset_type: 'sound', asset_url: '/a.mp3', is_primary: true },
			{ asset_type: 'image', asset_url: 'https://cdn/a.webp', is_enabled: true },
		])
		expect(assets[0].is_primary).toBe(false)
		expect(assets[1].is_primary).toBe(true)
	})

	it('多个主图只保留第一个', () => {
		const assets = sanitize_assets([
			{ asset_type: 'image', asset_url: 'https://cdn/a.webp', is_primary: true },
			{ asset_type: 'emoji', emoji: '🍎', is_primary: true },
		])
		expect(assets.filter(asset => asset.is_primary)).toHaveLength(1)
		expect(assets[0].is_primary).toBe(true)
		expect(assets[1].is_primary).toBe(false)
	})

	it('没有显式主图时只自动选择已启用视觉素材', () => {
		const assets = sanitize_assets([
			{ asset_type: 'image', asset_url: 'https://cdn/a.webp', is_enabled: false },
			{ asset_type: 'emoji', emoji: '🍎', is_enabled: true },
		])
		expect(assets[0].is_primary).toBe(false)
		expect(assets[1].is_primary).toBe(true)
	})

	it('拒绝重复素材 id 与超过 20 字符的 id', () => {
		expect(() =>
			sanitize_assets([
				{ id: 'same-id', asset_type: 'image', asset_url: 'https://cdn/a.webp' },
				{ id: 'same-id', asset_type: 'image', asset_url: 'https://cdn/b.webp' },
			]),
		).toThrow('素材 id 重复')
		expect(() => sanitize_assets([{ id: 'x'.repeat(21), asset_type: 'image', asset_url: 'https://cdn/a.webp' }])).toThrow('不能超过 20 个字符')
	})
})
