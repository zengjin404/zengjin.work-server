window.$config = {
	...window.$config,
	app: 'share', // 应用唯一标识（公开文件分享页）
	title: '云分享', // 浏览器标题
	loginStrict: false, // 公开分享页, 不强制登录
	publicLayout: true, // 公开可见
	share_worker: 'https://share.zengjin.work', // 分享下载 Worker (普通变量, 非机密)
}
