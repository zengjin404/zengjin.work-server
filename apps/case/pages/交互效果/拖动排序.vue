<script setup>
import draggable from 'vuedraggable'

import Precode from '/src/components/Precode.vue'

const state = reactive({
	list: [
		{ id: 1, label: 'Item 1' },
		{ id: 2, label: 'Item 2' },
		{ id: 3, label: 'Item 3' },
		{ id: 4, label: 'Item 4' },
		{ id: 5, label: 'Item 5' },
	],
})
</script>
<template>
	<div class="container">
		<pre>{{ JSON.stringify(state.list, null, 2) }}</pre>
		<!-- 拖拽容器 -->
		<!--  handle=".item_handle" -->
		<draggable v-model="state.list" item-key="id" class="list" animation="300" v-auto-animate>
			<!-- 拖拽项 -->
			<template #item="{ element: item }">
				<div class="item">
					<label>{{ item.label }}</label>
					<!-- <i class="fa-regular fa-grip-dots-vertical item_handle"></i> -->
				</div>
			</template>
		</draggable>
	</div>
	<Precode url="/case/pages/交互效果/拖动排序.vue" />
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

	display: flex;
	align-items: center;
	justify-content: space-between;

	cursor: grab;
}

.item_handle {
	cursor: grab;
}

/* 拖拽效果 */
.item.sortable-chosen:not(.sortable-ghost) {
	background: #0000;
	cursor: grabbing;
}

/* 占位效果 */
.item.sortable-ghost {
	opacity: 1;
	visibility: visible;
	background: #f0f9ff;
	border-color: #2196f3;
	box-shadow: 0 3px 6px rgba(0, 0, 0, 0.1);
	transform: scale(1.05);
}
</style>
