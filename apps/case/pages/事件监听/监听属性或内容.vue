<script setup>
import dayjs from 'dayjs'
import { MessagePlugin } from 'tdesign-vue-next'

import { nextTick } from 'vue'

import Logs from '/src/components/Logs.vue'
import Precode from '/src/components/Precode.vue'
import base from '/src/js/base.js'

const boxRef = ref()

const state = reactive({
	title: '初始title',
	radius: 0,

	logs: [],
})

onMounted(() => {
	const mutationObserver = new MutationObserver(mutationObserver_todo)
	mutationObserver.observe(boxRef.value, {
		attributes: true, // 观察属性改变
		childList: true, // 观察子节点新增或删除
		subtree: true, // 观察后代节点, 默认false
	})
})

function mutationObserver_todo(mutations) {
	if (!boxRef.value) return //暂未发现异常触发, 但保险起见还是加兼容

	mutations.forEach(item => {
		console.log(item.type, item)

		let log = `变化类型：${item.type}　`

		if (item.type === 'attributes') {
			log += `属性名：${item.attributeName}`
		}
		if (item.type === 'childList') {
			log += `增加项：${
				Array.from(item.addedNodes)
					.map(item => item.nodeName)
					.join(',') || '无'
			}　`
			log += `删除项：${
				Array.from(item.removedNodes)
					.map(item => item.nodeName)
					.join(',') || '无'
			}`
		}
		state.logs.push(log)
	})
}

let bgColors = ['#f005', '#0f05', '#00f5', '#f0f5', '#ff05', '#0ff5']
let bgColorIndex = 0
function change_bg() {
	boxRef.value.style.background = bgColors[bgColorIndex]

	bgColorIndex++
	if (bgColorIndex >= bgColors.length) {
		bgColorIndex = 0
	}
}

function change_radius() {
	state.radius = base.getRandom(0, 100)
}

function change_title() {
	state.title = dayjs().format('HH:mm:ss')
}

function insert_child() {
	let li = document.createElement('li')
	li.textContent = '新增子节点'
	boxRef.value.appendChild(li)
}

function insert_grandchild() {
	let lis = boxRef.value.querySelectorAll('li')
	if (lis.length === 0) {
		MessagePlugin.warning('没有子节点了')
		return
	}
	let li = lis[base.getRandom(0, lis.length - 1)]
	let p = document.createElement('p')
	p.textContent = '新增孙节点'
	li.appendChild(p)
}

function insert_childWithGrandchild() {
	let li = document.createElement('li')
	li.textContent = '新增子节点'

	let p1 = document.createElement('p')
	p1.textContent = '新增孙节点'
	li.appendChild(p1)

	let p2 = document.createElement('p')
	p2.textContent = '新增孙节点'
	li.appendChild(p2)

	boxRef.value.appendChild(li)
}

function remove_child() {
	let lis = boxRef.value.querySelectorAll('li')
	if (lis.length === 0) {
		MessagePlugin.warning('没有子节点了')
		return
	}
	let li = lis[base.getRandom(0, lis.length - 1)]
	li.remove()
}

function remove_grandchild() {
	let ps = boxRef.value.querySelectorAll('p')
	if (ps.length === 0) {
		MessagePlugin.warning('没有孙节点了')
		return
	}
	let p = ps[base.getRandom(0, ps.length - 1)]
	p.remove()
}

function clear_all() {
	boxRef.value.innerHTML = ''
}

function clear_child() {
	let lis = boxRef.value.querySelectorAll('li')
	if (lis.length === 0) {
		MessagePlugin.warning('没有子节点了')
		return
	}
	lis.forEach(li => {
		li.innerHTML = '改变子节点'
	})
}

function clear_grandchild() {
	let ps = boxRef.value.querySelectorAll('p')
	if (ps.length === 0) {
		MessagePlugin.warning('没有孙节点了')
		return
	}
	ps.forEach(p => {
		p.innerHTML = '改变孙节点'
	})
}

function reset() {
	boxRef.value.innerHTML = '<li class="raw">原有子节点</li>'
	boxRef.value.style.background = 'var(--bg-hard)'
	state.radius = 0
	state.title = '初始title'
}
</script>
<template>
	<section>
		<ul class="box" :title="state.title" :style="{ borderRadius: state.radius + 'px' }" ref="boxRef">
			<li class="raw">原有子节点</li>
		</ul>

		<div class="ctrlbar">
			<t-space direction="vertical" size="12px">
				<t-button size="small" variant="outline" @click="change_bg"> 改变背景色 </t-button>
				<t-button size="small" variant="outline" @click="change_radius"> 改变圆角 </t-button>
				<t-button size="small" variant="outline" @click="change_title"> 改变title </t-button>
				<t-divider dashed />
				<t-button size="small" variant="outline" @click="insert_child"> 新增子节点 </t-button>
				<t-button size="small" variant="outline" @click="insert_grandchild"> 新增孙节点 </t-button>
				<t-button size="small" variant="outline" @click="insert_childWithGrandchild"> 新增子含孙节点 </t-button>
				<t-divider dashed />
				<t-button size="small" variant="outline" @click="remove_child"> 移除子节点 </t-button>
				<t-button size="small" variant="outline" @click="remove_grandchild"> 移除孙节点</t-button>
				<t-divider dashed />
				<t-button size="small" variant="outline" @click="clear_child"> 改变全部子节点内容</t-button>
				<t-button size="small" variant="outline" @click="clear_grandchild"> 改变全部孙节点内容</t-button>
				<t-divider dashed />
				<t-button size="small" variant="outline" @click="clear_all"> 清空 </t-button>
				<t-button size="small" variant="outline" @click="reset"> 重置</t-button>
			</t-space>
		</div>
	</section>
	<Logs v-model="state.logs"></Logs>
	<Precode url="/case/pages/事件监听/监听属性或内容.vue" />
</template>

<style lang="less" scoped>
section {
	overflow: auto;

	height: 100%;
	padding: 16px;

	.ctrlbar {
		position: absolute;
		top: 16px;
		left: 16px;
		display: flex;
		flex-direction: column;

		.t-divider {
			margin: 0;
		}
	}

	.box {
		width: 200px;
		min-height: 200px;
		margin: 0 auto;
		padding: 16px;

		border: 1px solid var(--bd);
		background: var(--bg-hard);

		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		text-align: center;
		gap: 8px;

		color: #fff;

		:deep(li) {
			background: var(--warning);
			padding: 8px;

			p {
				background: #fff8;
				color: #0008;
				padding: 4px 8px;
				margin-top: 4px;
			}
		}

		:deep(li.raw) {
			background: var(--success);
		}
	}
}
</style>
