<script setup>
import { Chart } from '@antv/g2'

import BaseChart from '/src/components/BaseChart.vue'

const props = defineProps(['data'])
const chartRef = ref(null)

onMounted(() => {
	// init_chart()
	init_chart2()
})

// 配置项模式
function init_chart() {
	let chart = new Chart({ container: chartRef.value?.$el, autoFit: true })
	chart.options({
		type: 'line',
		data: props.data,
		encode: { x: 'year', y: 'value' },
		axis: { x: { title: false }, y: { title: false } },
	})
	chart.render()
}

// 函数模式
function init_chart2() {
	let chart = new Chart({ container: chartRef.value?.$el, autoFit: true })
	chart.line().data(props.data).encode('x', 'year').encode('y', 'value').axis('x', { title: false }).axis('y', { title: false })
	chart.render()
}
</script>
<template>
	<BaseChart ref="chartRef" />
</template>
<style scoped>
section {
	width: 100%;
	height: 100%;
}
</style>
