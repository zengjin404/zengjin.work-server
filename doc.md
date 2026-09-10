## `api` 中与 `share` 相关的 API

```js
import { requireAdmin } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import db from '#api_util/db.js'

const actions = {
	get: {},
	post: {},
}

// shareCode 字符集: 去除易混淆的 0/o/1/l (保留 i)
const CODE_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789'
const CODE_LENGTH = 4

// 分享服务 Worker 地址(非机密, 可在环境变量覆盖)
const workerBase = (process.env.SHARE_ADMIN_WORKER_URL || process.env.SHARE_WORKER_URL || 'https://share.zengjin.work').replace(/\/+$/, '')
// Worker 内部调用密钥(机密, 与 Worker 侧 SHARE_ADMIN_SECRET 保持一致)
const workerAdminSecret = process.env.SHARE_ADMIN_SECRET || ''

/**
 * 调用 Worker 解析 OneDrive 分享链接, 获取云端文件元数据
 * 约定契约: POST {workerBase}/internal/share/resolve
 *   请求头: X-Share-Admin-Secret
 *   请求体: { shareUrl }
 *   响应体: { driveItemId, fileName, fileSize, mimeType, webUrl }
 * 仅服务端调用, 返回结果只允许在服务端落库, 不直接透传前端
 */
async function resolve_shareUrl(shareUrl) {
	if (!workerAdminSecret) {
		throw new Error('分享服务尚未配置(SHARE_ADMIN_SECRET)')
	}
	let resp
	try {
		resp = await fetch(`${workerBase}/internal/share/resolve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-share-admin-secret': workerAdminSecret,
			},
			body: JSON.stringify({ shareUrl }),
			signal: AbortSignal.timeout(20 * 1000),
		})
	} catch (error) {
		throw new Error(`分享服务暂不可达: ${error.message}`)
	}

	const result = await resp.json().catch(() => ({}))
	if (!resp.ok || !result || result.driveItemId == null) {
		throw new Error(result?.msg || result?.message || `分享解析失败(HTTP ${resp.status})`)
	}
	return result
}

/**
 * 生成 shareCode (4位, 去混淆字符集), 唯一冲突时由调用方负责重试
 */
function gen_shareCode() {
	let code = ''
	for (let i = 0; i < CODE_LENGTH; i++) {
		code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
	}
	return code
}

/**
 * 规范化到期时间: 仅接受完整时刻 'YYYY-MM-DD HH:mm:ss'(几点失效由管理员决定, 不做隐式补末刻)
 * 空串/空值 = 永不过期(由调用方映射入库 NULL); 非法格式返回 null
 */
function norm_expiresAt(raw) {
	if (raw == null || String(raw).trim() === '') return ''
	const value = String(raw).trim()
	if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null
	return value
}

/**
 * 公开: 按 shareCode 获取分享元信息 (无需登录)
 * 仅返回安全字段, 服务端二次校验 enabled + expiresAt, 不透传 driveItemId
 */
actions.get.info = async ({ query }) => {
	const shareCode = String(query.shareCode || '')
		.trim()
		.toLowerCase()
	if (!shareCode || !new RegExp(`^[${CODE_CHARS}]{${CODE_LENGTH}}$`).test(shareCode)) {
		return base.respFailure({ msg: '分享链接无效' })
	}

	const sql = `
		SELECT "shareCode", "fileName", "mimeType", "fileSize", description, "createTime", "expiresAt"
		FROM share
		WHERE "shareCode" = $1
			AND enabled = true
			AND ("expiresAt" IS NULL OR "expiresAt" > to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
		LIMIT 1
	`
	try {
		const res = await db.query(sql, [shareCode])
		if (!res.rowCount) {
			return base.respFailure({ msg: '分享不存在或已失效' })
		}
		return base.respSuccess({
			data: base.formatDbRows(res.rows)[0],
		})
	} catch (error) {
		return base.respFailure({ msg: `获取分享信息失败：${error.message}` })
	}
}

/**
 * 管理端: 分页查询分享列表 (关键字可搜文件名/分享码, 可按启用状态过滤)
 */
actions.post.select = async ({ query, body }) => {
	const params = { ...query, ...body }
	const keyword = String(params.keyword || '').trim()
	// enabled: 兼容 boolean / 'true' 'false' / '1' '0' / 空串(全部)
	const enabledRaw = params.enabled
	const enabled =
		enabledRaw === '' || enabledRaw == null || enabledRaw === 'undefined'
			? null
			: enabledRaw === true || enabledRaw === 'true' || enabledRaw === 1 || enabledRaw === '1'
	const page = Math.max(1, Number(params.page || params.current || 1))
	const size = Math.min(100, Math.max(1, Number(params.size || params.pageSize || 10)))
	const offset = (page - 1) * size

	const binds = []
	let where = 'WHERE 1 = 1'
	if (keyword) {
		binds.push(`%${keyword}%`)
		where += ` AND ("fileName" ILIKE $${binds.length} OR "shareCode" ILIKE $${binds.length})`
	}
	if (enabled !== null) {
		binds.push(enabled)
		where += ` AND enabled = $${binds.length}`
	}

	const baseSelect = `
		SELECT s.id, s."shareCode", s."fileName", s."mimeType", s."fileSize", s.enabled,
			s.description, s."expiresAt", s."createTime", s."updateTime",
			bu.username AS "creatorName"
		FROM share s
		LEFT JOIN base_user bu ON bu.id = s."createdBy"
	`
	try {
		let res = await db.query(`${baseSelect} ${where} ORDER BY s."createTime" DESC LIMIT $${binds.length + 1} OFFSET $${binds.length + 2}`, [
			...binds,
			size,
			offset,
		])
		let rows = base.formatDbRows(res.rows)

		let totalRes = await db.query(`SELECT COUNT(*) AS count FROM share s ${where}`, binds)
		const total = Number(totalRes.rows[0].count || 0)

		const now = base.getTime()
		rows = rows.map(item => ({
			...item,
			expired: !!item.expiresAt && item.expiresAt < now,
		}))

		return base.respSuccess({ msg: '查询成功', total, data: rows })
	} catch (error) {
		// base_user 关联查询异常时降级为单表查询, 保证列表主流程可用
		try {
			let res = await db.query(
				`SELECT id, "shareCode", "fileName", "mimeType", "fileSize", enabled, description, "expiresAt", "createTime", "updateTime" FROM share s ${where} ORDER BY "createTime" DESC LIMIT $${binds.length + 1} OFFSET $${binds.length + 2}`,
				[...binds, size, offset],
			)
			let rows = base.formatDbRows(res.rows)
			let totalRes = await db.query(`SELECT COUNT(*) AS count FROM share s ${where}`, binds)
			const now = base.getTime()
			rows = rows.map(item => ({ ...item, creatorName: '', expired: !!item.expiresAt && item.expiresAt < now }))
			return base.respSuccess({ msg: '查询成功', total: Number(totalRes.rows[0].count || 0), data: rows })
		} catch (error2) {
			return base.respFailure({ msg: `查询失败：${error2.message}` })
		}
	}
}

/**
 * 管理端: 解析分享链接预览 (调用 Worker 校验并取回文件名/大小, 不做落库)
 */
actions.post.preview = async ({ body }) => {
	const shareUrl = String(body.shareUrl || '').trim()
	if (!/^https?:\/\/.+/.test(shareUrl)) {
		return base.respFailure({ msg: '分享链接格式不正确' })
	}
	try {
		const meta = await resolve_shareUrl(shareUrl)
		return base.respSuccess({
			msg: '解析成功',
			data: {
				fileName: meta.fileName || '',
				fileSize: meta.fileSize || 0,
				mimeType: meta.mimeType || '',
			},
		})
	} catch (error) {
		return base.respFailure({ msg: `解析失败：${error.message}` })
	}
}

/**
 * 管理端: 新增分享 (调用 Worker 解析分享链接, 落库一条分享记录)
 * 删除/停用分享记录均不影响 OneDrive 源文件
 */
actions.post.insert = async ({ body }) => {
	const shareUrl = String(body.shareUrl || '').trim()
	if (!/^https?:\/\/.+/.test(shareUrl)) {
		return base.respFailure({ msg: '分享链接格式不正确' })
	}
	const description = String(body.description || '').trim()
	const expiresAt = norm_expiresAt(body.expiresAt)
	if (body.expiresAt && expiresAt === null) {
		return base.respFailure({ msg: '到期时间格式不正确(需为 YYYY-MM-DD HH:mm:ss, 留空为永不过期)' })
	}

	let meta
	try {
		meta = await resolve_shareUrl(shareUrl)
	} catch (error) {
		return base.respFailure({ msg: error.message })
	}

	const id = base.getId()
	const createTime = base.getTime()
	const createdBy = base.req.user?.userId || ''

	// shareCode 唯一冲突重试 (最长 10 次)
	for (let i = 0; i < 10; i++) {
		const shareCode = gen_shareCode()
		try {
			await db.query(
				`INSERT INTO share (id, "shareCode", "driveItemId", "fileName", "mimeType", "fileSize", enabled, "expiresAt", "createdBy", description, "createTime", "updateTime")
				 VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10, $10)`,
				[
					id,
					shareCode,
					meta.driveItemId,
					meta.fileName || '',
					meta.mimeType || '',
					meta.fileSize || 0,
					expiresAt || null,
					createdBy,
					description,
					createTime,
				],
			)
			return base.respSuccess({
				msg: '新增成功',
				data: {
					id,
					shareCode,
					fileName: meta.fileName || '',
					fileSize: meta.fileSize || 0,
					mimeType: meta.mimeType || '',
				},
			})
		} catch (error) {
			// 23505 = 唯一键冲突(shareCode 撞码), 换码重试
			if (error.code === '23505' && i < 9) continue
			return base.respFailure({ msg: `新增失败：${error.message}` })
		}
	}
	return base.respFailure({ msg: '新增失败：请重试' })
}

/**
 * 管理端: 编辑分享
 *
 * 可改字段白名单仅: fileName / description / expiresAt / enabled。
 * shareCode 与 driveItemId 在创建时确定, 编辑接口不接受、也绝不改写(即使请求体携带也会被忽略);
 * 公开页/下载 session 缓存的 driveItemId 因此始终保持指向创建时的源文件。
 */
actions.post.update = async ({ body }) => {
	const id = String(body.id || '').trim()
	if (!id) {
		return base.respFailure({ msg: 'id 参数缺失' })
	}

	const updates = []
	const binds = []
	const push = (field, value) => {
		updates.push(`"${field}" = $${updates.length + 1}`)
		binds.push(value)
	}

	// 到期时间: 允许清空(传空串)或赋值
	if (body.expiresAt !== undefined) {
		const expiresAt = norm_expiresAt(body.expiresAt)
		if (body.expiresAt && expiresAt === null) {
			return base.respFailure({ msg: '到期时间格式不正确(需为 YYYY-MM-DD HH:mm:ss, 留空为永不过期)' })
		}
		push('expiresAt', expiresAt || null)
	}
	if (body.description !== undefined) push('description', String(body.description || '').trim())
	if (body.fileName !== undefined) push('fileName', String(body.fileName || '').trim())
	if (body.enabled !== undefined) {
		const enabled = body.enabled === true || body.enabled === 1 || body.enabled === '1' || body.enabled === 'true'
		push('enabled', enabled)
	}

	if (!updates.length) {
		return base.respFailure({ msg: '无数据变更' })
	}

	binds.push(base.getTime())
	const updateSql = `UPDATE share SET ${updates.join(', ')}, "updateTime" = $${updates.length} WHERE id = $${updates.length + 1}`
	try {
		const res = await db.query(updateSql, [...binds, id])
		if (!res.rowCount) {
			return base.respFailure({ msg: '分享记录不存在' })
		}
		return base.respSuccess({ msg: '保存成功', data: id })
	} catch (error) {
		return base.respFailure({ msg: `保存失败：${error.message}` })
	}
}

/**
 * 管理端: 删除分享记录 (仅删除业务记录, 绝不删除 OneDrive 源文件)
 */
actions.post.delete = async ({ body }) => {
	const id = String(body.id || '').trim()
	if (!id) {
		return base.respFailure({ msg: 'id 参数缺失' })
	}
	try {
		const res = await db.query(`DELETE FROM share WHERE id = $1`, [id])
		if (!res.rowCount) {
			return base.respFailure({ msg: '分享记录不存在或已被删除' })
		}
		return base.respSuccess({ msg: '删除成功', data: id })
	} catch (error) {
		return base.respFailure({ msg: `删除失败：${error.message}` })
	}
}

export default async (req, resp) => {
	base.req = req
	base.resp = resp

	const { method, action, query, body } = base.getReqInfo()

	// 公开接口: GET /api/share/info
	if (method === 'get' && action === 'info') {
		return actions.get.info({ query })
	}

	// 其余接口全部要求管理员 (非 admin 返回 403)
	return requireAdmin(async () => {
		const handler = actions[method]?.[action]
		if (!handler) {
			return base.respFailure({ msg: '请求的方法无效' })
		}
		return handler({ query, body })
	})()
}

```



## 云分享前端页面

#### 后台管理列表页

```vue
<script setup>
import { MessagePlugin } from 'tdesign-vue-next'

import DialogModel from '/src/components/model/DialogModel.vue'
import TableModel from '/src/components/model/TableModel.vue'
import http from '/src/js/http'

import share_form from './share_form.vue'

// 过滤筛选表单初始状态
const formInit = {
	keyword: '',
	enabled: '',
}
const form = reactive({ ...formInit })

// 核心主状态模型
const main = reactive({
	dialog: false,
	action: '',
	row: {},
})

