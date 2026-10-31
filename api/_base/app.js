import { requireAuth } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import crud from '#api_util/crud.js'
import db from '#api_util/db.js'

// 网站首页应用清单 (系统级基础表 base_app)
// 公开接口 get.home 仅返回 show=true AND status=1 的正式应用；
// 写操作 (CRUD) 统一 requireAuth 管理员鉴权，供 admin 应用管理页消费。

// 深拷贝 crud：actions.get/post 必须是全新对象，否则覆写会污染共享的 crud 单例
// （浅拷贝时 actions.get === crud.get，requireAuth 包装会泄漏到其他模块）
const actions = {
	get: { ...crud.get },
	post: { ...crud.post },
}

// 注意: fields 必须含 id —— crud.post.insert 会先赋 body.id 再按 fields 组装 INSERT 列
// 若缺 id, 主键无默认值将直接报错; 与 dict/note 等模块约定一致
// image: 首页大卡封面图 URL (留空则前端按 icon_color 生成主题色封面降级)
const fields = 'id,name,title,alias,desc,icon,icon_color,category,url,image,featured,tag,visibility,status,show,sort,createtime,updatetime'.split(',')
const valids = 'name,title,category'.split(',')

// 种子数据预设：[name, title, alias, desc, icon, icon_color, category, url, featured, tag, status, show, sort]
const presets = [
	// ---- 旗舰置顶 (featured=1, 进 Hero Dock) ----
	[
		'ai',
		'Zen AI 对话',
		'Zen AI, 聊天, 对话, 大模型, ChatGPT',
		'多模型 AI 对话，支持联网搜索与深度推理',
		'fa-regular fa-comment-dots',
		'#4f6bff',
		'daily,dev',
		'',
		1,
		'NEW',
		1,
		true,
		10,
	],
	[
		'fc',
		'FC 红白机游戏厅',
		'红白机, 游戏, 小霸王, 卡带, NES',
		'在线红白机游戏厅，重温 FC 经典',
		'fa-regular fa-gamepad',
		'#ef5350',
		'game',
		'',
		1,
		'HOT',
		1,
		true,
		20,
	],
	[
		'music',
		'增进工坊·音乐盒',
		'音乐盒, 播放器, 歌词, LRC',
		'音乐播放器，支持 LRC 歌词',
		'fa-regular fa-music',
		'#ab47bc',
		'daily,media',
		'',
		1,
		'',
		1,
		true,
		30,
	],
	['time', '计时器 / 秒表', '秒表, 计时, 番茄钟, 倒计时', '计时器 / 秒表 / 倒计时', 'fa-regular fa-stopwatch', '#26a69a', 'daily', '', 1, '', 1, true, 40],
	['note', '云端笔记', '笔记, 备忘录, 便签', '轻量云端笔记', 'fa-regular fa-note-sticky', '#ffb300', 'daily,dev', '', 1, '', 1, true, 50],

	// ---- 常规应用 (featured=0) ----
	['jq', '军旗卡牌', '军棋, 卡牌, 对弈', '军旗卡牌小游戏', 'fa-regular fa-chess-pawn', '#66bb6a', 'game', '', 0, '', 1, true, 100],
	['lucky', '幸运抽奖', '抽奖, 转盘, 随机', '幸运大转盘抽奖', 'fa-regular fa-gift', '#ff7043', 'game,daily', '', 0, '', 1, true, 110],
	['qjt', '全景图工具', '全景, 360, 全景图', '全景图片查看与生成', 'fa-regular fa-panorama', '#5c6bc0', 'media,gis', '', 0, '', 1, true, 120],
	['todo', 'TODO 待办', '待办, 清单, 任务', 'TODO 待办清单', 'fa-regular fa-square-check', '#9ccc65', 'daily', '', 0, '', 1, true, 130],
	[
		'base64_qoder',
		'Base64 图片工具',
		'base64图片, 图片转码, 预览',
		'Base64 图片编码预览工具',
		'fa-regular fa-image',
		'#4dd0e1',
		'media,dev',
		'',
		0,
		'',
		1,
		true,
		140,
	],
	[
		'base64_trae',
		'Base64 转换',
		'base64转换, 编解码',
		'Base64 与文本互转',
		'fa-regular fa-arrow-right-arrow-left',
		'#26c6da',
		'dev,daily',
		'',
		0,
		'',
		1,
		true,
		150,
	],
	['char', '字符大全', '字符, 转义, Unicode', '字符编码大全', 'fa-regular fa-keyboard', '#78909c', 'dev,daily', '', 0, '', 1, true, 160],
	// 印章生成器的图标与配色取自印章自身: 图标用图章, 主题色用默认印色 #C83232
	[
		'seal',
		'印章生成器',
		'印章, 盖章, 图章, 电子印章, 做旧, 透明png',
		'演示用印章图案生成, 本地渲染导出透明 PNG',
		'fa-regular fa-stamp',
		'#C83232',
		'media',
		'',
		0,
		'',
		1,
		true,
		165,
	],
	[
		'qrcode',
		'二维码生成器',
		'二维码, 二维码生成, 二维码识别, 二维码美化, 解码, 扫码',
		'在线生成与识别二维码，支持自定义样式、Logo 与本地无损导出',
		'fa-regular fa-qrcode',
		'#0052d9',
		'daily',
		'',
		0,
		'',
		1,
		true,
		168,
	],
	[
		'color',
		'色彩工具箱',
		'颜色转换, 配色设计, 色阶, 渐变, 对比度, 取色, 色板, Color Tools',
		'颜色转换、配色设计、渐变编辑与色彩分析工具集',
		'fa-regular fa-droplet',
		'#ec407a',
		'daily,dev',
		'',
		1,
		'',
		1,
		true,
		170,
	],
	['cursor', '光标预览', '光标, 鼠标, 样式', 'CSS 光标样式预览', 'fa-regular fa-arrow-pointer', '#8d6e63', 'dev', '', 0, '', 1, true, 180],
	['fa', 'Font Awesome 图标', 'font awesome, 图标库, 图标', 'Font Awesome 图标速查', 'fa-solid fa-icons', '#3f51b5', 'dev,media', '', 0, '', 1, true, 190],
	['fa5', 'FA5 图标库', 'fa5, 图标库, 图标', 'FA5 图标库检索', 'fa-regular fa-shapes', '#3949ab', 'dev,media', '', 0, '', 1, true, 200],
	['ti', 'Tabler 图标', 'tabler, 图标库, 图标', 'Tabler 图标速查', 'fa-regular fa-table-cells', '#1e88e5', 'dev,media', '', 0, '', 1, true, 210],
	['flex', 'Flex 布局演示', 'flex, css, 弹性盒', 'Flex 布局可视化演示', 'fa-regular fa-layer-group', '#00897b', 'dev', '', 0, '', 1, true, 220],
	['key2', '按键检测', '按键, 键盘, keydown', '按键码实时检测', 'fa-regular fa-keyboard', '#7e57c2', 'dev,daily', '', 0, '', 1, true, 230],
	['llq', '设备信息', '设备, 硬件, navigator', '设备与浏览器信息', 'fa-regular fa-laptop', '#00acc1', 'dev,daily', '', 0, '', 1, true, 240],
	['cameracapture', '摄像头采集', '摄像头, 相机, 采集, 人脸', '摄像头采集与截图', 'fa-regular fa-camera', '#fb8c00', 'media,daily', '', 0, '', 1, true, 250],
	[
		'camera',
		'摄像头调试器',
		'摄像头, 相机, 麦克风, 调试, 分辨率, 帧率',
		'摄像头与麦克风综合调试, 分辨率测试与检测报告',
		'fa-regular fa-camera-retro',
		'#0052d9',
		'media,dev',
		'',
		0,
		'',
		1,
		true,
		255,
	],
	[
		'mic',
		'Mic Lab · 麦克风调试器',
		'麦克风, 录音, 音频, 电平, 频谱, 调试',
		'麦克风设备能力、实时电平与录音调试, 本地检测报告',
		'fa-regular fa-microphone',
		'#0f9d76',
		'media,daily',
		'',
		0,
		'',
		1,
		true,
		257,
	],
	['gis', 'GIS 综合应用', 'gis, 地图, 地理', 'GIS 综合应用集', 'fa-regular fa-earth-asia', '#43a047', 'gis,dev', '', 0, '', 1, true, 260],
	['mars3d', 'Mars3D 实例', '三维, 3d, 地球, cesium', 'Mars3D 三维地球实例', 'fa-regular fa-globe', '#f4511e', 'gis,dev', '', 0, '', 1, true, 270],
	['threed', '3D 模型', '3d模型, three, 三维', '3D 模型在线预览', 'fa-regular fa-cube', '#5e35b1', 'gis,media', '', 0, '', 1, true, 280],
	['tile2d', '正射瓦片', '瓦片, 正射, 影像', '正射影像瓦片工具', 'fa-regular fa-border-all', '#039be5', 'gis', '', 0, '', 1, true, 290],
	['tileset', '3D Tiles', '3dtiles, 倾斜摄影, 三维瓦片', '3D Tiles 倾斜摄影加载', 'fa-regular fa-cubes', '#c0ca33', 'gis', '', 0, '', 1, true, 300],
	['case', '案例集', '案例, 示例, 合集', '各类技术案例合集', 'fa-regular fa-flask', '#90a4ae', 'dev', '', 0, '', 1, true, 310],
	['admin', '管理后台', '管理后台, 系统, 控制台', '平台管理后台', 'fa-regular fa-screwdriver-wrench', '#607d8b', 'dev,daily', '', 0, '', 1, true, 320],

	// ---- 框架模板 (status=1 正式但默认下架, 仅 admin 可上架) ----
	['prime', 'Prime 框架模板', 'prime, 框架, 模板', 'Prime 框架模板', 'fa-regular fa-diagram-project', '#607d8b', 'dev', '', 0, '', 1, false, 330],
	['wired', 'Wired 手绘风', 'wired, 手绘, 组件', 'Wired 手绘风组件库', 'fa-regular fa-diagram-project', '#607d8b', 'dev', '', 0, '', 1, false, 340],
	['control', '控件库模板', 'control, 控件, 模板', '控件库模板', 'fa-regular fa-diagram-project', '#607d8b', 'dev', '', 0, '', 1, false, 350],
]

