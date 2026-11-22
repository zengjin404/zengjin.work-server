-- Admin 全局消息通知中心 表结构
-- 说明：这些表由 api_util/notification_store.js 在首次请求时幂等自动创建；
--       本脚本仅作为 DDL 文档与手动初始化参考（对齐 api_util/sql/cards_schema.sql 惯例）。
-- 时间列统一为无时区 TIMESTAMP + 北京时间字面值。

CREATE TABLE IF NOT EXISTS admin_notification (
    id                VARCHAR(24) PRIMARY KEY,           -- 沿用 base.getId() 12 位业务 id
    app_code          VARCHAR(32) NOT NULL,              -- cards / system
    category          VARCHAR(32) NOT NULL,              -- missing_resource / system_notice
    severity          VARCHAR(16) NOT NULL DEFAULT 'warning',
    title             VARCHAR(128) NOT NULL DEFAULT '',
    content           TEXT NOT NULL DEFAULT '',
    source            VARCHAR(64) DEFAULT '',
    dedupe_key        VARCHAR(255) NOT NULL,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    status            VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending / processing / resolved
    read_at           TIMESTAMP,                         -- NULL = 未读；与 status 完全独立
    first_occurred_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
    last_occurred_at  TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
    occurrence_count  INTEGER NOT NULL DEFAULT 1,
    resolved_at       TIMESTAMP,
    createtime        TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
    updatetime        TIMESTAMP
);

-- 全局唯一：同一个持续性问题从创建到解决、再次激活都复用同一条记录
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_notification_dedupe ON admin_notification (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_admin_notification_scope ON admin_notification (app_code, category, status);
CREATE INDEX IF NOT EXISTS idx_admin_notification_status ON admin_notification (status, last_occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_notification_read ON admin_notification (read_at);
CREATE INDEX IF NOT EXISTS idx_admin_notification_time ON admin_notification (last_occurred_at DESC);

-- 功能开关（JSONB 布尔值），默认关闭内容缺口提醒
CREATE TABLE IF NOT EXISTS admin_notification_setting (
    key        VARCHAR(64) PRIMARY KEY,
    value      JSONB NOT NULL DEFAULT '{}'::jsonb,
    updatetime TIMESTAMP
);
INSERT INTO admin_notification_setting (key, value, updatetime)
VALUES ('content_gap_alert_enabled', 'false'::jsonb, (now() AT TIME ZONE 'Asia/Shanghai'))
ON CONFLICT (key) DO NOTHING;

-- 数据库级限频：bucket 含时间窗，主键冲突时原子自增，多 Serverless 实例同样有效
CREATE TABLE IF NOT EXISTS admin_notification_rate (
    scope        VARCHAR(32) NOT NULL,
    bucket       VARCHAR(160) NOT NULL,
    window_start TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
    count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, bucket)
);

-- Supabase PostgREST 默认向 anon / authenticated 暴露 public 表；
-- 启用 RLS 且不创建策略 = 匿名与普通登录用户无法直接读写，后端服务端连接不受影响。
ALTER TABLE admin_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_notification_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_notification_rate ENABLE ROW LEVEL SECURITY;
