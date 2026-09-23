import crypto from 'node:crypto'

import { checkAuth } from '#api_util/auth_middleware.js'
import base from '#api_util/base.js'
import { getPool } from '#api_util/db.js'

// 本接口专用：执行主备双写更新日志
async function upsert_backup_log_async(pool, logObj) {
	const query = `
    INSERT INTO "base_backup" ("id", "type", "source", "target", "status", "extra", "insertTime", "updateTime")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT ("id") 
    DO UPDATE SET 
      "status" = EXCLUDED."status", 
      "extra" = EXCLUDED."extra", 
      "updateTime" = EXCLUDED."updateTime";
  `
	const binds = [
		logObj.id,
		logObj.type,
		logObj.source,
		logObj.target,
		logObj.status,
		JSON.stringify(logObj.extra || {}),
		logObj.insertTime,
		logObj.updateTime || null,
	]
	await pool.query(query, binds)
}

// 备份日志表 DDL（双端幂等创建）
const LOG_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS "base_backup" (
    "id" varchar(255) NOT NULL,
    "type" varchar(50) NOT NULL,
    "source" varchar(100) NOT NULL,
    "target" varchar(100) NOT NULL,
    "status" smallint DEFAULT 0,
    "extra" jsonb DEFAULT '{}'::jsonb,
    "insertTime" varchar(19),
    "updateTime" varchar(19),
    PRIMARY KEY ("id")
  );
`

// 固定 id 的诊断标记：鉴权失败 / 连接池缺失这类「没进主流程」的故障记录
const GATE_AUTH_ID = '__auth_gate'
const GATE_POOL_ID = '__pool_gate'

// 尽力写一条 status=2 诊断标记
async function writeGateMark(logObj, markId, reason) {
	const now = base.getTime()
	const pools = [getPool(logObj.source), getPool(logObj.target)].filter(Boolean)
	for (const pool of pools) {
		try {
			await pool.query(LOG_TABLE_DDL)
			await upsert_backup_log_async(pool, {
				id: markId,
				type: logObj.type,
				source: logObj.source,
				target: logObj.target,
				status: 2,
				insertTime: logObj.insertTime,
				updateTime: now,
				extra: { error: reason, lastFailureAt: now, message: `备份未执行：${reason}` },
			})
		} catch (e) {
			console.error(`[备份引擎] 写入诊断标记 ${markId} 失败: ${e.message}`)
		}
	}
}

// 标准化错误构造函数
function format_phase_error(targetName, phase, objectName, action, originalError) {
	const prefix = `[backup][target=${targetName}][phase=${phase}]${objectName ? `[object=${objectName}]` : ''}`
	const msg = originalError && originalError.message ? originalError.message : String(originalError)
	const err = new Error(`${prefix} ${action} 失败: ${msg}`)
	if (originalError && originalError.stack) {
		err.originalStack = originalError.stack
	}
	return err
}

// SQL 字符串字面量转义（单引号转义成两个单引号）
function escape_sql_literal(str) {
	if (str == null) return "''"
	return `'${String(str).replace(/'/g, "''")}'`
}

// 数据插入值格式化，严格保证数据类型保真
function format_bind_value(val, colMeta) {
	if (val === null || val === undefined) {
		return null
	}
	if (typeof val === 'boolean' || typeof val === 'number') {
		return val
	}
	if (val instanceof Date) {
		return val
	}
	if (Buffer.isBuffer(val)) {
		return val
	}
	if (typeof val === 'object') {
		// 若为 PostgreSQL 数组字段类型且原生为 JS 数组，让 pg 驱动直接处理
		if (Array.isArray(val) && colMeta && colMeta.formatted_type && colMeta.formatted_type.endsWith('[]')) {
			return val
		}
		// 其余对象/复杂类型序列化为 JSON 字符串
		return JSON.stringify(val)
	}
	return val
}

function normalize_constraint_def(def, constraint_type) {
	if (!def) return ''

	let value = String(def).trim()

	if (constraint_type === 'c') {
		// PostgreSQL 不同版本对 CHECK 中 varchar[] / text 数组表达式的
		// pg_get_constraintdef() 反编译输出存在格式差异：
		//
		// 源库（如 Supabase PG15）：
		// ARRAY['official'::character varying, 'transfer'::character varying]::text[]
		//
		// 目标库（如 Neon PG16/17 在解析上述 DDL 时将 ::text[] 类型转换下推至数组内各元素）：
		// ARRAY['official'::character varying::text, 'transfer'::character varying::text]
		//
		// 两者语义完全一致。统一消除级联 ::text 与外层数组 ::text[] 标记，确保跨库一致性比对。
		value = value
			.replace(/::character varying::text/g, '::character varying')
			.replace(/::varchar::text/g, '::varchar')
			.replace(/\]\s*::text\[\]/g, ']')
	}

	return value
}

// 结构指纹计算函数（SHA-256）：提取表的所有结构对象规范化拼接后生成哈希
// detail=true 时同时返回各结构组件，用于定位 source / target 的具体差异
function compute_table_fingerprint(tableMeta, options = {}) {
	const cols = (tableMeta.columns || [])
		.map(c => `${c.column_name}:${c.formatted_type}:${c.not_null ? 1 : 0}:${c.column_default || ''}:${c.identity_type || ''}:${c.generated_type || ''}`)
		.sort()
		.join(';')

	const cons = (tableMeta.constraints || [])
		// PostgreSQL 18 开始，NOT NULL 也可能作为 pg_constraint(contype='n') 出现。
		// NOT NULL 已由 columns.attnotnull 负责审计，因此这里排除。
		.filter(c => c.constraint_type !== 'n')
		.map(c => {
			const constraintDef = normalize_constraint_def(c.constraint_def, c.constraint_type)

			return `${c.constraint_type}:${c.constraint_name}:${constraintDef}`
		})
		.sort()
		.join(';')

	const idxs = (tableMeta.indexes || [])
		.map(i => `${i.index_name}:${i.index_def}`)
		.sort()
		.join(';')

	const rls = `rls:${tableMeta.relrowsecurity ? 1 : 0}:force:${tableMeta.relforcerowsecurity ? 1 : 0}`

	const pols = (tableMeta.policies || [])
		.map(p => {
			// pg_policies.roles 是数组，复制后排序，避免修改原始 catalog 数据
			const rolesStr = Array.isArray(p.roles) ? [...p.roles].sort().join(',') : String(p.roles || '')

			// permissive 纳入指纹，防止 RESTRICTIVE / PERMISSIVE 差异漏检
			const permissive =
				p.permissive === false || String(p.permissive).toUpperCase() === 'RESTRICTIVE' || String(p.permissive).toLowerCase() === 'false'
					? 'RESTRICTIVE'
					: 'PERMISSIVE'

			return `${p.policyname}:${permissive}:${p.cmd}:${rolesStr}:${p.qual || ''}:${p.with_check || ''}`
		})
		.sort()
		.join(';')

	const trigs = (tableMeta.triggers || [])
		.map(t => `${t.trigger_name}:${t.trigger_def}`)
		.sort()
		.join(';')

	const components = {
		columns: cols,
		constraints: cons,
		indexes: idxs,
		rls,
		policies: pols,
		triggers: trigs,
	}

	const raw = Object.values(components).join('|')

	const fingerprint = crypto.createHash('sha256').update(raw).digest('hex')

	// 默认保持原有行为，只返回 SHA-256 指纹
	if (!options.detail) {
		return fingerprint
	}

	// detail=true 时返回完整组件，供一致性核验定位具体差异
	return {
		fingerprint,
		components,
	}
}

