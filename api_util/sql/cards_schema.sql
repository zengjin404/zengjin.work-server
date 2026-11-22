-- 图卡乐园 (cards) 表结构
-- 说明：这些表由 api/_cards.js 在首次请求时幂等自动创建；
--       本脚本仅作为 DDL 文档与手动初始化参考（对齐 api_util/sql/fc_schema.sql 惯例）。
-- 时间列统一为无时区 TIMESTAMP + 北京时间字面值。

CREATE TABLE IF NOT EXISTS cards_category (
    id             VARCHAR(20) PRIMARY KEY,
    code           VARCHAR(50) NOT NULL,
    name           VARCHAR(50) NOT NULL,
    parent_id      VARCHAR(20) DEFAULT '',
    description    VARCHAR(255) DEFAULT '',
    icon           VARCHAR(100) DEFAULT '',
    theme_color    VARCHAR(20) DEFAULT '',
    sort_order     INT DEFAULT 0,
    is_enabled     BOOLEAN NOT NULL DEFAULT true,
    publish_status SMALLINT NOT NULL DEFAULT 0,
    createtime     TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
    updatetime     TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_category_code ON cards_category (code);
CREATE INDEX IF NOT EXISTS idx_cards_category_sort ON cards_category (publish_status, is_enabled, sort_order);

CREATE TABLE IF NOT EXISTS cards_item (
    id             VARCHAR(20) PRIMARY KEY,
    card_key       VARCHAR(60) NOT NULL,
    category_id    VARCHAR(20) NOT NULL,
    label          VARCHAR(50) NOT NULL,
    pinyin         VARCHAR(100) DEFAULT '',
    en_label       VARCHAR(100) DEFAULT '',
    description    VARCHAR(255) DEFAULT '',
    knowledge      VARCHAR(500) DEFAULT '',
    play_modes     VARCHAR(50) NOT NULL DEFAULT 'recognize,connect,memory',
    sort_order     INT DEFAULT 0,
    is_enabled     BOOLEAN NOT NULL DEFAULT true,
    publish_status SMALLINT NOT NULL DEFAULT 0,
    createtime     TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
    updatetime     TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_item_key ON cards_item (card_key);
CREATE INDEX IF NOT EXISTS idx_cards_item_category ON cards_item (category_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_cards_item_publish ON cards_item (publish_status, is_enabled);

CREATE TABLE IF NOT EXISTS cards_asset (
    id          VARCHAR(20) PRIMARY KEY,
    card_id     VARCHAR(20) NOT NULL,
    asset_type  VARCHAR(20) NOT NULL, -- image / thumbnail / narration / sound / emoji
    asset_url   VARCHAR(500) NOT NULL,
    mime_type   VARCHAR(100) DEFAULT '',
    sort_order  INT DEFAULT 0,
    is_primary  BOOLEAN NOT NULL DEFAULT false,
    is_enabled  BOOLEAN NOT NULL DEFAULT true,
    is_random   BOOLEAN NOT NULL DEFAULT true,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    createtime  TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')
);
CREATE INDEX IF NOT EXISTS idx_cards_asset_card ON cards_asset (card_id, asset_type, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_asset_primary ON cards_asset (card_id) WHERE is_primary;

CREATE TABLE IF NOT EXISTS cards_user_progress (
    id               VARCHAR(20) PRIMARY KEY,
    user_id          VARCHAR(40) NOT NULL,
    card_key         VARCHAR(60) NOT NULL,
    explored_at      TIMESTAMP,
    last_explored_at TIMESTAMP,
    favorite_at      TIMESTAMP,
    createtime       TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
    updatetime       TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_progress_user_card ON cards_user_progress (user_id, card_key);
CREATE INDEX IF NOT EXISTS idx_cards_progress_user_time ON cards_user_progress (user_id, last_explored_at DESC);

CREATE TABLE IF NOT EXISTS cards_play_record (
    id              VARCHAR(20) PRIMARY KEY,
    request_id      VARCHAR(64) NOT NULL,
    user_id         VARCHAR(40),
    play_mode       VARCHAR(20) NOT NULL,
    category_id     VARCHAR(20) DEFAULT '',
    difficulty      VARCHAR(20) DEFAULT '',
    total_pairs     INT NOT NULL DEFAULT 0,
    completed_pairs INT NOT NULL DEFAULT 0,
    duration        INT NOT NULL DEFAULT 0,
    result          VARCHAR(20) NOT NULL DEFAULT 'completed',
    createtime      TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_play_request ON cards_play_record (request_id);
CREATE INDEX IF NOT EXISTS idx_cards_play_user ON cards_play_record (user_id, createtime DESC);
CREATE INDEX IF NOT EXISTS idx_cards_play_mode ON cards_play_record (play_mode, createtime DESC);

CREATE TABLE IF NOT EXISTS cards_stats_daily (
    stat_date  DATE NOT NULL,
    event_type VARCHAR(30) NOT NULL,
    object_id  VARCHAR(60) NOT NULL DEFAULT '',
    count      INT NOT NULL DEFAULT 0,
    updatetime TIMESTAMP,
    PRIMARY KEY (stat_date, event_type, object_id)
);
CREATE INDEX IF NOT EXISTS idx_cards_stats_type ON cards_stats_daily (event_type, stat_date DESC);

CREATE TABLE IF NOT EXISTS cards_user_setting (
    user_id    VARCHAR(40) PRIMARY KEY,
    settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
    createtime TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
    updatetime TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cards_content_version (
    id               VARCHAR(20) PRIMARY KEY,
    version          BIGINT NOT NULL DEFAULT 1,
    category_version BIGINT NOT NULL DEFAULT 1,
    item_version     BIGINT NOT NULL DEFAULT 1,
    asset_version    BIGINT NOT NULL DEFAULT 1,
    seed_version     INT NOT NULL DEFAULT 0,
    updatetime       TIMESTAMP
);
INSERT INTO cards_content_version (id, version, category_version, item_version, asset_version, seed_version)
VALUES ('cards', 1, 1, 1, 1, 0)
ON CONFLICT (id) DO NOTHING;