// 表格配置
const table = reactive({
	rowKey: 'id',
	request: async pageInfo => {
		const params = { ...form, ...pageInfo }
		if (!params.enabled) params.enabled = ''
		return await http.post('/api/share/select', params)
	},
	columns: [
		{ ellipsis: true, minWidth: 200, title: '文件名', colKey: 'fileName' },
		{ ellipsis: true, width: 110, title: '分享码', colKey: 'shareCode', align: 'center' },
		{ ellipsis: true, width: 90, title: '大小', colKey: 'fileSize', align: 'right' },
		{ ellipsis: true, width: 90, title: '状态', colKey: 'status', align: 'center' },
		{ ellipsis: true, width: 160, title: '到期时间', colKey: 'expiresAt', align: 'center' },
		{ ellipsis: true, width: 90, title: '创建人', colKey: 'creatorName', align: 'center' },
		{ ellipsis: true, width: 160, title: '创建时间', colKey: 'createTime', align: 'center' },
		{ ellipsis: false, width: 210, title: '操作', colKey: 'actions', align: 'center', fixed: 'right' },
	],
	selectedRowKeys: [],
})

const tableRef = ref()

/** 查询表格数据 */
function click_select() {
	table.selectedRowKeys = []
	tableRef.value?.get_data(true)
}

/** 重置搜索条件 */
function click_reset() {
	Object.assign(form, formInit)
	click_select()
}

/** 提交后回调刷新 */
function submit_callback() {
	main.action === 'insert' ? click_select() : tableRef.value?.get_data()
	main.dialog = false
	main.action = ''
	main.row = {}
}

/** 打开新增弹窗 */
function click_insert() {
	main.row = {}
	main.action = 'insert'
	main.dialog = true
}

/** 打开编辑弹窗 */
function click_update(row) {
	main.row = row
	main.action = 'update'
	main.dialog = true
}

/** 复制公开分享链接 */
async function click_copy(row) {
	const shareUrl = `${location.origin}/share/${row.shareCode}`
	try {
		await navigator.clipboard.writeText(shareUrl)
		MessagePlugin.success('分享链接已复制')
	} catch (error) {
		// 剪贴板不可用(如非安全上下文)时降级为选中文本提示
		MessagePlugin.info(`分享链接：${shareUrl}`)
	}
}

/** 启停切换 */
function change_status(row) {
	const enabledNext = !row.enabled
	http.post('/api/share/update', { id: row.id, enabled: enabledNext })
		.then(res => {
			MessagePlugin.success(res.msg || (enabledNext ? '已启用分享' : '已停用分享'))
			tableRef.value?.get_data()
		})
		.catch(() => {
			row.enabled = !enabledNext
		})
}

/** 删除分享记录 (仅删业务记录, 不影响 OneDrive 源文件) */
function click_delete(row) {
	http.post('/api/share/delete', { id: row.id }).then(res => {
		MessagePlugin.success(res.msg || '删除成功')
		tableRef.value?.get_data()
	})
}

/** 展示分享状态: 停用 > 过期 > 分享中 */
function status_info(row) {
	if (!row.enabled) return { text: '已停用', theme: 'default' }
	if (row.expired) return { text: '已过期', theme: 'warning' }
	return { text: '分享中', theme: 'success' }
}

/** 格式化文件大小 */
function format_fileSize(bytes) {
	const num = Number(bytes)
	if (!num && num !== 0) return '-'
	if (num < 1024) return `${num} B`
	const units = ['KB', 'MB', 'GB', 'TB']
	let value = num
	let i = -1
	do {
		value /= 1024
		i++
	} while (value >= 1024 && i < units.length - 1)
	return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}
</script>

<template>
	<div class="share_manage _panel">
		<TableModel ref="tableRef" v-bind="table" :show_checkbox="false" v-model:selectedRowKeys="table.selectedRowKeys">
			<template #TableModelHeader>
				<t-form ref="formRef" :data="form" layout="inline" colon @keypress.enter="click_select">
					<t-form-item label="文件名 / 分享码">
						<t-input v-model="form.keyword" clearable />
					</t-form-item>

					<t-form-item label="状态">
						<t-select
							v-model="form.enabled"
							clearable
							class="w-36"
							:options="[
								{ label: '分享中', value: 'true' },
								{ label: '已停用', value: 'false' },
							]" />
					</t-form-item>

					<t-form-item>
						<t-button theme="primary" @click="click_select">查询</t-button>
						<t-button theme="primary" variant="outline" @click="click_reset">重置</t-button>
					</t-form-item>

					<t-form-item class="ml-auto">
						<t-button theme="primary" @click="click_insert">新增分享</t-button>
					</t-form-item>
				</t-form>
			</template>

			<!-- 分享码 -->
			<template #shareCode="{ row }">
				<code class="share-code">{{ row.shareCode }}</code>
			</template>

			<!-- 文件大小 -->
			<template #fileSize="{ row }">
				<span>{{ format_fileSize(row.fileSize) }}</span>
			</template>

			<!-- 状态 -->
			<template #status="{ row }">
				<t-tag :theme="status_info(row).theme" variant="light">
					{{ status_info(row).text }}
				</t-tag>
			</template>

			<!-- 到期时间 -->
			<template #expiresAt="{ row }">
				<span :class="{ expired: row.expired }">{{ row.expiresAt || '永久' }}</span>
			</template>

			<!-- 操作列 -->
			<template #actions="{ row }">
				<t-link theme="primary" @click="click_copy(row)">复制链接</t-link>
				<t-link theme="warning" @click="click_update(row)">编辑</t-link>
				<t-popconfirm
					:theme="row.enabled ? 'warning' : 'success'"
					:content="`确定${row.enabled ? '停用' : '启用'}分享【${row.fileName}】？`"
					@confirm="change_status(row)">
					<t-link :theme="row.enabled ? 'warning' : 'success'">
						{{ row.enabled ? '停用' : '启用' }}
					</t-link>
				</t-popconfirm>
				<t-popconfirm theme="danger" :content="`确定删除分享【${row.fileName}】？源文件不会被删除`" @confirm="click_delete(row)">
					<t-link theme="danger">删除</t-link>
				</t-popconfirm>
			</template>
		</TableModel>

		<!-- 新增 / 编辑弹窗 -->
		<DialogModel v-model:visible="main.dialog" :width="640">
			<template #header>
				<span>{{ main.action === 'insert' ? '新增分享' : '编辑分享' }}</span>
			</template>
			<share_form :row="main.row" :action="main.action" :submitCallback="submit_callback" />
		</DialogModel>
	</div>
</template>

<style lang="less" scoped>
.share_manage {
	height: 100%;

	.share-code {
		font-family: monospace, monospace;
		font-size: 13px;
		background: var(--bg-disabled);
		border-radius: 4px;
		padding: 1px 6px;
		letter-spacing: 1px;
	}

	.expired {
		color: var(--td-error-color);
	}
}
</style>
```

#### 后台管理表单页

```vue
<script setup>
import { MessagePlugin } from 'tdesign-vue-next'

import FormModel from '/src/components/model/FormModel.vue'
import http from '/src/js/http'

const props = defineProps(['row', 'action', 'submitCallback'])

const form = reactive({
	id: undefined,
	shareUrl: '',
	fileName: '',
	description: '',
	expiresAt: '',
	enabled: true,
})

const main = reactive({
	previewed: false,
	fileSize: 0,
	mimeType: '',
	checking: false,
	submitting: false,
})

onMounted(() => {
	if (props.action !== 'insert' && props.row?.id) {
		Object.assign(form, {
			id: props.row.id,
			fileName: props.row.fileName || '',
			description: props.row.description || '',
			expiresAt: props.row.expiresAt || '',
			enabled: !!props.row.enabled,
		})
	}
})

/** 校验 OneDrive 分享链接 (后端转 Worker 解析, 仅回显文件名/大小) */
function click_preview() {
	const shareUrl = form.shareUrl.trim()
	if (!/^https?:\/\/.+/.test(shareUrl)) {
		MessagePlugin.warning('请先粘贴合法的 OneDrive 分享链接')
		return
	}
	main.checking = true
	http.post('/api/share/preview', { shareUrl })
		.then(res => {
			main.previewed = true
			main.fileSize = res.data?.fileSize || 0
			main.mimeType = res.data?.mimeType || ''
			form.fileName = res.data?.fileName || ''
			MessagePlugin.success('解析成功，确认文件无误后提交')
		})
		.catch(() => {
			main.previewed = false
			form.fileName = ''
		})
		.finally(() => {
			main.checking = false
		})
}

/** 格式化文件大小 */
function format_fileSize(bytes) {
	const num = Number(bytes)
	if (!num && num !== 0) return '-'
	if (num < 1024) return `${num} B`
	const units = ['KB', 'MB', 'GB', 'TB']
	let value = num
	let i = -1
	do {
		value /= 1024
		i++
	} while (value >= 1024 && i < units.length - 1)
	return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

/** 提交保存 */
async function submit_form({ validateResult }) {
	if (validateResult !== true) {
		return false
	}

	main.submitting = true
	try {
		const isInsert = props.action === 'insert'
		const payload = isInsert
			? {
					shareUrl: form.shareUrl.trim(),
					description: form.description,
					expiresAt: form.expiresAt,
				}
			: {
					id: props.row.id,
					fileName: form.fileName,
					description: form.description,
					expiresAt: form.expiresAt,
					enabled: form.enabled,
				}

		const res = await http.post(`/api/share/${isInsert ? 'insert' : 'update'}`, payload)
		MessagePlugin.success(res.msg || '保存成功')
		if (props.submitCallback) {
			props.submitCallback(res.data)
		}
	} catch (error) {
		MessagePlugin.error(error?.message || '保存失败')
	} finally {
		main.submitting = false
	}
}
</script>

<template>
	<FormModel :action="props.action" labelWidth="7em" :data="form" @submit="submit_form">
		<t-row :gutter="[16, 16]">
			<!-- OneDrive 分享链接 (仅新增时可填, 编辑时不可改) -->
			<t-col :span="24" v-if="props.action === 'insert'">
				<t-form-item
					label="OneDrive 分享链接"
					name="shareUrl"
					:rules="[
						{ required: true, message: '请输入 OneDrive 分享链接' },
						{
							validator: val => /^https?:\/\/.+/.test(val || ''),
							message: '链接需以 http(s):// 开头',
						},
					]">
					<t-space direction="vertical" style="width: 100%">
						<t-input v-model="form.shareUrl" placeholder="粘贴文件/文件夹的 OneDrive 公开分享链接" clearable />
						<t-space size="small">
							<t-button theme="primary" variant="outline" size="small" :loading="main.checking" @click="click_preview"> 校验链接 </t-button>
							<span v-if="main.previewed" class="preview-tip">
								已解析：{{ form.fileName || '未知文件' }}
								<template v-if="main.fileSize">（{{ format_fileSize(main.fileSize) }}）</template>
							</span>
						</t-space>
					</t-space>
				</t-form-item>
			</t-col>

			<!-- 文件名 (新增由解析自动填充; 编辑允许修改显示名, 不影响源文件) -->
			<t-col :span="24">
				<t-form-item label="文件名" name="fileName">
					<t-input v-model="form.fileName" :disabled="props.action === 'insert'" clearable placeholder="新增时由 OneDrive 链接解析自动填充" />
				</t-form-item>
			</t-col>

			<!-- 到期时间 -->
			<t-col :span="12">
				<t-form-item label="到期时间" name="expiresAt">
					<t-date-picker
						v-model="form.expiresAt"
						mode="date"
						format="YYYY-MM-DD HH:mm:ss"
						value-type="YYYY-MM-DD HH:mm:ss"
						:enable-time-picker="true"
						:default-time="'23:59:59'"
						clearable
						placeholder="留空 = 永不过期"
						style="width: 100%" />
				</t-form-item>
			</t-col>

			<!-- 启用状态 (新增默认启用) -->
			<t-col :span="12" v-if="props.action !== 'insert'">
				<t-form-item label="分享状态" name="enabled">
					<t-radio-group v-model="form.enabled">
						<t-radio :value="true">启用</t-radio>
						<t-radio :value="false">停用</t-radio>
					</t-radio-group>
				</t-form-item>
			</t-col>

			<!-- 备注说明 -->
			<t-col :span="24">
				<t-form-item label="备注说明" name="description">
					<t-textarea v-model="form.description" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="选填，展示在公开分享页" />
				</t-form-item>
			</t-col>

			<!-- 到期提示 -->
			<t-col :span="24">
				<t-form-item label=" ">
					<div class="form-tip">
						留空 = 永不过期；可选日期 + 时间精确到秒指定失效时刻，几点失效由你决定。到期后分享页自动不可访问，源文件不受影响。
					</div>
				</t-form-item>
			</t-col>
		</t-row>

		<template #FormModelFooter>
			<t-button theme="primary" type="submit" :loading="main.submitting">
				{{ props.action === 'insert' ? '新增分享' : '保存修改' }}
			</t-button>
		</template>
	</FormModel>
</template>

<style lang="less" scoped>
.preview-tip {
	font-size: 13px;
	color: var(--tc-soft);
	word-break: break-all;
}

.form-tip {
	font-size: 12px;
	color: var(--tc-soft);
	line-height: 1.5;
}
</style>
```

#### 前台分享落地页

```vue
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

import Logo from '/src/components/Logo.vue'
import Theme from '/src/components/Theme.vue'
import FooterLayout from '/src/components/layout/FooterLayout.vue'
import { use_user } from '/src/pinia/user.js'

// 用户状态与主题绑定
const _user = use_user()

// shareCode 字符集与后端一致: 去混淆 0/o/1/l (保留 i), 4 位
const CODE_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789'
const CODE_LENGTH = 4

// 分享下载 Worker 基础地址
const workerBase = (window.$config?.share_worker || 'https://share.zengjin.work').replace(/\/+$/, '')

// 下载交棒浏览器后的按钮复位定时器
let downloadResetTimeout

