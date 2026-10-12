-- ============================================================
-- jndv 户型图 / 座位图数据库建表脚本 (Supabase / PostgreSQL)
-- 执行前请确认已连接到正确的数据库
-- ============================================================

-- 座位主表 (存储每个座位的姓名、拼音、工种标签、性别、是否组长及修改人)
-- 本文件与服务端 ensure_dbInitialized_async() 里的幂等建表保持一致；存量库缺列由那边的
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS 补齐 (pinyin 就是这么加上去的)，此脚本不必重复执行。
CREATE TABLE IF NOT EXISTS public.jndv_seat (
    id          VARCHAR(20) PRIMARY KEY,
    room        VARCHAR(20) NOT NULL,
    seat_id     VARCHAR(40) NOT NULL UNIQUE,
    name        VARCHAR(40) DEFAULT '',
    pinyin      VARCHAR(60) DEFAULT '',
    work        VARCHAR(40) DEFAULT '',
    sex         SMALLINT DEFAULT 1,
    leader      BOOLEAN DEFAULT false,
    version     INT DEFAULT 1,
    createtime  TIMESTAMPTZ DEFAULT NOW(),
    updatetime  TIMESTAMPTZ DEFAULT NOW(),
    updateby    VARCHAR(40) DEFAULT ''
);

-- 房间索引，优化按房间查询性能
CREATE INDEX IF NOT EXISTS idx_jndv_seat_room ON public.jndv_seat (room);

-- 问答门的「通过标记」表 (只记谁在哪个版本上通过过；题目与答案不落库，在 api_util/jndv_gate.js 里)
-- user_id 的唯一约束是 upsert 的落点，不可省
CREATE TABLE IF NOT EXISTS public.jndv_unlock (
    id           VARCHAR(20) PRIMARY KEY,
    user_id      VARCHAR(40) NOT NULL UNIQUE,
    username     VARCHAR(40) DEFAULT '',
    gate_version INT DEFAULT 1,
    createtime   TIMESTAMPTZ DEFAULT NOW(),
    updatetime   TIMESTAMPTZ DEFAULT NOW()
);
