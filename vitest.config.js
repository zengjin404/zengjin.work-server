import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// 服务端测试使用 Node.js 环境
		environment: 'node',
		globals: true,
		include: ['api_util/__tests__/**/*.test.js', '$apps/**/__tests__/**/*.test.js'],
		// 设置环境变量供 crypto.js 和 jwt.js 使用
		env: {
			JWT_SECRET: 'test-jwt-secret-for-unit-tests-only',
			CRYPTO_SECRET: 'test-crypto-secret-for-unit-tests-only',
			// 占位 DB 配置：仅让 getPool 返回真实 Pool 对象（懒连接、不发请求），供 app.test.js 运行时替换 query
			DB: 'supabase',
			DB_SUPABASE_HOST: 'test-host.invalid',
			DB_SUPABASE_PORT: '5432',
			DB_SUPABASE_NAME: 'test',
			DB_SUPABASE_USER: 'test',
			DB_SUPABASE_PASSWORD: 'test',
		},
	},
})
