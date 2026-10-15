<script setup>
import Precode from '/src/components/Precode.vue'

const state = reactive({
	list: [
		{ id: 1, label: 'Item 1' },
		{ id: 2, label: 'Item 2' },
		{ id: 3, label: 'Item 3' },
		{ id: 4, label: 'Item 4' },
		{ id: 5, label: 'Item 5' },
	],
	dragI: null,
	hoverI: null,
})

// 拖拽开始时记录起始索引
const dragstart_item = (e, i) => {
	state.dragI = i
	e.dataTransfer.effectAllowed = 'move'
}

// 拖拽经过时更新悬停索引
const dragover_item = (e, i) => {
	// 防止自身触发高亮
	if (i != state.dragI) {
		state.hoverI = i
	}
}

// 离开时清除悬停索引
const dragleave_item = (e, i) => {
	if (state.hoverI == i) {
		state.hoverI = null
	}
}

// 释放时交换元素位置
const drop_item = (e, i) => {
	if (state.dragI !== null && state.hoverI !== null) {
		// 交换数组元素
		const item = state.list[state.dragI]
		state.list[state.dragI] = state.list[i]
		state.list[i] = item

		// 重置状态
		state.dragI = null
		state.hoverI = null
	}
}
</script>
<template>
	<div class="container">
		<pre>{{ JSON.stringify(state.list, null, 2) }}</pre>
		<!-- 拖拽容器 -->
		<div class="list" v-auto-animate>
			<!-- 拖拽项 -->
			<template v-for="(item, i) in state.list" :key="item.id">
				<div
					class="item"
					draggable="true"
					:active="state.hoverI == i ? '' : null"
					@dragstart="dragstart_item($event, i)"
					@dragover.prevent="dragover_item($event, i)"
					@dragleave="dragleave_item($event, i)"
					@drop.prevent="drop_item($event, i)">
					{{ item.label }}
				</div>
			</template>
		</div>
	</div>
	<Precode url="/case/pages/交互效果/拖动互换位置.vue" />
</template>
<style scoped>
.container {
	padding: 20px;
}

.list {
	display: flex;
	flex-direction: column;
	gap: 10px;
	max-width: 300px;
}

.item {
	padding: 15px;
	background: #fff;
	border: 2px solid #ddd;

	user-select: none;
	cursor: grab;
}

/* 拖拽效果 */
.item:active {
	opacity: 0.5;
	cursor: grabbing;
}

/* 悬停效果 */
.item[active] {
	background: #f0f9ff;
	border-color: #2196f3;
	box-shadow: 0 3px 6px rgba(0, 0, 0, 0.1);
	transform: scale(1.05);
}
</style>
