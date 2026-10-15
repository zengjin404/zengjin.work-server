<script setup>
import Precode from '/src/components/Precode.vue'
import base from '/src/js/base.js'

//初始化===================================================================
const state = reactive({})
</script>

<template>
	<section>
		<p>中文效果比较完美，英文a效果b不c理想</p>
	</section>
	<Precode url="/case/pages/其他css相关/打字机.vue" />
</template>

<style lang="less" scoped>
section {
	p {
		font-size: 22px;
		width: 18em;
		white-space: nowrap;
		overflow: hidden;
		animation:
			typing 4s steps(18) /* 执行typing动画，在4s内执行完毕，分18段执行 */,
			caret 0.5s steps(1) 10 /* 执行typing动画，在0.5s内执行完毕，分1段执行，循环执行10次 */;
		border-right: 1px solid transparent;

		@keyframes typing {
			from {
				width: 0;
			}
		}

		@keyframes caret {
			50% {
				border-right-color: var(--tc);
			}
		}
	}
}
</style>
