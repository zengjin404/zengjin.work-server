import fs from 'fs'
import base from '#api_util/base.js'
import db from '#api_util/db.js'

async function reseed() {
	console.log('--- 开始 CARDS 数据全量重建与入库 ---')

	const rawData = JSON.parse(fs.readFileSync('tools/parsed_cards.json', 'utf8'))
	const NOW_SQL = "(now() AT TIME ZONE 'Asia/Shanghai')"

	// 1. 清理旧数据表
	console.log('1. 清理旧数据表...')
	await db.query('DELETE FROM cards_asset')
	await db.query('DELETE FROM cards_user_progress')
	await db.query('DELETE FROM cards_play_record')
	await db.query('DELETE FROM cards_item')
	await db.query('DELETE FROM cards_category')
	await db.query("DELETE FROM admin_notification WHERE app_code = 'cards'")

	const seedCategories = []
	const seedItems = []
	const seedAssets = []

	let categoryCount = 0
	let cardCount = 0
	let assetCount = 0

	console.log('2. 逐类生成 base.getId() 并写入数据库...')

	for (const catData of rawData) {
		const categoryId = base.getId()
		categoryCount++

		await db.query(
			`INSERT INTO cards_category
				(id, name, parent_id, description, icon, theme_color, sort_order, is_enabled, publish_status, createtime)
			 VALUES ($1, $2, '', $3, $4, $5, $6, true, 1, ${NOW_SQL})`,
			[categoryId, catData.name, catData.desc, catData.icon, catData.color, catData.sort],
		)

		seedCategories.push({
			id: categoryId,
			name: catData.name,
			description: catData.desc,
			icon: catData.icon,
			theme_color: catData.color,
			sort_order: catData.sort,
		})

		for (const card of catData.cards) {
			const cardId = base.getId()
			cardCount++

			// 针对包子等没有标准单一 emoji 的，不写入 emoji 资产，留空供后续手动录入
			const hasEmoji = Boolean(card.emoji && card.emoji !== '包子插画' && card.emoji !== '挖掘机插画' && !card.emoji.includes('插画'))

			await db.query(
				`INSERT INTO cards_item
					(id, category_id, label, pinyin, en_label, description, knowledge, play_modes, sort_order, is_enabled, publish_status, createtime)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, 'recognize,connect,memory', $8, true, 1, ${NOW_SQL})`,
				[cardId, categoryId, card.label, card.pinyin || '', card.en_label || '', card.description || '', card.knowledge || '', card.sort_order || 0],
			)

			seedItems.push({
				id: cardId,
				category_id: categoryId,
				label: card.label,
				pinyin: card.pinyin || '',
				en_label: card.en_label || '',
				description: card.description || '',
				knowledge: card.knowledge || '',
				play_modes: 'recognize,connect,memory',
				sort_order: card.sort_order || 0,
				publish_status: 1,
				is_enabled: true,
			})

			if (hasEmoji) {
				const assetId = base.getId()
				assetCount++
				await db.query(
					`INSERT INTO cards_asset
						(id, card_id, asset_type, asset_url, mime_type, sort_order, is_primary, is_enabled, is_random, metadata, createtime)
					 VALUES ($1, $2, 'emoji', $3, 'image/emoji', 10, true, true, true, $4::jsonb, ${NOW_SQL})`,
					[assetId, cardId, `emoji:${card.emoji}`, JSON.stringify({ emoji: card.emoji })],
				)

				seedAssets.push({
					id: assetId,
					card_id: cardId,
					asset_type: 'emoji',
					asset_url: `emoji:${card.emoji}`,
					is_primary: true,
					metadata: { emoji: card.emoji },
				})
			}
		}
	}

	// 3. 更新版本控制
	console.log('3. 更新版本号 cards_content_version...')
	await db.query(
		`INSERT INTO cards_content_version
			(id, version, category_version, item_version, asset_version, seed_version, updatetime)
		 VALUES ('cards', 100, 100, 100, 100, 1, ${NOW_SQL})
		 ON CONFLICT (id) DO UPDATE SET
			version = cards_content_version.version + 10,
			category_version = cards_content_version.category_version + 10,
			item_version = cards_content_version.item_version + 10,
			asset_version = cards_content_version.asset_version + 10,
			seed_version = 1,
			updatetime = ${NOW_SQL}`,
	)

	console.log(`入库统计完成：`)
	console.log(`- 分类: ${categoryCount} 个`)
	console.log(`- 卡片: ${cardCount} 张`)
	console.log(`- 主图Emoji素材: ${assetCount} 个`)

	// 保存生成好的种子数据镜像供 cards_seed.js 使用
	fs.writeFileSync(
		'tools/seeded_dump.json',
		JSON.stringify(
			{
				categories: seedCategories,
				items: seedItems,
			},
			null,
			2,
		),
		'utf8',
	)

	console.log('已导出 tools/seeded_dump.json')
	process.exit(0)
}

reseed().catch(err => {
	console.error('入库失败:', err)
	process.exit(1)
})
