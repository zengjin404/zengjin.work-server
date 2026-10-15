/**
 * 印章导出记录的服务端配置白名单
 *
 * 为什么服务端要再校验一遍: 前端那份 sanitize_config 是给用户看的体验(改坏了当场提示),
 * **不是安全边界** —— 浏览器在用户手里, 改一份 localStorage 或直接发一条 fetch 就绕过去了。
 * 所以这里的原则是「只认识白名单里的字段」, 而且一律拒收、不做夹取:
 *   - 字段缺失  -> 拒收(config_snapshot 是一份完整快照, 缺字段的记录没法比对)
 *   - 未知字段  -> 拒收(静默丢弃会把一次构造好的请求洗成一条看起来正常的记录)
 *   - 形状/类型不对 -> 拒收
 *   - 数值越界  -> 拒收(注意: 前端是夹取, 这里是拒收, 两边故意不同)
 *
 * 边界必须与前端 apps/seal/utils/seal-defaults.js 的 defaultSealConfig / RANGES 对齐。
 * 那边加了字段这边要跟着加: 宁可让请求带着明确错误失败, 也不要存下一份缺字段的快照。
 */

//配置结构版本, 必须与前端 SEAL_CONFIG_VERSION 一致
export const SEAL_CONFIG_VERSION = 1

//服务端认的事件名 —— 只有一个。客户端不能自报「这是游客请求」或「这是管理员导出」
export const SEAL_EVENT_TYPE = 'clean_export_requested'

//导出格式白名单: 首版只存 png 记录, 不接收也不保存任何图片本体
export const SEAL_OUTPUT_FORMATS = ['png']

//载荷字节上限: 一份完整配置约 2~3KB, 64KB 留足余量, 同时挡住「把图片塞进快照」这类用法
export const SEAL_MAX_PAYLOAD_BYTES = 64 * 1024

//JSON 深度上限: 配置本身就 3 层(config → block → field), 留一层余量给外壳
const MAX_DEPTH = 5

//节点总数上限: 挡住「宽而浅」的超大对象绕过深度限制
const MAX_NODES = 2000

/* 字段规格 --------------------------------------------------------------- */

const BOOL = { kind: 'bool' }
/** 文本: max 是 UTF-16 长度上限, 与前端 str() 的截断口径一致 */
const TEXT = max => ({ kind: 'text', max })
/** 数值: int 为真时必须是整数 */
const NUM = (min, max, int = false) => ({ kind: 'num', min, max, int })
/** 枚举: 值与顺序都照抄前端常量 */
const ENUM = (...values) => ({ kind: 'enum', values })
/** 颜色: 前端 normalize_color 只产出 6 位或 8 位十六进制, 这里就只认这两种 */
const COLOR = { kind: 'color' }

const COLOR_PATTERN = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * 文本块骨架
 *
 * 五个槽位的字段名完全一样(可见性/文字/字体/字重 + 各自的几何),
 * 差别只在几何项的取值范围, 所以骨架写一次, 各槽位只声明自己的 ranges。
 */
const TEXT_BLOCK = ranges => ({
	visible: BOOL,
	text: TEXT(60),
	fontFamily: TEXT(120),
	fontWeight: NUM(100, 900, true),
	...ranges,
})

/** 做旧效果: 三处结构相同 */
const EFFECT = {
	enabled: BOOL,
	intensity: NUM(0, 100, true),
	seed: NUM(1, 999999, true),
}

/**
 * 配置白名单 —— 字段名与嵌套结构照抄前端 sanitize_config 的返回值
 *
 * 顺序也照抄: JSONB 不保证键序, 但顺序一致时人工比对快照最省事。
 */
