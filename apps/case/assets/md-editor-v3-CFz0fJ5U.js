import{Gr as e,Ii as t,Li as n,Wi as r,Zr as i,_i as a,fi as o,ki as s,l as c,mi as l,ni as u,oi as d,qr as f,ti as p,vi as m,zi as h}from"./index-BqETJdWy.js";import{a as g,c as _,i as v,n as y,o as b,r as x,s as S,t as C}from"./preview-DNUuimKa.js";`${_}`;var w=(e,t)=>+getComputedStyle(e).getPropertyValue(t).replace(`px`,``),T=u({props:{tocItem:{type:Object,default:()=>({})},mdHeadingId:{type:Function,default:()=>{}},onActive:{type:Function,default:()=>{}},onClick:{type:Function,default:()=>{}},scrollElementOffsetTop:{type:Number,default:0}},setup(e){let t=d(`scrollElementRef`),r=d(`roorNodeRef`),i=n();s(()=>e.tocItem.active,t=>{t&&e.onActive(e.tocItem,i.value)}),l(()=>{e.tocItem.active&&e.onActive(e.tocItem,i.value)});let a=n=>{if(n.stopPropagation(),e.onClick(n,e.tocItem),n.defaultPrevented)return;let i=e.mdHeadingId({text:e.tocItem.text,level:e.tocItem.level,index:e.tocItem.index,currentToken:e.tocItem.currentToken,nextToken:e.tocItem.nextToken}),a=r.value.getElementById(i),o=t.value;if(a&&o){let t=a.offsetParent,n=a.offsetTop;if(o.contains(t))for(;t&&o!=t;)n+=t?.offsetTop,t=t?.offsetParent;let r=a.previousElementSibling,i=0;r||(i=w(a,`margin-block-start`)),o?.scrollTo({top:n-e.scrollElementOffsetTop-i,behavior:`smooth`})}};return()=>p(`div`,{ref:i,class:[`${_}-catalog-link`,e.tocItem.active&&`md-editor-catalog-active`],onClick:a},[p(`span`,{title:e.tocItem.text},[e.tocItem.text]),e.tocItem.children&&e.tocItem.children.length>0&&p(`div`,{class:`md-editor-catalog-wrapper`},[e.tocItem.children.map(t=>p(T,{mdHeadingId:e.mdHeadingId,key:`${e.tocItem.text}-link-${t.level}-${t.text}`,tocItem:t,onActive:e.onActive,onClick:e.onClick,scrollElementOffsetTop:e.scrollElementOffsetTop},null))])])}}),E=u({name:`MdCatalog`,props:{editorId:{type:String,default:void 0},class:{type:String,default:``},mdHeadingId:{type:Function,default:({text:e})=>e},scrollElement:{type:[String,Object],default:void 0},theme:{type:String,default:`light`},offsetTop:{type:Number,default:20},scrollElementOffsetTop:{type:Number,default:0},onClick:{type:Function,default:void 0},onActive:{type:Function,default:void 0},isScrollElementInShadow:{type:Boolean,default:!1},syncWith:{type:String,default:`preview`},catalogMaxDepth:{type:Number,default:void 0}},emits:[`onClick`,`onActive`],setup(r,i){let a=r.editorId,c=`#${a}-preview-wrapper`,u=t({list:[],show:!1,scrollElement:r.scrollElement||c}),d=h(),C=n(),E=n(),D=n(),O=n(),k=h(),A=n({});m(`scrollElementRef`,E),m(`roorNodeRef`,O);let j=f(()=>{let e=[];return u.list.forEach((t,n)=>{if(r.catalogMaxDepth&&t.level>r.catalogMaxDepth)return;let{text:i,level:a,line:o}=t,s={level:a,text:i,line:o,index:n+1,active:d.value===t};if(e.length===0)e.push(s);else{let t=e[e.length-1];if(s.level>t.level)for(let e=t.level+1;e<=6;e++){let{children:e}=t;if(!e){t.children=[s];break}if(t=e[e.length-1],s.level<=t.level){e.push(s);break}}else e.push(s)}}),e}),M=()=>{if(u.scrollElement instanceof HTMLElement)return u.scrollElement;let e=document;return(u.scrollElement===c||r.isScrollElementInShadow)&&(e=C.value?.getRootNode()),e.querySelector(u.scrollElement)},N=e=>{if(e.length===0)return d.value=void 0,u.list=[],!1;let{activeHead:t,activeIndex:n}=e.reduce((e,t,n)=>{let i=0;if(r.syncWith===`preview`){let e=O.value?.getElementById(r.mdHeadingId({text:t.text,level:t.level,index:n+1,currentToken:t.currentToken,nextToken:t.nextToken}));e instanceof HTMLElement&&(i=y(e,E.value))}else{let e=k.value;e&&(i=e.lineBlockAt(e.state.doc.line(t.line+1).from).top-e.scrollDOM.scrollTop)}return i<r.offsetTop&&i>e.minTop?{activeHead:t,activeIndex:n,minTop:i}:e},{activeHead:e[0],activeIndex:0,minTop:-(2**53-1)}),i=t,{catalogMaxDepth:a}=r;if(a&&i.level>a){for(let t=n;t>=0;t--){let n=e[t];if(n.level<=a){i=n;break}}if(i.level>a){let t=e.find(e=>e.level<=a);t&&(i=t)}}d.value=i,u.list=e},P=(e,t)=>{A.value.top=t.offsetTop+w(t,`padding-block-start`)+`px`,r.onActive?.(e,t),i.emit(`onActive`,e,t)},F=()=>{N(u.list)},I=e=>{if(D.value?.removeEventListener(`scroll`,F),r.syncWith===`editor`)D.value=k.value?.scrollDOM;else{let e=M();E.value=e,D.value=e===document.documentElement?document:e}N(e),D.value?.addEventListener(`scroll`,F)},L=e=>{k.value=e};s([()=>r.syncWith,k,()=>r.catalogMaxDepth],()=>{I(u.list)}),l(()=>{O.value=C.value.getRootNode(),x.on(a,{name:g,callback:I}),x.on(a,{name:b,callback:L}),x.emit(a,v),x.emit(a,S)}),o(()=>{x.remove(a,g,I),x.remove(a,b,L),D.value?.removeEventListener(`scroll`,F)});let R=(e,t)=>{r.onClick?.(e,t),i.emit(`onClick`,e,t)};return()=>p(`div`,{class:[`${_}-catalog`,r.theme===`dark`&&`md-editor-catalog-dark`,r.class||``],ref:C},[j.value.length>0&&p(e,null,[p(`div`,{class:`md-editor-catalog-indicator`,style:A.value},null),p(`div`,{class:`md-editor-catalog-container`},[j.value.map(e=>p(T,{mdHeadingId:r.mdHeadingId,tocItem:e,key:`link-${e.level}-${e.text}`,onActive:P,onClick:R,scrollElementOffsetTop:r.scrollElementOffsetTop},null))])])])}});E.install=e=>(e.component(E.name,E),e);var D=`# Vue 3 表单自动草稿保存与恢复机制指南

在复杂的企业级表单业务中，用户录入大量数据时可能会遇到误刷新、页面崩溃或意外关闭等情况。为了保障数据安全，本项目设计并实现了一套**非侵入式、内聚、遵循单向数据流**的通用表单草稿自动保存与恢复方案。

本文档详细介绍了该机制的设计原理，并附带了核心组件源码及父表单接入示例，旨在方便开发人员或 AI 助手在其他项目中快速复刻此能力。

---

## 一、 机制设计与核心原理

这套机制围绕一个独立的草稿组件 \`<Draft>\` 展开，核心特性如下：

1. **自动侦听与防抖存储**：
    - **深度监听 (\`watch deep\`)**：组件内部对父组件传入的表单数据（\`form\`）进行深度 watch。为避免高频修改触发大量 I/O 损耗，采用 **2 秒防抖（Debounce）** 保存至 \`LocalStorage\`。
    - **失焦即存 (\`focusout\`)**：监听全局的 \`focusout\` 事件。当用户在输入框完成输入并点击空白处或切换焦点时，立即执行保存，保证防抖未触发前的最后一笔录入也能安全入库。
2. **存储分区设计（防篡改与覆盖）**：
    - **新增状态 (\`insert\`)**：草稿以指定的 \`keyPrefix\` 加 \`_insert\` 组合作为键名存储（如 \`chanpinrk_jc_insert\`），全局仅一份。
    - **编辑状态 (\`update\`)**：以 \`keyPrefix_update_[id]\` 组合作为键名。不同的编辑记录拥有独立唯一的草稿，互不覆盖干扰。
    - **空白草稿拦截**：在新增状态下，如果表单没有任何有效数据录入，将不会保存草稿，防止空白数据覆盖已有草稿。
3. **单向数据流确认恢复**：
    - 恢复操作采用“气泡确认框（Popconfirm）”进行二次确认。
    - 用户确认后，子组件不直接修改父组件的表单属性（避免破坏单向数据流），而是通过事件 **\`emit('load', draftContent)\`** 将草稿内容派发出去，由父组件在自身作用域执行表单还原与级联字典拉取。
4. **生命周期协同与缓存回收**：
    - **安全激活**：父组件在初始数据请求成功（即 \`get_data\` 结束后）再调用子组件的 \`init_draft()\` 方法激活草稿读取和 watch 监听。防止后台拉取到的初始数据在刚挂载时，被误判为“用户输入变化”而保存覆盖了旧草稿。
    - **垃圾回收 (GC) - 表单提交**：当表单成功提交（\`onSubmit\`）时，表单内主动调用子组件的 \`clear_draft()\` 方法，彻底销毁该表单对应的 LocalStorage 缓存。
    - **垃圾回收 (GC) - 列表删除**：当用户在表格页（List 页面）直接物理删除某条数据时，也应同步清理该数据在本地持久化的编辑草稿，防止其在 LocalStorage 中沦为长期的僵尸数据。

---

## 二、 通用草稿组件源码 (\`Draft.vue\`)

直接将此组件复制并放置于项目组件库中（例如 \`src/components/base/Draft.vue\`）：

\`\`\`vue
<!-- 通用表单草稿组件 Draft.vue -->
<script setup>
import { reactive, watch, onMounted, onBeforeUnmount } from 'vue'
import dayjs from 'dayjs'

const props = defineProps({
	form: { type: Object, required: true },
	action: { type: String, required: true },
	row: { type: Object, default: () => ({}) },
	keyPrefix: { type: String, required: true },
})

const emit = defineEmits(['load'])

const draftMeta = reactive({
	time: '',
	content: null,
	shown: false,
})

let watcherBlocked = true
let draftTimeout = null

// 根据状态动态获取草稿的 LocalStorage 唯一键
function get_draft_key() {
	if (props.action === 'insert') {
		return \`\${props.keyPrefix}_insert\`
	} else if (props.action === 'update' && props.row?.id) {
		return \`\${props.keyPrefix}_update_\${props.row.id}\`
	}
	return null
}

// 加载本地草稿元数据
function load_draftMeta() {
	const key = get_draft_key()
	if (!key) return
	try {
		const stored = localStorage.getItem(key)
		if (stored) {
			const draft = JSON.parse(stored)
			if (draft && draft.time && draft.content) {
				draftMeta.time = draft.time
				draftMeta.content = draft.content
				draftMeta.shown = true
			}
		}
	} catch (e) {
		console.error('Failed to load draft metadata:', e)
	}
}

// 执行草稿持久化
function save_draft() {
	const key = get_draft_key()
	if (!key) return

	// 新增状态下，若没有任何内容录入则不保存，避免空白草稿覆盖
	if (props.action === 'insert') {
		const hasInput =
			Object.keys(props.form).some(k => {
				// 排除子表格的空引用属性
				if (k === 'fpv_camera' || k === 'details' || k === 'drone_camera' || k === 'compatibles') return false
				return props.form[k] !== undefined && props.form[k] !== null && props.form[k] !== ''
			}) ||
			(props.form.fpv_camera && props.form.fpv_camera.length > 0) ||
			(props.form.details && props.form.details.length > 0) ||
			(props.form.compatibles && props.form.compatibles.some(item => item.brand || item.series || item.model))
		if (!hasInput) return
	}

	const now = dayjs().format('YYYY-MM-DD HH:mm:ss')
	const draft = {
		time: now,
		content: JSON.parse(JSON.stringify(props.form)),
	}
	localStorage.setItem(key, JSON.stringify(draft))
	draftMeta.time = now
	draftMeta.content = draft.content
	draftMeta.shown = true
}

// 恢复草稿确认
function confirm_loadDraft() {
	if (draftMeta.content) {
		watcherBlocked = true
		emit('load', draftMeta.content)
		draftMeta.shown = false
		// 恢复数据后防抖短时间锁定 watch，防止自身修改触发草稿重写
		setTimeout(() => {
			watcherBlocked = false
		}, 500)
	}
}

// 失焦立即保存监听
function focusout_todo() {
	if (props.action !== 'insert' && props.action !== 'update') return
	if (watcherBlocked) return
	save_draft()
}

// 销毁草稿数据（提交表单成功后）
function clear_draft() {
	const key = get_draft_key()
	if (key) {
		localStorage.removeItem(key)
	}
	draftMeta.time = ''
	draftMeta.content = null
	draftMeta.shown = false
}

// 初始化及激活（暴露给父组件调用）
function init_draft() {
	load_draftMeta()
	setTimeout(() => {
		watcherBlocked = false
	}, 500)
}

// 深度深度防抖 watch 表单变化
watch(
	() => props.form,
	() => {
		if (props.action !== 'insert' && props.action !== 'update') return
		if (watcherBlocked) return
		if (draftTimeout) {
			clearTimeout(draftTimeout)
		}
		draftTimeout = setTimeout(() => {
			save_draft()
		}, 2000)
	},
	{ deep: true },
)

onMounted(() => {
	addEventListener('focusout', focusout_todo)
})

onBeforeUnmount(() => {
	removeEventListener('focusout', focusout_todo)
	if (draftTimeout) {
		clearTimeout(draftTimeout)
	}
})

// 显式暴露方法给父组件的 Ref
defineExpose({
	init_draft,
	clear_draft,
})
<\/script>

<template>
	<t-popconfirm
		theme="primary"
		content="确定加载该草稿?"
		@confirm="confirm_loadDraft"
		v-if="(props.action === 'insert' || props.action === 'update') && draftMeta.shown">
		<t-link theme="default">
			<t-popup :content="\`\${draftMeta.time} 自动存入草稿，点击可恢复\`" showArrow placement="bottom">
				<t-icon name="history" size="18px" />
			</t-popup>
		</t-link>
	</t-popconfirm>
</template>

<style lang="less" scoped>
.t-link {
	position: absolute;
	left: 0;
}
</style>
\`\`\`

> [!NOTE] > **内置定位说明**：在组件内通过 Scoped CSS 为 \`.t-link\` 直接定义了 \`position: absolute; left: 0;\` 定位，这使时钟图标能够完全自主地贴在父级容器的左下侧，无需外部表单或全局公共样式去处理挤压、宽度变动及定位排版等问题，最大化提升了“即插即用”的整洁性。

---

## 三、 父表单集成范式与示例

父表单组件接入自动草稿功能非常简单，仅需在组件中做好**声明**、**生命周期调用**以及**事件承接**三个步骤：

### 1. 模板声明

在父表单的脚部（例如页脚插槽）引入并绑定该组件：

\`\`\`html
<template #FormModelFooter>
	<Draft ref="draftRef" keyPrefix="custom_form_key" :form="form" :action="props.action" :row="props.row" @load="load_draft" />
	<t-button theme="primary" type="submit">提交</t-button>
</template>
\`\`\`

### 2. JS 逻辑编写

在 \`<script setup>\` 里的集成逻辑结构如下：

\`\`\`javascript
import { ref, onMounted, reactive } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import req from '@/util/req'
import Draft from '@/components/base/Draft.vue'

const props = defineProps(['row', 'action', 'submitCallback'])
const form = reactive({
	brand: '',
	model: '',
	// 其他业务表单字段
})

const draftRef = ref() // 绑定组件 Ref

onMounted(() => {
	get_data(() => {
		// 关键点一：必须在获取数据回调执行成功后再激活草稿监听
		if (props.action === 'insert' || props.action === 'update') {
			draftRef.value?.init_draft()
		}
	})
})

// 关键点二：定义草稿恢复逻辑（load 事件回调）
function load_draft(draftContent) {
	// 1. 清空当前表单所有动态属性，防止脏数据交叉污染
	Object.keys(form).forEach(key => delete form[key])
	// 2. 将草稿的最新数据浅拷贝合并入表单中
	Object.assign(form, draftContent)

	// 3. 高级字典联动：如果表单内有级联关系（如品牌联动系列/型号），必须在此手动触发字典异步拉取，以回显名称
	if (form.brand) {
		req.get_dict({ parentUuid: form.brand }).then(dictData => {
			selects.model_types = dictData || []
		})
	}
}

// 获取初始化表单数据
function get_data(callback) {
	if (props.action === 'insert') {
		callback?.()
		return
	}
	req.get('/api/product/get', { id: props.row.id }).then(res => {
		Object.assign(form, res.data || {})
		callback?.()
	})
}

// 提交成功后回收缓存
function onSubmit({ validateResult }) {
	if (validateResult !== true) return

	req.post('/api/product/save', form).then(res => {
		MessagePlugin.success('保存成功')
		// 关键点三：表单保存成功，主动清空本地草稿缓存
		draftRef.value?.clear_draft()
		props.submitCallback(res.data)
	})
}
\`\`\`

---

## 四、 表格页（列表页）的草稿清理对接

在以列表/表格为核心的数据页中，如果某行数据被用户成功物理删除，为了保持 \`LocalStorage\` 的干净，应当在表格组件的删除回调（Confirm/Delete）中，同步清除该数据对应的编辑草稿缓存。

### 示例代码：

\`\`\`javascript
// 在表格页的 <script setup> 中
import req from '@/util/req'
import { MessagePlugin } from 'tdesign-vue-next'

// 删除单条记录
function delete_row_todo(row) {
	req.post('/api/product/delete', { id: row.id }).then(() => {
		MessagePlugin.success('删除成功')
		
		// 关键点：数据物理删除成功后，一并清理本地该记录对应的编辑草稿
		localStorage.removeItem(\`custom_form_key_update_\${row.id}\`)
		
		// 刷新列表数据
		fetch_tableData()
	})
}
\`\`\`

通过这一联动清除机制，编辑状态下产生的特定记录草稿，会随数据本身的删除而彻底被垃圾回收（GC），防止残留无效数据无限制地霸占用户的浏览器 LocalStorage 空间。
`,O=`preview-only`,k=c({__name:`md-editor-v3`,setup(e){let t=document.documentElement;return(e,n)=>(a(),i(`section`,null,[p(r(C),{id:O,modelValue:r(D)},null,8,[`modelValue`]),p(r(E),{editorId:O,scrollElement:r(t)},null,8,[`scrollElement`])]))}},[[`__scopeId`,`data-v-afc1371e`]]);export{k as default};