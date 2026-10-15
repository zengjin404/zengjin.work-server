<script setup>
import BaseChart from '/src/components/BaseChart.vue'

const props = defineProps(['data'])
const chartRef = ref(null)

onMounted(() => {
	init_chart()
})

function init_chart() {
	let chart = new google.visualization.LineChart(chartRef.value?.$el)
	let data = google.visualization.arrayToDataTable([['x', 'y'], ...props.data?.map(item => [item.year, item.value])])
	let options = {
		legend: {
			position: 'none', // 隐藏图例
		},
	}
	chart.draw(data, options)
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
