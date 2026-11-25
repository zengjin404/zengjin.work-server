/* 图卡乐园离线壳
 *
 * 只缓存同源静态资源：
 *   - 导航请求网络优先，失败回退缓存（断网刷新仍能打开）
 *   - 带 hash 的静态资源缓存优先（新 HTML 会自然引用新文件）
 *   - /api/ 请求完全不缓存（内容由 localStorage 索引负责）
 * 缓存名固定，不清除其他应用的缓存；升级时只删除旧 cards-shell-*。
 */
const CACHE = 'cards-shell-v2'
const SHELL = ['/cards', '/cards/index.html']

self.addEventListener('install', event => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then(cache => cache.addAll(SHELL).catch(() => {}))
			.then(() => self.skipWaiting()),
	)
})

self.addEventListener('activate', event => {
	event.waitUntil(
		caches
			.keys()
			.then(keys => Promise.all(keys.filter(key => key.startsWith('cards-shell-') && key !== CACHE).map(key => caches.delete(key))))
			.then(() => self.clients.claim()),
	)
})

self.addEventListener('fetch', event => {
	const request = event.request
	if (request.method !== 'GET') return
	const url = new URL(request.url)
	if (url.origin !== self.location.origin) return
	if (url.pathname.startsWith('/api/')) return
	if (!(url.pathname === '/cards' || url.pathname.startsWith('/cards/'))) return

	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request)
				.then(response => {
					const copy = response.clone()
					caches.open(CACHE).then(cache => cache.put(request, copy))
					return response
				})
				.catch(async () => {
					const cache = await caches.open(CACHE)
					return (await cache.match(request)) || (await cache.match('/cards')) || (await cache.match('/cards/')) || Response.error()
				}),
		)
		return
	}

	// 音频文件名不带构建 hash，后续可能原地替换：网络优先，失败时再用缓存兜底
	if (url.pathname.startsWith('/cards/audio/')) {
		event.respondWith(
			fetch(request, { cache: 'no-cache' })
				.then(response => {
					if (response.ok) {
						const copy = response.clone()
						caches.open(CACHE).then(cache => cache.put(request, copy))
					}
					return response
				})
				.catch(async () => (await caches.match(request)) || Response.error()),
		)
		return
	}

	event.respondWith(
		caches.match(request).then(cached => {
			if (cached) return cached
			return fetch(request).then(response => {
				if (response.ok) {
					const copy = response.clone()
					caches.open(CACHE).then(cache => cache.put(request, copy))
				}
				return response
			})
		}),
	)
})
