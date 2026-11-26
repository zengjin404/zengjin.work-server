import pkg from 'pg'

const { Pool } = pkg

// neon
const db = new Pool({
	host: process.env.DB_HOST || 'ep-restless-hill-a5p02wtt-pooler.us-east-2.aws.neon.tech',
	port: process.env.DB_PORT || 5432,
	user: process.env.DB_USER || 'neondb_owner',
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME || 'neondb',
	max: 10, // 连接池最大连接数
	idleTimeoutMillis: 30000, // 连接最大空闲时间
	ssl: {
		require: true,
		rejectUnauthorized: true,
	},
})
export default db
