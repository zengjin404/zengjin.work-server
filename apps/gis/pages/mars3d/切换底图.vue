<script setup>
import MapCtrl_basemap from '/src/components/MapCtrlMars3d/MapCtrlMars3d_basemap.vue'
import Map from '/src/components/MapMars3d.vue'

//props属性===================================================================
const props = defineProps({})

//emits事件===================================================================
const emits = defineEmits([])

//初始化===================================================================
const main = reactive({
	mapDone: false,
})

let map = null
function inited_map(value) {
	map = value
	map.flyToPoint([118.35, 35.08], { radius: 145000, duration: 1 })
	main.mapDone = true
}
</script>

<template>
	<section>
		<Map @inited="inited_map" />
		<template v-if="main.mapDone">
			<div class="MapCtrls">
				<MapCtrl_basemap :map="map" />
			</div>
		</template>
	</section>
</template>

<style lang="less" scoped>
section {
	width: 100%;
	height: 100%;
	position: relative;
	overflow: hidden;

	.MapCtrls {
		position: absolute;
		z-index: 401;
		bottom: 10px;
		left: 10px;
	}
}
</style>
