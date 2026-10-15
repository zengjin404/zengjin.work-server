<script setup>
import HuiCharts from '@opentiny/huicharts'

import BaseChart from '/src/components/BaseChart.vue'

const props = defineProps(['data'])
const chartRef = ref(null)

onMounted(() => {
	// init_chart()
	init_chart2()
})

// 使用echarts配置渲染
function init_chart() {
	let chart = new HuiCharts()
	chart.init(chartRef.value?.$el)
	chart.setEchartsOption({
		xAxis: { type: 'category' },
		yAxis: {},
		dataset: {
			dimensions: ['year', 'value'],
			source: props.data,
		},
		series: [{ type: 'line' }],
	})
	chart.render()
}

// 标准渲染
function init_chart2() {
	let chart = new HuiCharts()
	chart.init(chartRef.value?.$el)
	chart.setSimpleOption('LineChart', {
		legend: {
			show: false,
		},
		data: props.data,
	})
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