// 提取码输入框 DOM 引用
const inputRef = ref()

// 核心状态分组 (符合规范：必须包含 main 分组)
const main = reactive({
	status: 'loading', // loading | ok | err | portal
	info: {},
	msg: '',
	code: '',
	inputCode: '',
	inputError: '',
	downloading: false,
	started: false,
	downloadError: '',
	copied: false,
})

// 按钮文案计算属性
const download_text = computed(() => {
	if (main.started) return '已开始下载，请留意下载栏'
	if (main.downloading) return '正在准备下载…'
	return '立即下载'
})

/**
 * 统一设置页面标题
 * 仅在资源有明确文件名时展示 "<文件名> - <工坊标题>"；
 * 其余情况（主页、提取文件输入页、错误提示页等）直接展示工坊标题，无需特殊前缀。
 */
function set_pageTitle(name = '') {
	const baseTitle = [$config.title, '增进工坊'].filter(Boolean).join(' | ')
	document.title = name ? `${name} - ${baseTitle}` : baseTitle
}

// 从当前 URL 路径提取 shareCode: /share/<shareCode>
// 若访问根路径 /share 或 /share/ 则返回 null 进入提取码输入面板
function parse_shareCode() {
	const segments = location.pathname.split('/').filter(Boolean)
	if (segments.length === 0 || (segments.length === 1 && segments[0].toLowerCase() === 'share')) {
		return null
	}
	const last = segments[segments.length - 1] || ''
	const code = decodeURIComponent(last).trim().toLowerCase()
	if (!code || code === 'share') {
		return null
	}
	if (!new RegExp('^[' + CODE_CHARS + ']{' + CODE_LENGTH + '}$').test(code)) {
		main.status = 'err'
		main.msg = '分享链接错误或已过期'
		set_pageTitle()
		return ''
	}
	return code
}

/**
 * 提交 4 位提取码并加载分享文件
 */
function submit_code() {
	const val = (main.inputCode || '').trim().toLowerCase()
	if (!val) {
		main.inputError = '请输入提取码'
		inputRef.value?.focus()
		return
	}
	if (!new RegExp('^[' + CODE_CHARS + ']{' + CODE_LENGTH + '}$').test(val)) {
		main.inputError = '请输入 4 位有效提取码'
		inputRef.value?.focus()
		return
	}
	main.inputError = ''
	main.code = val
	const targetPath = `/share/${val}`
	if (location.pathname !== targetPath) {
		history.pushState(null, '', targetPath)
	}
	fetch_info_async()
}

/**
 * 切换至提取码输入模式
 */
function switch_portal() {
	main.code = ''
	main.inputCode = ''
	main.inputError = ''
	main.status = 'portal'
	if (location.pathname !== '/share') {
		history.pushState(null, '', '/share')
	}
	set_pageTitle()
	nextTick(() => inputRef.value?.focus())
}

/**
 * 浏览器前进/后退历史导航监听
 */
function on_popstate() {
	const code = parse_shareCode()
	if (code === null) {
		main.code = ''
		main.inputCode = ''
		main.inputError = ''
		main.status = 'portal'
		set_pageTitle()
		nextTick(() => inputRef.value?.focus())
	} else if (code) {
		main.code = code
		fetch_info_async()
	}
}

/**
 * 依据文件名与 MIME 类型智能匹配文件类型、矢量图标与主题色彩
 */
function get_fileMeta(fileName = '', mimeType = '') {
	const name = (fileName || '').toLowerCase()
	const mime = (mimeType || '').toLowerCase()

	// 压缩文件 (ZIP, RAR, 7Z, TAR, GZ 等)
	if (/\.(zip|rar|7z|tar|gz|bz2|xz|iso|cab|tgz)$/.test(name) || mime.includes('zip') || mime.includes('compressed')) {
		return {
			typeLabel: '压缩文件',
			icon: 'fa-solid fa-file-zipper',
			theme: 'archive',
			gradient: 'linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%)',
			glow: 'rgba(59, 130, 246, 0.4)',
			accent: '#3b82f6',
		}
	}
	// 视频媒体
	if (/\.(mp4|mkv|mov|avi|flv|webm|wmv|m4v|rmvb)$/.test(name) || mime.startsWith('video/')) {
		return {
			typeLabel: '视频',
			icon: 'fa-solid fa-file-video',
			theme: 'video',
			gradient: 'linear-gradient(135deg, #f43f5e 0%, #fb7185 100%)',
			glow: 'rgba(244, 63, 94, 0.45)',
			accent: '#f43f5e',
		}
	}
	// 音频媒体
	if (/\.(mp3|wav|flac|aac|m4a|ogg|wma|ape)$/.test(name) || mime.startsWith('audio/')) {
		return {
			typeLabel: '音频',
			icon: 'fa-solid fa-file-audio',
			theme: 'audio',
			gradient: 'linear-gradient(135deg, #8b5cf6 0%, #c084fc 100%)',
			glow: 'rgba(139, 92, 246, 0.45)',
			accent: '#8b5cf6',
		}
	}
	// 图像图片
	if (/\.(png|jpe?g|gif|webp|svg|bmp|heic|ico|tiff?|psd)$/.test(name) || mime.startsWith('image/')) {
		return {
			typeLabel: '图片',
			icon: 'fa-solid fa-file-image',
			theme: 'image',
			gradient: 'linear-gradient(135deg, #f97316 0%, #fb923c 100%)',
			glow: 'rgba(249, 115, 22, 0.45)',
			accent: '#f97316',
		}
	}
	// PDF 文档
	if (name.endsWith('.pdf') || mime.includes('pdf')) {
		return {
			typeLabel: 'PDF 文档',
			icon: 'fa-solid fa-file-pdf',
			theme: 'pdf',
			gradient: 'linear-gradient(135deg, #ef4444 0%, #f87185 100%)',
			glow: 'rgba(239, 68, 68, 0.45)',
			accent: '#ef4444',
		}
	}
	// Word 文档
	if (/\.(docx?|doc|dotx?|wps|rtf)$/.test(name) || mime.includes('word') || mime.includes('officedocument.wordprocessing')) {
		return {
			typeLabel: 'Word 文档',
			icon: 'fa-solid fa-file-word',
			theme: 'word',
			gradient: 'linear-gradient(135deg, #2563eb 0%, #60a5fa 100%)',
			glow: 'rgba(37, 99, 235, 0.45)',
			accent: '#2563eb',
		}
	}
	// Excel 电子表格
	if (/\.(xlsx?|xls|csv|numbers|tsv)$/.test(name) || mime.includes('sheet') || mime.includes('excel')) {
		return {
			typeLabel: '电子表格',
			icon: 'fa-solid fa-file-excel',
			theme: 'excel',
			gradient: 'linear-gradient(135deg, #10b981 0%, #34d399 100%)',
			glow: 'rgba(16, 185, 129, 0.45)',
			accent: '#10b981',
		}
	}
	// PPT 幻灯片
	if (/\.(pptx?|ppt|key|potx?)$/.test(name) || mime.includes('presentation') || mime.includes('powerpoint')) {
		return {
			typeLabel: '幻灯演示',
			icon: 'fa-solid fa-file-powerpoint',
			theme: 'ppt',
			gradient: 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)',
			glow: 'rgba(245, 158, 11, 0.45)',
			accent: '#f59e0b',
		}
	}
	// 文本代码
	if (/\.(txt|md|json|js|ts|vue|css|less|html?|py|java|c|cpp|go|rs|sql|sh|yml|yaml)$/.test(name)) {
		return {
			typeLabel: '文本 / 代码',
			icon: 'fa-solid fa-file-code',
			theme: 'code',
			gradient: 'linear-gradient(135deg, #06b6d4 0%, #22d3ee 100%)',
			glow: 'rgba(6, 182, 212, 0.45)',
			accent: '#06b6d4',
		}
	}
	// 通用云端文件
	return {
		typeLabel: '云端文件',
		icon: 'fa-solid fa-cloud-arrow-down',
		theme: 'default',
		gradient: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
		glow: 'rgba(59, 130, 246, 0.4)',
		accent: '#3b82f6',
	}
}

// 当前文件元信息映射计算属性
const fileMeta = computed(() => get_fileMeta(main.info.fileName, main.info.mimeType))

/**
 * 格式化文件大小
 */
function format_fileSize(bytes) {
	const num = Number(bytes)
	if (!num && num !== 0) return '-'
	if (num < 1024) return `${num} B`
	const units = ['KB', 'MB', 'GB', 'TB']
	let value = num
	let i = -1
	do {
		value /= 1024
		i++
	} while (value >= 1024 && i < units.length - 1)
	return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

/**
 * 格式化到期时间展示
 */
function format_expiresAt(timeStr) {
	if (!timeStr) return '长期有效'
	return timeStr
}

/**
 * 拉取分享元信息
 */
async function fetch_info_async() {
	main.status = 'loading'
	main.downloadError = ''
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 12000)
	try {
		const resp = await fetch(`/api/share/info?shareCode=${encodeURIComponent(main.code)}`, {
			signal: controller.signal,
			headers: { accept: 'application/json' },
		})
		const result = await resp.json().catch(() => ({}))
		if (!resp.ok || result.code !== 0 || !result.data) {
			main.status = 'err'
			main.msg = result?.msg || '文件不存在或已过期'
			set_pageTitle()
			return
		}
		main.info = result.data
		main.status = 'ok'
		set_pageTitle(main.info.fileName)
	} catch (error) {
		main.status = 'err'
		main.msg = error?.name === 'AbortError' ? '连接超时，请检查网络后重试' : '获取文件失败，请稍后重试'
		set_pageTitle()
	} finally {
		clearTimeout(timeout)
	}
}

/**
 * 复制当前分享链接
 */
async function click_copy() {
	const shareUrl = `${location.origin}/share/${main.code}`
	try {
		await navigator.clipboard.writeText(shareUrl)
		main.copied = true
		setTimeout(() => {
			main.copied = false
		}, 2000)
	} catch (error) {
		main.msg = `分享链接：${shareUrl}`
	}
}

/**
 * 开始下载：换票 (ticket 20s) -> 兑换会话 (sessionId 1h) -> 唤醒浏览器流式下载
 */
async function click_download() {
	if (main.downloading) return
	main.downloading = true
	main.downloadError = ''
	try {
		// 1) 换取 20s ticket
		const ticketResp = await fetch(`${workerBase}/download-ticket/${encodeURIComponent(main.code)}`, {
			method: 'POST',
			headers: { accept: 'application/json' },
		})
		const ticketResult = await ticketResp.json().catch(() => ({}))
		if (!ticketResp.ok || !ticketResult.ticket) {
			throw new Error(ticketResult?.msg || '获取下载凭证失败，请重试')
		}

		// 2) 兑换为 1h session
		const sessionResp = await fetch(`${workerBase}/download-session`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ticket: ticketResult.ticket }),
		})
		const sessionResult = await sessionResp.json().catch(() => ({}))
		if (!sessionResp.ok || !sessionResult.sessionId) {
			throw new Error(sessionResult?.msg || '下载凭证已过期，请重新点击')
		}

		// 3) 触发浏览器高速下载
		main.started = true
		location.href = `${workerBase}/download/${encodeURIComponent(sessionResult.sessionId)}`

		clearTimeout(downloadResetTimeout)
		downloadResetTimeout = setTimeout(() => {
			main.downloading = false
			main.started = false
		}, 3000)
	} catch (error) {
		main.downloading = false
		main.started = false
		main.downloadError = error?.message || '服务暂时繁忙，请稍后重试'
	}
}

onMounted(() => {
	window.addEventListener('popstate', on_popstate)
	main.code = parse_shareCode()
	if (main.code === null) {
		main.status = 'portal'
		set_pageTitle()
		nextTick(() => inputRef.value?.focus())
	} else if (main.code) {
		fetch_info_async()
	} else if (main.status !== 'err') {
		main.status = 'err'
		main.msg = '分享链接错误或已过期'
		set_pageTitle()
	}
})

onBeforeUnmount(() => {
	clearTimeout(downloadResetTimeout)
	window.removeEventListener('popstate', on_popstate)
})
</script>

