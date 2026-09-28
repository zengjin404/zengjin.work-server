<script setup>
import Map from '/src/components/MapMars3d.vue'
import Precode from '/src/components/Precode.vue'

//props属性===================================================================
const props = defineProps({})

//emits事件===================================================================
const emits = defineEmits([])

//初始化===================================================================

let map = null

onMounted(() => {
	addEventListener('mousedown', mouse.mousedown)
	addEventListener('mousemove', mouse.mousemove)
	addEventListener('mouseup', mouse.mouseup)
	addEventListener('wheel', mouse.wheel)
})
onBeforeUnmount(() => {
	removeEventListener('mousedown', mouse.mousedown)
	removeEventListener('mousemove', mouse.mousemove)
	removeEventListener('mouseup', mouse.mouseup)
	removeEventListener('wheel', mouse.wheel)
})

function inited_map(value, ref) {
	map = value

	//飞向目标点
	map.flyToPoint([118.35, 35.08, 0], {
		heading: 0,
		pitch: -5,
		radius: 200,
		duration: 0.8,
	})
}

// 鼠标控制相关==================================================================================
const mouseId = 'id_' + new Date().getTime()
const mouse = reactive({
	width: 0, //容器宽度
	height: 0, //容器高度
	startDrag: false, //是否开始拖动
	startX: 0, //开始拖动时鼠标X坐标
	startY: 0, //开始拖动时鼠标Y坐标
	step: 0.1, //拖动最小步长(比例)
	mousedown: e => {
		if (e.button != 0 || !e.target.closest(`#${mouseId}`)) {
			return
		}
		mouse.width = document.querySelector(`#${mouseId}`).clientWidth
		mouse.height = document.querySelector(`#${mouseId}`).clientHeight
		mouse.startDrag = true
		mouse.startX = e.clientX
		mouse.startY = e.clientY
	},
	mousemove: e => {
		if (e.button != 0 || !mouse.startDrag) {
			return
		}
		mouse.calc(e)
	},
	mouseup: e => {
		if (e.button != 0 || !mouse.startDrag) {
			return
		}
		mouse.startDrag = false
		mouse.calc(e)
	},
	wheel: e => {
		console.log('滚轮滚动: ', e.deltaX, e.deltaY)
	},
	calc: e => {
		let diffX = e.clientX - mouse.startX
		let diffY = e.clientY - mouse.startY
		let x = (diffX / mouse.width).toFixed(2) * 1
		let y = (diffY / mouse.height).toFixed(2) * 1
		if (Math.abs(x) < mouse.step && Math.abs(y) < mouse.step) {
			console.log('左键拖动防抖')
			return
		}
		mouse.startX = e.clientX
		mouse.startY = e.clientY
		console.log('左键拖动: ', x, y)
	},
})
</script>

<template>
	<Map @inited="inited_map">
		<div class="mouse" :id="mouseId" draggable="false"></div>
	</Map>
	<Precode url="/gis/pages/mars3d/自定义事件.vue" />
</template>

<style lang="less" scoped>
.Mars3d {
	.mouse {
		position: absolute;
		inset: 0;
		z-index: 1;
	}
}
</style>
