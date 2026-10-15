<script setup>
import Logs from '/src/components/Logs.vue'
import Precode from '/src/components/Precode.vue'
import base from '/src/js/base.js'

const boxRef = ref()

const state = reactive({
	size: '0 × 0',
	transition: 0,

	logs: [],
})

onMounted(() => {
	const resizeObserver = new ResizeObserver(resizeObserver_todo)
	resizeObserver.observe(boxRef.value) //初始化时会自动触发一次
})

function resizeObserver_todo(e) {
	if (!boxRef.value) return //销毁时也会触发, 所以要加兼容

	state.size = `${boxRef.value.offsetWidth} × ${boxRef.value.offsetHeight}`
	state.logs.push(state.size)
}

const transition = computed(() => (state.transition ? '0.3s' : '0s'))

function change_size(width, height) {
	if (width) boxRef.value.style.width = `${width}px`
	if (height) boxRef.value.style.height = `${height}px`
}
</script>

<template>
	<section>
		<div class="box" :style="{ transition }" ref="boxRef">{{ state.size }}</div>

		<div class="ctrlbar">
			<t-space direction="vertical" size="12px">
				<!-- 有动效时中间过程也触发, 无动效时仅最终状态触发 -->
				<t-checkbox v-model="state.transition" style="font-size: 0.85rem">动效</t-checkbox>
				<t-divider dashed />
				<t-button size="small" variant="outline" @click="change_size(base.getRandom(100, 500))"> 改变宽度 </t-button>
				<t-button size="small" variant="outline" @click="change_size(null, base.getRandom(50, 300))"> 改变高度 </t-button>
				<t-button size="small" variant="outline" @click="change_size(base.getRandom(100, 500), base.getRandom(50, 300))"> 同时改变宽高 </t-button>
				<t-divider dashed />
				<t-tag size="small" variant="outline" disabled>拖拽右下角手柄可手动触发</t-tag>
			</t-space>
		</div>
	</section>
	<Logs v-model="state.logs" />
	<Precode url="/case/pages/事件监听/监听尺寸.vue" />
</template>

<style lang="less" scoped>
section {
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
		display: flex;
		align-items: center;
		justify-content: center;

		width: 100px;
		height: 100px;
		margin: auto;
		resize: both; //手动触发尺寸改变
		overflow: scroll; //resize搭配属性

		border: 1px solid var(--bd);
		background: var(--bg-hard);
		position: relative;

		scrollbar-width: initial;
		scrollbar-color: initial;
		padding: 1.2rem 0 0 1.2rem;
	}

	.box::-webkit-resizer {
		background-color: var(--primary);
		/* 设置背景颜色 */
	}

	.box::-webkit-scrollbar {
		width: 1.2rem;
		height: 1.2rem;
	}
}
</style>