<template>
	<div class="sharePage" :theme="_user?.theme">
		<!-- 动态柔和云海与氛围光晕背景 -->
		<div class="skyBackdrop">
			<div class="ambientOrb orbSun"></div>
			<div class="ambientOrb orbSky"></div>
			<div class="ambientOrb orbViolet"></div>
			<div class="cloudLayer layerBack"></div>
			<div class="cloudLayer layerFront"></div>
		</div>

		<!-- 顶栏导航区 -->
		<header class="shareHeader">
			<div class="headerLeft">
				<a href="/" class="logoWrapper" title="返回增进工坊首页">
					<Logo />
				</a>
				<span class="headerDivider"></span>
				<span class="headerTag"> 云分享 </span>
				<!-- <div class="headerTag">
					<i class="fa-solid fa-cloud-arrow-down"></i>
					<span>云分享</span>
				</div> -->
			</div>

			<div class="headerRight">
				<div class="themeWrapper">
					<Theme simple />
				</div>
			</div>
		</header>

		<!-- 页面主视口容器 -->
		<main class="shareMain">
			<!-- 核心卡片容器 -->
			<div class="shareCard" :class="{ portalMode: main.status === 'portal' }">
				<!-- 状态 1：加载中 -->
				<div v-if="main.status === 'loading'" class="stateLoading">
					<div class="loadingSpinner">
						<div class="spinnerGlow"></div>
						<i class="fa-solid fa-cloud-arrow-down spinnerIcon"></i>
					</div>
					<h3 class="loadingTitle">正在解析文件…</h3>
					<p class="loadingSubtitle">正在连接云端节点并获取文件信息</p>
				</div>

				<!-- 状态 2：失效或错误 -->
				<div v-else-if="main.status === 'err'" class="stateError">
					<div class="errorEmblem">
						<i class="fa-solid fa-cloud-slash"></i>
					</div>
					<h2 class="errorTitle">文件不存在</h2>
					<p class="errorMsg">{{ main.msg }}</p>
					<div class="errorActions">
						<a class="actionBtn ghostBtn" href="/">
							<i class="fa-regular fa-house"></i>
							<span>工坊首页</span>
						</a>
						<button class="actionBtn ghostBtn" @click="switch_portal">
							<i class="fa-regular fa-keyboard"></i>
							<span>输入提取码</span>
						</button>
						<button v-if="main.code" class="actionBtn primaryBtn" @click="fetch_info_async">
							<i class="fa-regular fa-arrow-rotate-right"></i>
							<span>重试</span>
						</button>
					</div>
				</div>

				<!-- 状态 3：提取码输入面板 (访问 /share 首页或主动输入) -->
				<div v-else-if="main.status === 'portal'" class="statePortal">
					<div class="fileEmblemWrapper">
						<div class="fileEmblemGlow" style="background: rgba(59, 130, 246, 0.45)"></div>
						<div class="fileEmblemBox" style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)">
							<div class="emblemDocFold"></div>
							<i class="fa-solid fa-cloud-arrow-down emblemIcon"></i>
						</div>
					</div>

					<div class="fileHeader">
						<h1 class="fileName">提取云端文件</h1>
						<p class="fileSlogan">输入 4 位文件提取码</p>
					</div>

					<div class="portalArea">
						<div class="portalBar" :class="{ error: !!main.inputError }" @click="inputRef?.focus()">
							<div class="barPrefix">
								<i class="fa-solid fa-key"></i>
							</div>
							<input
								ref="inputRef"
								v-model="main.inputCode"
								class="codeInput"
								type="text"
								maxlength="4"
								autocomplete="off"
								spellcheck="false"
								@input="main.inputError = ''"
								@keydown.enter="submit_code"
							/>
							<button class="barSubmitBtn" @click.stop="submit_code">
								<span>提取</span>
								<i class="fa-solid fa-arrow-right"></i>
							</button>
						</div>

						<p v-if="main.inputError" class="portalErrorTip">
							<i class="fa-solid fa-circle-exclamation"></i>
							<span>{{ main.inputError }}</span>
						</p>
					</div>
				</div>

				<!-- 状态 4：就绪/展示正常分享信息 -->
				<div v-else class="shareContent">
					<!-- 文件标志勋章展示 (速率调优：2s 灵动浮动) -->
					<div class="fileEmblemWrapper">
						<div class="fileEmblemGlow" :style="{ background: fileMeta.glow }"></div>
						<div class="fileEmblemBox" :style="{ background: fileMeta.gradient }">
							<div class="emblemDocFold"></div>
							<i :class="fileMeta.icon" class="emblemIcon"></i>
						</div>
					</div>

					<!-- 文件名称与描述 -->
					<div class="fileHeader">
						<h1 class="fileName" :title="main.info.fileName">
							{{ main.info.fileName || '未命名云端文件' }}
						</h1>
						<p v-if="main.info.description" class="fileDesc">
							{{ main.info.description }}
						</p>
						<p v-else class="fileSlogan">
							云端直连 · 免登录高速传输
						</p>
					</div>

					<!-- 核心元数据条 (白底 + 轻间隔线，按：文件大小 | 文件类型 | 有效期 排序) -->
					<div class="statsRow">
						<div class="statItem">
							<span class="statLabel">文件大小</span>
							<strong class="statValue">{{ format_fileSize(main.info.fileSize) }}</strong>
						</div>
						<div class="statDivider"></div>
						<div class="statItem">
							<span class="statLabel">文件类型</span>
							<strong class="statValue">{{ fileMeta.typeLabel }}</strong>
						</div>
						<div class="statDivider"></div>
						<div class="statItem">
							<span class="statLabel">有效期</span>
							<strong class="statValue">{{ format_expiresAt(main.info.expiresAt) }}</strong>
						</div>
					</div>

					<!-- 下载主操作区 -->
					<div class="actionArea">
						<button class="downloadBtn" :disabled="main.downloading"
							:style="{ background: fileMeta.gradient, boxShadow: `0 12px 28px -6px ${fileMeta.glow}` }"
							@click="click_download">
							<span v-if="main.downloading && !main.started" class="btnSpinner"></span>
							<i v-else-if="main.started" class="fa-solid fa-circle-check btnCheckIcon"></i>
							<i v-else class="fa-solid fa-cloud-arrow-down btnDownloadIcon"></i>
							<span class="btnText">{{ download_text }}</span>
						</button>

						<p v-if="main.downloadError" class="downloadErrorTip">
							<i class="fa-solid fa-triangle-exclamation"></i>
							<span>{{ main.downloadError }}</span>
						</p>

						<div class="secondaryRow">
							<button class="copyLinkBtn" :class="{ copied: main.copied }" @click="click_copy">
								<i :class="main.copied ? 'fa-solid fa-check' : 'fa-regular fa-copy'"></i>
								<span>{{ main.copied ? '链接已复制' : '复制分享链接' }}</span>
							</button>
						</div>
					</div>
				</div>
			</div>

			<!-- 5. 面板外提示文案 -->
			<div class="cardFooterNotice">
				<i class="fa-solid fa-cloud-check"></i>
				<span>云端直连 · 免登录高速传输</span>
			</div>
		</main>

		<!-- 通用页脚区 -->
		<footer class="shareFooter">
			<FooterLayout :readonly="true" />
		</footer>
	</div>
</template>