// 核心初始化状态（ed 后缀命名）
let dbInitialized = false

/**
 * 确保表结构与种子数据已初始化 (异步，首个请求触发)
 * 种子采用「幂等增量补齐」：计数不足 presets.length 时用 ON CONFLICT DO NOTHING 补插，
 * 云端断连导致的半种子会在下一次请求自动补齐，无需事务也能自愈
 */
async function ensure_dbInitialized_async() {
	if (dbInitialized) return

	// 建表（desc 为 Postgres 非保留关键字，按 ai.js 惯例加引号规避歧义）
	await db.query(`
		CREATE TABLE IF NOT EXISTS base_app (
			id         VARCHAR(20) PRIMARY KEY,
			name       VARCHAR(50)  NOT NULL UNIQUE,
			title      VARCHAR(100) NOT NULL,
			alias      VARCHAR(100) DEFAULT '',
			"desc"     VARCHAR(255) DEFAULT '',
			icon       VARCHAR(100) DEFAULT '',
			icon_color VARCHAR(20)  DEFAULT '',
			category   VARCHAR(100) DEFAULT 'daily',
			url        VARCHAR(150) DEFAULT '',
			image      VARCHAR(500) DEFAULT '',
			featured   SMALLINT     DEFAULT 0,
			tag        VARCHAR(20)  DEFAULT '',
			visibility VARCHAR(20)  DEFAULT 'public',
			status     INT          DEFAULT 1,
			show       BOOLEAN      DEFAULT true,
			sort       INT          DEFAULT 0,
			createtime TIMESTAMPTZ  DEFAULT NOW(),
			updatetime TIMESTAMPTZ
		);
	`)
	await db.query('CREATE INDEX IF NOT EXISTS idx_base_app_show_status_sort ON base_app (show, status, sort)')
	// 幂等迁移：为存量表补齐 image 封面列（新表已在 CREATE TABLE 内置）
	await db.query(`ALTER TABLE base_app ADD COLUMN IF NOT EXISTS image VARCHAR(500) DEFAULT ''`)
	// 幂等迁移：扩大 category 字段长度以支持多分类存储
	await db.query(`ALTER TABLE base_app ALTER COLUMN category TYPE VARCHAR(100)`)

	// 幂等迁移：将旧分类平滑过渡到新分类规范
	await db.query(`
		UPDATE base_app SET category = CASE
			WHEN category = 'ai' THEN 'daily,dev'
			WHEN category = 'tool' THEN 'daily,dev'
			WHEN category = 'office' THEN 'daily'
			WHEN category = 'map' THEN 'gis'
			WHEN category = 'frame' THEN 'dev'
			WHEN category = 'demo' THEN 'dev'
			ELSE category
		END
		WHERE category IN ('ai', 'tool', 'office', 'map', 'frame', 'demo')
	`)

	// 幂等迁移：旧「摄像头采集」应用由 camera 更名为 cameracapture，把 camera 让位给新的摄像头调试器
	// 仅在 cameracapture 尚不存在且旧行仍是原名字/标题时执行，避免覆盖 admin 的手工调整
	await db.query(`
		UPDATE base_app SET
			id = 'cameracapture',
			name = 'cameracapture',
			title = '摄像头采集',
			alias = '摄像头, 相机, 采集, 人脸',
			"desc" = '摄像头采集与截图',
			icon = 'fa-regular fa-camera',
			icon_color = '#fb8c00',
			category = 'media,daily',
			sort = 250
		WHERE name = 'camera'
			AND title = '摄像头采集'
			AND NOT EXISTS (SELECT 1 FROM base_app WHERE name = 'cameracapture')
	`)

	// 幂等补齐种子：仅当行数不足时补插缺失 name（不覆盖已存在行，不干扰 admin 上/下架调整）
	const countRes = await db.query('SELECT COUNT(*) FROM base_app')
	if (parseInt(countRes.rows[0].count) < presets.length) {
		for (const p of presets) {
			await db.query(
				`
				INSERT INTO base_app (id, name, title, alias, "desc", icon, icon_color, category, url, featured, tag, visibility, status, show, sort)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'public', $12, $13, $14)
				ON CONFLICT (name) DO NOTHING
			`,
				[base.getId(), ...p],
			)
		}
	}

	dbInitialized = true
}

