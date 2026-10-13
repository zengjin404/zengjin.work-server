-- ============================================================
-- jndv 户型图 / 座位图数据库建表脚本 (Supabase / PostgreSQL)
-- 执行前请确认已连接到正确的数据库
-- ============================================================

-- 时间列的时区约定 (2026-10-13 定案，两张表都适用)
--   createtime / updatetime 用**无时区 TIMESTAMP**，列里存的就是**北京时间字面值**，
--   写入一律显式写 (now() AT TIME ZONE 'Asia/Shanghai')。
--   为什么不用 TIMESTAMPTZ：它只存 UTC 瞬间、不存显示用的字面值，显示成什么取决于读它的客户端 ——
--   to_char 按会话时区渲染(本项目会话是 UTC)，Supabase 控制台的 Table Editor 也固定按 UTC 显示
--   且没有时区开关(官方仍只是 feature request)。结果就是直接查表会比北京时间少 8 小时、得心算。
--   为什么敢用无时区类型：Asia/Shanghai 恒为 +08:00 且无夏令时(pg_timezone_names 实测 utc_offset = 8h、
--   is_dst = false；中国 1986-1991 实行过夏令时、1992 年起取消)，墙上时间单调、不重复、不跳变。
--   需要还原 UTC 瞬间时减 8 小时即可。
--   ⚠️ 存量库由 ensure_dbInitialized_async() 里的 migrate_time_column() 自动迁移，注意两点：
--      ① 改类型必须带 USING (列 AT TIME ZONE 'Asia/Shanghai') —— 不加会按会话时区(UTC)解释，把存量数据整体改错 8 小时；
--      ② 改完类型还要补一步 SET DEFAULT —— ALTER TYPE 会把老库的 DEFAULT NOW() 原样带过来，
--         而它落在无时区列上按会话时区(UTC)取值，跟这里的 (now() AT TIME ZONE 'Asia/Shanghai') 不是一回事。

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
    createtime  TIMESTAMP DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
    updatetime  TIMESTAMP DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
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
    createtime   TIMESTAMP DEFAULT (now() AT TIME ZONE 'Asia/Shanghai'),
    updatetime   TIMESTAMP DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')
);
