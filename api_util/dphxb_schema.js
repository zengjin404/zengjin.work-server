/**
 * 大炮轰小兵 - 对局结算数据校验与清洗器 (dphxb_schema)
 *
 * 核心安全与校验准则：
 *   1. 身份不信任前端：user_id 绝不从请求体读取，统一由服务端 verifyAuth 提取。
 *   2. 行棋轨迹轻量几何校验：
 *      - 坐标必须在 0~5 范围。
 *      - 普通移动必须且仅能在上下左右 4 个正交方向移动 1 格（大炮与小兵均不支持斜移）。
 *      - 炮击吃子仅大炮具备；且必须为上下左右正交方向跨越 2 格（dx=2,dy=0 或 dx=0,dy=2）。
 *      - 小兵严禁发起炮击吃子。
 *   3. 行棋序列自洽性校验：
 *      - 开局必须由大炮方先行（第 1 步为 cannon）。
 *      - 双方必须严格交替行动（cannon 与 soldier 轮流）。
 *      - 吃子事件步步核验：每发生一次 capture，存活小兵数必须精准减 1；move 则数量不变。
 *      - 最终步的小兵存活数必须与结算字段 soldiersRemaining 保持一致。
 *   4. 残局统计口径计算：
 *      - 自动识别对局行棋序列中首次进入“小兵剩余 <= 2”的步数（enteredEndgameAtPly）。
 *      - 计算进入残局后的持续半回合数（endgamePlies）与最低存活小兵数（minSoldiersRemaining）。
 *   5. 终局结果与原因自洽性校验：
 *      - all_captured: 必须为大炮获胜且小兵剩余为 0。
 *      - cannons_trapped: 必须为小兵获胜。
 *      - repetition / no_progress / step_limit: 必须为和棋 (draw)。
 *   6. 终局后悔棋替代机制：
 *      - 支持接收 supersededRequestId 标识被本局替代的历史终局记录。
 */

export class DphxbPayloadError extends Error {
	constructor(message) {
		super(message)
		this.name = 'DphxbPayloadError'
	}
}

const ALLOWED_MODES = new Set(['pve', 'pvp_local', 'pvp_online'])
const ALLOWED_WINNERS = new Set(['cannon', 'soldier', 'draw'])
const ALLOWED_SIDES = new Set(['cannon', 'soldier'])
const ALLOWED_DIFFICULTIES = new Set(['easy', 'normal', 'hard'])

/**
 * 校验坐标点 (0..5)
 */
function is_valid_coord(c) {
	return c && Number.isInteger(c.x) && c.x >= 0 && c.x <= 5 && Number.isInteger(c.y) && c.y >= 0 && c.y <= 5
}

/**
 * 校验并清洗每步行动数据 (轻量几何与动作规范校验)
 */
function sanitize_move(m, idx) {
	if (!m || typeof m !== 'object') {
		throw new DphxbPayloadError(`第 ${idx + 1} 步行棋数据格式不合法`)
	}
	if (!ALLOWED_SIDES.has(m.side)) {
		throw new DphxbPayloadError(`第 ${idx + 1} 步行动方不合法: ${m.side}`)
	}
	if (m.type !== 'move' && m.type !== 'capture') {
		throw new DphxbPayloadError(`第 ${idx + 1} 步行动类型不合法: ${m.type}`)
	}
	if (!is_valid_coord(m.from) || !is_valid_coord(m.to)) {
		throw new DphxbPayloadError(`第 ${idx + 1} 步坐标超出 6x6 棋盘范围`)
	}

	const dx = Math.abs(m.to.x - m.from.x)
	const dy = Math.abs(m.to.y - m.from.y)

	// 不能原地移动
	if (dx === 0 && dy === 0) {
		throw new DphxbPayloadError(`第 ${idx + 1} 步起点与终点重合`)
	}

	if (m.type === 'move') {
		// 普通移动：必须且仅能在上下左右正交方向移动 1 格
		const isOrthogonalOneStep = (dx === 1 && dy === 0) || (dx === 0 && dy === 1)
		if (!isOrthogonalOneStep) {
			throw new DphxbPayloadError(`第 ${idx + 1} 步普通移动非法：必须且仅能正交移动 1 步`)
		}
	} else if (m.type === 'capture') {
		// 炮击吃子：仅限大炮方
		if (m.side !== 'cannon') {
			throw new DphxbPayloadError(`第 ${idx + 1} 步非法：小兵方不能发起炮击吃子`)
		}
		// 炮击跨度必须为正交 2 格 (dx=2,dy=0 或 dx=0,dy=2)
		const isOrthogonalTwoStep = (dx === 2 && dy === 0) || (dx === 0 && dy === 2)
		if (!isOrthogonalTwoStep) {
			throw new DphxbPayloadError(`第 ${idx + 1} 步炮击非法：大炮炮击跨度必须且仅能为正交 2 格`)
		}
		if (!m.capturedPieceId) {
			throw new DphxbPayloadError(`第 ${idx + 1} 步炮击缺少被消灭棋子标识 (capturedPieceId)`)
		}
	}

	return {
		ply: Number.isInteger(m.ply) ? m.ply : idx + 1,
		side: m.side,
		type: m.type,
		from: { x: m.from.x, y: m.from.y, algebraic: m.from.algebraic || '' },
		to: { x: m.to.x, y: m.to.y, algebraic: m.to.algebraic || '' },
		capturedPieceId: m.capturedPieceId ? String(m.capturedPieceId) : null,
		soldiersRemaining: Number.isInteger(m.soldiersRemaining) ? m.soldiersRemaining : null,
		cannonsRemaining: Number.isInteger(m.cannonsRemaining) ? m.cannonsRemaining : 2,
		noProgressCount: Number.isInteger(m.noProgressCount) ? m.noProgressCount : 0,
	}
}