const CONFIG_SPEC = {
	version: ENUM(SEAL_CONFIG_VERSION),
	templateId: TEXT(40),
	shape: ENUM('circle', 'ellipse', 'square', 'rect', 'diamond'),
	color: COLOR,

	preview: {
		background: ENUM('checkerboard', 'white'),
		showGuides: BOOL,
	},

	output: {
		size: ENUM(512, 1024, 2048),
		transparent: BOOL,
		backgroundColor: COLOR,
	},

	mainText: TEXT_BLOCK({
		fontSize: NUM(6, 90),
		letterSpacing: NUM(-5, 30),
		radius: NUM(20, 148),
		startAngle: NUM(-180, 180),
		scaleX: NUM(0.4, 2.5),
		offsetX: NUM(-80, 80),
		offsetY: NUM(-80, 80),
	}),
	subText: TEXT_BLOCK({
		fontSize: NUM(5, 60),
		letterSpacing: NUM(-5, 30),
		radius: NUM(20, 148),
		startAngle: NUM(-180, 180),
		scaleX: NUM(0.4, 2.5),
		offsetX: NUM(-80, 80),
		offsetY: NUM(-80, 80),
	}),
	sampleCode: TEXT_BLOCK({
		fontSize: NUM(5, 60),
		letterSpacing: NUM(-5, 30),
		radius: NUM(20, 148),
		offsetX: NUM(-80, 80),
		offsetY: NUM(-80, 80),
	}),
	bottomText: TEXT_BLOCK({
		fontSize: NUM(6, 80),
		letterSpacing: NUM(-5, 30),
		scaleX: NUM(0.4, 2.5),
		scaleY: NUM(0.4, 2.5),
		offsetX: NUM(-80, 80),
		offsetY: NUM(-80, 80),
	}),
	centerText: TEXT_BLOCK({
		fontSize: NUM(6, 80),
		letterSpacing: NUM(-5, 30),
		scaleX: NUM(0.4, 2.5),
		offsetX: NUM(-80, 80),
		offsetY: NUM(-80, 80),
	}),

	centerSymbol: {
		visible: BOOL,
		mode: ENUM('star', 'char'),
		customChar: TEXT(4),
		fontFamily: TEXT(120),
		size: NUM(8, 160),
		fontWeight: NUM(100, 900, true),
		offsetX: NUM(-80, 80),
		offsetY: NUM(-80, 80),
	},

	borders: {
		outer: {
			visible: BOOL,
			color: COLOR,
			width: NUM(0.5, 20),
			inset: NUM(0, 60),
			dashed: BOOL,
			segments: NUM(4, 200, true),
			gapRatio: NUM(1, 9, true),
		},
		inner: {
			visible: BOOL,
			color: COLOR,
			width: NUM(0.5, 20),
			gap: NUM(0, 60),
		},
		center: {
			visible: BOOL,
			color: COLOR,
			width: NUM(0.5, 20),
			radius: NUM(20, 148),
		},
	},

	effects: {
		noise: EFFECT,
		edgeWear: EFFECT,
		scratches: EFFECT,
	},

	//演示标识只存外观: 这里**没有**开关字段, 「画不画」是客户端渲染策略
	//(watermarkMode), 不是配置能表达的东西 —— 存一份带 enabled:false 的快照,
	//等于承认「关掉标识」是一种合法配置, 那不是我们要的语义。
	demoMark: {
		text: TEXT(12),
		opacity: NUM(0.08, 0.6),
		rotation: NUM(-180, 180),
	},
}

/** 外壳白名单 —— 与 config_snapshot 的列一一对应 */
const PAYLOAD_SPEC = {
	eventType: ENUM(SEAL_EVENT_TYPE),
	templateId: TEXT(40),
	shape: ENUM('circle', 'ellipse', 'square', 'rect', 'diamond'),
	outputFormat: ENUM(...SEAL_OUTPUT_FORMATS),
	outputSize: ENUM(512, 1024, 2048),
	rendererVersion: TEXT(10),
	requestId: TEXT(40),
	configSnapshot: CONFIG_SPEC,
}

//幂等键格式: 前端是「毫秒时间戳36进制-随机串」, 形状固定, 这里按形状收
const REQUEST_ID_PATTERN = /^[0-9a-z]{6,20}-[0-9a-z]{4,20}$/

/** 渲染器版本: 只允许数字与点, 形如 1 / 1.1 */
const RENDERER_VERSION_PATTERN = /^\d{1,3}(?:\.\d{1,2})?$/

/** 校验失败 —— 由调用方翻成给用户看的提示, 不把内部细节吐回去 */
export class SealPayloadError extends Error {
	constructor(message) {
		super(message)
		this.name = 'SealPayloadError'
	}
}

function fail(message) {
	throw new SealPayloadError(message)
}

/** 规格节点(嵌套块) vs 标量: 标量都带 kind */
function is_block(spec) {
	return spec && typeof spec === 'object' && !spec.kind
}

/**
 * 深度与节点数预检
 *
 * 放在解构之前: 一份深度 1 万层或 50 万节点的载荷, 不该等到递归下降时才炸。
 * JSON.parse 的产物不会有环, 所以普通递归计数就够。
 */