// 视图依赖拓扑排序算法
function sort_views_by_dependency(views, dependencies) {
	const sorted = []
	const visited = new Set()
	const viewMap = new Map(views.map(v => [v.view_name, v]))
	const depMap = new Map()

	for (const v of views) {
		depMap.set(v.view_name, new Set())
	}
	for (const d of dependencies) {
		if (depMap.has(d.view_name) && depMap.has(d.depends_on)) {
			depMap.get(d.view_name).add(d.depends_on)
		}
	}

	let progress = true
	while (sorted.length < views.length && progress) {
		progress = false
		for (const [vName, deps] of depMap.entries()) {
			if (!visited.has(vName)) {
				const allResolved = [...deps].every(dep => visited.has(dep))
				if (allResolved) {
					visited.add(vName)
					sorted.push(viewMap.get(vName))
					progress = true
				}
			}
		}
	}

	// 环路或无明确依赖的剩余视图直接追加
	for (const v of views) {
		if (!visited.has(v.view_name)) {
			sorted.push(v)
		}
	}
	return sorted
}

/**
 * 阶段 1：从源库 Catalog 提取全部应用数据库对象快照
 */
async function fetch_catalog_metadata_async(pool, sourceName) {
	const warnings = []

	// 1. 检测暂不支持的对象并登记 Warning（如物化视图、自定义规则）
	try {
		const mvRes = await pool.query(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'm';
    `)
		for (const r of mvRes.rows) {
			warnings.push(`检测到 Materialized View [${r.relname}]，当前版本暂不处理，已跳过`)
		}

		const ruleRes = await pool.query(`
      SELECT rulename, tablename
      FROM pg_rules
      WHERE schemaname = 'public' AND rulename != '_RETURN';
    `)
		for (const r of ruleRes.rows) {
			warnings.push(`检测到用户自定义 Rule [${r.rulename}] on [${r.tablename}]，当前版本暂不处理，已跳过`)
		}
	} catch (e) {
		console.warn('[备份引擎] 扫描不支持对象时出现非致命提示:', e.message)
	}

	// 2. 读取 public schema 下的自定义 enum 类型（若存在）
	let enums = []
	try {
		const enumRes = await pool.query(`
      SELECT
        t.typname AS enum_name,
        array_agg(e.enumlabel ORDER BY e.enumsortorder) AS enum_values
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      GROUP BY t.typname;
    `)
		enums = enumRes.rows
	} catch (e) {
		console.warn('[备份引擎] 读取 enum 类型失败:', e.message)
	}

	// 3. 读取待同步的普通业务数据表
	// 排除规则：base_backup 永不参与镜像；base_keepalive 属于 Supabase 独有保活对象，不参与镜像同步
	const tablesRes = await pool.query(`
    SELECT
      c.relname AS table_name,
      c.relrowsecurity,
      c.relforcerowsecurity,
      obj_description(c.oid, 'pg_class') AS table_comment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname != 'base_backup'
      AND c.relname != 'base_keepalive'
    ORDER BY c.relname;
  `)
	const tables = tablesRes.rows.map(r => r.table_name)
	const tableClassMap = new Map(tablesRes.rows.map(r => [r.table_name, r]))

	// 4. 读取所有序列定义及当前位点（通过 pg_depend 明确区分 Identity 序列与普通 Sequence）
	let sequences = []
	try {
		const seqRes = await pool.query(`
      SELECT
        c.relname AS sequence_name,
        s.seqstart AS start_value,
        s.seqincrement AS increment,
        s.seqmax AS max_value,
        s.seqmin AS min_value,
        s.seqcache AS cache_size,
        s.seqcycle AS is_cycled,
        dep.owned_table,
        dep.owned_column,
        COALESCE(dep.is_identity, false) AS is_identity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_sequence s ON s.seqrelid = c.oid
      LEFT JOIN LATERAL (
        SELECT
          t.relname AS owned_table,
          a.attname AS owned_column,
          (a.attidentity IN ('a', 'd')) AS is_identity
        FROM pg_depend d
        JOIN pg_class t ON t.oid = d.refobjid
        JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
        WHERE d.objid = c.oid AND d.deptype IN ('i', 'a')
        ORDER BY (d.deptype = 'i') DESC
        LIMIT 1
      ) dep ON true
      WHERE n.nspname = 'public'
        AND c.relkind = 'S'
      ORDER BY c.relname;
    `)

		for (const s of seqRes.rows) {
			try {
				const valRes = await pool.query(`SELECT last_value::text AS last_value, is_called FROM "${s.sequence_name}";`)
				sequences.push({
					...s,
					last_value: String(valRes.rows[0].last_value),
					is_called: valRes.rows[0].is_called,
				})
			} catch (e) {
				sequences.push({ ...s, last_value: '1', is_called: false })
			}
		}
	} catch (e) {
		console.warn('[备份引擎] 读取 sequences 编目失败:', e.message)
	}

	// 5. 遍历业务表提取列、约束、索引、RLS、策略与触发器
	const tableMeta = {}
	for (const table of tables) {
		const classInfo = tableClassMap.get(table) || {}

		// A. 列字段定义 (使用 format_type 精确还原类型)
		const colsRes = await pool.query(
			`
      SELECT
        a.attname AS column_name,
        format_type(a.atttypid, a.atttypmod) AS formatted_type,
        a.attnotnull AS not_null,
        pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
        a.attidentity AS identity_type,
        a.attgenerated AS generated_type,
        col_description(a.attrelid, a.attnum) AS column_comment
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum;
    `,
			[table],
		)

		// B. 约束 (PK, Unique, Check, FK)
		const consRes = await pool.query(
			`
      SELECT
        con.conname AS constraint_name,
        con.contype AS constraint_type,
        pg_get_constraintdef(con.oid, true) AS constraint_def
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = $1
      ORDER BY con.contype, con.conname;
    `,
			[table],
		)

		// C. 索引 (排除 PK 与 UNIQUE 对应的隐式索引，避免重复创建报错)
		const idxRes = await pool.query(
			`
      SELECT
        c.relname AS index_name,
        pg_get_indexdef(i.indexrelid) AS index_def
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = $1
        AND NOT i.indisprimary
        AND i.indexrelid NOT IN (
          SELECT conindid FROM pg_constraint WHERE contype IN ('p', 'u')
        )
      ORDER BY c.relname;
    `,
			[table],
		)

		// D. 策略 (Policy)
		const polRes = await pool.query(
			`
      SELECT
        policyname,
        permissive,
        roles,
        cmd,
        qual,
        with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = $1
      ORDER BY policyname;
    `,
			[table],
		)

		// E. 用户自定义触发器
		const trigRes = await pool.query(
			`
      SELECT
        t.tgname AS trigger_name,
        pg_get_triggerdef(t.oid) AS trigger_def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND NOT t.tgisinternal
      ORDER BY t.tgname;
    `,
			[table],
		)

		tableMeta[table] = {
			columns: colsRes.rows,
			constraints: consRes.rows,
			indexes: idxRes.rows,
			relrowsecurity: !!classInfo.relrowsecurity,
			relforcerowsecurity: !!classInfo.relforcerowsecurity,
			table_comment: classInfo.table_comment || null,
			policies: polRes.rows,
			triggers: trigRes.rows,
		}
	}

	// 6. 读取视图 (View) 与视图间依赖
	const viewsRes = await pool.query(`
    SELECT
      c.relname AS view_name,
      pg_get_viewdef(c.oid, true) AS definition
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v'
    ORDER BY c.relname;
  `)

	let viewDependencies = []
	try {
		const depRes = await pool.query(`
      SELECT DISTINCT
        v.relname AS view_name,
        dep.relname AS depends_on
      FROM pg_depend d
      JOIN pg_rewrite r ON r.oid = d.objid
      JOIN pg_class v ON v.oid = r.ev_class
      JOIN pg_class dep ON dep.oid = d.refobjid
      JOIN pg_namespace nv ON nv.oid = v.relnamespace
      JOIN pg_namespace ndep ON ndep.oid = dep.relnamespace
      WHERE nv.nspname = 'public'
        AND ndep.nspname = 'public'
        AND v.relkind = 'v'
        AND dep.relkind = 'v'
        AND v.relname != dep.relname;
    `)
		viewDependencies = depRes.rows
	} catch (e) {
		console.warn('[备份引擎] 读取视图依赖失败:', e.message)
	}

	return {
		tables,
		tableMeta,
		sequences,
		enums,
		views: viewsRes.rows,
		viewDependencies,
		warnings,
	}
}

/**
 * 阶段 2：目标库对象扫描、异常变空安全熔断与有序级联清理
 */
async function clean_target_objects_async(client, sourceTables, targetName) {
	// 1. 扫描目标库 public 下现存的所有表、视图与序列
	const tTablesRes = await client.query(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r';
  `)
	const existingTables = tTablesRes.rows.map(r => r.relname)

	// 过滤出业务表（排除保护表）
	const businessTables = existingTables.filter(t => t !== 'base_backup' && t !== 'base_keepalive')

	// 2. 目标库异常变空保护（安全熔断机制）
	// 首次初始化备库允许 target 为空；若 target 存在业务数据而源库异常归零/剧烈减少，坚决熔断
	if (businessTables.length >= 3 && sourceTables.length === 0) {
		throw new Error(
			`[backup][target=${targetName}] 异常变空保护熔断：源库有效业务表数量为 0，而目标库已有 ${businessTables.length} 张业务表。已中止备份以防清空备库！`,
		)
	}
	if (businessTables.length >= 5 && sourceTables.length < 3) {
		throw new Error(
			`[backup][target=${targetName}] 异常变空保护熔断：源库业务表数量 (${sourceTables.length}) 异常减少，远低于目标库现有业务表数量 (${businessTables.length})。已中止备份！`,
		)
	}

	// 3. 先清理目标库现有的所有视图（按依赖逆向拓扑有序 DROP RESTRICT，避免 CASCADE 误杀外部对象）
	const tViewsRes = await client.query(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v';
  `)

	let tViewDeps = []
	try {
		const tDepRes = await client.query(`
      SELECT DISTINCT
        v.relname AS view_name,
        dep.relname AS depends_on
      FROM pg_depend d
      JOIN pg_rewrite r ON r.oid = d.objid
      JOIN pg_class v ON v.oid = r.ev_class
      JOIN pg_class dep ON dep.oid = d.refobjid
      JOIN pg_namespace nv ON nv.oid = v.relnamespace
      JOIN pg_namespace ndep ON ndep.oid = dep.relnamespace
      WHERE nv.nspname = 'public'
        AND ndep.nspname = 'public'
        AND v.relkind = 'v'
        AND dep.relkind = 'v'
        AND v.relname != dep.relname;
    `)
		tViewDeps = tDepRes.rows
	} catch (e) {}

	const viewsToDrop = sort_views_by_dependency(
		tViewsRes.rows.map(r => ({ view_name: r.relname, definition: '' })),
		tViewDeps,
	).reverse()

	for (const v of viewsToDrop) {
		try {
			await client.query(`DROP VIEW IF EXISTS "${v.view_name}";`)
		} catch (err) {
			throw format_phase_error(targetName, 'drop_view', v.view_name, 'DROP VIEW (RESTRICT)', err)
		}
	}

	// 4. 清理目标库中的业务表（含孤儿表清理）
	// 保护逻辑：base_backup 与 base_keepalive 两端永久保护，严禁删除
	for (const table of existingTables) {
		if (table === 'base_backup' || table === 'base_keepalive') continue
		await client.query(`DROP TABLE IF EXISTS "${table}" CASCADE;`)
	}

	// 5. 清理孤儿独立序列（严格保护 base_backup 与 base_keepalive 关联序列）
	const tSeqRes = await client.query(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
      AND c.relname NOT LIKE 'base_backup%'
      AND c.relname NOT LIKE 'base_keepalive%'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        JOIN pg_class t ON t.oid = d.refobjid
        WHERE d.objid = c.oid
          AND d.deptype IN ('i', 'a')
          AND t.relname IN ('base_backup', 'base_keepalive')
      );
  `)
	for (const s of tSeqRes.rows) {
		await client.query(`DROP SEQUENCE IF EXISTS "${s.relname}" CASCADE;`)
	}
}

/**
 * 阶段 3：重建 Enum 与普通 Sequence
 */
async function rebuild_types_and_sequences_async(client, enums, sequences, targetName) {
	// 1. 重建 Enum
	for (const e of enums) {
		try {
			const existsRes = await client.query(
				`SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = $1;`,
				[e.enum_name],
			)
			if (!existsRes.rowCount) {
				const vals = e.enum_values.map(v => escape_sql_literal(v)).join(', ')
				await client.query(`CREATE TYPE "${e.enum_name}" AS ENUM (${vals});`)
			}
		} catch (err) {
			throw format_phase_error(targetName, 'enum', e.enum_name, 'CREATE TYPE', err)
		}
	}

	// 2. 重建普通/Serial Sequence（Identity Sequence 由 CREATE TABLE 自动生成，跳过预创建防冲突）
	for (const s of sequences) {
		if (s.is_identity) continue
		try {
			const cycleClause = s.is_cycled ? 'CYCLE' : 'NO CYCLE'
			const createSeqSql = `CREATE SEQUENCE IF NOT EXISTS "${s.sequence_name}" INCREMENT BY ${s.increment} MINVALUE ${s.min_value} MAXVALUE ${s.max_value} START WITH ${s.start_value} CACHE ${s.cache_size} ${cycleClause};`
			await client.query(createSeqSql)
		} catch (err) {
			throw format_phase_error(targetName, 'sequence', s.sequence_name, 'CREATE SEQUENCE', err)
		}
	}
}

/**
 * 阶段 4：重建轻量业务表结构（不含约束与索引）
 */
async function create_target_tables_async(client, tables, tableMeta, sequences, targetName) {
	for (const table of tables) {
		const meta = tableMeta[table]
		const colDefs = []

		for (const col of meta.columns) {
			let def = `"${col.column_name}" ${col.formatted_type}`
			if (col.identity_type === 'd' || col.identity_type === 'a') {
				const idKind = col.identity_type === 'a' ? 'ALWAYS' : 'BY DEFAULT'
				const matchedSeq = (sequences || []).find(s => s.owned_table === table && s.owned_column === col.column_name)
				if (matchedSeq) {
					const cycleClause = matchedSeq.is_cycled ? 'CYCLE' : 'NO CYCLE'
					def += ` GENERATED ${idKind} AS IDENTITY (INCREMENT BY ${matchedSeq.increment} MINVALUE ${matchedSeq.min_value} MAXVALUE ${matchedSeq.max_value} START WITH ${matchedSeq.start_value} CACHE ${matchedSeq.cache_size} ${cycleClause})`
				} else {
					def += ` GENERATED ${idKind} AS IDENTITY`
				}
			} else if (col.generated_type === 's') {
				def += ` GENERATED ALWAYS AS (${col.column_default}) STORED`
			} else if (col.column_default !== null) {
				def += ` DEFAULT ${col.column_default}`
			}

			if (col.not_null && col.identity_type !== 'd' && col.identity_type !== 'a') {
				def += ' NOT NULL'
			}
			colDefs.push(def)
		}

		const createSql = `CREATE TABLE "${table}" (\n  ${colDefs.join(',\n  ')}\n);`
		try {
			await client.query(createSql)
		} catch (err) {
			throw format_phase_error(targetName, 'table', table, 'CREATE TABLE', err)
		}
	}
}

/**
 * 阶段 5：批量参数化迁移各表数据（类型保真）
 */
async function copy_table_data_async(sourcePool, client, tables, tableMeta, targetName) {
	for (const table of tables) {
		const meta = tableMeta[table]
		let rows = []
		try {
			const dataRes = await sourcePool.query(`SELECT * FROM "${table}";`)
			rows = dataRes.rows
		} catch (err) {
			throw format_phase_error(targetName, 'data_extract', table, 'SELECT', err)
		}

		if (rows.length === 0) continue

		// 排除存储型生成列（GENERATED ALWAYS AS ... STORED 列不可直接 INSERT）
		const validCols = meta.columns.filter(c => c.generated_type !== 's')
		const colNames = validCols.map(c => `"${c.column_name}"`).join(', ')

		// 若存在 GENERATED ALWAYS AS IDENTITY 列，需指定 OVERRIDING SYSTEM VALUE
		const hasAlwaysIdentity = validCols.some(c => c.identity_type === 'a')
		const overrideClause = hasAlwaysIdentity ? ' OVERRIDING SYSTEM VALUE' : ''

		const batchSize = 100
		for (let i = 0; i < rows.length; i += batchSize) {
			const batch = rows.slice(i, i + batchSize)
			const values = []
			const placeholders = []
			let paramIndex = 1

			for (const row of batch) {
				const rowPlaceholders = []
				for (const col of validCols) {
					const val = row[col.column_name]
					values.push(format_bind_value(val, col))
					rowPlaceholders.push(`$${paramIndex++}`)
				}
				placeholders.push(`(${rowPlaceholders.join(', ')})`)
			}

			const insertSql = `INSERT INTO "${table}" (${colNames})${overrideClause} VALUES ${placeholders.join(', ')};`
			try {
				await client.query(insertSql, values)
			} catch (err) {
				throw format_phase_error(targetName, 'data_insert', table, 'INSERT', err)
			}
		}
	}
}

/**
 * 阶段 6：重建约束（PK/UNIQUE/CHECK 先建，FK 后建）与非主键索引
 */
async function rebuild_constraints_and_indexes_async(client, tables, tableMeta, targetName) {
	// 1. 重建 PK / UNIQUE / CHECK 约束
	for (const table of tables) {
		const meta = tableMeta[table]
		for (const con of meta.constraints) {
			if (con.constraint_type === 'p' || con.constraint_type === 'u' || con.constraint_type === 'c') {
				try {
					await client.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${con.constraint_name}" ${con.constraint_def};`)
				} catch (err) {
					throw format_phase_error(targetName, 'constraint', `${table}.${con.constraint_name}`, 'ADD CONSTRAINT', err)
				}
			}
		}
	}

	// 2. 重建外键 (FK) 约束
	for (const table of tables) {
		const meta = tableMeta[table]
		for (const con of meta.constraints) {
			if (con.constraint_type === 'f') {
				try {
					await client.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${con.constraint_name}" ${con.constraint_def};`)
				} catch (err) {
					throw format_phase_error(targetName, 'foreign_key', `${table}.${con.constraint_name}`, 'ADD FOREIGN KEY', err)
				}
			}
		}
	}

	// 3. 重建额外普通索引
	for (const table of tables) {
		const meta = tableMeta[table]
		for (const idx of meta.indexes) {
			try {
				await client.query(idx.index_def)
			} catch (err) {
				throw format_phase_error(targetName, 'index', idx.index_name, 'CREATE INDEX', err)
			}
		}
	}
}

/**
 * 阶段 7：校正序列位点与恢复所属关系（普通 Sequence 与 Identity 序列）
 */
async function reset_sequences_async(client, sequences, tables, tableMeta, targetName) {
	// 1. 恢复独立/普通 Sequence 的位点与 OWNED BY 归属关联
	for (const s of sequences) {
		if (s.is_identity) continue

		// 恢复位点：采用标准参数化 $1::regclass，失败严格抛错触发事务回滚，严禁 console.warn 吞错
		const qualifiedSeq = `"public"."${s.sequence_name.replace(/"/g, '""')}"`
		try {
			await client.query(`SELECT setval($1::regclass, $2::bigint, $3::boolean);`, [qualifiedSeq, s.last_value, !!s.is_called])
		} catch (err) {
			throw format_phase_error(targetName, 'sequence_setval', s.sequence_name, `恢复序列位点 (${s.last_value}, is_called=${s.is_called})`, err)
		}

		// 恢复普通/Serial 序列对表字段的 OWNED BY 归属关联（失败严格抛错触发事务回滚，严禁结构不一致静默成功）
		if (s.owned_table && s.owned_column) {
			try {
				await client.query(`ALTER SEQUENCE "${s.sequence_name}" OWNED BY "${s.owned_table}"."${s.owned_column}";`)
			} catch (err) {
				throw format_phase_error(
					targetName,
					'sequence_owned_by',
					s.sequence_name,
					`恢复 Sequence OWNED BY ("${s.owned_table}"."${s.owned_column}")`,
					err,
				)
			}
		}
	}

	// 2. 检查各表自增列/Identity 列的最大值并依据源 sequence 状态校准当前位点
	// 注意：Sequence 步长、边界、缓存、循环等属性已在建表/建序列 DDL 阶段精准恢复，此处仅需校准位点
	for (const table of tables) {
		const meta = tableMeta[table]
		for (const col of meta.columns) {
			if (col.identity_type || (col.column_default && col.column_default.includes('nextval'))) {
				try {
					const seqRes = await client.query(`SELECT pg_get_serial_sequence('"${table}"', '${col.column_name}') AS sname;`)
					const sname = seqRes.rows[0]?.sname
					if (sname) {
						// 寻找对应的源 sequence 元数据
						const matchedSeq = sequences.find(s => s.sequence_name === sname || (s.owned_table === table && s.owned_column === col.column_name))
						// 查询目标表中该列当前实存数据的最大值（注意：这是当前数据表的实际最大 ID，绝非 sequence 本身的 MAXVALUE 属性）
						// 设计意图：防止源库存在手工插大数导致 last_value 低于已有最大 ID 时，备库下一次 INSERT 产生 duplicate key 唯一键冲突
						const maxColRes = await client.query(`SELECT MAX("${col.column_name}")::text AS max_col_val FROM "${table}";`)
						const maxColValStr = maxColRes.rows[0]?.max_col_val

						if (matchedSeq) {
							// 优先以源序列真实 last_value 为基准，防止将 bigint 强转 Number 损失精度
							let finalVal = BigInt(matchedSeq.last_value)
							let isCalled = matchedSeq.is_called
							if (maxColValStr !== null && maxColValStr !== undefined) {
								const maxColValBig = BigInt(maxColValStr)
								if (maxColValBig > finalVal) {
									finalVal = maxColValBig
									isCalled = true
								}
							}
							await client.query(`SELECT setval($1::regclass, $2::bigint, $3::boolean);`, [sname, finalVal.toString(), !!isCalled])
						} else if (maxColValStr !== null && maxColValStr !== undefined) {
							await client.query(`SELECT setval($1::regclass, $2::bigint, true);`, [sname, maxColValStr])
						}
					}
				} catch (err) {
					throw format_phase_error(targetName, 'sequence_calibrate', `${table}.${col.column_name}`, `校准自增序列位点`, err)
				}
			}
		}
	}
}

/**
 * 阶段 8：恢复注释、RLS 状态、策略与触发器
 */
async function rebuild_security_and_triggers_async(client, tables, tableMeta, targetName) {
	for (const table of tables) {
		const meta = tableMeta[table]

		// 1. 表注释与列注释
		if (meta.table_comment) {
			try {
				await client.query(`COMMENT ON TABLE "${table}" IS ${escape_sql_literal(meta.table_comment)};`)
			} catch (e) {}
		}
		for (const col of meta.columns) {
			if (col.column_comment) {
				try {
					await client.query(`COMMENT ON COLUMN "${table}"."${col.column_name}" IS ${escape_sql_literal(col.column_comment)};`)
				} catch (e) {}
			}
		}

		// 2. RLS 状态与强制状态恢复
		try {
			if (meta.relrowsecurity) {
				await client.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`)
			} else {
				await client.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY;`)
			}
			if (meta.relforcerowsecurity) {
				await client.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`)
			} else {
				await client.query(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY;`)
			}
		} catch (err) {
			throw format_phase_error(targetName, 'rls_state', table, 'ALTER ROW LEVEL SECURITY', err)
		}

		// 3. 策略 (Policies) 重建
		for (const pol of meta.policies) {
			let roleList = []
			if (Array.isArray(pol.roles)) {
				roleList = pol.roles
			} else if (typeof pol.roles === 'string') {
				roleList = pol.roles
					.replace(/^\{|\}$/g, '')
					.split(',')
					.map(s => s.trim().replace(/^"|"$/g, ''))
					.filter(Boolean)
			}

			// 校验目标库 roles 存在性
			const targetRoles = []
			for (const r of roleList) {
				if (r.toLowerCase() === 'public') {
					targetRoles.push('public')
					continue
				}
				try {
					const rRes = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1;', [r])
					if (rRes.rowCount > 0) {
						targetRoles.push(`"${r}"`)
					} else {
						// 尝试创建 NOLOGIN 占位角色以保证策略绑定一致性
						try {
							await client.query(`CREATE ROLE "${r}" NOLOGIN;`)
							targetRoles.push(`"${r}"`)
						} catch (crErr) {
							throw format_phase_error(
								targetName,
								'policy_role',
								`${table}.${pol.policyname}`,
								`目标角色 [${r}] 不存在且无法自动创建 NOLOGIN 角色(${crErr.message})，为防止权限扩大中止备份`,
								crErr,
							)
						}
					}
				} catch (checkErr) {
					if (checkErr.message?.includes('为防止权限扩大')) {
						throw checkErr
					}
					throw format_phase_error(targetName, 'policy_role_check', `${table}.${pol.policyname}`, `查询角色 [${r}] 失败`, checkErr)
				}
			}

			if (targetRoles.length === 0) {
				throw format_phase_error(
					targetName,
					'policy',
					`${table}.${pol.policyname}`,
					'CREATE POLICY',
					new Error(`策略 [${pol.policyname}] 缺少有效授权角色`),
				)
			}

			const rolesClause = targetRoles.join(', ')
			const permissiveClause =
				pol.permissive === false || String(pol.permissive).toUpperCase() === 'RESTRICTIVE' || String(pol.permissive).toLowerCase() === 'false'
					? 'RESTRICTIVE'
					: 'PERMISSIVE'

			let polSql = `CREATE POLICY "${pol.policyname}" ON "${table}" AS ${permissiveClause} FOR ${pol.cmd || 'ALL'} TO ${rolesClause}`
			if (pol.qual) {
				polSql += ` USING (${pol.qual})`
			}
			if (pol.with_check) {
				polSql += ` WITH CHECK (${pol.with_check})`
			}

			try {
				await client.query(polSql)
			} catch (err) {
				throw format_phase_error(targetName, 'policy', `${table}.${pol.policyname}`, 'CREATE POLICY', err)
			}
		}

		// 4. 触发器 (Triggers) 重建
		for (const trig of meta.triggers) {
			try {
				await client.query(trig.trigger_def)
			} catch (err) {
				throw format_phase_error(targetName, 'trigger', `${table}.${trig.trigger_name}`, 'CREATE TRIGGER', err)
			}
		}
	}
}