<style lang="less" scoped>
.sharePage {
	min-height: 100vh;
	display: flex;
	flex-direction: column;
	position: relative;
	overflow-x: hidden;
	color: #1e293b;
	font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Ubuntu, Helvetica Neue, Helvetica, Arial, PingFang SC, Hiragino Sans GB,  WenQuanYi Micro Hei, Source Han Sans CN, sans-serif;
	background: linear-gradient(180deg, #dbeafe 0%, #eef5ff 40%, #f8fafc 100%);
	

	transition: background-color 0.4s ease, color 0.4s ease;

	// ----------------------------------------------------
	// 柔和灵动云海背景层 (恢复原版柔和天青蓝与金阳紫晕)
	// ----------------------------------------------------
	.skyBackdrop {
		position: fixed;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		overflow: hidden;
		transition: background 0.4s ease;

		background: #f4f8fc no-repeat center / cover;
		background-image: url('/$apps/share/bg.jpg');
		&:after{
			content: '';
			position: fixed;
			inset: 0;
			z-index: 0;
			pointer-events: none;
			overflow: hidden;
			background:linear-gradient( #fff9, #fff3);
		}

		.ambientOrb {
			position: absolute;
			border-radius: 50%;
			filter: blur(80px);
			opacity: 0.65;
			will-change: transform;
		}

		.orbSun {
			width: 380px;
			height: 380px;
			top: -100px;
			right: 5%;
			background: radial-gradient(circle, rgba(254, 240, 138, 0.7) 0%, rgba(253, 230, 138, 0) 70%);
			animation: pulseFloat 12s ease-in-out infinite alternate;
		}

		.orbSky {
			width: 540px;
			height: 540px;
			top: 15%;
			left: -120px;
			background: radial-gradient(circle, rgba(147, 197, 253, 0.6) 0%, rgba(191, 219, 254, 0) 70%);
			animation: pulseFloat 16s ease-in-out infinite alternate-reverse;
		}

		.orbViolet {
			width: 480px;
			height: 480px;
			bottom: 10%;
			right: -80px;
			background: radial-gradient(circle, rgba(233, 213, 255, 0.5) 0%, rgba(243, 232, 255, 0) 70%);
			animation: pulseFloat 14s ease-in-out infinite alternate;
		}

		.cloudLayer {
			position: absolute;
			inset: 0;
			background-repeat: no-repeat;
			opacity: 0.35;
		}

		.layerBack {
			background-image:
				radial-gradient(ellipse at 20% 85%, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0) 45%),
				radial-gradient(ellipse at 80% 80%, rgba(255, 255, 255, 0.9) 0%, rgba(255, 255, 255, 0) 50%);
		}

		.layerFront {
			background-image:
				radial-gradient(ellipse at 50% 90%, rgba(255, 255, 255, 0.98) 0%, rgba(255, 255, 255, 0) 60%);
		}
	}

	@keyframes pulseFloat {
		0% {
			transform: translate(0, 0) scale(1);
		}

		50% {
			transform: translate(25px, -20px) scale(1.06);
		}

		100% {
			transform: translate(-20px, 15px) scale(0.96);
		}
	}

	// ----------------------------------------------------
	// 顶栏 Header
	// ----------------------------------------------------
	.shareHeader {
		position: relative;
		z-index: 10;
		height: 56px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 32px;
		backdrop-filter: blur(20px);
		-webkit-backdrop-filter: blur(20px);
		background: #fff5;
		border-bottom: 1px solid #fff2;

		.headerLeft {
			display: flex;
			align-items: center;
			gap: 12px;

			.logoWrapper {
				display: flex;
				align-items: center;
				text-decoration: none;
				color: inherit;
				transition: transform 0.2s ease;

				&:hover {
					transform: translateY(-1px);
				}
			}

			.headerDivider {
				width: 1px;
				height: 18px;
				background: rgba(148, 163, 184, 0.35);
			}

			.headerTag {
				margin-top: -2px;
				color: var(--cl-soft)
			}

			// .headerTag {
			// 	display: inline-flex;
			// 	align-items: center;
			// 	gap: 6px;
			// 	padding: 3px 10px;
			// 	border-radius: 9999px;
			// 	font-size: 13px;
			// 	font-weight: 600;
			// 	color: #2563eb;
			// 	background: rgba(37, 99, 235, 0.08);
			// 	border: 1px solid rgba(37, 99, 235, 0.15);

			// 	i {
			// 		font-size: 12px;
			// 	}
			// }
		}

		.headerRight {
			display: flex;
			align-items: center;

			.themeWrapper {
				display: flex;
				align-items: center;
			}
		}
	}

	// ----------------------------------------------------
	// 主视口 Main & 卡片
	// ----------------------------------------------------
	.shareMain {
		position: relative;
		z-index: 5;
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 4vh 24px 8vh;
		box-sizing: border-box;

		.shareCard {
			position: relative;
			z-index: 1;
			width: 100%;
			max-width: 480px;
			// 1. 半透磨砂玻璃质感 + 双重立体边缘高光 (即使叠加壁纸背景也极为通透轻盈)
			background: #fff8;
			backdrop-filter: blur(16px) saturate(140%);
			border: 1px solid rgba(255, 255, 255, 0.88);
			border-radius: 36px; // 1. 放大圆角，更加优雅大气
			padding: 42px 36px 32px;
			box-shadow:
				0 30px 70px -15px rgba(37, 99, 235, 0.16),
				0 10px 24px -6px rgba(0, 0, 0, 0.03),
				inset 0 1.5px 2px 0 #fff5,
				inset 0 0 0 1px rgba(255, 255, 255, 0.5);
			box-sizing: border-box;
			text-align: center;
			transition: max-width 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), padding 0.3s ease, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.3s ease;
			animation: cardFadeIn 0.55s cubic-bezier(0.16, 1, 0.3, 1);

			&.portalMode {
				max-width: 390px;
				padding: 34px 26px 30px;
			}

			&:hover {
				// transform: translateY(-4px);
				box-shadow:
					0 36px 80px -18px rgba(37, 99, 235, 0.22),
					0 12px 28px -6px rgba(0, 0, 0, 0.04),
					inset 0 1.5px 2px 0 rgba(255, 255, 255, 1),
					inset 0 0 0 1px rgba(255, 255, 255, 0.7);
			}
		}

		// 5. 面板外的底部提示文案
		.cardFooterNotice {
			margin-top: 24px;
			font-size: 12.5px;
			color: #64748b;
			opacity: 0.85;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 6px;
			letter-spacing: 0.04em;
			transition: color 0.4s ease;

			i {
				font-size: 13px;
				color: #2563eb;
			}
		}
	}

	@keyframes cardFadeIn {
		from {
			opacity: 0;
			transform: translateY(16px) scale(0.98);
		}

		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	// ----------------------------------------------------
	// 卡片内容：文件标志徽章 (2. 速率优化为 2s 灵动呼吸)
	// ----------------------------------------------------
	.fileEmblemWrapper {
		position: relative;
		width: 72px;
		height: 72px;
		margin: 0 auto 28px;

		.fileEmblemGlow {
			position: absolute;
			inset: -6px;
			border-radius: 24px;
			filter: blur(14px);
			opacity: 0.6;
			animation: glowPulse 2s ease-in-out infinite;
			transition: opacity 0.3s ease;
		}

		.fileEmblemBox {
			position: relative;
			width: 100%;
			height: 100%;
			border-radius: 22px;
			display: flex;
			align-items: center;
			justify-content: center;
			color: #ffffff;
			border: 1px solid rgba(255, 255, 255, 0.9);
			box-shadow: 0 10px 24px rgba(186, 230, 253, 0.4);
			animation: emblemFloat 2s ease-in-out infinite; // 2. 优化动效速率：2s 灵动浮动

			.emblemDocFold {
				position: absolute;
				top: 0;
				right: 0;
				width: 18px;
				height: 18px;
				background: rgba(255, 255, 255, 0.32);
				border-bottom-left-radius: 10px;
				border-top-right-radius: 22px;
			}

			.emblemIcon {
				font-size: 32px;
				filter: drop-shadow(0 3px 6px rgba(0, 0, 0, 0.16));
			}
		}
	}

	@keyframes emblemFloat {

		0%,
		100% {
			transform: translateY(0px);
		}

		50% {
			transform: translateY(-8px);
		}
	}

	@keyframes glowPulse {

		0%,
		100% {
			transform: scale(0.95);
			opacity: 0.5;
		}

		50% {
			transform: scale(1.06);
			opacity: 0.75;
		}
	}

	// ----------------------------------------------------
	// 文件名与文案
	// ----------------------------------------------------
	.fileHeader {
		margin-bottom: 22px;

		.fileName {
			margin: 0 0 8px;
			font-size: 20px;
			font-weight: 600;
			letter-spacing: -0.01em;
			line-height: 1.4;
			color: #1e293b;
			word-break: break-word;
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
		}

		.fileDesc {
			margin: 10px auto 0;
			font-size: 13.5px;
			line-height: 1.6;
			color: #475569;
			background: rgba(255, 255, 255, 0.55);
			border: 1px solid rgba(255, 255, 255, 0.85);
			border-radius: 14px;
			padding: 8px 14px;
			display: inline-block;
			text-align: left;
			max-height: 80px;
			overflow-y: auto;
			word-break: break-word;
		}

		.fileSlogan {
			margin: 0;
			font-size: 13.5px;
			color: #64748b;
		}
	}

	// ----------------------------------------------------
	// 3. 元数据条：白底 + 轻间隔线 (文件类型 | 文件大小 | 有效期)
	// ----------------------------------------------------
	.statsRow {
		display: flex;
		align-items: center;
		justify-content: space-around;
		background: #fffc;
		border: 1px solid rgba(255, 255, 255, 1);
		border-radius: 18px;
		padding: 13px 12px;
		margin-bottom: 26px;
		box-shadow: 0 4px 18px -4px rgba(0, 0, 0, 0.04), 0 1px 3px 0 rgba(0, 0, 0, 0.02);

		.statItem {
			flex: 1;
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 3px;
			min-width: 0;

			.statLabel {
				font-size: 11.5px;
				color: #64748b;
				letter-spacing: 0.04em;
			}

			.statValue {
				font-size: 13.5px;
				font-weight: 600;
				color: #1e293b;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				max-width: 100%;
			}
		}

		.statDivider {
			width: 1px;
			height: 22px;
			background: #e2e8f0;
			flex-shrink: 0;
		}
	}

	// ----------------------------------------------------
	// 4. 核心下载与按钮区域 (贴合适配面板的圆角矩形)
	// ----------------------------------------------------
	.actionArea {
		display: flex;
		flex-direction: column;
		gap: 12px; // 优化呼吸节奏，拉开主次级操作感

		.downloadBtn {
			width: 100%;
			height: 50px;
			border: 0;
			border-radius: 16px; // 4. 贴合适配面板的圆角矩形
			cursor: pointer;
			color: #ffffff;
			font-size: 15.5px;
			font-weight: 600;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 9px;
			transition: all 0.25s ease;
			outline: none;

			&:hover:not(:disabled) {
				opacity: 0.95;
				transform: scale(1.01);
				box-shadow: 0 14px 28px -4px rgba(56, 189, 248, 0.55);
			}

			&:active:not(:disabled) {
				transform: scale(0.98);
			}

			&:disabled {
				opacity: 0.82;
				cursor: not-allowed;
			}

			.btnDownloadIcon {
				font-size: 17px;
				transition: transform 0.2s ease;
			}

			&:hover:not(:disabled) .btnDownloadIcon {
				transform: translateY(2px);
			}

			.btnCheckIcon {
				font-size: 18px;
				color: #a7f3d0;
			}

			.btnSpinner {
				width: 17px;
				height: 17px;
				border: 2px solid rgba(255, 255, 255, 0.35);
				border-top-color: #ffffff;
				border-radius: 50%;
				animation: spin 0.8s linear infinite;
			}
		}

		.downloadErrorTip {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 6px;
			margin: 2px 0 0;
			color: #dc2626;
			font-size: 13px;
			font-weight: 500;
		}

		.secondaryRow {
			width: 100%;
			display: flex;
			justify-content: center;

			// 次级辅助按钮：采用轻量文本形态，不与主按钮争夺视觉焦点
			.copyLinkBtn {
				width: auto;
				height: 34px;
				padding: 0 14px;
				background: transparent;
				border: 0;
				border-radius: 10px;
				color: #64748b;
				font-size: 13.5px;
				font-weight: 500;
				cursor: pointer;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				gap: 6px;
				transition: all 0.2s ease;

				&:hover {
					// background: rgba(37, 99, 235, 0.08);
					color: #2563eb;
					transform: translateY(-0.5px);
				}

				&.copied {
					color: #059669;
					// background: rgba(16, 185, 129, 0.1);
				}

				&:active {
					transform: scale(0.96);
				}

				i {
					font-size: 13px;
					transition: transform 0.2s ease;
				}

				&:hover i {
					transform: scale(1.08);
				}
			}
		}
	}

	// ----------------------------------------------------
	// 状态卡片：加载中
	// ----------------------------------------------------
	.stateLoading {
		padding: 32px 12px;

		.loadingSpinner {
			position: relative;
			width: 64px;
			height: 64px;
			margin: 0 auto 20px;
			display: flex;
			align-items: center;
			justify-content: center;

			.spinnerGlow {
				position: absolute;
				inset: 0;
				border: 3px solid rgba(37, 99, 235, 0.15);
				border-top-color: #2563eb;
				border-radius: 50%;
				animation: spin 1s linear infinite;
			}

			.spinnerIcon {
				font-size: 24px;
				color: #2563eb;
				animation: pulse 1.6s ease-in-out infinite;
			}
		}

		.loadingTitle {
			margin: 0 0 6px;
			font-size: 18px;
			font-weight: 600;
			color: #0f172a;
		}

		.loadingSubtitle {
			margin: 0;
			font-size: 13.5px;
			color: #64748b;
		}
	}

	// ----------------------------------------------------
	// 状态卡片：失效/错误
	// ----------------------------------------------------
	.stateError {
		padding: 8px 12px 28px;

		.errorEmblem {
			width: 68px;
			height: 68px;
			margin: 0 auto 28px;
			border-radius: 22px;
			background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
			color: #ef4444;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 30px;
			box-shadow: 0 10px 24px -4px rgba(239, 68, 68, 0.25);
		}

		.errorTitle {
			margin: 0 0 8px;
			font-size: 20px;
			font-weight: 700;
			color: #0f172a;
		}

		.errorMsg {
			margin: 0 0 24px;
			font-size: 14px;
			color: #64748b;
			line-height: 1.5;
		}

		.errorActions {
			display: flex;
			gap: 12px;
			justify-content: center;
			flex-wrap: wrap;

			.actionBtn {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				gap: 8px;
				padding: 10px 18px;
				border-radius: 14px; // 4. 适配圆角矩形
				font-size: 14px;
				font-weight: 600;
				cursor: pointer;
				text-decoration: none;
				border: 0;
				box-sizing: border-box;
				transition: all 0.2s ease;

				&.ghostBtn {
					min-width: 132px;
					background: rgba(241, 245, 249, 0.9);
					color: #334155;
					border: 1px solid rgba(203, 213, 225, 0.8);

					&:hover {
						background: #ffffff;
						border-color: #94a3b8;
						transform: translateY(-1px);
					}
				}

				&.primaryBtn {
					min-width: 96px;
					background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
					color: #ffffff;
					box-shadow: 0 8px 20px -4px rgba(37, 99, 235, 0.4);

					&:hover {
						filter: brightness(1.06);
						transform: translateY(-1px);
					}
				}
			}
		}
	}

	// ----------------------------------------------------
	// 状态卡片：提取码模式 (Portal 一体化轻量胶囊)
	// ----------------------------------------------------
	.statePortal {
		// 针对提取码页适度缩减云端徽章尺寸，避免头重脚轻
		.fileEmblemWrapper {
			width: 66px;
			height: 66px;
			margin: 0 auto 16px;

			.fileEmblemGlow {
				border-radius: 22px;
				filter: blur(12px);
				inset: -6px;
			}

			.fileEmblemBox {
				border-radius: 20px;

				.emblemDocFold {
					width: 17px;
					height: 17px;
					border-bottom-left-radius: 9px;
					border-top-right-radius: 20px;
				}

				.emblemIcon {
					font-size: 28px;
				}
			}
		}

		.fileHeader {
			margin-bottom: 20px;

			.fileName {
				font-size: 19px;
				margin: 0 0 6px;
			}

			.fileSlogan {
				font-size: 13px;
			}
		}

		.portalArea {
			display: flex;
			flex-direction: column;
			gap: 8px;
			width: 100%;
			max-width: 290px;
			margin: 0 auto;

			.portalBar {
				position: relative;
				height: 48px;
				display: flex;
				align-items: center;
				background: rgba(255, 255, 255, 0.88);
				border: 1.5px solid #cbd5e1;
				border-radius: 15px;
				padding: 0 5px 0 14px;
				box-sizing: border-box;
				transition: all 0.25s ease;
				box-shadow: 0 2px 8px -2px rgba(0, 0, 0, 0.05), inset 0 1px 2px rgba(0, 0, 0, 0.02);
				cursor: text;

				&:focus-within {
					border-color: #3b82f6;
					background: #ffffff;
					box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.14);
				}

				&.error {
					border-color: #ef4444;
					box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.14);
					animation: shake 0.35s ease-in-out;
				}

				.barPrefix {
					display: flex;
					align-items: center;
					justify-content: center;
					width: 20px;
					color: #94a3b8;
					font-size: 13.5px;
					flex-shrink: 0;
					transition: color 0.2s ease;
				}

				&:focus-within .barPrefix {
					color: #3b82f6;
				}

				.codeInput {
					flex: 1;
					min-width: 0;
					height: 100%;
					border: none;
					outline: none;
					background: transparent;
					text-align: center;
					font-size: 20px;
					font-weight: 700;
					letter-spacing: 9px;
					text-indent: 9px;
					color: #0f172a;
					font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
					text-transform: uppercase;
					box-sizing: border-box;
				}

				.barSubmitBtn {
					height: 36px;
					padding: 0 13px;
					border: 0;
					border-radius: 10px;
					cursor: pointer;
					color: #ffffff;
					font-size: 13px;
					font-weight: 600;
					background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
					box-shadow: 0 4px 12px -2px rgba(37, 99, 235, 0.4);
					display: inline-flex;
					align-items: center;
					gap: 5px;
					flex-shrink: 0;
					transition: all 0.2s ease;
					outline: none;

					&:hover {
						filter: brightness(1.08);
						transform: translateY(-0.5px);
						box-shadow: 0 6px 16px -2px rgba(37, 99, 235, 0.5);
					}

					&:active {
						transform: scale(0.96);
					}
				}
			}

			.portalErrorTip {
				display: flex;
				align-items: center;
				justify-content: center;
				gap: 6px;
				margin: 0;
				color: #dc2626;
				font-size: 12px;
				font-weight: 500;
			}
		}
	}

	// ----------------------------------------------------
	// 底部通用页脚区
	// ----------------------------------------------------
	.shareFooter {
		position: relative;
		z-index: 10;
		margin-top: auto;

		.FooterLayout{
			background:#fff8;
			border-top: 1px solid #fffa;
		}
	}
}

// --------------------------------------------------------
// 暗黑模式适配 (Dark Theme)
// --------------------------------------------------------
.sharePage[theme='dark'],
:root[theme='dark'] .sharePage,
:root[theme-mode='dark'] .sharePage {
	background: #090d16;
	color: #f1f5f9;

	.skyBackdrop {
		background: linear-gradient(180deg, #090d16 0%, #0d1424 45%, #080c14 100%);

		.orbSun {
			background: radial-gradient(circle, rgba(59, 130, 246, 0.25) 0%, rgba(37, 99, 235, 0) 70%);
		}

		.orbSky {
			background: radial-gradient(circle, rgba(99, 102, 241, 0.2) 0%, rgba(79, 70, 229, 0) 70%);
		}

		.orbViolet {
			background: radial-gradient(circle, rgba(168, 85, 247, 0.18) 0%, rgba(147, 51, 234, 0) 70%);
		}

		.cloudLayer {
			opacity: 0.08;
		}
	}

	.shareHeader {
		background: rgba(13, 20, 36, 0.55);
		border-bottom-color: rgba(255, 255, 255, 0.08);

		.headerLeft {
			.headerDivider {
				background: rgba(255, 255, 255, 0.15);
			}

			.headerTag {
				color: #60a5fa;
				background: rgba(96, 165, 250, 0.12);
				border-color: rgba(96, 165, 250, 0.25);
			}
		}
	}

	.shareMain .shareCard {
		background: rgba(17, 24, 39, 0.78);
		border-color: rgba(255, 255, 255, 0.12);
		box-shadow:
			0 30px 70px -15px rgba(0, 0, 0, 0.65),
			inset 0 1.5px 2px 0 rgba(255, 255, 255, 0.18),
			inset 0 0 0 1px rgba(255, 255, 255, 0.05);

		&:hover {
			box-shadow:
				0 36px 80px -18px rgba(0, 0, 0, 0.75),
				inset 0 1.5px 2px 0 rgba(255, 255, 255, 0.22),
				inset 0 0 0 1px rgba(255, 255, 255, 0.08);
		}
	}

	.fileHeader {
		.fileName {
			color: #f8fafc;
		}

		.fileDesc {
			background: rgba(30, 41, 59, 0.6);
			border-color: rgba(255, 255, 255, 0.08);
			color: #cbd5e1;
		}

		.fileSlogan {
			color: #94a3b8;
		}
	}

	.statsRow {
		background: rgba(30, 41, 59, 0.7);
		border-color: rgba(255, 255, 255, 0.08);
		box-shadow: 0 4px 16px -4px rgba(0, 0, 0, 0.2);

		.statItem {
			.statLabel {
				color: #94a3b8;
			}

			.statValue {
				color: #f1f5f9;
			}
		}

		.statDivider {
			background: rgba(255, 255, 255, 0.1);
		}
	}

	.actionArea .secondaryRow .copyLinkBtn {
		background: transparent;
		border: 0;
		color: #94a3b8;

		&:hover {
			background: rgba(96, 165, 250, 0.12);
			color: #60a5fa;
		}

		&.copied {
			color: #34d399;
			background: rgba(52, 211, 153, 0.15);
		}
	}

	.shareMain .cardFooterNotice {
		color: #94a3b8;

		i {
			color: #60a5fa;
		}
	}

	.stateLoading {
		.loadingTitle {
			color: #f8fafc;
		}

		.loadingSubtitle {
			color: #94a3b8;
		}
	}

	.stateError {
		.errorEmblem {
			background: rgba(239, 68, 68, 0.18);
			color: #f87171;
		}

		.errorTitle {
			color: #f8fafc;
		}

		.errorMsg {
			color: #94a3b8;
		}

		.errorActions .actionBtn.ghostBtn {
			background: rgba(30, 41, 59, 0.8);
			color: #e2e8f0;
			border-color: rgba(255, 255, 255, 0.12);

			&:hover {
				background: rgba(30, 41, 59, 1);
				border-color: rgba(255, 255, 255, 0.25);
			}
		}
	}

	.statePortal .portalArea {
		.portalBar {
			background: rgba(30, 41, 59, 0.65);
			border-color: rgba(255, 255, 255, 0.12);

			&:focus-within {
				background: rgba(30, 41, 59, 0.95);
				border-color: #60a5fa;
				box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.2);
			}

			&.error {
				border-color: #f87171;
				box-shadow: 0 0 0 4px rgba(248, 113, 113, 0.2);
			}

			.barPrefix {
				color: #64748b;
			}

			.codeInput {
				color: #f8fafc;
			}

			.barSubmitBtn {
				box-shadow: 0 4px 14px -2px rgba(37, 99, 235, 0.5);
			}
		}
	}
}

