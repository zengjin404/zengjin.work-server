<script setup>
// import Logs from '/src/components/Logs.vue'
import Precode from '/src/components/Precode.vue'
import DialogModel from '/src/components/model/DialogModel.vue'
import base from '/src/js/base.js'

//初始化===================================================================
const state = reactive({
	dialog: false,
	type: '',
})

function open_dialog(type) {
	state.type = type
	state.dialog = true
}
</script>

<template>
	<section>
		<div class="ctrlbar">
			<t-space size="12px">
				<t-button size="small" @click="open_dialog('jpg')"> jpg </t-button>
				<t-button size="small" @click="open_dialog('png')"> png </t-button>
			</t-space>
			<t-space size="12px">
				<t-button size="small" @click="open_dialog('mp3')"> mp3 </t-button>
				<t-button size="small" @click="open_dialog('mp4')"> mp4 </t-button>
			</t-space>
			<t-space size="12px">
				<!-- <t-button size="small" @click="open_dialog('txt')"> txt </t-button> -->
				<t-button size="small" @click="open_dialog('pdf')"> pdf </t-button>
			</t-space>
			<t-space size="12px">
				<!-- <t-button size="small" @click="open_dialog('docx')"> docx </t-button> -->
				<!-- <t-button size="small" @click="open_dialog('doc')"> doc </t-button> -->
			</t-space>
		</div>
	</section>
	<DialogModel class="预览文件Dialog" v-model:visible="state.dialog" attachToBody closeEasy :header="state.type">
		<template v-if="false"> </template>

		<template v-else-if="['jpg', 'png'].includes(state.type)">
			<img :src="`/$base/file/demo.${state.type}`" />
		</template>

		<template v-else-if="['mp3'].includes(state.type)">
			<audio :src="`/$base/file/demo.${state.type}`" controls autoplay />
		</template>

		<template v-else-if="['mp4'].includes(state.type)">
			<video :src="`/$base/file/demo.${state.type}`" controls autoplay />
		</template>

		<template v-else-if="['pdf'].includes(state.type)">
			<iframe :src="`${base.isMob ? '/$base/plugin/pdfjs-4.9.155/web/viewer.html?file=' : ''}/$base/file/demo.${state.type}`"></iframe>
		</template>
	</DialogModel>

	<!-- <Logs v-model="state.logs" /> -->
	<!-- <Precode url="/case/pages/其他js相关/预览文件.vue" /> -->
</template>

<style lang="less">
.预览文件Dialog {
	.t-dialog__body {
		padding: 16px;
		overflow: hidden;
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: center;
		position: relative;

		& > * {
			flex: initial;
			object-fit: contain;
			max-width: calc(100vw - 36px);
			max-height: calc(100vh - 108px);
			overflow: hidden;
		}

		& > iframe {
			width: 850px;
			height: 1200px;
			border: 0;
		}
	}
}
</style>
<style lang="less" scoped>
section {
	height: 100%;
	padding: 16px 16px 5vh;
	display: flex;
	justify-content: center;
	align-items: center;

	iframe,
	embed,
	object,
	img,
	audio,
	video {
		border: 0;
		width: 200px;
		height: 200px;
		object-fit: contain;

		display: inline-flex;
		justify-content: center;
		align-items: center;
	}

	.ctrlbar {
		// position: absolute;
		// top: 16px;
		// left: 16px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		margin: auto;
		width: max-content;

		.t-divider {
			margin: 0;
		}
	}

	.box {
		display: flex;
		align-items: center;
		justify-content: center;

		width: 100px;
		height: 100px;
		margin: auto;
		resize: both; //手动触发尺寸改变
		overflow: scroll; //resize搭配属性

		border: 1px solid var(--bd);
		background: var(--bg-hard);
		position: relative;

		scrollbar-width: initial;
		scrollbar-color: initial;
		padding: 1.2rem 0 0 1.2rem;
	}

	.box::-webkit-resizer {
		background-color: var(--primary);
		/* 设置背景颜色 */
	}

	.box::-webkit-scrollbar {
		width: 1.2rem;
		height: 1.2rem;
	}
}
</style>
