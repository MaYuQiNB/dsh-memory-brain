/**
 * Host half of the `dsh-memory-brain` bundle — 记忆脑 / Memory Brain.
 *
 * A deliberately small imitation of human memory on top of the Harness session
 * log:
 *   - Every completed conversation turn of a task (Session) is encoded as an
 *     episodic memory with auto-extracted tags (`session/event` capture).
 *   - On first activation the plugin can backfill recent history through
 *     `sessionQuery`, so the memory network starts populated instead of empty.
 *     Backfilled turns are "recalled now": their real date becomes `createdAt`
 *     while the forgetting clock starts at capture time.
 *   - Retention decays on the Ebbinghaus curve (see `lib/memory-engine.js`);
 *     periodic "sleep" consolidates similar episodes into semantic memories and
 *     purges what decayed past the purge threshold.
 *   - The panel talks to `/memory-brain/*`, the agent gets the same operations
 *     through the `brain_memory` tool, and a system-prompt section tells the
 *     model the memory bank exists.
 *
 * Design notes:
 *   - Plugin-owned data lives in `$DSH_HOME/memory-brain.json`, written
 *     atomically (temp file + rename) through a debounced saver.
 *   - Every mutation bumps `revision` and returns the whole derived state, so
 *     the panel never reconciles partial updates.
 *   - The store is framework-free (`lib/memory-store.js`); this file only wires
 *     it to Cordis services, the Session log and the web routes.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { MemoryError, MemoryStore, collectTurns, extractText } from './lib/memory-store.js'

/** Services required before routes, capture and the tool can be mounted. */
export const inject = ['webServer', 'connection', 'tools', 'systemPrompt']

/** Route prefix; the Client half builds every request path from it. */
export const ROUTE_PREFIX = '/memory-brain'

const TOOL_NAME = 'brain_memory'
const MAX_BODY_BYTES = 256 * 1024

/** History backfill: newest sessions first, bounded so activation stays quick. */
const BACKFILL_SESSIONS = 40
const BACKFILL_TURNS_PER_SESSION = 10
const BACKFILL_MEMORY_CEILING = 600

/**
 * QQ bridge sessions live under their own working directory; their memories
 * carry the `QQ` tag and `source: 'qq'` so the panel and the agent can tell
 * QQ chat apart from ordinary DSH tasks.
 */
const QQ_CWD_HINT = 'qq-bridge'
const QQ_SOURCE = 'qq'
const QQ_SOURCE_TAG = 'qq'
/** QQ history is one long session per conversation: scan more turns, fewer sessions. */
const QQ_BACKFILL_SESSIONS = 8
const QQ_BACKFILL_TURNS_PER_SESSION = 20
const QQ_FALLBACK_TITLE = 'QQ 聊天'

/** How often the periodic "sleep" check runs; actual cadence comes from settings. */
const SLEEP_CHECK_MS = 10 * 60 * 1000
/** First automatic history scan delay after activation. */
const AUTO_CAPTURE_DELAY_MS = 4000

/**
 * One request-level failure with an HTTP status and a stable code.
 */
class BrainError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} code Stable machine-readable failure key.
   * @param {string} message Human-readable reason.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'BrainError'
    this.status = status
    this.code = code
  }
}

/** @returns {string} Absolute path of the memory bank file. */
function storePath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'memory-brain.json')
}

/**
 * Whether a live session or a session header belongs to the QQ bridge. The
 * bridge creates its DSH sessions with a dedicated `cwd` (its agents directory),
 * so the path is the stable signal — the session title is user-facing text and
 * may be missing.
 * @param {any} headerOrSession Session, or a session header object.
 * @returns {boolean} True for QQ bridge sessions.
 */
function isQqSession(headerOrSession) {
  try {
    if (headerOrSession === null || typeof headerOrSession !== 'object') return false
    const header = headerOrSession.header !== undefined ? headerOrSession.header : headerOrSession
    if (header === null || typeof header !== 'object') return false
    const cwd = typeof header.cwd === 'string' ? header.cwd.toLowerCase().replace(/\\/g, '/') : ''
    return cwd.includes(QQ_CWD_HINT)
  } catch {
    return false
  }
}

/**
 * @param {string} source Memory source ('qq' or '').
 * @returns {string[]} Source tags for the memory record.
 */
function sourceTagsOf(source) {
  return source === QQ_SOURCE ? [QQ_SOURCE_TAG] : []
}

/**
 * QQ bridge turns are full of MCP QQ tool calls; collapse those into the single
 * `qq` tag instead of leaking long `mcp__snowluma__*` names into the tag cloud.
 * @param {readonly string[]} toolNames Tool names of the turn.
 * @param {string} source Memory source.
 * @returns {string[]} Tool names for tag extraction.
 */
