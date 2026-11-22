import fetch from 'node-fetch'

// Vercel Node 环境通常自带 fetch，但若低于 v18 可按需补充，这里采用兼容写法

// 使用用户的 Rest key (建议后续将密钥移至环境变量 .env 中，此处为演示直接声明)
const GOEASY_REST_KEY = 'PR-3b4ced7910ca461085b8937f9893a1c3'
const GOEASY_HOST = 'https://rest-hz.goeasy.io/v2/pubsub/publish'

/**
 * 后端向 GoEasy 发送消息
 *
 * 频道命名规范规划：
 * 1. 个人专属频道：`user_${userId}` (用于系统通知、单聊等个人私有数据，通过消息体复用分发)
 * 2. 预留：公共广播频道：`system_broadcast` (用于全站公告等，将来规划)
 * 3. 预留：群聊频道：`group_${groupId}` (用于群组聊天，将来规划)
 * 4. 预留：游戏房间：`room_${roomId}` (用于棋牌游戏等高频同步，将来规划)
 *
 * @param {string} channel - 目标频道，如 'user_k9l8m7n6o5p4'
 * @param {object} payload - 消息体对象 (需符合 {app, type, data} 规范)
 */
export const publish_message_ws = async (channel, payload) => {
	if (process.env.VITEST && !process.env.TEST_REAL_WS) {
		return { success: true, mocked: true }
	}

	try {
		// Node 环境自带原生 fetch，如需老版本兼容可引入对应 polyfill
		const globalFetch = typeof fetch !== 'undefined' ? fetch : (await import('node-fetch')).default

		const response = await globalFetch(GOEASY_HOST, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				appkey: GOEASY_REST_KEY,
				channel: channel,
				content: typeof payload === 'string' ? payload : JSON.stringify(payload),
			}),
		})

		const result = await response.json()

		if (result && result.code === 200) {
			return { success: true, data: result }
		} else {
			console.error('GoEasy Publish Error:', result)
			return { success: false, error: result }
		}
	} catch (error) {
		console.error('GoEasy Publish Request Failed:', error.message)
		return { success: false, error: error.message }
	}
}
