<script setup>
import Highcharts from 'highcharts'
import 'highcharts/modules/exporting'

import BaseChart from '/src/components/BaseChart.vue'

const props = defineProps(['data'])
const chartRef = ref(null)

onMounted(() => {
	init_chart()
})

function init_chart() {
	Highcharts.chart(chartRef.value?.$el, {
		title: false,
		legend: false,
		xAxis: {
			categories: props.data?.map(item => item.year),
		},
		yAxis: {
			title: false,
		},
		series: [
			{
				data: props.data?.map(item => item.value),
			},
		],
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
