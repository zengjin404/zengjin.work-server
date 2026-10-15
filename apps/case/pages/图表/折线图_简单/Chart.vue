<script setup>
import Chart from 'chart.js/auto'

import BaseChart from '/src/components/BaseChart.vue'

const props = defineProps(['data'])
const chartRef = ref(null)

onMounted(() => {
	init_chart()
	// init_chart2()
})

function init_chart() {
	new Chart(chartRef.value?.$el, {
		type: 'line',
		options: {
			plugins: {
				legend: {
					display: false, // 隐藏图例
				},
			},
		},
		data: {
			labels: props.data?.map(item => item.year),
			datasets: [
				{
					data: props.data?.map(item => item.value),
				},
			],
		},
	})
}
</script>
<template>
	<BaseChart canvas ref="chartRef" />
</template>
<style scoped>
section {
	width: 100%;
	height: 100%;
}
</style>