function toolNamesForSource(toolNames, source) {
  if (!Array.isArray(toolNames)) return []
  if (source !== QQ_SOURCE) return [...toolNames]
  return toolNames.map((name) => (/^mcp__snowluma/i.test(name) ? QQ_SOURCE_TAG : name))
}

/**
 * Keep QQ session labels readable: the bridge seeds the auto session title from
 * its wake scaffolding ("【当前时间】…"), which makes a poor memory-network
 * label. Anything that still looks like a short human-readable title is kept.
 * @param {string} rawTitle Candidate title.
 * @param {string} source Memory source.
 * @returns {string} Session label for the memory record.
 */
function titleForSource(rawTitle, source) {
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  if (source !== QQ_SOURCE) return title
  if (title !== '' && !title.startsWith('【') && title.length <= 24) return title
  return QQ_FALLBACK_TITLE
}

/**
 * Mount the memory store, the live capture, the panel API, the agent tool, the
 * prompt section and the periodic consolidation.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 */
export function apply(ctx) {
  const store = new MemoryStore({
    save: async (payload) => {
      const path = storePath()
      try {
        await mkdir(dirname(path), { recursive: true })
        const temporary = `${path}.${process.pid}.tmp`
        await writeFile(temporary, JSON.stringify(payload))
        await rename(temporary, path)
      } catch (error) {
        // A failed write must not take the plugin or the request down: the
        // in-memory bank stays authoritative for this process and the next
        // mutation rewrites the file.
        ctx.logger?.warn?.('dsh-memory-brain: could not persist the memory bank')
        ctx.logger?.warn?.(error)
      }
    },
  })

  /** Whether the persisted bank has been adopted. */
  let loaded = false
  /** Events that arrived while the bank was loading. */
  /** @type {Array<[any, any]>} */
  const pendingEvents = []
  /** @type {Promise<void>} Resolves once loading finished (never rejects). */
  const ready = (async () => {
    try {
      const text = await readFile(storePath(), 'utf8')
      store.load(JSON.parse(text))
    } catch (error) {
      if (error === null || typeof error !== 'object' || /** @type {any} */ (error).code !== 'ENOENT') {
        ctx.logger?.warn?.('dsh-memory-brain: could not read the saved memory bank, starting fresh')
        ctx.logger?.warn?.(error)
      }
    } finally {
      loaded = true
      const backlog = pendingEvents.splice(0, pendingEvents.length)
      for (const [session, event] of backlog) handleSessionEvent(session, event)
    }
  })()

  // ---------------------------------------------------------------------
  // Live capture — one conversation turn becomes one episodic memory
  // ---------------------------------------------------------------------

  /** @type {Map<string, { turn: number, userTexts: string[], assistantTexts: string[], toolNames: string[], startedAt: number }>} */
  const turnBuffers = new Map()

  /**
   * Read the task title (Session title) for a live session, when the profile
   * has the session-title service.
   * @param {any} session Live Session.
   * @returns {string} Title, or ''.
   */
  function sessionTitleOf(session) {
    try {
      const titles = ctx.get('sessionTitle')
      const snapshot = titles !== null && typeof titles === 'object' ? titles.get(session) : undefined
      if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.title === 'string') return snapshot.title.trim()
    } catch {
      // The optional service is absent or refused the read; the fallback below
      // derives a title from the first prompt instead.
    }
    return ''
  }

  /**
   * Consume one durable session event.
   * @param {any} session Session that committed the event.
   * @param {any} event Durable session event.
   */
  function handleSessionEvent(session, event) {
    if (event === null || typeof event !== 'object') return
    if (session === null || typeof session !== 'object') return
    const header = session.header
    if (header !== null && typeof header === 'object' && header.origin === 'subagent') return
    if (store.settings.autoCapture !== true) return
    const sessionId = String(session.id ?? '')
    if (sessionId === '') return
    const type = typeof event.type === 'string' ? event.type : ''
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}

    if (type === 'turn/start') {
      turnBuffers.set(sessionId, {
        turn: Number.isFinite(data.turn) ? data.turn : 0,
        userTexts: [],
        assistantTexts: [],
        toolNames: [],
        startedAt: Number.isFinite(event.time) ? event.time : Date.now(),
      })
      return
    }

    const buffer = turnBuffers.get(sessionId)
    if (type === 'user/message') {
      if (data.source !== null && typeof data.source === 'object' && typeof data.source.kind === 'string' && data.source.kind !== 'user') return
      if (buffer === undefined) return
      const text = extractText(data.message ?? data)
      if (text !== '') buffer.userTexts.push(text)
      return
    }
    if (type === 'assistant/message') {
      if (buffer === undefined) return
      const text = extractText(data.message ?? data)
      if (text !== '') buffer.assistantTexts.push(text)
      return
    }
    if (type === 'tool/call') {
      if (buffer === undefined) return
      if (typeof data.name === 'string' && data.name !== '') buffer.toolNames.push(data.name)
      return
    }
    if (type !== 'turn/end') return

    const active = buffer ?? {
      turn: Number.isFinite(data.turn) ? data.turn : 0,
      userTexts: [],
      assistantTexts: [],
      toolNames: [],
      startedAt: Number.isFinite(event.time) ? event.time : Date.now(),
    }
    turnBuffers.delete(sessionId)
    const source = isQqSession(session) ? QQ_SOURCE : ''
    const rawTitle = sessionTitleOf(session) !== ''
      ? sessionTitleOf(session)
      : (active.userTexts[0] ?? '').replace(/\s+/g, ' ').slice(0, 40)
    const title = titleForSource(rawTitle, source)
    store.commitLight(() => store.ingestTurn({
      sessionId,
      sessionTitle: title,
      turn: Number.isFinite(data.turn) ? data.turn : active.turn,
      userTexts: active.userTexts,
      assistantTexts: active.assistantTexts,
      toolNames: toolNamesForSource(active.toolNames, source),
      startedAt: active.startedAt,
      encodedAt: Date.now(),
      seq: Number.isFinite(event.seq) ? event.seq : 0,
      source,
      sourceTags: sourceTagsOf(source),
    }))
  }

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (!loaded) {
      if (pendingEvents.length < 4000) pendingEvents.push([session, event])
      return
    }
    try {
      handleSessionEvent(session, event)
    } catch (error) {
      ctx.logger?.warn?.('dsh-memory-brain: capture failed for one session event')
      ctx.logger?.warn?.(error)
    }
  }), 'dsh-memory-brain: capture')

  // ---------------------------------------------------------------------
  // History backfill — recall old tasks into the memory network
  // ---------------------------------------------------------------------

  /** @type {Promise<number> | null} In-flight backfill. */
  let captureJob = null

  /**
   * Scan recent historical sessions and encode their last turns. Idempotent:
   * a turn that is already a memory is skipped. Concurrent callers share one
   * job.
   * @returns {Promise<number>} Number of memories added.
   */
  function captureHistory() {
    if (captureJob !== null) return captureJob
    captureJob = (async () => {
      await ready
      const query = ctx.get('sessionQuery')
      if (query === null || typeof query !== 'object' || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
        throw new BrainError(503, 'query-unavailable', '当前 profile 没有可用的会话查询服务，无法扫描历史会话。')
      }
      let records
      try {
        records = await query.listSessions()
      } catch (error) {
        throw new BrainError(503, 'query-failed', `读取会话列表失败：${messageOf(error)}`)
      }
      const ordered = (Array.isArray(records) ? records : [])
        .filter((record) => record !== null && typeof record === 'object' && record.header !== null && typeof record.header === 'object')
        .filter((record) => record.header.origin !== 'subagent')
        .sort((a, b) => (Number(b.header.createdAt) || 0) - (Number(a.header.createdAt) || 0))
      // QQ bridge conversations first: the bridge keeps one long session per QQ
      // chat, so those would otherwise fall outside the newest-sessions window.
      const qqSessions = ordered.filter((record) => isQqSession(record.header)).slice(0, QQ_BACKFILL_SESSIONS)
      const otherSessions = ordered.filter((record) => !isQqSession(record.header)).slice(0, BACKFILL_SESSIONS)
      /** @type {Array<{ record: any, source: string, maxTurns: number }>} */
      const queue = [
        ...qqSessions.map((record) => ({ record, source: QQ_SOURCE, maxTurns: QQ_BACKFILL_TURNS_PER_SESSION })),
        ...otherSessions.map((record) => ({ record, source: '', maxTurns: BACKFILL_TURNS_PER_SESSION })),
      ]
      const encodedAt = Date.now()
      let added = 0
      for (const item of queue) {
        if (store.memories.length >= BACKFILL_MEMORY_CEILING) break
        const record = item.record
        const source = item.source
        const sessionId = String(record.header.id ?? '')
        if (sessionId === '') continue
        let snapshot
        try {
          snapshot = await query.readSession(sessionId)
        } catch {
          continue
        }
        if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.events)) continue
        const { turns, title } = collectTurns(snapshot.events)
        const fallbackTitle = (() => {
          for (const turn of turns) {
            const text = (turn.userTexts[0] ?? '').replace(/\s+/g, ' ').trim()
            if (text !== '') return text.slice(0, 40)
          }
          return ''
        })()
        const sessionTitle = titleForSource(
          title !== '' ? title : fallbackTitle,
          source,
        )
        const sourceTags = sourceTagsOf(source)
        for (const turn of turns.slice(-item.maxTurns)) {
          if (store.memories.length >= BACKFILL_MEMORY_CEILING) break
          const encoded = store.commitLight(() => store.ingestTurn({
            sessionId,
            sessionTitle,
            turn: turn.turn,
            userTexts: turn.userTexts,
            assistantTexts: turn.assistantTexts,
            toolNames: toolNamesForSource(turn.toolNames, source),
            startedAt: turn.startedAt,
            encodedAt,
            seq: 0,
            source,
            sourceTags,
          }))
          if (encoded !== null) added += 1
        }
      }
      await store.flush()
      return added
    })().finally(() => {
      captureJob = null
    })
    return captureJob
  }

  // First activation: fill the bank from recent history so the network shows
  // real tasks instead of an empty canvas. Also runs when no QQ memory exists
  // yet, so a QQ bridge that was already chatting before this plugin activation
  // gets backfilled without wiping the bank. Deferred so the panel and routes
  // are live first.
  let autoCaptureTimer = null
  ctx.effect(() => {
    void ready.then(() => {
      if (store.settings.autoCapture !== true) return
      const hasQqMemory = store.memories.some((memory) => memory.source === 'qq')
      if (store.memories.length > 0 && hasQqMemory) return
      autoCaptureTimer = setTimeout(() => {
        void captureHistory().catch((error) => {
          ctx.logger?.info?.('dsh-memory-brain: automatic history scan skipped')
          ctx.logger?.warn?.(error)
        })
      }, AUTO_CAPTURE_DELAY_MS)
      if (typeof autoCaptureTimer?.unref === 'function') autoCaptureTimer.unref()
    })
    return () => {
      if (autoCaptureTimer !== null) clearTimeout(autoCaptureTimer)
      autoCaptureTimer = null
    }
  }, 'dsh-memory-brain: initial capture')

  // ---------------------------------------------------------------------
  // Periodic consolidation ("sleep")
  // ---------------------------------------------------------------------

  let sleepTimer = null
  ctx.effect(() => {
    sleepTimer = setInterval(() => {
      if (!loaded || store.memories.length === 0) return
      const interval = Math.max(1, store.settings.consolidateEveryHours) * 60 * 60 * 1000
      if (Date.now() - store.lastSleepAt < interval) return
      try {
        const result = store.commitLight(() => store.sleep(Date.now()))
        void store.flush()
        ctx.logger?.info?.(`dsh-memory-brain: sleep — consolidated ${result.marked} episodes into ${result.consolidated} semantic memories, purged ${result.purged}`)
      } catch (error) {
        ctx.logger?.warn?.('dsh-memory-brain: sleep failed')
        ctx.logger?.warn?.(error)
      }
    }, SLEEP_CHECK_MS)
    if (typeof sleepTimer?.unref === 'function') sleepTimer.unref()
    return () => {
      if (sleepTimer !== null) clearInterval(sleepTimer)
      sleepTimer = null
      store.dispose()
    }
  }, 'dsh-memory-brain: sleep timer')

  // ---------------------------------------------------------------------
  // HTTP API — the panel's only data channel
  // ---------------------------------------------------------------------

  /**
   * Dispatch one route action against the store.
   * @param {string} action Action key from the route table.
   * @param {Record<string, any>} body Parsed JSON body (empty for GET).
   * @returns {Promise<Record<string, any>>} Response payload.
   */
  async function dispatch(action, body) {
    await ready
    switch (action) {
      case 'state':
        return { ok: true, state: store.snapshot() }
      case 'tag/add': {
        const { state } = await store.commitNow(() => store.addTag(requireId(body, 'id'), body.tag))
        return { ok: true, state }
      }
      case 'tag/remove': {
        const { state } = await store.commitNow(() => store.removeTag(requireId(body, 'id'), body.tag))
        return { ok: true, state }
      }
      case 'rehearse': {
        const { state } = await store.commitNow(() => store.rehearse(requireId(body, 'id')))
        return { ok: true, state }
      }
      case 'forget': {
        const { state } = await store.commitNow(() => store.forget(requireId(body, 'id'), body.hard === true))
        return { ok: true, state }
      }
      case 'restore': {
        const { state } = await store.commitNow(() => store.restore(requireId(body, 'id')))
        return { ok: true, state }
      }
      case 'pin': {
        const { state } = await store.commitNow(() => store.pin(requireId(body, 'id'), body.pinned === true))
        return { ok: true, state }
      }
      case 'sleep': {
        const result = store.commitLight(() => store.sleep(Date.now()))
        await store.flush()
        return { ok: true, state: store.snapshot(), result }
      }
      case 'capture': {
        const added = await captureHistory()
        return { ok: true, state: store.snapshot(), added }
      }
      case 'settings': {
        const { state } = await store.commitNow(() => store.updateSettings(body))
        return { ok: true, state }
      }
      case 'purge': {
        const removed = store.commitLight(() => store.purge())
        await store.flush()
        return { ok: true, state: store.snapshot(), removed }
      }
      case 'reset': {
        store.commitLight(() => store.reset())
        await store.flush()
        return { ok: true, state: store.snapshot() }
      }
      default:
        throw new BrainError(404, 'unknown-action', `未知 action：${action}`)
    }
  }

  /** @type {Array<{ action: string, method: 'GET'|'POST', suffix: string }>} */
  const routeTable = [
    { action: 'state', method: 'GET', suffix: '/state' },
    { action: 'tag/add', method: 'POST', suffix: '/tag/add' },
    { action: 'tag/remove', method: 'POST', suffix: '/tag/remove' },
    { action: 'rehearse', method: 'POST', suffix: '/rehearse' },
    { action: 'forget', method: 'POST', suffix: '/forget' },
    { action: 'restore', method: 'POST', suffix: '/restore' },
    { action: 'pin', method: 'POST', suffix: '/pin' },
    { action: 'sleep', method: 'POST', suffix: '/sleep' },
    { action: 'capture', method: 'POST', suffix: '/capture' },
    { action: 'settings', method: 'POST', suffix: '/settings' },
    { action: 'purge', method: 'POST', suffix: '/purge' },
    { action: 'reset', method: 'POST', suffix: '/reset' },
  ]

  ctx.effect(() => {
    const disposers = routeTable.map(({ action, method, suffix }) => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}${suffix}`,
      handler: (req, res) => {
        void handleRoute(req, res, action, method)
      },
    }))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-memory-brain: routes')

  /**
   * One HTTP request: authenticate, read the JSON body, dispatch, answer.
   * @param {import('node:http').IncomingMessage} req Request.
   * @param {import('node:http').ServerResponse} res Response.
   * @param {string} action Route action.
   * @param {'GET'|'POST'} method Expected HTTP method.
   */
  async function handleRoute(req, res, action, method) {
    try {
      // Reuse the Connection fence instead of re-deriving trusted authorities.
      const rejection = ctx.connection.requestRejection({ headers: req.headers })
      if (rejection !== undefined) throw new BrainError(rejection, 'unauthorized', '请求未通过本机连接认证。')
      if (req.method !== method) throw new BrainError(405, 'method-not-allowed', `仅支持 ${method} 请求。`)
      /** @type {Record<string, any>} */
      let body = {}
      if (method === 'POST') {
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
        if (!contentType.startsWith('application/json')) throw new BrainError(415, 'json-required', '请求必须是 application/json。')
        let parsed
        try {
          parsed = JSON.parse(await readJsonBody(req, MAX_BODY_BYTES))
        } catch (error) {
          if (error instanceof BrainError) throw error
          throw new BrainError(400, 'invalid-json', '请求内容不是合法的 JSON。')
        }
        body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      }
      writeJson(res, 200, await dispatch(action, body))
    } catch (error) {
      const status = error instanceof BrainError ? error.status : (error instanceof MemoryError ? error.status : 500)
      const code = error instanceof BrainError ? error.code : (error instanceof MemoryError ? error.code : 'internal')
      const message = messageOf(error)
      if (!(error instanceof BrainError) && !(error instanceof MemoryError)) {
        ctx.logger?.warn?.(`dsh-memory-brain: ${action} failed`)
        ctx.logger?.warn?.(error)
      }
      writeJson(res, status, { ok: false, error: { code, message } })
    }
  }

  // ---------------------------------------------------------------------
  // Agent tool — the same operations, second caller
  // ---------------------------------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: TOOL_NAME,
    description: [
      '记忆脑（Memory Brain）：一个模仿人脑的长期记忆库，跨任务保存你与用户的对话记忆。',
      '每轮对话结束后，插件会自动把它编码成一条带标签的「情节记忆」；记忆会随时间按遗忘曲线衰减，',
      '反复被想起（rehearse）会变牢固，巩固睡眠会把相似情节合并成「语义记忆」。',
      'action 取值：',
      '- state：看记忆库统计（先用它了解记忆库状态）。',
      '- recall：按关键词/标签/任务检索还没遗忘的记忆，参数 query（关键词）、tag（标签）、sessionId、limit（默认 8）。检索本身会强化被想起的记忆。',
      '- remember：主动记住一条重要事实，参数 text，可选 tags（字符串数组）。',
      '- tag / untag：给一条记忆加/删标签，参数 id、tag。',
      '- rehearse：唤醒/强化一条记忆，参数 id。',
      '- forget：遗忘一条记忆，参数 id，可选 hard=true 彻底删除。',
      '- restore：恢复被遗忘的记忆，参数 id。',
      '- pin：固定/取消固定长期记忆，参数 id、pinned（布尔）。',
      '- sleep：立刻做一次巩固（合并语义记忆 + 清理彻底衰减的记忆）。',
      '- capture：扫描历史任务并补记记忆（首次安装后可用）。',
      '- settings：手动修改记忆设置——forgetAfterDays（遗忘时间，1–60 天，默认 7）、autoCapture（布尔）、maxMemories（100–2000）、consolidateEveryHours（1–24）。用户说「把遗忘时间改成 X 天」时用它。',
      'QQ 聊天也会被自动捕获：通过 QQ 桥接进行的对话记忆带「QQ」标签（source=qq），可以用 recall 的 tag="QQ" 或 sessionId 检索；它们在记忆网里作为独立的「任务」分组出现。',
      '记忆 id 形如 ep-xxxx，只能从 state/recall 的返回里拿，不要自己编。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['state', 'recall', 'remember', 'tag', 'untag', 'rehearse', 'forget', 'restore', 'pin', 'sleep', 'capture', 'settings'],
          description: '要执行的操作。',
        },
        id: { type: 'string', description: 'tag/untag/rehearse/forget/restore/pin 的目标记忆 id。' },
        tag: { type: 'string', description: 'tag/untag：标签文本；recall：按标签筛选。' },
        query: { type: 'string', description: 'recall：关键词（可空格分隔多个词）。' },
        sessionId: { type: 'string', description: 'recall：只看某个任务（会话）的记忆。' },
        limit: { type: 'number', description: 'recall：最多返回几条（默认 8，最多 30）。' },
        text: { type: 'string', description: 'remember：要记住的内容。' },
        tags: { type: 'array', items: { type: 'string' }, description: 'remember：可选自定义标签。' },
        hard: { type: 'boolean', description: 'forget：true = 彻底删除，不留幽灵。' },
        pinned: { type: 'boolean', description: 'pin：true 固定为长期记忆，false 取消固定。' },
        forgetAfterDays: { type: 'number', description: 'settings：遗忘时间（天，1–60，默认 7）。' },
        autoCapture: { type: 'boolean', description: 'settings：是否自动捕获新对话。' },
        maxMemories: { type: 'number', description: 'settings：记忆总量上限（100–2000）。' },
        consolidateEveryHours: { type: 'number', description: 'settings：自动巩固间隔（小时，1–24）。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderToolText(value) }],
    },
    isConcurrencySafe: () => false,
    execute: async (rawArgs, exec) => {
      await ready
      const args = rawArgs !== null && typeof rawArgs === 'object' ? /** @type {Record<string, any>} */ (rawArgs) : {}
      const action = typeof args.action === 'string' ? args.action : ''
      switch (action) {
        case 'state': {
          const summary = store.summary()
          const settings = store.publicSettings()
          return { ok: true, text: renderStatsText(summary, settings), stats: summary, settings }
        }
        case 'recall': {
          const query = typeof args.query === 'string' ? args.query : ''
          const tag = typeof args.tag === 'string' ? args.tag : ''
          const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
          const limit = Number.isFinite(args.limit) ? args.limit : 8
          const results = store.recall({ query, tag, sessionId, limit })
          if (results.length > 0) {
            store.commitLight(() => store.rehearseMany(results.map((memory) => memory.id)))
            void store.flush()
          }
          return { ok: true, text: renderRecallText(results, { query, tag }), memories: results, count: results.length }
        }
        case 'remember': {
          const { value } = await store.commitNow(() => store.remember({
            text: typeof args.text === 'string' ? args.text : '',
            tags: Array.isArray(args.tags) ? args.tags : [],
            sessionId: exec !== null && exec !== undefined && exec.agent !== undefined ? String(exec.agent.id ?? '') : '',
            sessionTitle: '',
          }))
          return { ok: true, text: `已记住一条长期记忆 ${value.id}（标签：${value.tags.join('、') || '无'}）。`, id: value.id, tags: value.tags }
        }
        case 'tag': {
          const { value } = await store.commitNow(() => store.addTag(args.id, args.tag))
          return { ok: true, text: `已给 ${value.id} 加上标签「${value.tags[0] ?? ''}」，现在是：${value.tags.join('、')}。`, id: value.id, tags: value.tags }
        }
        case 'untag': {
          const { value } = await store.commitNow(() => store.removeTag(args.id, args.tag))
          return { ok: true, text: `已从 ${value.id} 移除标签，现在是：${value.tags.join('、') || '无'}。`, id: value.id, tags: value.tags }
        }
        case 'rehearse': {
          const { value } = await store.commitNow(() => store.rehearse(args.id))
          return { ok: true, text: `已唤醒记忆 ${value.id}（累计 ${value.accessCount} 次，轨迹更牢固了）。`, id: value.id, accessCount: value.accessCount }
        }
        case 'forget': {
          const id = requireId(args, 'id')
          const hard = args.hard === true
          await store.commitNow(() => store.forget(id, hard))
          return { ok: true, text: hard ? `已彻底删除记忆 ${id}。` : `已遗忘记忆 ${id}，它变成了一条幽灵记忆，可以 restore 恢复。`, id, hard }
        }
        case 'restore': {
          const { value } = await store.commitNow(() => store.restore(args.id))
          return { ok: true, text: `已恢复记忆 ${value.id}。`, id: value.id }
        }
        case 'pin': {
          const { value } = await store.commitNow(() => store.pin(args.id, args.pinned === true))
          return { ok: true, text: value.pinned ? `已把 ${value.id} 固定为长期记忆。` : `已取消 ${value.id} 的长期记忆。`, id: value.id, pinned: value.pinned }
        }
        case 'sleep': {
          const result = store.commitLight(() => store.sleep(Date.now()))
          await store.flush()
          return {
            ok: true,
            text: `巩固完成：${result.marked} 条情节记忆被合并进 ${result.consolidated} 条语义记忆，清理了 ${result.purged} 条彻底衰减的记忆。`,
            ...result,
          }
        }
        case 'capture': {
          const added = await captureHistory()
          return { ok: true, text: `已扫描历史任务，补记了 ${added} 条记忆。`, added }
        }
        case 'settings': {
          /** @type {Record<string, any>} */
          const patch = {}
          if (args.forgetAfterDays !== undefined) patch.forgetAfterDays = args.forgetAfterDays
          if (args.autoCapture !== undefined) patch.autoCapture = args.autoCapture
          if (args.maxMemories !== undefined) patch.maxMemories = args.maxMemories
          if (args.consolidateEveryHours !== undefined) patch.consolidateEveryHours = args.consolidateEveryHours
          if (Object.keys(patch).length === 0) {
            throw new Error('settings：至少给一个要改的字段（forgetAfterDays / autoCapture / maxMemories / consolidateEveryHours）。')
          }
          const { state } = await store.commitNow(() => store.updateSettings(patch))
          return {
            ok: true,
            text: `已手动更新设置：遗忘时间 ${state.settings.forgetAfterDays} 天、自动捕获 ${state.settings.autoCapture ? '开' : '关'}、记忆上限 ${state.settings.maxMemories}。`,
            settings: state.settings,
          }
        }
        default:
          throw new Error(`未知 action：${action || '(空)'}。可用：state/recall/remember/tag/untag/rehearse/forget/restore/pin/sleep/capture/settings。`)
      }
    },
  }), 'dsh-memory-brain: tool')

  // ---------------------------------------------------------------------
  // System-prompt section — tell the model its memory bank exists
  // ---------------------------------------------------------------------

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'memory-brain',
    order: 860,
    text: () => {
      const summary = store.summary()
      return [
        '【仿生记忆脑 Memory Brain】',
        '一个模仿人脑的长期记忆库已挂载：每个任务里的对话轮次会自动编码成带标签的“情节记忆”，随时间按遗忘曲线衰减、遗忘；重复想起会强化，巩固睡眠会把相似情节合并成“语义记忆”。',
        `当前：${summary.total} 条记忆（活跃 ${summary.active} / 消退 ${summary.fading} / 遗忘 ${summary.forgotten} / 固定 ${summary.pinned}），覆盖 ${summary.sessions} 个任务、${summary.tags} 个标签，平均保持率 ${Math.round((Number(summary.avgRetention) || 0) * 100)}%。`,
        'QQ 桥接的聊天（QQ 好友/群）也会自动进入这个记忆库：记忆带「QQ」标签、归属于独立的 QQ 会话；用户问起 QQ 上聊过的事时，用 brain_memory recall（可加 tag="QQ"）就能想起来。',
        `当前遗忘时间：${store.publicSettings().forgetAfterDays} 天（用户可在设置面板手动改，或让 agent 调 brain_memory 的 settings 动作改 forgetAfterDays）。`,
        '需要回忆旧信息时调用 brain_memory 工具：recall 按关键词/标签检索（检索本身会强化记忆）；state 看统计；remember 主动记住一条重要事实；tag/untag 改标签；rehearse 强化；forget/restore 遗忘或恢复；pin 固定为长期记忆；sleep 做一次巩固；capture 扫描历史会话。',
        '不要在回答里复述这段说明；只在确实需要旧信息时使用工具。',
      ].join('\n')
    },
  }), 'dsh-memory-brain: prompt section')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} body Request body.
 * @param {string} key Identity field.
 * @returns {string} Trimmed identity.
 */
function requireId(body, key) {
  const value = body !== null && typeof body === 'object' ? body[key] : undefined
  if (typeof value !== 'string' || value.trim() === '') throw new BrainError(400, 'invalid-id', `缺少 ${key}。`)
  return value.trim()
}

/**
 * Read a bounded request body.
 * @param {import('node:http').IncomingMessage} req Request.
 * @param {number} limit Byte ceiling.
 * @returns {Promise<string>} UTF-8 body text.
 */
function readJsonBody(req, limit) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        rejectBody(new BrainError(413, 'payload-too-large', '请求体过大。'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

/**
 * @param {import('node:http').ServerResponse} res Response.
 * @param {number} status HTTP status.
 * @param {unknown} payload JSON payload.
 */
function writeJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch {
    // The peer disconnected before the response; nothing useful to do.
  }
}

/**
 * @param {unknown} error Any thrown value.
 * @returns {string} Message text.
 */
function messageOf(error) {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return '未知错误'
}

/**
 * Human-readable one-liner for the STATS tool action.
 * @param {Record<string, any>} stats Store summary.
 * @param {Record<string, any>} [settings] Public settings slice.
 * @returns {string} Text.
 */
function renderStatsText(stats, settings) {
  const lines = [
    `记忆库：${stats.total} 条（情节 ${stats.episodes} / 语义 ${stats.semantic}，活跃 ${stats.active} / 消退 ${stats.fading} / 遗忘 ${stats.forgotten} / 固定 ${stats.pinned}）`,
    `覆盖 ${stats.sessions} 个任务、${stats.tags} 个标签，平均保持率 ${Math.round((Number(stats.avgRetention) || 0) * 100)}%。自动捕获：${stats.autoCapture ? '开' : '关'}。`,
  ]
  if (settings !== undefined) {
    lines.push(`当前设置：遗忘时间 ${settings.forgetAfterDays} 天（可手动改：面板设置，或 brain_memory 的 settings 动作传 forgetAfterDays）。`)
  }
  return lines.join('\n')
}

/**
 * Human-readable list for the RECALL tool action.
 * @param {Array<Record<string, any>>} memories Ranked memories.
 * @param {{ query: string, tag: string }} filters Applied filters.
 * @returns {string} Text.
 */
function renderRecallText(memories, filters) {
  if (memories.length === 0) {
    const hints = []
    if (filters.query !== '') hints.push(`关键词「${filters.query}」`)
    if (filters.tag !== '') hints.push(`标签「${filters.tag}」`)
    return hints.length === 0 ? '记忆库里还没有可回忆的内容。' : `没有找到匹配${hints.join('、')}的记忆（可能已经遗忘）。`
  }
  const lines = [`想起 ${memories.length} 条记忆：`]
  for (const memory of memories) {
    const percent = Math.round(memory.retention * 100)
    const task = memory.sessionTitle !== '' ? memory.sessionTitle : memory.sessionId
    lines.push(`- [${memory.id}]（${memory.kind === 'semantic' ? '语义' : '情节'}·保持 ${percent}%·${task}）${memory.excerpt}`)
    if (memory.tags.length > 0) lines.push(`  标签：${memory.tags.join('、')}`)
  }
  return lines.join('\n')
}

/**
 * Render a tool value for the conversation card.
 * @param {unknown} value Tool result.
 * @returns {string} Text.
 */
function renderToolText(value) {
  if (value !== null && typeof value === 'object' && typeof (/** @type {any} */ (value).text) === 'string') return /** @type {any} */ (value).text
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