// --------------------------------------------------------
// 移动端响应式布局优化 (<= 640px)
// --------------------------------------------------------
@media (max-width: 640px) {
	.sharePage {
		.shareHeader {
			height: 56px;
			padding: 0 16px;
		}

		.shareMain {
			padding: 24px 16px 16px;

			.shareCard {
				padding: 30px 20px 22px;
				border-radius: 28px;
			}

			.cardFooterNotice {
				margin-top: 16px;
			}
		}

		.statsRow {
			padding: 10px 8px;

			.statItem .statValue {
				font-size: 12.5px;
			}
		}

		.fileHeader .fileName {
			font-size: 18.5px;
		}

		.actionArea .downloadBtn {
			height: 48px;
			font-size: 15px;
			border-radius: 14px;
		}

		.actionArea .secondaryRow .copyLinkBtn {
			height: 32px;
			font-size: 13px;
			padding: 0 12px;
		}

		.shareCard.portalMode {
			padding: 26px 16px 22px;
		}

		.statePortal {
			.fileEmblemWrapper {
				width: 56px;
				height: 56px;
				margin-bottom: 12px;

				.fileEmblemBox {
					border-radius: 17px;

					.emblemIcon {
						font-size: 24px;
					}
				}
			}

			.portalArea {
				.portalBar {
					height: 44px;

					.barPrefix {
						width: 18px;
						font-size: 12px;
					}

					.codeInput {
						font-size: 17px;
						letter-spacing: 7px;
						text-indent: 7px;
					}

					.barSubmitBtn {
						height: 32px;
						padding: 0 10px;
						font-size: 12.5px;
						border-radius: 9px;
					}
				}
			}
		}
	}
}

@keyframes spin {
	to {
		transform: rotate(360deg);
	}
}

@keyframes pulse {

	0%,
	100% {
		opacity: 1;
		transform: scale(1);
	}

	50% {
		opacity: 0.6;
		transform: scale(0.92);
	}
}

@keyframes shake {

	0%,
	100% {
		transform: translateX(0);
	}

	20%,
	60% {
		transform: translateX(-4px);
	}

	40%,
	80% {
		transform: translateX(4px);
	}
}
</style>
```

## OneDrive 文件相关 API / 工具

#### (cloudflare) worker.js

```js
const CLIENT_ID = '52693198-aef2-4b0b-919b-1429e7f101a0'

const REDIRECT_URI = 'https://share.zengjin.work/auth/callback'

const AUTH_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize'

const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'

const GRAPH_URL = 'https://graph.microsoft.com/v1.0'

const REFRESH_TOKEN_KEY = 'onedrive_refresh_token'
// shareCode 字符集: 剔除易混淆 0/o/1/l (保留 i; 与后端/公开页保持一致)
const SHARE_CODE_RE = /^[abcdefghijkmnpqrstuvwxyz23456789]{4}$/

// 下载门禁: ticket 对外有效期 20s(仅作兑换凭证); session 最长 1h 滑动续期
const TICKET_TTL_S = 20
const TICKET_VALID_MS = TICKET_TTL_S * 1000
// Cloudflare KV expirationTtl 下限 60s(硬性): ticket 在 KV 中落盘 60s,
// 真实 20s 有效期由兑换端按 createdAt 年龄判定, 不依赖 KV 精确过期
const KV_TTL_MIN_S = 60
const SESSION_TTL_S = 3600
// OneDrive downloadUrl 实际约 1h 有效, 提前 10 分钟视为需重新取
const DOWNLOAD_URL_MAX_AGE_MS = 50 * 60 * 1000
// KV 写入节流, 避免分段/Range 高频请求打满 KV 写入配额
const KV_WRITE_MIN_MS = 60 * 1000

const TICKET_PREFIX = 'share_ticket:'
const SESSION_PREFIX = 'share_session:'
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

export default {
	async fetch(request, env) {
		const url = new URL(request.url)

		if (url.pathname === '/auth/login') {
			return handleLogin()
		}

		if (url.pathname === '/auth/callback') {
			return handleCallback(request, url, env)
		}

		// 浏览器跨域预检 (公开页与 Worker 不同源)
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: corsHeaders(),
			})
		}

		// 内部：解析 OneDrive 分享链接 (业务后端调用, 需 admin secret)
		if (url.pathname === '/internal/share/resolve') {
			return handleResolveShare(request, env)
		}

		// 公开下载门禁 1: 换 20s ticket
		if (request.method === 'POST' && url.pathname.startsWith('/download-ticket/')) {
			const shareCode = decodeURIComponent(url.pathname.slice('/download-ticket/'.length)).toLowerCase()
			return handleIssueTicket(env, shareCode)
		}

		// 公开下载门禁 2: ticket 兑换 1h session (sessionId 为随机不透明值)
		if (request.method === 'POST' && url.pathname === '/download-session') {
			return handleExchange(request, env)
		}

		// 公开下载门禁 3: 附件流式 + Range (复用 sessionId)
		if (request.method === 'GET' && url.pathname.startsWith('/download/')) {
			const sessionId = decodeURIComponent(url.pathname.slice('/download/'.length))
			return handleStream(request, env, sessionId)
		}

		return helpResponse()
	},
}

/**
 * 开始 Microsoft OAuth 登录
 */
function handleLogin() {
	const state = crypto.randomUUID()

	const params = new URLSearchParams({
		client_id: CLIENT_ID,
		response_type: 'code',
		redirect_uri: REDIRECT_URI,
		response_mode: 'query',
		scope: 'openid profile offline_access User.Read Files.Read',
		state,
	})

	return new Response(null, {
		status: 302,
		headers: {
			Location: `${AUTH_URL}?${params}`,
			'Set-Cookie': [`oauth_state=${encodeURIComponent(state)}`, 'Path=/auth', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=600'].join('; '),
		},
	})
}

/**
 * 处理 OAuth 回调
 */
async function handleCallback(request, url, env) {
	const error = url.searchParams.get('error')

	if (error) {
		return textResponse(['Microsoft 授权失败', '', error, url.searchParams.get('error_description') || ''].join('\n'), 400)
	}

	const code = url.searchParams.get('code')

	if (!code) {
		return textResponse('缺少 authorization code', 400)
	}

	// 验证 OAuth state
	const cookies = parseCookies(request.headers.get('Cookie'))
	const savedState = cookies.oauth_state
	const receivedState = url.searchParams.get('state')

	if (!savedState || !receivedState || savedState !== receivedState) {
		return textResponse('OAuth state 校验失败，请重新登录', 400)
	}

	// 使用 authorization code 换取 Token
	const tokenResponse = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: env.CLIENT_SECRET,
			grant_type: 'authorization_code',
			code,
			redirect_uri: REDIRECT_URI,
			scope: 'openid profile offline_access User.Read Files.Read',
		}),
	})

	const tokenData = await tokenResponse.json()

	if (!tokenResponse.ok) {
		return textResponse(['Token 获取失败', '', JSON.stringify(tokenData, null, 2)].join('\n'), 400)
	}

	const accessToken = tokenData.access_token
	const refreshToken = tokenData.refresh_token

	if (!accessToken) {
		return textResponse('Token 获取成功，但没有返回 access_token', 400)
	}

	if (!refreshToken) {
		return textResponse('Token 获取成功，但没有返回 refresh_token。\n\n' + '请确认 OAuth scope 包含 offline_access。', 400)
	}

	// 保存 Refresh Token
	await env.ONEDRIVE_KV.put(REFRESH_TOKEN_KEY, refreshToken)

	// 验证 OneDrive
	const driveResponse = await fetch(`${GRAPH_URL}/me/drive`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	})

	const driveData = await driveResponse.json()

	if (!driveResponse.ok) {
		return textResponse(['Refresh Token 已保存，但 OneDrive 访问失败', '', JSON.stringify(driveData, null, 2)].join('\n'), 400)
	}

	const headers = new Headers({
		'Content-Type': 'text/plain; charset=utf-8',
	})

	// 清除 OAuth state
	headers.append('Set-Cookie', 'oauth_state=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0')

	return new Response(
		[
			'Microsoft OAuth 授权成功！',
			'',
			'OneDrive 连接成功！',
			'',
			`Drive 类型：${driveData.driveType || '未知'}`,
			`Drive ID：${driveData.id || '未知'}`,
			`Drive 名称：${driveData.name || '未知'}`,
			'',
			'Refresh Token 已安全保存到 Cloudflare KV。',
			'',
			'下一步：可以开始实现文件分享功能。',
		].join('\n'),
		{
			status: 200,
			headers,
		},
	)
}

/**
 * 获取有效的 Access Token
 *
 * 如果 KV 中没有 Refresh Token，则返回 null。
 */
async function getAccessToken(env) {
	const refreshToken = await env.ONEDRIVE_KV.get(REFRESH_TOKEN_KEY)

	if (!refreshToken) {
		return null
	}

	const tokenResponse = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: env.CLIENT_SECRET,
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			scope: 'openid profile offline_access User.Read Files.Read',
		}),
	})

	const tokenData = await tokenResponse.json()

	if (!tokenResponse.ok) {
		console.error('Refresh Token 刷新失败:', JSON.stringify(tokenData))
		return null
	}

	// Microsoft 可能在刷新时返回新的 Refresh Token
	if (tokenData.refresh_token) {
		await env.ONEDRIVE_KV.put(REFRESH_TOKEN_KEY, tokenData.refresh_token)
	}

	return tokenData.access_token || null
}

/**
 * 解析 Cookie
 */
function parseCookies(cookieHeader) {
	const cookies = {}

	if (!cookieHeader) {
		return cookies
	}

	for (const part of cookieHeader.split(';')) {
		const index = part.indexOf('=')

		if (index === -1) {
			continue
		}

		const key = part.slice(0, index).trim()
		const value = part.slice(index + 1).trim()

		cookies[key] = decodeURIComponent(value)
	}

	return cookies
}

/**
 * 根据 shareCode 查询分享记录 (env.SUPABASE_SECRET_KEY 为 Supabase Secret Key, 可读 driveItemId)
 */
async function getShare(env, shareCode) {
	const url = `${env.SUPABASE_URL}/rest/v1/share` + `?select=*` + `&shareCode=eq.${encodeURIComponent(shareCode)}` + `&limit=1`

	const response = await fetch(url, {
		headers: {
			apikey: env.SUPABASE_SECRET_KEY,
			Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
		},
	})

	if (!response.ok) {
		const error = await response.text()
		throw new Error(`Supabase 查询失败：${response.status} ${error}`)
	}

	const rows = await response.json()

	return rows[0] || null
}

/**
 * 获取 OneDrive DriveItem
 */
async function getDriveItem(env, driveItemId) {
	const accessToken = await getAccessToken(env)

	if (!accessToken) {
		throw new Error('无法获取 OneDrive Access Token')
	}

	const response = await fetch(`${GRAPH_URL}/me/drive/items/${encodeURIComponent(driveItemId)}`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	})

	if (!response.ok) {
		const message = await response.text()
		const error = new Error(`OneDrive 查询失败：${response.status} ${message}`)
		error.status = response.status
		throw error
	}

	return response.json()
}

/**
 * 将「OneDrive 源文件已失效」的 share 记录置为停用
 *
 * 仅当 Graph 明确返回 404(源文件被删除/失效)时调用;
 * 停用后公开页 info 与换票接口即刻返回"不存在/已停用", 避免残留可点击但必然失败的分享。
 */
async function disableShare(env, shareCode) {
	const url = `${env.SUPABASE_URL}/rest/v1/share` + `?shareCode=eq.${encodeURIComponent(shareCode)}`
	const response = await fetch(url, {
		method: 'PATCH',
		headers: {
			apikey: env.SUPABASE_SECRET_KEY,
			Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
			'content-type': 'application/json',
			Prefer: 'return=minimal',
		},
		body: JSON.stringify({ enabled: false }),
	})

	if (!response.ok) {
		throw new Error(`停用分享记录失败：${response.status}`)
	}
}

