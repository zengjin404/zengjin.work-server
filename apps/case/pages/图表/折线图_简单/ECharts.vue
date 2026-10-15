<script setup>
import * as Echarts from 'echarts'

import BaseChart from '/src/components/BaseChart.vue'

const props = defineProps(['data'])
const chartRef = ref(null)

onMounted(() => {
	// init_chart()
	init_chart2()
})

// 系列模式
function init_chart() {
	let chart = Echarts.init(chartRef.value?.$el, null, { renderer: 'svg' })
	chart.setOption({
		xAxis: {
			data: props.data?.map(item => item.year),
		},
		yAxis: {
			type: 'value',
		},
		series: [
			{
				type: 'line',
				data: props.data?.map(item => item.value),
			},
		],
	})
}

// 数据集模式
function init_chart2() {
	let chart = Echarts.init(chartRef.value?.$el, null, { renderer: 'svg' })
	chart.setOption({
		xAxis: { type: 'category' },
		yAxis: {},
		dataset: {
			dimensions: ['year', 'value'],
			source: props.data,
		},
		series: [{ type: 'line' }],
	})
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