/**
 * 校验并清洗终局结算入参
 * @param {object} raw 客户端原始请求体
 * @returns {object} 清洗后的标准化对象
 */
export function sanitize_game_payload(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new DphxbPayloadError('请求体必须是 JSON 对象')
	}

	// 1. 幂等标识
	const requestId = typeof raw.requestId === 'string' ? raw.requestId.trim() : ''
	if (!requestId || requestId.length > 64) {
		throw new DphxbPayloadError('requestId 必须为 1~64 位的非空字符串')
	}

	// 可选替代原终局的标识 (终局后悔棋继续对局)
	const supersededRequestId =
		typeof raw.supersededRequestId === 'string' && raw.supersededRequestId.trim() ? raw.supersededRequestId.trim().slice(0, 64) : null

	// 2. 对局模式（兼容历史值 pvp -> pvp_local）
	let mode = typeof raw.mode === 'string' ? raw.mode.trim() : ''
	if (mode === 'pvp') mode = 'pvp_local'
	if (!ALLOWED_MODES.has(mode)) {
		throw new DphxbPayloadError(`不支持的对局模式: ${raw.mode}`)
	}

	// 3. 胜方校验
	const winner = typeof raw.winner === 'string' ? raw.winner.trim() : ''
	if (!ALLOWED_WINNERS.has(winner)) {
		throw new DphxbPayloadError(`未知的胜负结果: ${raw.winner}`)
	}

	// 4. 终局原因
	const endReason = typeof raw.endReason === 'string' ? raw.endReason.trim() : ''
	if (!endReason || endReason.length > 50) {
		throw new DphxbPayloadError('endReason 不能为空且长度不能超过 50 个字符')
	}
	const endReasonText = typeof raw.endReasonText === 'string' ? raw.endReasonText.trim().slice(0, 100) : ''

	// 5. 步数与剩余棋子数
	const totalPlies = Number(raw.totalPlies)
	if (!Number.isInteger(totalPlies) || totalPlies < 1 || totalPlies > 600) {
		throw new DphxbPayloadError('totalPlies 必须为 1~600 之间的整数')
	}

	const cannonsRemaining = Number(raw.cannonsRemaining)
	if (!Number.isInteger(cannonsRemaining) || cannonsRemaining < 0 || cannonsRemaining > 2) {
		throw new DphxbPayloadError('cannonsRemaining 必须为 0~2 之间的整数')
	}

	const soldiersRemaining = Number(raw.soldiersRemaining)
	if (!Number.isInteger(soldiersRemaining) || soldiersRemaining < 0 || soldiersRemaining > 18) {
		throw new DphxbPayloadError('soldiersRemaining 必须为 0~18 之间的整数')
	}

	// 6. 核心胜负与终局原因逻辑自洽性校验
	if (winner === 'cannon' && soldiersRemaining > 0) {
		throw new DphxbPayloadError('大炮获胜时剩余小兵数必须为 0')
	}
	if (endReason === 'all_captured') {
		if (winner !== 'cannon' || soldiersRemaining !== 0) {
			throw new DphxbPayloadError('全歼小兵终局原因必须对应大炮方获胜且小兵数归零')
		}
	}
	if (endReason === 'cannons_trapped' && winner !== 'soldier') {
		throw new DphxbPayloadError('双炮被困绝杀时胜方必须为小兵')
	}
	if (['repetition', 'no_progress', 'step_limit'].includes(endReason) && winner !== 'draw') {
		throw new DphxbPayloadError(`和棋终局原因 (${endReason}) 对应胜方必须为 draw`)
	}

	// 7. 参与者与 AI 信息
	let playerSide = null
	if (raw.playerSide && ALLOWED_SIDES.has(raw.playerSide)) {
		playerSide = raw.playerSide
	}

	let aiDifficulty = null
	if (mode === 'pve' && raw.aiDifficulty && ALLOWED_DIFFICULTIES.has(raw.aiDifficulty)) {
		aiDifficulty = raw.aiDifficulty
	}

	let participants = []
	if (Array.isArray(raw.participants)) {
		participants = raw.participants.slice(0, 4).map(p => ({
			role: typeof p.role === 'string' ? p.role.slice(0, 20) : '',
			type: typeof p.type === 'string' ? p.type.slice(0, 20) : '',
			userId: typeof p.userId === 'string' ? p.userId.slice(0, 40) : undefined,
			difficulty: typeof p.difficulty === 'string' ? p.difficulty.slice(0, 20) : undefined,
		}))
	} else if (mode === 'pve') {
		const humanSide = playerSide || 'cannon'
		const aiSide = humanSide === 'cannon' ? 'soldier' : 'cannon'
		participants = [
			{ role: humanSide, type: 'human' },
			{ role: aiSide, type: 'ai', difficulty: aiDifficulty || 'normal' },
		]
	} else if (mode === 'pvp_local') {
		participants = [
			{ role: 'cannon', type: 'human_local' },
			{ role: 'soldier', type: 'human_local' },
		]
	}

	// 8. 完整行棋数据与轨迹连续性校验 (gameData)
	const rawGameData = raw.gameData && typeof raw.gameData === 'object' ? raw.gameData : {}
	const rawMoves = Array.isArray(rawGameData.moves) ? rawGameData.moves : []
	if (rawMoves.length > 600) {
		throw new DphxbPayloadError('对局行棋步数超出上限 (最大 600 步)')
	}

	const sanitizedMoves = rawMoves.map((m, i) => sanitize_move(m, i))

	// 轨迹序列自洽性校验
	let expectedSoldiers = 18
	let enteredEndgameAtPly = null
	let minSoldiers = 18

	if (sanitizedMoves.length > 0) {
		// 行棋总步数与外部声明步数需一致
		if (sanitizedMoves.length !== totalPlies) {
			throw new DphxbPayloadError(`行棋记录步数 (${sanitizedMoves.length}) 与声明总步数 (${totalPlies}) 不一致`)
		}

		// 开局必须大炮先行
		if (sanitizedMoves[0].side !== 'cannon') {
			throw new DphxbPayloadError('对局第 1 步必须由大炮方先行')
		}

		for (let i = 0; i < sanitizedMoves.length; i++) {
			const m = sanitizedMoves[i]

			// 检查交替行动
			if (i > 0) {
				const prev = sanitizedMoves[i - 1]
				if (m.side === prev.side) {
					throw new DphxbPayloadError(`第 ${i + 1} 步行动方 (${m.side}) 与上一步重复，未遵守交替行棋规则`)
				}
			}

			// 吃子与存活兵数核验
			if (m.type === 'capture') {
				expectedSoldiers--
			}

			if (expectedSoldiers < 0) {
				throw new DphxbPayloadError(`第 ${i + 1} 步被吃子后小兵数小于 0，属于非法棋谱`)
			}

			if (m.soldiersRemaining !== null && m.soldiersRemaining !== expectedSoldiers) {
				throw new DphxbPayloadError(`第 ${i + 1} 步记录的小兵存活数 (${m.soldiersRemaining}) 与推演期望 (${expectedSoldiers}) 不符`)
			}

			if (expectedSoldiers < minSoldiers) {
				minSoldiers = expectedSoldiers
			}

			// 记录首次进入 <= 2 残局阶段的步数
			if (enteredEndgameAtPly === null && expectedSoldiers <= 2) {
				enteredEndgameAtPly = m.ply || i + 1
			}
		}

		// 终步存活兵数必须与结算字段 soldiersRemaining 保持一致
		if (expectedSoldiers !== soldiersRemaining) {
			throw new DphxbPayloadError(`整盘走棋推演的最终小兵数 (${expectedSoldiers}) 与终局声明 (${soldiersRemaining}) 不一致`)
		}
	} else {
		// 若无详细行棋序列，根据终局剩余兵数估算
		minSoldiers = soldiersRemaining
		if (soldiersRemaining <= 2) {
			enteredEndgameAtPly = totalPlies
		}
	}

	// 计算残局持续步数 (若进入残局，从进入步算至终局)
	const endgamePlies = enteredEndgameAtPly !== null ? totalPlies - enteredEndgameAtPly + 1 : 0

	const gameData = {
		initialPieces: Array.isArray(rawGameData.initialPieces) ? rawGameData.initialPieces.slice(0, 20) : [],
		finalPieces: Array.isArray(rawGameData.finalPieces) ? rawGameData.finalPieces.slice(0, 20) : [],
		moves: sanitizedMoves,
	}

	// 9. 时间戳格式化
	const startedAt = typeof raw.startedAt === 'string' && raw.startedAt.trim() ? raw.startedAt.trim().slice(0, 30) : null
	const endedAt = typeof raw.endedAt === 'string' && raw.endedAt.trim() ? raw.endedAt.trim().slice(0, 30) : null

	return {
		requestId,
		supersededRequestId,
		mode,
		ruleVersion: typeof raw.ruleVersion === 'string' && raw.ruleVersion.trim() ? raw.ruleVersion.trim().slice(0, 20) : '1.0.0',
		winner,
		endReason,
		endReasonText,
		totalPlies,
		cannonsRemaining,
		soldiersRemaining,
		playerSide,
		aiDifficulty,
		isNormalFinish: raw.isNormalFinish !== false,
		enteredEndgameAtPly,
		endgamePlies,
		minSoldiersRemaining: minSoldiers,
		participants,
		gameData,
		startedAt,
		endedAt,
	}
}