/**
 * 将 OneDrive 分享链接编码为 Microsoft Graph 所需的 shareId
 */
function encodeShareUrl(shareUrl) {
	const bytes = new TextEncoder().encode(shareUrl)
	let binary = ''

	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}

	const base64 = btoa(binary)

	return 'u!' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 通过 OneDrive 分享链接获取 DriveItem
 */
async function resolveShareUrl(env, shareUrl) {
	const accessToken = await getAccessToken(env)

	if (!accessToken) {
		throw new Error('无法获取 OneDrive Access Token')
	}

	const shareId = encodeShareUrl(shareUrl)

	const response = await fetch(`${GRAPH_URL}/shares/${shareId}/driveItem`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	})

	if (!response.ok) {
		const error = await response.text()
		throw new Error(`OneDrive 分享解析失败：${response.status} ${error}`)
	}

	return response.json()
}

/**
 * 验证后台调用凭证
 */
function verifyAdminRequest(request, env) {
	const secret = request.headers.get('X-Share-Admin-Secret')

	return Boolean(secret && env.SHARE_ADMIN_SECRET && secret === env.SHARE_ADMIN_SECRET)
}

/**
 * 内部：解析 OneDrive 分享链接
 *
 * 契约与业务后端 _share.js 对齐:
 *   POST body { shareUrl }  (兼容旧 ?url= 查询参数)
 *   请求头: X-Share-Admin-Secret
 */
async function handleResolveShare(request, env) {
	if (!verifyAdminRequest(request, env)) {
		return textResponse('Unauthorized', 401)
	}

	let shareUrl = null

	if (request.method === 'POST') {
		const body = await request.json().catch(() => ({}))
		shareUrl = String(body.shareUrl || body.url || '').trim() || null
	}

	if (!shareUrl) {
		shareUrl = new URL(request.url).searchParams.get('url')
	}

	if (!shareUrl) {
		return jsonResponse({ msg: '缺少 url/shareUrl 参数' }, 400)
	}

	try {
		const driveItem = await resolveShareUrl(env, shareUrl)

		return jsonResponse({
			driveItemId: driveItem.id,
			fileName: driveItem.name,
			fileSize: driveItem.size ?? null,
			mimeType: driveItem.file?.mimeType ?? null,
			webUrl: driveItem.webUrl ?? null,
		})
	} catch (error) {
		console.error(error)
		return textResponse('OneDrive 分享解析失败', 502)
	}
}

/**
 * 门禁 1: 校验 share 有效后签发 20s ticket
 *
 * KV 以 60s(Cloudflare 下限)落盘, 真实有效期 20s 由兑换端按 createdAt 判定;
 * 避免 expirationTtl<60 抛错导致的 500 / 无 CORS 头假象。
 */
async function handleIssueTicket(env, shareCode) {
	if (!SHARE_CODE_RE.test(shareCode)) {
		return jsonResponse({ msg: '分享链接无效' }, 404)
	}

	let share
	try {
		share = await getShare(env, shareCode)
	} catch (error) {
		console.error(error)
		return jsonResponse({ msg: '查询分享记录失败' }, 502)
	}

	if (!share || !share.enabled) {
		return jsonResponse({ msg: '分享不存在或已停用' }, 404)
	}

	const expiresAtEpoch = share.expiresAt ? beijingStringToEpoch(share.expiresAt) : null
	if (expiresAtEpoch != null && Date.now() >= expiresAtEpoch) {
		return jsonResponse({ msg: '分享已过期' }, 404)
	}

	const ticket = randomToken()
	const payload = {
		shareCode,
		driveItemId: share.driveItemId,
		fileName: share.fileName || '',
		expiresAtEpoch,
		createdAt: Date.now(),
	}

	// KV expirationTtl 下限 60s; 20s 逻辑有效期在兑换端按 createdAt 判定
	try {
		await env.ONEDRIVE_KV.put(TICKET_PREFIX + ticket, JSON.stringify(payload), {
			expirationTtl: KV_TTL_MIN_S,
		})
	} catch (error) {
		console.error('签发 ticket 失败:', error)
		// 统一走带 CORS 头的错误响应, 避免未捕获异常 → 无 CORS 头的 500 假象
		return jsonResponse({ msg: '下载服务暂不可用，请稍后重试' }, 502)
	}

	return jsonResponse({ ticket })
}

/**
 * 门禁 2: 20s 内用 ticket 兑换 1h session
 *
 * sessionId 为密码学随机值: 不含 shareCode, 不可由 ticket 推导。
 * KV 映射 driveItemId/fileName, TTL = min(1h, 剩余分享有效期), 滑动续期。
 */
async function handleExchange(request, env) {
	const body = await request.json().catch(() => ({}))
	const ticket = String(body.ticket || '').trim()

	if (!ticket) {
		return jsonResponse({ msg: '缺少 ticket' }, 400)
	}

	const key = TICKET_PREFIX + ticket
	// 注: KV get→delete 非原子, 极端并发下同一 ticket 理论上可能被兑换两次。
	// 第一版接受该极低概率竞态(至多产生两个均会被每次回查 share 的合法 session),
	// 暂不引入 Durable Object。
	const raw = await env.ONEDRIVE_KV.get(key)

	if (!raw) {
		return jsonResponse({ msg: '下载凭证无效或已过期，请重新点击下载' }, 410)
	}

	// 一次性消费 ticket(删除失败视为服务异常, 不继续签发, 避免被重复兑换)
	try {
		await env.ONEDRIVE_KV.delete(key)
	} catch (error) {
		console.error('消费 ticket 失败:', error)
		return jsonResponse({ msg: '下载凭证处理失败，请重试' }, 502)
	}

	let payload
	try {
		payload = JSON.parse(raw)
	} catch (error) {
		return jsonResponse({ msg: '下载凭证无效，请重新点击下载' }, 410)
	}

	const now = Date.now()

	// 真实有效期判定: 仅接受签发后 ≤20s 的 ticket(与对外规则一致; KV 只保证 ≤60s 落盘)
	if (!payload.createdAt || now - payload.createdAt > TICKET_VALID_MS) {
		// 超龄即作废(上文已删除 KV key, 满足"失效即删")
		return jsonResponse({ msg: '下载凭证已过期，请重新点击下载' }, 410)
	}

	if (payload.expiresAtEpoch != null && now >= payload.expiresAtEpoch) {
		return jsonResponse({ msg: '分享已过期' }, 410)
	}

	const sessionId = randomToken()
	const session = {
		shareCode: payload.shareCode,
		driveItemId: payload.driveItemId,
		fileName: payload.fileName || '',
		expiresAtEpoch: payload.expiresAtEpoch,
		downloadUrl: null,
		urlAt: 0,
		lastTouched: now,
		createdAt: now,
	}

	// 预热: 签发 session 时就取好上游 downloadUrl(重活 = 取 token + Graph 查文件,
	// 均发生在本次兑换内, 已被前端"正在准备下载…"的 loading 覆盖)。
	// 浏览器随后 GET /download/:sessionId 时链路已热, 几乎即时弹下载提示,
	// 消除"按钮已复位、下载却迟迟不开始"的空窗, 避免用户误判重复点击。
	try {
		const item = await getDriveItem(env, payload.driveItemId)
		const freshUrl = item && item['@microsoft.graph.downloadUrl']
		if (!freshUrl) {
			return jsonResponse({ msg: '文件下载地址获取失败，请重试' }, 502)
		}
		session.downloadUrl = freshUrl
		session.urlAt = now
	} catch (error) {
		console.error('预热下载地址失败:', error)
		// Graph 明确 404 = 源文件被删/失效: 当场停用该分享并明确提示,
		// 不给用户留下"点下去没反应/空白"的必失败路径
		if (error && error.status === 404) {
			try {
				await disableShare(env, payload.shareCode)
			} catch (error2) {
				console.error('停用分享记录失败:', error2)
			}
			return jsonResponse({ msg: '分享源文件已失效，请联系分享者重新分享' }, 410)
		}
		return jsonResponse({ msg: '下载服务暂不可用，请重新点击下载' }, 502)
	}

	// session 逻辑沿用 1h 滑动续期; 写 KV 失败也返回带 CORS 头的明确错误
	try {
		await env.ONEDRIVE_KV.put(SESSION_PREFIX + sessionId, JSON.stringify(session), {
			expirationTtl: sessionTtlSeconds(session, now),
		})
	} catch (error) {
		console.error('签发 session 失败:', error)
		return jsonResponse({ msg: '下载服务暂不可用，请重新点击下载' }, 502)
	}

	return jsonResponse({ sessionId })
}

/**
 * 门禁 3: 附件流式下载, 支持 Range; 每次成功请求滑动续期 session
 */
async function handleStream(request, env, sessionId) {
	const key = SESSION_PREFIX + sessionId
	let session

	try {
		const raw = await env.ONEDRIVE_KV.get(key)
		session = raw ? JSON.parse(raw) : null
	} catch (error) {
		session = null
	}

	if (!session) {
		return textResponse('下载会话已失效，请返回重新点击下载', 410)
	}

	const now = Date.now()

	if (!session.shareCode) {
		await env.ONEDRIVE_KV.delete(key)
		return textResponse('下载会话已失效，请重新点击下载', 410)
	}

	// 每次请求重新查询 share: 停用/过期即时阻断 (失效即删 session)
	let share
	try {
		share = await getShare(env, session.shareCode)
	} catch (error) {
		console.error(error)
		return textResponse('分享状态校验失败，请稍后重试', 502)
	}

	if (!share || !share.enabled) {
		await env.ONEDRIVE_KV.delete(key)
		return textResponse('分享不存在或已停用', 410)
	}

	// 以 DB 最新 expiresAt 为准 (管理员可能中途改动到期时间)
	const shareExpiresEpoch = share.expiresAt ? beijingStringToEpoch(share.expiresAt) : null
	session.expiresAtEpoch = shareExpiresEpoch
	if (shareExpiresEpoch != null && now >= shareExpiresEpoch) {
		await env.ONEDRIVE_KV.delete(key)
		return textResponse('分享已过期', 410)
	}

	try {
		let needFresh = !session.downloadUrl || now - (session.urlAt || 0) > DOWNLOAD_URL_MAX_AGE_MS

		if (needFresh) {
			const item = await getDriveItem(env, session.driveItemId)
			const freshUrl = item && item['@microsoft.graph.downloadUrl']
			if (!freshUrl) {
				return textResponse('文件下载地址获取失败', 502)
			}
			session.downloadUrl = freshUrl
			session.urlAt = now
		}

		// 写入节流: url 更新或距上次写超过 1 分钟才持久化(顺带滑动续期)
		const shouldPersist = needFresh || now - (session.lastTouched || session.createdAt) > KV_WRITE_MIN_MS
		if (shouldPersist) {
			session.lastTouched = now
			await env.ONEDRIVE_KV.put(key, JSON.stringify(session), {
				expirationTtl: sessionTtlSeconds(session, now),
			})
		}

		const range = request.headers.get('Range')
		const upHeaders = {}
		if (range) {
			upHeaders.Range = range
		}

		let fileResponse = await fetch(session.downloadUrl, {
			headers: upHeaders,
			redirect: 'follow',
		})

		// 缓存 url 失效(如上游 401/410)且本次非新取, 则刷新一次后重试
		if (!fileResponse.ok && fileResponse.status !== 206 && !needFresh) {
			const item = await getDriveItem(env, session.driveItemId)
			const freshUrl = item && item['@microsoft.graph.downloadUrl']
			if (freshUrl) {
				session.downloadUrl = freshUrl
				session.urlAt = Date.now()
				session.lastTouched = Date.now()
				await env.ONEDRIVE_KV.put(key, JSON.stringify(session), {
					expirationTtl: sessionTtlSeconds(session, Date.now()),
				})
				fileResponse = await fetch(freshUrl, {
					headers: upHeaders,
					redirect: 'follow',
				})
			}
		}

		if (!fileResponse.ok && fileResponse.status !== 206) {
			return textResponse('文件下载失败', fileResponse.status)
		}

		const responseHeaders = new Headers()

		for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag']) {
			const value = fileResponse.headers.get(name)
			if (value) {
				responseHeaders.set(name, value)
			}
		}

		responseHeaders.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(session.fileName)}`)
		responseHeaders.set('Cache-Control', 'no-store')
		responseHeaders.set('Access-Control-Allow-Origin', '*')

		return new Response(fileResponse.body, {
			status: fileResponse.status,
			headers: responseHeaders,
		})
	} catch (error) {
		console.error(error)
		// OneDrive Graph 明确返回 404(源文件已删除/失效): 停用 share 记录, 后续访问即刻被拦截
		if (error && error.status === 404 && session?.shareCode) {
			try {
				await disableShare(env, session.shareCode)
			} catch (disableError) {
				console.error('停用分享记录失败:', disableError)
			}
			await env.ONEDRIVE_KV.delete(key).catch(() => {})
			return textResponse('分享源文件已失效，请联系分享者重新分享', 410)
		}
		return textResponse('下载服务异常', 500)
	}
}

/**
 * 生成密码学随机不透明 token (32B CSPRNG → base64url)
 */
function randomToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	let binary = ''

	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}

	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 'YYYY-MM-DD HH:mm:ss'(北京时间) → epoch 毫秒
 */
function beijingStringToEpoch(value) {
	const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value))
	if (!match) {
		return null
	}
	const [, y, mo, d, h, mi, s] = match.map(Number)
	return Date.UTC(y, mo - 1, d, h, mi, s) - BEIJING_OFFSET_MS
}

/**
 * session 剩余有效秒数 = min(1h, 剩余分享有效期), 并夹取到 [60, 3600]
 *
 * Cloudflare KV expirationTtl 下限 60s: 即使分享剩余不足 60s, key 也会多存活片刻;
 * 真实失效由 handleStream 每次回查 share(expiresAt) 兜底判定, 不依赖 KV 精确过期。
 */
function sessionTtlSeconds(session, now) {
	const cap = session.expiresAtEpoch == null ? SESSION_TTL_S : (session.expiresAtEpoch - now) / 1000
	const ttl = Math.floor(Math.min(SESSION_TTL_S, cap))
	return Math.max(KV_TTL_MIN_S, ttl)
}

/**
 * 跨域响应头 (公开页与 Worker 不同源, 这些端点不携带 Cookie, 可放开)
 */
function corsHeaders() {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'content-type, x-share-admin-secret',
		'Access-Control-Max-Age': '86400',
	}
}

/**
 * JSON 响应 (带跨域头, 供公开页 fetch 读取)
 */
function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			...corsHeaders(),
		},
	})
}

/**
 * 纯文本响应 (人类可读; 跨域头对无凭证端点无害)
 */
function textResponse(text, status = 200) {
	return new Response(text, {
		status,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			...corsHeaders(),
		},
	})
}

/**
 * 路由兜底: 端点一览
 */
function helpResponse() {
	return textResponse(
		'Zengjin OneDrive Share\n\n' +
			'/auth/login - Microsoft OAuth 登录\n' +
			'/auth/callback - OAuth 回调\n' +
			'/internal/share/resolve - 后台解析分享链接 (admin secret)\n' +
			'POST /download-ticket/:shareCode - 换 20s ticket\n' +
			'POST /download-session - ticket 兑换 1h session\n' +
			'GET /download/:sessionId - 附件流式下载 (Range)',
	)
}
```