// 首页公开列表：仅返回上架且正式的应用（无需登录），供 Bento / Cmd+K 消费
actions.get.home = async () => {
	try {
		const { rows } = await db.query(
			`
			SELECT name, title, alias, "desc", icon, icon_color, category, url, image, featured, tag
			FROM base_app
			WHERE show = true AND status = 1
			ORDER BY featured DESC, sort ASC, createtime ASC
		`,
			[],
		)
		return base.respSuccess({ msg: '查询成功', data: base.formatDbRows(rows) })
	} catch (error) {
		return base.respFailure({ msg: `查询失败：${error.message}` })
	}
}

// 写操作 / 管理端查询统一管理员鉴权
actions.get.select = requireAuth(crud.get.select)
actions.get.detail = requireAuth(crud.get.detail)
actions.post.insert = requireAuth(crud.post.insert)
actions.post.update = requireAuth(crud.post.update)
actions.post.delete = requireAuth(crud.post.delete)

export default async (req, resp) => {
	base.req = req
	base.resp = resp
	const { method, action, query, body } = base.getReqInfo()

	try {
		// 建表/种子对所有入口统一前置（含管理端 CRUD），幂等缓存保证只执行一次
		await ensure_dbInitialized_async()

		if (actions[method]?.[action]) {
			const handler = actions[method][action]
			return await handler({ table: 'base_app', fields, valids, req, resp, query, body })
		}
		return base.respFailure({ msg: '请求类型或方法无效' })
	} catch (error) {
		return base.respFailure({ msg: `服务器内部错误: ${error.message}` })
	}
}