/**
 * 阶段 9：依依赖顺序重建视图 (View)
 */
async function rebuild_views_async(client, views, viewDependencies, targetName) {
	if (views.length === 0) return

	const sortedViews = sort_views_by_dependency(views, viewDependencies)
	for (const v of sortedViews) {
		try {
			await client.query(`CREATE OR REPLACE VIEW "${v.view_name}" AS ${v.definition};`)
		} catch (err) {
			throw format_phase_error(targetName, 'view', v.view_name, 'CREATE VIEW', err)
		}
	}
}

/**
 * 阶段 10：一致性核验、视图可用性检测与结构指纹审计
 */
async function validate_target_async(sourcePool, client, tables, metadata, targetName) {
	const auditLog = {}
	const viewLog = {}
	const warnings = [...metadata.warnings]

	let isRowMatched = true
	let isObjectMatched = true

	// 1. 逐表行数比对与指纹审计
	for (const table of tables) {
		let sCount = 0
		let tCount = 0

		// 查询源库行数
		try {
			const sCountRes = await sourcePool.query(`SELECT count(*) AS count FROM "${table}";`)

			sCount = parseInt(sCountRes.rows[0].count, 10)
		} catch (e) {
			// 源库查询失败不应污染目标库事务，但应让本表行数核验失败
			sCount = -1
		}

		// 查询目标库行数
		try {
			const tCountRes = await client.query(`SELECT count(*) AS count FROM "${table}";`)

			tCount = parseInt(tCountRes.rows[0].count, 10)
		} catch (e) {
			// 目标库处于事务中，任何 SQL 错误都必须立即终止并由外层 ROLLBACK
			throw format_phase_error(targetName, 'validation_count', table, '查询目标库表行数进行对账', e)
		}

		const rowMatch = sCount >= 0 && tCount >= 0 && sCount === tCount

		if (!rowMatch) {
			isRowMatched = false

			warnings.push(`表 [${table}] 数据行数不一致 (source: ${sCount}, target: ${tCount})`)
		}

		// ---------------------------------------------------------
		// 计算源库表指纹
		// ---------------------------------------------------------

		const sFpDetail = compute_table_fingerprint(metadata.tableMeta[table], {
			detail: true,
		})

		const sFp = sFpDetail.fingerprint

		// ---------------------------------------------------------
		// 获取目标库当前表元数据
		// ---------------------------------------------------------

		let tFp = ''
		let tFpDetail = null
		let schemaMatch = false

		try {
			// columns
			const tColsRes = await client.query(
				`
                SELECT
                    a.attname AS column_name,
                    format_type(a.atttypid, a.atttypmod) AS formatted_type,
                    a.attnotnull AS not_null,
                    pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
                    a.attidentity AS identity_type,
                    a.attgenerated AS generated_type
                FROM pg_attribute a
                JOIN pg_class c
                    ON c.oid = a.attrelid
                JOIN pg_namespace n
                    ON n.oid = c.relnamespace
                LEFT JOIN pg_attrdef ad
                    ON ad.adrelid = a.attrelid
                    AND ad.adnum = a.attnum
                WHERE n.nspname = 'public'
                    AND c.relname = $1
                    AND a.attnum > 0
                    AND NOT a.attisdropped
                ORDER BY a.attnum;
                `,
				[table],
			)

			// constraints
			const tConsRes = await client.query(
				`
                SELECT
                    con.conname AS constraint_name,
                    con.contype AS constraint_type,
                    pg_get_constraintdef(con.oid, true) AS constraint_def
                FROM pg_constraint con
                JOIN pg_class c
                    ON c.oid = con.conrelid
                JOIN pg_namespace n
                    ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                    AND c.relname = $1;
                `,
				[table],
			)

			// indexes
			const tIdxRes = await client.query(
				`
                SELECT
                    c.relname AS index_name,
                    pg_get_indexdef(i.indexrelid) AS index_def
                FROM pg_index i
                JOIN pg_class c
                    ON c.oid = i.indexrelid
                JOIN pg_class t
                    ON t.oid = i.indrelid
                JOIN pg_namespace n
                    ON n.oid = t.relnamespace
                WHERE n.nspname = 'public'
                    AND t.relname = $1
                    AND NOT i.indisprimary
                    AND i.indexrelid NOT IN (
                        SELECT conindid
                        FROM pg_constraint
                        WHERE contype IN ('p', 'u')
                    );
                `,
				[table],
			)

			// RLS
			const tRlsRes = await client.query(
				`
                SELECT
                    c.relrowsecurity,
                    c.relforcerowsecurity
                FROM pg_class c
                JOIN pg_namespace n
                    ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                    AND c.relname = $1;
                `,
				[table],
			)

			// policies
			const tPolRes = await client.query(
				`
                SELECT
                    policyname,
                    permissive,
                    roles,
                    cmd,
                    qual,
                    with_check
                FROM pg_policies
                WHERE schemaname = 'public'
                    AND tablename = $1;
                `,
				[table],
			)

			// triggers
			const tTrigRes = await client.query(
				`
                SELECT
                    t.tgname AS trigger_name,
                    pg_get_triggerdef(t.oid) AS trigger_def
                FROM pg_trigger t
                JOIN pg_class c
                    ON c.oid = t.tgrelid
                JOIN pg_namespace n
                    ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                    AND c.relname = $1
                    AND NOT t.tgisinternal;
                `,
				[table],
			)

			const tMeta = {
				columns: tColsRes.rows,
				constraints: tConsRes.rows,
				indexes: tIdxRes.rows,
				relrowsecurity: !!tRlsRes.rows[0]?.relrowsecurity,
				relforcerowsecurity: !!tRlsRes.rows[0]?.relforcerowsecurity,
				policies: tPolRes.rows,
				triggers: tTrigRes.rows,
			}

			tFpDetail = compute_table_fingerprint(tMeta, {
				detail: true,
			})

			tFp = tFpDetail.fingerprint
			schemaMatch = sFp === tFp
		} catch (e) {
			// 目标库处于事务中，任何 catalog 查询失败都必须立即抛出，
			// 禁止 catch 后继续执行，否则 PostgreSQL transaction 会进入 aborted 状态
			throw format_phase_error(targetName, 'validation_schema', table, '查询目标库表结构进行指纹核验', e)
		}

		// ---------------------------------------------------------
		// 结构指纹差异诊断
		// ---------------------------------------------------------

		if (!schemaMatch) {
			// 结构不一致必须影响最终 isOverallSuccess
			isObjectMatched = false

			warnings.push(`表 [${table}] 结构指纹不一致 (source: ${sFp.slice(0, 8)}, target: ${tFp.slice(0, 8)})`)

			const componentNames = ['columns', 'constraints', 'indexes', 'rls', 'policies', 'triggers']

			for (const componentName of componentNames) {
				const sourceComponent = sFpDetail.components[componentName]

				const targetComponent = tFpDetail.components[componentName]

				if (sourceComponent !== targetComponent) {
					warnings.push(`表 [${table}] 指纹组件不一致：${componentName}`)

					// 完整差异只输出到服务端日志，避免 API 返回体过大
					console.warn(`[备份引擎] 表 [${table}] ${componentName} 结构差异`, {
						source: sourceComponent,
						target: targetComponent,
					})
				}
			}
		}

		auditLog[table] = {
			source: sCount,
			target: tCount,
			rowMatch,
			sourceFingerprint: sFp,
			targetFingerprint: tFp,
			schemaMatch,
		}
	}

	// ---------------------------------------------------------
	// 2. 检查 base_keepalive 是否安全存续
	// ---------------------------------------------------------

	try {
		const kaExistsRes = await client.query(
			`
            SELECT 1
            FROM pg_class c
            JOIN pg_namespace n
                ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
                AND c.relkind = 'r'
                AND c.relname = 'base_keepalive';
            `,
		)

		if (kaExistsRes.rowCount > 0) {
			const kaCountRes = await client.query(`SELECT count(*) AS count FROM "base_keepalive";`)

			auditLog['base_keepalive'] = {
				source: null,
				target: parseInt(kaCountRes.rows[0].count, 10),
				rowMatch: true,
				schemaMatch: true,
				memo: '保活表 base_keepalive 已获隔离保护，未参与镜像与清理',
			}
		}
	} catch (e) {
		throw format_phase_error(targetName, 'validation_keepalive', 'base_keepalive', '核验保活表 base_keepalive 状态', e)
	}

	// ---------------------------------------------------------
	// 3. 视图有效性核验
	// ---------------------------------------------------------

	for (const v of metadata.views) {
		try {
			await client.query(`SELECT * FROM "${v.view_name}" LIMIT 0;`)

			viewLog[v.view_name] = {
				match: true,
			}
		} catch (e) {
			// View 查询失败会使当前事务进入 aborted 状态，
			// 因此必须立即抛出真实错误
			throw format_phase_error(targetName, 'validation_view', v.view_name, '查询视图进行可用性核验', e)
		}
	}

	// ---------------------------------------------------------
	// 4. 统计目标库实际 Policy / Trigger 数量
	// ---------------------------------------------------------

	let targetPolicyCount = 0
	let targetTriggerCount = 0

	try {
		const tPolCountRes = await client.query(
			`
            SELECT count(*) AS count
            FROM pg_policies
            WHERE schemaname = 'public';
            `,
		)

		targetPolicyCount = parseInt(tPolCountRes.rows[0]?.count || 0, 10)

		const tTrigCountRes = await client.query(
			`
            SELECT count(*) AS count
            FROM pg_trigger t
            JOIN pg_class c
                ON c.oid = t.tgrelid
            JOIN pg_namespace n
                ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
                AND NOT t.tgisinternal;
            `,
		)

		targetTriggerCount = parseInt(tTrigCountRes.rows[0]?.count || 0, 10)
	} catch (e) {
		throw format_phase_error(targetName, 'validation_object_count', 'public', '查询目标库 Policy / Trigger 实际数量', e)
	}

	// ---------------------------------------------------------
	// 5. 真实统计目标库业务表与视图数量
	// ---------------------------------------------------------

	let targetTableCount = 0
	let targetViewCount = 0

	try {
		const tTableCountRes = await client.query(
			`
            SELECT count(*) AS count
            FROM pg_class c
            JOIN pg_namespace n
                ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
                AND c.relkind = 'r'
                AND c.relname NOT IN (
                    'base_backup',
                    'base_keepalive'
                );
            `,
		)

		targetTableCount = parseInt(tTableCountRes.rows[0]?.count || 0, 10)

		const tViewCountRes = await client.query(
			`
            SELECT count(*) AS count
            FROM pg_class c
            JOIN pg_namespace n
                ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
                AND c.relkind = 'v';
            `,
		)

		targetViewCount = parseInt(tViewCountRes.rows[0]?.count || 0, 10)
	} catch (e) {
		throw format_phase_error(targetName, 'validation_object_count', 'public', '查询目标库业务表与视图实际数量', e)
	}

	// ---------------------------------------------------------
	// 6. 汇总 source / target 对账结果
	// ---------------------------------------------------------

	const sourcePolicyCount = Object.values(metadata.tableMeta).reduce((acc, m) => acc + (m.policies?.length || 0), 0)

	const sourceTriggerCount = Object.values(metadata.tableMeta).reduce((acc, m) => acc + (m.triggers?.length || 0), 0)

	const isPolicyMatched = sourcePolicyCount === targetPolicyCount

	const isTriggerMatched = sourceTriggerCount === targetTriggerCount

	const isTableCountMatched = tables.length === targetTableCount

	const isViewCountMatched = metadata.views.length === targetViewCount

	if (!isPolicyMatched) {
		isObjectMatched = false

		warnings.push(`策略数量不一致 (源库: ${sourcePolicyCount}, 目标库: ${targetPolicyCount})`)
	}

	if (!isTriggerMatched) {
		isObjectMatched = false

		warnings.push(`触发器数量不一致 (源库: ${sourceTriggerCount}, 目标库: ${targetTriggerCount})`)
	}

	if (!isTableCountMatched) {
		isObjectMatched = false

		warnings.push(`业务表数量不一致 (源库: ${tables.length}, 目标库: ${targetTableCount})`)
	}

	if (!isViewCountMatched) {
		isObjectMatched = false

		warnings.push(`视图数量不一致 (源库: ${metadata.views.length}, 目标库: ${targetViewCount})`)
	}

	// ---------------------------------------------------------
	// 7. 最终一致性判定
	// ---------------------------------------------------------

	const isOverallSuccess = isRowMatched && isObjectMatched && isTableCountMatched && isViewCountMatched

	return {
		auditLog,
		viewLog,
		warnings,
		isOverallSuccess,

		tableCount: {
			source: tables.length,
			target: targetTableCount,
			match: isTableCountMatched && isRowMatched,
		},

		viewCount: {
			source: metadata.views.length,
			target: targetViewCount,
			match: isViewCountMatched && isObjectMatched,
		},

		policyCount: {
			source: sourcePolicyCount,
			target: targetPolicyCount,
			match: isPolicyMatched,
		},

		triggerCount: {
			source: sourceTriggerCount,
			target: targetTriggerCount,
			match: isTriggerMatched,
		},
	}
}

