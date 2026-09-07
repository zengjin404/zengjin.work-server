import base from '#api_util/base.js'

import aiHandler from './_base/ai.js'
import appHandler from './_base/app.js'
import backupHandler from './_base/backup.js'
import dictHandler from './_base/dict.js'
import keepaliveHandler from './_base/keepalive.js'
import storageHandler from './_base/storage.js'
import translateHandler from './_base/translate.js'
import userHandler from './_base/user.js'
import wsdemoHandler from './_base/wsdemo.js'
import demoHandler from './_demo.js'
import docHandler from './_doc.js'
import fcHandler from './_fc.js'
import fileHandler from './_file.js'
import firebaseHandler from './_firebase.js'
import musicHandler from './_music.js'
import noteHandler from './_note.js'
import shareHandler from './_share.js'
import subHandler from './_sub.js'
import classHandler from './_zone/mzl/class.js'
import studentHandler from './_zone/mzl/student.js'

export default async function masterHandler(req, res) {
	return base.storage.run({ req, resp: res }, async () => {
		// 无论部署后还是 Vercel 本地 Dev，通过 vercel.json 的 rewrite 打过来的请求
		// 其 req.url 保持原始状态，例如: "/api/zone/mzl/student/select?current=1"
		const urlWithoutQuery = req.url.split('?')[0]
		// 分割路径: ['','api','zone','mzl','student','select']
		const segments = urlWithoutQuery.split('/')

		// segment[2] 必定是顶级模块名如 'demo', 'note', 'zone'
		const targetModule = segments[2]
		// array 的截取获得后面的动作 ['mzl', 'student', 'select']
		const fullAction = segments.slice(2)

		// 把 action 参数挂在 req.query 上，完美兼容内部 _demo 等已经成型的结构
		req.query.action = fullAction

		try {
			switch (targetModule) {
				case 'note':
					return await noteHandler(req, res)

				case 'demo':
					return await demoHandler(req, res)

				case 'firebase':
					return await firebaseHandler(req, res)

				case 'base':
					const subModule = fullAction[1] // 例如 'login' 或者是 'dict'
					if (subModule === 'user') {
						return await userHandler(req, res)
					} else if (subModule === 'dict') {
						return await dictHandler(req, res)
					} else if (subModule === 'translate') {
						return await translateHandler(req, res)
					} else if (subModule === 'keepalive') {
						return await keepaliveHandler(req, res)
					} else if (subModule === 'storage') {
						return await storageHandler(req, res)
					} else if (subModule === 'wsdemo') {
						return await wsdemoHandler(req, res)
					} else if (subModule === 'ai') {
						return await aiHandler(req, res)
					} else if (subModule === 'app') {
						return await appHandler(req, res)
					} else if (subModule === 'backup') {
						return await backupHandler(req, res)
					}

					return res.status(404).json({ error: `base 基础网关拦截: 未识别或未挂载的业务模块 '${subModule}'` })

				case 'file':
					return await fileHandler(req, res)

				case 'doc':
					return await docHandler(req, res)

				case 'fc':
					return await fcHandler(req, res)

				case 'sub':
					return await subHandler(req, res)

				case 'share':
					return await shareHandler(req, res)

				case 'music':
					return await musicHandler(req, res)

				case 'zone':
					const zoneName = fullAction[1] // 'mzl'
					const entity = fullAction[2] // 'class' 或 'student'

					if (zoneName === 'mzl') {
						if (entity === 'class') {
							return await classHandler(req, res)
						} else if (entity === 'student') {
							return await studentHandler(req, res)
						}
					}
					return res.status(404).json({ error: `zone 开发区网关拦截: 未识别或未挂载的接口模块 '${zoneName}/${entity}'` })

				default:
					return res.status(404).json({ error: `总路由架构降级拦截: 未知系统级模块 '${targetModule || '空'}'`, path: req.url })
			}
		} catch (error) {
			return res.status(500).json({ error: '网关路由分发环境崩溃', details: error.message })
		}
	})
}
