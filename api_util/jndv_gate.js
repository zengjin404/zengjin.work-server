import jwt from 'jsonwebtoken'

/**
 * jndv 前置问答门：题干、答案与准入凭证
 *
 * 户型图与工位图带同事姓名与部门分布，属于相对隐私的内容，进门前先答一个问题。
 * 这里是**答案的唯一来源**，答案名单刻意不建表、不进数据库：
 *   - 改人 = 改这个数组 + version 加一（version 一变，老凭证与库里的通过标记一起失效，全员重答）；
 *   - 题干与答案字段都**不允许**出现在任何接口响应里，下发只经 gate_public_info()。
 *
 * 通过凭证是一张自签的 JWT（浏览器侧），只在 180 天内证明「这台设备答对过」；
 * 调高 version 或换 JWT_SECRET 都会让它立刻作废。
 */
export const jndv_gate = {
	version: 1,
	// 高亮用 **…** 标记，前端拆成 <strong> 渲染（不经 v-html）
	question: '请写出任意一位 **入职时间** 在 2021 年 12 月 31 日（含）之前、**目前仍在职**、属于 **研发中心** 的同事姓名。',
	// 已确认穷尽：符合「2021 年 12 月 31 日（含）之前入职 + 当前在职 + 研发中心」的人就这 8 位。
	// 将来有增减，除了改这里，必须把 version 一并加一。
	answers: ['王永贞', '刘玉娇', '李昌婷', '石祥玲', '曾进', '王长香', '黄江伟', '冯斌'],
	hint: '填一位同事的姓名即可',
	// 凭证有效期（天）：够长，员工换设备/清缓存后不至于反复重答
	ticketDays: 180,
}

// 有人会把符合条件的两三位一起填进来，这些符号当分隔符拆开逐个认
const ANSWER_SEPARATORS = /[、，,;；/\\|]+/

// 答题限流：同一 IP 每分钟最多答错多少次（尽力而为，见下方注释）
const MAX_FAILURES_PER_MINUTE = 5
const FAILURE_WINDOW_MS = 60 * 1000
const FAILURE_MAP_LIMIT = 5000
const failureMap = new Map()

/** 去掉所有空白并转小写，避免「王 永 贞」「王永贞 」这类写法被误判 */
export function normalize_answer(text) {
	return String(text ?? '')
		.replace(/\s+/g, '')
		.toLowerCase()
}

/** 判断题干答案：整串认得就过，认不得再按分隔符拆开逐个认（任一位命中即通过） */
export function check_answer(text) {
	const known = new Set(jndv_gate.answers.map(normalize_answer))
	if (known.has(normalize_answer(text))) return true
	return String(text ?? '')
		.split(ANSWER_SEPARATORS)
		.some(part => known.has(normalize_answer(part)))
}

/** 只下发可以公开的字段 —— 答案名单永远不经这里出门 */
export function gate_public_info() {
	return {
		version: jndv_gate.version,
		question: jndv_gate.question,
		hint: jndv_gate.hint,
	}
}

function getSecret() {
	const secret = process.env.JWT_SECRET
	if (!secret) throw new Error('环境变量 JWT_SECRET 未配置')
	return secret
}

/**
 * 签发通过凭证
 *
 * 不用 api_util/jwt.js 的 generateAccessToken：那把有效期写死 15 分钟，
 * 而这张凭证要撑 180 天，所以这里内联 jwt.sign 自定义 expiresIn。
 */
export function sign_jndv_ticket() {
	return jwt.sign({ scope: 'jndv_gate', v: jndv_gate.version }, getSecret(), { expiresIn: `${jndv_gate.ticketDays}d` })
}

/** 校验通过凭证：签名、scope、版本三者全对才算数（改版即全体失效） */
export function verify_jndv_ticket(ticket) {
	if (!ticket || typeof ticket !== 'string') return false
	try {
		const decoded = jwt.verify(ticket, getSecret())
		return decoded?.scope === 'jndv_gate' && decoded?.v === jndv_gate.version
	} catch {
		// 过期/伪造/换密钥都走这里，一律当作没通过
		return false
	}
}

/**
 * 取请求来源 IP
 *
 * Vercel 等反向代理后面真实来源在 x-forwarded-for 的第一段；直连时退回 socket 地址。
 */
export function get_req_ip(req) {
	const forwarded = req?.headers?.['x-forwarded-for']
	if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
	return req?.socket?.remoteAddress || req?.ip || 'unknown'
}

/**
 * 是否还允许这个 IP 继续答题
 *
 * 只是「尽力而为」的一层减速带：计数放在进程内存里，多实例 / Serverless 冷启动都会各自从零开始，
 * 重启即清零，够挡住脚本硬猜，但**不是**确定性防护。真要挡死得把失败次数落库或接入 ALTCHA。
 */
export function allow_answer_attempt(ip) {
	const now = Date.now()
	if (failureMap.size > FAILURE_MAP_LIMIT) {
		// 懒清理：只在地图偏大时顺手扫一遍过期条目，避免长期运行无限增长
		for (const [key, hit] of failureMap) {
			if (now - hit.start > FAILURE_WINDOW_MS) failureMap.delete(key)
		}
	}
	const hit = failureMap.get(ip)
	return !hit || now - hit.start > FAILURE_WINDOW_MS || hit.count < MAX_FAILURES_PER_MINUTE
}

/** 记一次答错。答对不计数 —— 正常员工不该被自己的成功尝试消耗额度 */
export function record_answer_failure(ip) {
	const now = Date.now()
	const hit = failureMap.get(ip)
	if (!hit || now - hit.start > FAILURE_WINDOW_MS) {
		failureMap.set(ip, { start: now, count: 1 })
		return
	}
	hit.count += 1
}
