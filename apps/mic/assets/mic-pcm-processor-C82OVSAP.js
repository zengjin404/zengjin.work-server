// PCM 采集处理器: 在音频渲染线程按固定块聚合, 再以可转移缓冲发送到主线程
// 该文件只作为 AudioWorklet 模块加载, 不参与普通主线程打包

const BLOCK_FRAMES = 4096

class MicPcmProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super()
		const config = options?.processorOptions || {}
		this.maxFrames = Number(config.maxFrames) || 0
		this.buffers = []
		this.fill = 0
		this.frames = 0
		this.active = true
		this.port.onmessage = event => {
			const type = event.data?.type
			if (type === 'stop') {
				this.flush()
				this.active = false
				this.port.postMessage({ type: 'done', frames: this.frames })
			} else if (type === 'flush') {
				this.flush()
			}
		}
	}

	ensure_buffers(channelCount) {
		if (this.buffers.length === channelCount) return
		this.buffers = Array.from({ length: channelCount }, () => new Float32Array(BLOCK_FRAMES))
		this.fill = 0
	}

	flush() {
		if (!this.fill) return
		const frames = this.fill
		const channels = this.buffers.map(buffer => buffer.slice(0, frames))
		this.port.postMessage(
			{ type: 'data', channels, frames },
			channels.map(channel => channel.buffer),
		)
		this.fill = 0
	}

	process(inputs) {
		if (!this.active) return false
		const input = inputs[0]
		if (!input || !input.length) return true
		this.ensure_buffers(input.length)
		const frames = input[0].length
		let offset = 0

		while (offset < frames) {
			const take = Math.min(frames - offset, BLOCK_FRAMES - this.fill)
			for (let channel = 0; channel < input.length; channel++) {
				this.buffers[channel].set(input[channel].subarray(offset, offset + take), this.fill)
			}
			this.fill += take
			offset += take
			this.frames += take
			if (this.fill === BLOCK_FRAMES) this.flush()
		}

		if (this.maxFrames && this.frames >= this.maxFrames) {
			this.flush()
			this.active = false
			this.port.postMessage({ type: 'limit', frames: this.frames })
			return false
		}
		return true
	}
}

registerProcessor('mic-pcm-processor', MicPcmProcessor)
