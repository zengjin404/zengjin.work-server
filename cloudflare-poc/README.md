# Cloudflare Workers POC

> 状态：**REJECTED_FOR_PRODUCTION**。仅保留为静态托管/多应用路由验证记录；不合并 main，不用于生产。

最小验证项目，独立于 EdgeOne 配置。

## 本地

```bash
cd cloudflare-poc
npx wrangler@4.168.0 dev --local
```

## 部署（需要先完成 Cloudflare OAuth 登录）

```bash
cd cloudflare-poc
npx wrangler@4.168.0 login
npx wrangler@4.168.0 whoami
npx wrangler@4.168.0 deploy
```

完整静态产物（复用 `../edgeone-dist`）：

```bash
npx wrangler@4.168.0 dev --local --config wrangler.full.jsonc
npx wrangler@4.168.0 deploy --config wrangler.full.jsonc
```

不要修改生产 DNS；测试域名只允许 `test.zengjin.work`。

## 已部署的 POC

- 最小 Worker：https://zengjin-cf-poc.zengjin.workers.dev
- 完整静态 Worker：`zengjin-cf-poc-full`
- 测试路由：`test.zengjin.work/*`（DNS A 记录未改）
- `wrangler.full.jsonc` 已包含测试路由；重新部署会更新 `test.zengjin.work` 的 Worker 路由，不会修改 `zengjin.work`。
- 当前 `/api/*` 返回 503，不代理生产 API；多应用 History 深链通过 `env.ASSETS.fetch('/<app>/index.html')` 回退。
