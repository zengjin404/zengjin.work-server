import { describe, expect, it } from 'vitest'

// 这是**联网冒烟测试**，不是单元测试：它真的去打 Google Identity Toolkit，验证 FIREBASE_WEB_API_KEY 可用。
// 默认跳过 —— 在 googleapis.com 不可达的环境里（本机实测 curl 直接超时、http=000，而 baidu.com 正常）
// 它只会挂到超时再报 Test timed out，让 npm test 的成败取决于网络状况没有意义。
// 需要真验时显式打开（换 key 也一样）：
//   RUN_FIREBASE_LIVE_TEST=1 npx vitest run api_util/__tests__/firebase.test.js
const run_live = process.env.RUN_FIREBASE_LIVE_TEST === '1'

describe('Firebase recaptchaParams Test', () => {
	it.skipIf(!run_live)(
		'should fetch recaptchaSiteKey from Google Identity Toolkit',
		async () => {
			const apiKey = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyAltJyHFfhU0XjUr6ux7xkA6XIdGlVSLGE'
			const response = await fetch(`https://identitytoolkit.googleapis.com/v1/recaptchaParams?key=${apiKey}`)
			const data = await response.json()
			console.log('Firebase recaptchaParams response:', data)
			expect(data).toHaveProperty('recaptchaSiteKey')
			expect(data.recaptchaSiteKey).toBeTruthy()
		},
		20000,
	)
})
