-- ============================================================
-- jndv 户型图 / 座位图数据库建表脚本 (Supabase / PostgreSQL)
-- 执行前请确认已连接到正确的数据库
-- ============================================================

-- 座位主表 (存储每个座位的姓名、工种标签、性别、是否组长及修改人)
CREATE TABLE IF NOT EXISTS public.jndv_seat (
    id          VARCHAR(20) PRIMARY KEY,
    room        VARCHAR(20) NOT NULL,
    seat_id     VARCHAR(40) NOT NULL UNIQUE,
    name        VARCHAR(40) DEFAULT '',
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