/**
 * 备份引擎主入口
 */
export default async (req, resp) => {
	// 初始化 base 上下文
	base.req = req
	base.resp = resp

	const startTime = Date.now()
	const activeDb = (process.env.DB || 'neon').toLowerCase()
	const sourceName = activeDb
	const targetName = activeDb === 'neon' ? 'supabase' : 'neon'

	// 准备初始日志对象（提前创建：鉴权失败/连接池缺失分支也能写诊断标记）
	const logId = base.getId()
	const insertTimeStr = base.getTime()
	const logObj = {
		id: logId,
		type: 'db',
		source: sourceName,
		target: targetName,
		status: 0, // 进行中
		insertTime: insertTimeStr,
		extra: {},
	}

	// 1. 鉴权：生产环境下进行双通道校验 (Vercel Cron 校验 或 用户登录 Token 校验)
	const isProd = process.env.NODE_ENV === 'production'
	const authHeader = req.headers.authorization || req.headers.Authorization
	if (isProd) {
		let isAuthorized = false
		// 通道一：Vercel Cron 自动定时任务校验
		if (authHeader === `Bearer ${process.env.CRON_SECRET}`) {
			isAuthorized = true
		}
		// 通道二：系统已登录管理用户的 Token 校验 (支持 admin 管理端手动触发)
		if (!isAuthorized) {
			const isUserAuth = await checkAuth(req, resp)
			if (!isUserAuth) {
				await writeGateMark(logObj, GATE_AUTH_ID, '鉴权失败：缺少或错误的 CRON_SECRET / 登录令牌')
				return
			}
			isAuthorized = true
		}
	}

	console.log(`[备份引擎 V2] 启动。主库: [${sourceName}] -> 备份目标库: [${targetName}]`)

	// 2. 获取主库与备库的连接池
	const sourcePool = getPool(sourceName)
	const targetPool = getPool(targetName)

	if (!sourcePool || !targetPool) {
		await writeGateMark(
			logObj,
			GATE_POOL_ID,
			`连接池初始化失败（source[${sourceName}]=${!!sourcePool}，target[${targetName}]=${!!targetPool}），请检查环境变量配置`,
		)
		return base.respFailure({ msg: '数据库连接池初始化失败，请检查环境变量配置。' })
	}

	let targetClient = null
	let isCommitted = false

	try {
		// 3. 自动创建备份日志表 (双端幂等确保持久化)
		await sourcePool.query(LOG_TABLE_DDL)
		await targetPool.query(LOG_TABLE_DDL)

		// 4. 在主库中插入本次“进行中”状态的日志记录
		await upsert_backup_log_async(sourcePool, logObj)
		console.log(`[备份引擎 V2] 已在主库中登记初始日志: ${logId}`)

		// 5. 提取源库完整的 Catalog 元数据快照
		console.log('[备份引擎 V2] 正在扫描源库编目元数据（表、约束、索引、序列、视图、RLS、策略、触发器）...')
		const metadata = await fetch_catalog_metadata_async(sourcePool, sourceName)
		console.log(`[备份引擎 V2] 元数据解析就绪：${metadata.tables.length} 张业务表，${metadata.views.length} 个视图`)

		// 6. 从目标库连接池获取专用客户端，开启单事务
		targetClient = await targetPool.connect()
		await targetClient.query('BEGIN')
		console.log('[备份引擎 V2] 目标库单事务 BEGIN 开启成功')

		// 7. 清理目标库对象（视图优先，孤儿表清理，隔离保护 keepalive 与 backup）
		console.log('[备份引擎 V2] 正在清理目标库旧对象...')
		await clean_target_objects_async(targetClient, metadata.tables, targetName)

		// 8. 重建自定义 Enum 与 Sequence
		console.log('[备份引擎 V2] 正在重建序列与类型定义...')
		await rebuild_types_and_sequences_async(targetClient, metadata.enums, metadata.sequences, targetName)

		// 9. 重建轻量业务表结构（不带外键与索引，利于高速插入，并恢复 Identity 序列配置）
		console.log('[备份引擎 V2] 正在重建表结构...')
		await create_target_tables_async(targetClient, metadata.tables, metadata.tableMeta, metadata.sequences, targetName)

		// 10. 分批传输数据（保持数据类型保真）
		console.log('[备份引擎 V2] 正在分批迁移业务数据...')
		await copy_table_data_async(sourcePool, targetClient, metadata.tables, metadata.tableMeta, targetName)

		// 11. 重建约束（PK/UNIQUE/CHECK 优先，FK 次之）与额外索引
		console.log('[备份引擎 V2] 正在还原主键、唯一键、CHECK、外键与索引...')
		await rebuild_constraints_and_indexes_async(targetClient, metadata.tables, metadata.tableMeta, targetName)

		// 12. 校正序列与 Identity 当前位点
		console.log('[备份引擎 V2] 正在修正自增序列位点...')
		await reset_sequences_async(targetClient, metadata.sequences, metadata.tables, metadata.tableMeta, targetName)

		// 13. 重建表注释、RLS 状态、Policy 策略与触发器
		console.log('[备份引擎 V2] 正在还原 RLS 状态、策略、注释与触发器...')
		await rebuild_security_and_triggers_async(targetClient, metadata.tables, metadata.tableMeta, targetName)

		// 14. 按依赖顺序重建视图
		console.log('[备份引擎 V2] 正在按依赖拓扑重建视图...')
		await rebuild_views_async(targetClient, metadata.views, metadata.viewDependencies, targetName)

		// 15. 在事务内执行行数对账、视图核验与结构指纹比对
		console.log('[备份引擎 V2] 正在执行对账核验与结构指纹审计...')
		const validation = await validate_target_async(sourcePool, targetClient, metadata.tables, metadata, targetName)

		if (!validation.isOverallSuccess) {
			throw new Error('[backup][validation] 目标库数据对账或对象核验未通过，触发事务自动回滚')
		}

		// 16. 提交事务
		await targetClient.query('COMMIT')
		isCommitted = true
		console.log('[备份引擎 V2] 目标库全量镜像事务已安全 COMMIT 提交')

		const duration = `${Date.now() - startTime}ms`
		logObj.status = 1
		logObj.updateTime = base.getTime()
		logObj.extra = {
			duration,
			source: sourceName,
			target: targetName,
			tableCount: validation.tableCount,
			viewCount: validation.viewCount,
			policyCount: validation.policyCount,
			triggerCount: validation.triggerCount,
			warningCount: validation.warnings.length,
			warnings: validation.warnings,
			tables: validation.auditLog,
			views: validation.viewLog,
			message: '数据库应用单向全量灾备镜像及源/目标一致性核验已完成。',
		}

		// 双向持久化记录最终成功日志（提交后异常防误报处理）
		try {
			await upsert_backup_log_async(sourcePool, logObj)
			await upsert_backup_log_async(targetPool, logObj)
		} catch (logErr) {
			console.warn('[备份引擎 V2] 目标库镜像已提交成功，但双向记录成功日志失败:', logErr.message)
			logObj.extra.logWarning = `镜像已成功提交，但双写日志提示: ${logErr.message}`
		}

		return base.respSuccess({
			msg: '备份同步及源/目标一致性核验已完成。',
			data: logObj.extra,
		})
	} catch (error) {
		console.error('[备份引擎 V2] 执行异常:', error)

		// 关键防误判逻辑：若事务已提交成功，绝不能 ROLLBACK，亦不可错误标记为 backup failed
		if (isCommitted) {
			console.warn('[备份引擎 V2] 目标库镜像已完成 COMMIT 提交，错误发生在提交后收尾阶段，不可回滚亦不判定为灾备失败')
			logObj.extra.postCommitError = error.message
			return base.respSuccess({
				msg: '备份同步已成功提交，但收尾阶段存在提示。',
				data: logObj.extra,
			})
		}

		// 事务未提交时的真正失败回滚逻辑
		if (targetClient) {
			try {
				await targetClient.query('ROLLBACK')
				console.warn('[备份引擎 V2] 已执行目标库事务 ROLLBACK，未在目标库残留脏数据')
			} catch (rbErr) {
				console.error('[备份引擎 V2] 回滚失败:', rbErr.message)
			}
		}

		const duration = `${Date.now() - startTime}ms`
		logObj.status = 2
		logObj.updateTime = base.getTime()
		logObj.extra = {
			duration,
			source: sourceName,
			target: targetName,
			error: error.message,
			stack: error.originalStack || error.stack,
			message: '备份过程中遭遇崩溃中断，已原子回滚目标库。',
		}

		try {
			await upsert_backup_log_async(sourcePool, logObj)
			await upsert_backup_log_async(targetPool, logObj)
		} catch (dbErr) {
			console.error('[备份引擎 V2] 写入故障状态日志失败:', dbErr.message)
		}

		return base.respFailure({
			msg: `备份执行失败: ${error.message}`,
			details: logObj.extra,
		})
	} finally {
		if (targetClient) {
			targetClient.release()
		}
	}
}