## 七牛云 / R2 相关工具（如果已经有）

#### api/_base/storage.js

```js
import provider from '#api_util/_storage_provider.js'
import base from '#api_util/base.js'

/**
 * 通用存储适配器 (Provider)
 * 职责：直接与云厂商通信，不含业务逻辑
 */
export default async (req, resp) => {
	base.req = req
	base.resp = resp
	const { action, query, body } = base.getReqInfo()

	// 获取目标桶 (兼容嵌套参数格式)
	const bucket = query.bucket || query['params[bucket]'] || body.bucket || 'file'

	try {
		// 1. 获取上传凭证
		if (action === 'token') {
			const options = {
				returnBody: '{"key":"$(key)","hash":"$(etag)","fsize":$(fsize),"bucket":"$(bucket)","name":"$(x:name)","mimeType":"$(mimeType)"}',
			}
			const data = provider.getUploadToken(bucket, options)
			return base.respSuccess({ data })
		}

		// 2. 原始列表获取
		if (action === 'list') {
			const prefix = query.prefix || query['params[prefix]'] || ''
			const marker = query.marker || query['params[marker]'] || ''
			const limit = parseInt(query.limit || query['params[limit]']) || 100
			const delimiter = query.delimiter || query['params[delimiter]'] || '/'

			const data = await provider.listFiles(bucket, { prefix, marker, limit, delimiter })
			return base.respSuccess({ data })
		}

		// 3. 物理删除
		if (action === 'delete') {
			const key = query.key || body.key
			if (!key) return base.respFailure({ msg: 'Missing key' })
			await provider.deleteFile(bucket, key)
			return base.respSuccess({ msg: 'Deleted' })
		}

		// 4. 物理移动/重命名
		if (action === 'move') {
			const { srcKey, destKey, srcBucket = bucket, destBucket = bucket } = body
			if (!srcKey || !destKey) return base.respFailure({ msg: 'Missing srcKey or destKey' })
			await provider.moveFile(srcBucket, srcKey, destBucket, destKey)
			return base.respSuccess({ msg: 'Moved' })
		}

		// 5. 物理复制
		if (action === 'copy') {
			const { srcKey, destKey, srcBucket = bucket, destBucket = bucket } = body
			if (!srcKey || !destKey) return base.respFailure({ msg: 'Missing srcKey or destKey' })
			await provider.copyFile(srcBucket, srcKey, destBucket, destKey)
			return base.respSuccess({ msg: 'Copied' })
		}

		// 5. 修改存储类型
		if (action === 'chtype') {
			const { key, type } = body
			if (!key || type == null) return base.respFailure({ msg: 'Missing key or type' })
			await provider.changeType(bucket, key, type)
			return base.respSuccess({ msg: 'Type Changed' })
		}

		// 6. 新建文件夹
		if (action === 'mkdir') {
			const { prefix } = body
			if (!prefix) return base.respFailure({ msg: 'Missing prefix' })
			await provider.createFolder(bucket, prefix)
			return base.respSuccess({ msg: 'Folder Created' })
		}

		return base.respFailure({ msg: 'Action Not Found' })
	} catch (error) {
		return base.respFailure({ msg: 'Error', error: error.message })
	}
}
```

#### api/_file.js

```js
import provider from '#api_util/_storage_provider.js'
import base from '#api_util/base.js'

// 业务常量
const BUCKET = 'file'
const MODULE_DRIVE = 'drive'
const MODULE_RECYCLE = 'recycle'

// 自动分类映射
const TYPE_MAP = {
	image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'],
	video: ['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm'],
	audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'],
	doc: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'md'],
}

/**
 * 根据文件名获取分类
 */
const getCategory = fileName => {
	const ext = fileName.split('.').pop().toLowerCase()
	for (const [cat, exts] of Object.entries(TYPE_MAP)) {
		if (exts.includes(ext)) return cat
	}
	return 'other'
}

/**
 * 剥离 ID 前缀获取原始文件名
 */
const getOriginalName = key => {
	const fileName = key.split('/').pop()
	const index = fileName.indexOf('_')
	return index > -1 ? fileName.substring(index + 1) : fileName
}

/**
 * 用户文件业务逻辑控制器 (Controller)
 */
export default async (req, resp) => {
	base.req = req
	base.resp = resp
	const { action, query, body } = base.getReqInfo()

	// TODO: 从 JWT/Session 获取真实 userId，目前硬编码演示
	const userId = 'user_001'

	try {
		// 1. 获取上传凭证 (自动处理路径和 ID 前缀)
		if (action === 'token') {
			const fileName = query.name || body.name || 'file'
			const category = getCategory(fileName)
			const datePrefix = base.getTime().substring(0, 7).replace('-', '') // yyyymm
			const fileId = base.getId()

			// 最终路径：user_001/drive/image/202602/m2k3j4h5g8f2_myphoto.jpg
			const key = `${userId}/${MODULE_DRIVE}/${category}/${datePrefix}/${fileId}_${fileName}`

			const data = provider.getUploadToken(BUCKET, {
				scope: `${provider.getBucketName(BUCKET)}:${key}`, // 限制只能上传到这个 key
				returnBody: `{"key":"$(key)","name":"${fileName}","fileId":"${fileId}","category":"${category}"}`,
			})

			return base.respSuccess({ data: { ...data, key } })
		}

		// 2. 列表查询 (自动剥离前缀，处理模拟目录)
		if (action === 'list') {
			const subPrefix = query.prefix || query['params[prefix]'] || '' // 相对路径，如 "image/"
			const fullPrefix = `${userId}/${MODULE_DRIVE}/${subPrefix}`

			const result = await provider.listFiles(BUCKET, {
				prefix: fullPrefix,
				delimiter: '/',
			})

			const list = [
				...(result.commonPrefixes || []).map(p => ({
					name: p.replace(fullPrefix, '').replace('/', ''),
					prefix: p.replace(`${userId}/${MODULE_DRIVE}/`, ''), // 返回相对业务路径
					fullPrefix: p,
					type: 'dir',
				})),
				...(result.items || []).map(item => ({
					...item,
					originalName: getOriginalName(item.key),
					name: getOriginalName(item.key), // 统一前端显示的名称
					relKey: item.key.replace(`${userId}/${MODULE_DRIVE}/`, ''), // 相对业务路径
					type: 'file',
				})),
			]

			return base.respSuccess({ data: { list, marker: result.marker } })
		}

		// 3. 软删除 (移动到 recycle 目录 + 转为低频存储)
		if (action === 'delete') {
			const relKey = body.key // 相对业务路径，如 "image/202602/id_name.jpg"
			if (!relKey) return base.respFailure({ msg: 'Missing key' })

			const srcKey = `${userId}/${MODULE_DRIVE}/${relKey}`
			const destKey = `${userId}/${MODULE_RECYCLE}/${relKey}`

			// 1. 移动文件
			await provider.moveFile(BUCKET, srcKey, BUCKET, destKey)
			// 2. 修改存储类型为低频 (1) 以节省成本
			try {
				await provider.changeType(BUCKET, destKey, 1)
			} catch (e) {
				console.warn('Chtype failed (maybe not supported by bucket), but move succeeded.')
			}

			return base.respSuccess({ msg: '已移至回收站' })
		}

		// 4. 恢复文件
		if (action === 'restore') {
			const relKey = body.key // 相对业务路径
			const srcKey = `${userId}/${MODULE_RECYCLE}/${relKey}`
			const destKey = `${userId}/${MODULE_DRIVE}/${relKey}`

			await provider.moveFile(BUCKET, srcKey, BUCKET, destKey)
			await provider.changeType(BUCKET, destKey, 0) // 恢复为标准存储 (0)

			return base.respSuccess({ msg: '文件已恢复' })
		}

		return base.respFailure({ msg: 'Action Not Found' })
	} catch (error) {
		return base.respFailure({ msg: 'Error', error: error.message })
	}
}
```

## `share` 表对应的 SQL（如果还有独立 SQL）

```sql
/*
 Navicat Premium Dump SQL

 Source Server         : zengjin@supabase
 Source Server Type    : PostgreSQL
 Source Server Version : 170004 (170004)
 Source Host           : aws-1-ap-northeast-2.pooler.supabase.com:5432
 Source Catalog        : postgres
 Source Schema         : public

 Target Server Type    : PostgreSQL
 Target Server Version : 170004 (170004)
 File Encoding         : 65001

 Date: 10/09/2026 11:25:59
*/


-- ----------------------------
-- Table structure for share
-- ----------------------------
DROP TABLE IF EXISTS "public"."share";
CREATE TABLE "public"."share" (
  "id" varchar(12) COLLATE "pg_catalog"."default" NOT NULL,
  "shareCode" varchar(6) COLLATE "pg_catalog"."default" NOT NULL,
  "driveItemId" varchar(255) COLLATE "pg_catalog"."default" NOT NULL,
  "fileName" varchar(500) COLLATE "pg_catalog"."default" NOT NULL,
  "mimeType" varchar(255) COLLATE "pg_catalog"."default",
  "fileSize" int8,
  "enabled" bool NOT NULL DEFAULT true,
  "expiresAt" varchar(19) COLLATE "pg_catalog"."default",
  "createdBy" varchar(255) COLLATE "pg_catalog"."default",
  "description" text COLLATE "pg_catalog"."default",
  "createTime" varchar(19) COLLATE "pg_catalog"."default" NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'::text),
  "updateTime" varchar(19) COLLATE "pg_catalog"."default" NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'::text),
  "sourceType" varchar(20) COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'official'::character varying,
  "uploadStatus" varchar(20) COLLATE "pg_catalog"."default" NOT NULL DEFAULT 'pending'::character varying,
  "downloadCount" int8 NOT NULL DEFAULT 0
)
;

-- ----------------------------
-- Indexes structure for table share
-- ----------------------------
CREATE INDEX "share_createdBy_idx" ON "public"."share" USING btree (
  "createdBy" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);
CREATE INDEX "share_driveItemId_idx" ON "public"."share" USING btree (
  "driveItemId" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);
CREATE INDEX "share_enabled_idx" ON "public"."share" USING btree (
  "enabled" "pg_catalog"."bool_ops" ASC NULLS LAST
);
CREATE INDEX "share_expiresAt_idx" ON "public"."share" USING btree (
  "expiresAt" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);
CREATE INDEX "share_sourceType_idx" ON "public"."share" USING btree (
  "sourceType" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);
CREATE INDEX "share_source_enabled_expires_idx" ON "public"."share" USING btree (
  "sourceType" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST,
  "enabled" "pg_catalog"."bool_ops" ASC NULLS LAST,
  "expiresAt" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);
CREATE INDEX "share_uploadStatus_idx" ON "public"."share" USING btree (
  "uploadStatus" COLLATE "pg_catalog"."default" "pg_catalog"."text_ops" ASC NULLS LAST
);

-- ----------------------------
-- Uniques structure for table share
-- ----------------------------
ALTER TABLE "public"."share" ADD CONSTRAINT "share_shareCode_key" UNIQUE ("shareCode");

-- ----------------------------
-- Checks structure for table share
-- ----------------------------
ALTER TABLE "public"."share" ADD CONSTRAINT "share_sourceType_check" CHECK ("sourceType"::text = ANY (ARRAY['official'::character varying::text, 'transfer'::character varying::text]));
ALTER TABLE "public"."share" ADD CONSTRAINT "share_uploadStatus_check" CHECK ("uploadStatus"::text = ANY (ARRAY['pending'::character varying::text, 'uploading'::character varying::text, 'completed'::character varying::text, 'failed'::character varying::text, 'expired'::character varying::text, 'deleted'::character varying::text]));

-- ----------------------------
-- Primary Key structure for table share
-- ----------------------------
ALTER TABLE "public"."share" ADD CONSTRAINT "share_pkey" PRIMARY KEY ("id");

-- ----------------------------
-- Foreign Keys structure for table share
-- ----------------------------
ALTER TABLE "public"."share" ADD CONSTRAINT "share_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "public"."base_user" ("id") ON DELETE SET NULL ON UPDATE NO ACTION;

```

