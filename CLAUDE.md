# zengjin.work 服务端开发规范

## 常用命令

- 测试：`bun test` / `bun test:watch`
- 格式：`bun format:check` / `bun format`
- 本地调试：`bun serve`（端口见 `../zengjin.work-source/docs/_deployment.md`）

## 架构与编码规范

- 运行环境：Node.js ESM (Vercel Serverless Functions)，`"type": "module"`
- 别名使用：必须使用 `#api_util/xxx` 引用基础设施层（定义在 package.json imports）
- 路由分发：基于 `actions[method][action]` 分发模式，统一使用 `base.getReqInfo()` 解析
- 响应结构：使用 `base.respSuccess` / `base.respFailure` 统一输出，不改变 200 HTTP 状态码
- 数据库：PostgreSQL (pg)，必须使用 `$1` / `$2` 参数化占位符，严禁字符串拼接 SQL
- 时间处理：强制使用 `base.getTime()` 北京时间 (Asia/Shanghai)
- ID 生成：使用 `base.getId()` (12 位 36 进制字符串)
- 鉴权模式：私有接口统一使用 `requireAuth(handler)` 装饰器包裹

## 专项文档指引（需要时按需查阅）

- 文档治理 / AI 协作边界 / 文档事实变更日志 → `../zengjin.work-source/docs/_doc_guide.md` / `_ai.md` / `_doc_changelog.md`
- 跨仓契约 / 字段口径 / 隐性契约 → `../zengjin.work-source/docs/_contracts.md`
- 验证方法 / 敏感数据脱敏 → `../zengjin.work-source/docs/_verification.md`
- API 架构总览 → `../zengjin.work-source/docs/_api.md`
- 通用 CRUD 引擎 → `../zengjin.work-source/docs/_crud.md`
- 数据库架构 / 双库 / 连接池 → `../zengjin.work-source/docs/_database.md`
- 部署 / 环境变量 / Cron 备份 → `../zengjin.work-source/docs/_deployment.md`
- 用户鉴权 / 双Token / AES加密 → `../zengjin.work-source/docs/_user.md`
- 七牛云存储适配器 → `../zengjin.work-source/docs/_storage.md`

## 文档维护规则

- 文档治理、证据规范、保留策略、收尾清单 → `../zengjin.work-source/docs/_doc_guide.md`；AI 可写/必问/禁止 → `../zengjin.work-source/docs/_ai.md`。
- 代码重构、新增功能、修补重要 Bug 后，必须同步更新对应专项文档、`README.md` 或 `CLAUDE.md`，并在 `../zengjin.work-source/docs/_doc_changelog.md` 记录文档事实变更。
- `CLAUDE.md` 软预算 ≤80 行且 ≤6,000 字符，只保留核心命令、硬约束和指针。
- 归档隔离：`../zengjin.work-source/docs/归档/` 仅供人工查阅历史资料，禁止作为当前事实依据。

## 仓库协约

- 包管理器：Bun；`bun.lock` 纳入版本控制，变更依赖时同步提交。
- 质量门禁：GitHub Actions 执行 `bun install` + `bun format:check` + `bun test`，不执行 build。
- 生产部署：由 Vercel 负责构建；CI 不产出构建产物。
- 提交前至少运行 `bun format:check`；行为变更需补测试。