function assert_shape_limits(value, depth = 1, counter = { total: 0 }) {
	if (depth > MAX_DEPTH) fail('配置嵌套层数超过上限 ' + MAX_DEPTH)

	counter.total += 1
	if (counter.total > MAX_NODES) fail('配置节点数超过上限 ' + MAX_NODES)

	if (value && typeof value === 'object') {
		const children = Array.isArray(value) ? value : Object.values(value)
		for (const child of children) assert_shape_limits(child, depth + 1, counter)
	}
}

function assert_plain_object(value, path) {
	//数组也是 object, 单独挡掉: 配置里没有任何数组字段, 收到数组一定是构造出来的
	if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path + ' 必须是对象')
}

function check_scalar(value, field, path) {
	switch (field.kind) {
		case 'bool': {
			if (typeof value !== 'boolean') fail(path + ' 必须是布尔值')
			return value
		}
		case 'text': {
			if (typeof value !== 'string') fail(path + ' 必须是字符串')
			if (value.length > field.max) fail(path + ' 长度超过上限 ' + field.max)
			return value
		}
		case 'num': {
			if (typeof value !== 'number' || !Number.isFinite(value)) fail(path + ' 必须是有限数字')
			if (field.int && !Number.isInteger(value)) fail(path + ' 必须是整数')
			if (value < field.min || value > field.max) fail(path + ' 超出范围 ' + field.min + ' ~ ' + field.max)
			return value
		}
		case 'enum': {
			if (!field.values.includes(value)) fail(path + ' 不是允许的取值')
			return value
		}
		case 'color': {
			if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) fail(path + ' 必须是 #RRGGBB 或 #RRGGBBAA')
			return value
		}
		default:
			//规格表写错属于部署期错误, 不该等到线上才以「字段非法」的面目出现
			throw new Error('seal_schema: 未知字段规格 ' + String(field.kind) + ' (' + path + ')')
	}
}

/**
 * 按规格走一遍并产出干净副本
 *
 * 输出对象只由规格表组装 —— 输入里多出来的键在「未知字段」那一步就断了,
 * 所以快照里不可能夹带没在白名单里的东西(含 __proto__ 这类原型链键:
 * JSON.parse 会把它变成普通自有属性, 在这里同样是未知字段而被拒)。
 */
function walk(value, spec, path) {
	assert_plain_object(value, path)

	for (const key of Object.keys(value)) {
		if (!Object.prototype.hasOwnProperty.call(spec, key)) fail(path + ' 含未知字段: ' + key)
	}

	const out = {}
	for (const [key, field] of Object.entries(spec)) {
		const childPath = path + '.' + key
		if (!Object.prototype.hasOwnProperty.call(value, key)) fail(childPath + ' 缺失')
		out[key] = is_block(field) ? walk(value[key], field, childPath) : check_scalar(value[key], field, childPath)
	}
	return out
}

/**
 * 校验并规范化一次导出上报
 *
 * 返回的对象才是可以写进 config_snapshot 的那份配置 —— 外壳字段里的 templateId /
 * shape / outputSize 必须与快照里的同名值一致, 不一致直接拒收:
 * 一条自身矛盾(列上是 A、快照里是 B)的记录, 比没有这条记录还糟。
 *
 * @param {object} raw 请求体
 * @returns {{eventType: string, templateId: string, shape: string, outputFormat: string, outputSize: number, rendererVersion: string, requestId: string, configSnapshot: object}}
 * @throws {SealPayloadError} 任何一项不符合白名单
 */
export function sanitize_export_payload(raw) {
	assert_plain_object(raw, '请求体')

	//先按字节量挡一道: 大载荷没必要再走后面的解析
	const bytes = Buffer.byteLength(JSON.stringify(raw) || '', 'utf8')
	if (bytes > SEAL_MAX_PAYLOAD_BYTES) fail('载荷超过 ' + Math.round(SEAL_MAX_PAYLOAD_BYTES / 1024) + 'KB 上限')

	assert_shape_limits(raw)

	const payload = walk(raw, PAYLOAD_SPEC, 'payload')
	const config = payload.configSnapshot

	if (!REQUEST_ID_PATTERN.test(payload.requestId)) fail('payload.requestId 格式不正确')
	if (!RENDERER_VERSION_PATTERN.test(payload.rendererVersion)) fail('payload.rendererVersion 格式不正确')

	if (payload.templateId !== config.templateId) fail('payload.templateId 与配置快照不一致')
	if (payload.shape !== config.shape) fail('payload.shape 与配置快照不一致')
	if (payload.outputSize !== config.output.size) fail('payload.outputSize 与配置快照不一致')

	return payload
}
