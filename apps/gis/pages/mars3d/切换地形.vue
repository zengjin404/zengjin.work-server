<script setup>
import MapCtrl_terrain from '/src/components/MapCtrlMars3d/MapCtrlMars3d_terrain.vue'
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
function inited_map(value, ref) {
	map = value
	map.setCameraView({ lat: 35.435943, lng: 113.455323, alt: 204.4, heading: 42.5, pitch: -2.8 })

	main.mapDone = true
}
</script>

<template>
	<section>
		<Map @inited="inited_map" />
		<div class="layerControl" v-if="main.mapDone">
			<t-dropdown trigger="click" maxColumnWidth="auto" maxHeight="500" placement="bottom-right">
				<t-link theme="primary">
					{{ main.name }}
					<ChevronDownIcon />
				</t-link>
				<t-dropdown-menu>
					<t-dropdown-item :active="item.name == main.name" :divider="item.divider" @click="click_item(item.name)">
						{{ item.name }}
					</t-dropdown-item>
				</t-dropdown-menu>
			</t-dropdown>
		</div>
	</section>
	<Precode url="/gis/pages/mars3d/切换地形.vue" />
</template>

<style lang="less" scoped>
section {
	width: 100%;
	height: 100%;
	overflow: hidden;

	// .layerControl {
	// 	position: absolute;
	// 	z-index: 21;
	// 	bottom: 10px;
	// 	left: 10px;

	// 	:deep(.t-link) {
	// 		position: relative;
	// 		display: flex;
	// 		overflow: hidden;
	// 		width: min-content;
	// 		padding: 5px 8px 5px 10px;

	// 		cursor: pointer;
	// 		white-space: nowrap;
	// 		border-radius: 4px;
	// 		// background-color: #fff;
	// 		background: var(--bg-hard);
	// 		//box-shadow: 1px 1px 4px var(--bd-hard);
	// 		box-shadow: 1px 2px 8px #2366;

	// 		font-size: 1rem;

	// 		.t-icon {
	// 			margin-left: 2px;
	// 		}
	// 	}
	// }
}
</style>
