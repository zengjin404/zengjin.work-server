<script setup>
import { reactive } from 'vue'

import Map from '/src/components/MapMars3d.vue'
import Precode from '/src/components/Precode.vue'

//props属性===================================================================
const props = defineProps({})

//emits事件===================================================================
const emits = defineEmits([])

//初始化===================================================================

let map = null
const mapRef = ref()

const main = reactive({
	visibleAlways: true,
})
const tilesets = reactive({})

function inited_map(value, ref) {
	map = value
	mapRef.value = ref

	// 地形
	map.terrainProvider = mars3d.LayerUtil.createTerrainProvider(map.terrains[0])

	// 模型
	tilesets.学校 = new mars3d.layer.TilesetLayer({
		url: 'https://data.mars3d.cn/3dtiles/qx-xuexiao/tileset.json',
		maximumScreenSpaceError: 2, // 细化级别, 默认16, 值越小加载贴图越清晰
		maxMemory: 4000, // 最大缓存内存大小(MB)
		flyTo: true,
		center: { lng: 125.136704, lat: 43.823957, alt: 270, heading: 11, pitch: -24 },
	}).addTo(map)

	// 标注
	map.render_units({
		nameShow: true,
		data: [
			{
				lng: 125.136758,
				lat: 43.825192,
				alt: 217,
				name: '点位1-完全可见',
			},
			{
				lng: 125.136978,
				lat: 43.825248,
				alt: 213.7,
				name: '点位2-部分遮挡',
			},
			{
				lng: 125.137225,
				lat: 43.8253,
				alt: 210,
				name: '点位3-完全遮挡',
			},
		],
	})
}
// 切换防遮挡
function change_visibleAlways() {
	map.unitGroup.eachGraphic(unit => {
		unit.setStyle({
			visibleDepth: !main.visibleAlways,
			label: {
				visibleDepth: !main.visibleAlways,
			},
		})
	})
}
</script>

<template>
	<section>
		<Map @inited="inited_map" />

		<div class="ctrlbar">
			<ul>
				<li>
					<label>控制</label>
					<t-space>
						<t-switch v-model="main.visibleAlways" label="防遮挡" @change="change_visibleAlways" />
					</t-space>
				</li>
			</ul>
		</div>
		<Precode url="/gis/pages/mars3d/标注防遮挡.vue" />
	</section>
</template>

<style lang="less" scoped>
section {
	width: 100%;
	height: 100%;
	overflow: hidden;

	.ctrlbar {
		position: absolute;
		z-index: 1;
		bottom: 36px;
		left: 10px;

		background: var(--bg);
		padding: 1rem;
		border-radius: 0.5rem;

		ul {
			display: flex;
			flex-direction: column;
			gap: 4px;

			li {
				display: flex;
				align-items: center;

				label {
					&::after {
						content: '：';
					}
				}
			}
		}
	}

	:deep(.Precode) {
		z-index: 12345;
	}
}
</style>
