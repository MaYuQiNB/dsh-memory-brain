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
      // Enforce the forgetting time on the persisted bank: memories that crossed
      // it while DSH was offline get their content deleted right away.
      try {
        const scrubbed = store.commitLight(() => store.sweepForgotten(Date.now()))
        if (scrubbed > 0) {
          void store.flush()
          ctx.logger?.info?.(`dsh-memory-brain: ${scrubbed} memories reached the forgetting time; content deleted`)
        }
      } catch (error) {
        ctx.logger?.warn?.('dsh-memory-brain: forgetting sweep on load failed')
        ctx.logger?.warn?.(error)
      }
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
  // Periodic sweep + consolidation ("forgetting time" + "sleep")
  // ---------------------------------------------------------------------

  let sleepTimer = null
  ctx.effect(() => {
    sleepTimer = setInterval(() => {
      if (!loaded || store.memories.length === 0) return
      try {
        // Every tick: once a memory reaches its forgetting time, delete its
        // readable content (it becomes an empty tombstone).
        const scrubbed = store.commitLight(() => store.sweepForgotten(Date.now()))
        if (scrubbed > 0) {
          void store.flush()
          ctx.logger?.info?.(`dsh-memory-brain: ${scrubbed} memories reached the forgetting time; content deleted`)
        }
        const interval = Math.max(1, store.settings.consolidateEveryHours) * 60 * 60 * 1000
        if (Date.now() - store.lastSleepAt < interval) return
        const result = store.commitLight(() => store.sleep(Date.now()))
        void store.flush()
        ctx.logger?.info?.(`dsh-memory-brain: sleep — consolidated ${result.marked} episodes into ${result.consolidated} semantic memories, purged ${result.purged}`)
      } catch (error) {
        ctx.logger?.warn?.('dsh-memory-brain: sweep/sleep failed')
        ctx.logger?.warn?.(error)
      }
    }, SLEEP_CHECK_MS)
    if (typeof sleepTimer?.unref === 'function') sleepTimer.unref()
    return () => {
      if (sleepTimer !== null) clearInterval(sleepTimer)
      sleepTimer = null
      store.dispose()
    }
  }, 'dsh-memory-brain: sweep + sleep timer')

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
      case 'features': {
        const patch = body.features !== null && typeof body.features === 'object' ? body.features : body
        const { state, value } = await store.commitNow(() => store.updateFeatures(patch))
        return { ok: true, state, features: value }
      }
      case 'facts/rebuild': {
        // Full re-extraction over the whole bank (old data included); clears
        // first so running it repeatedly is idempotent instead of inflating
        // seenCount. Pass clear=false only for a deliberate incremental pass.
        const { state, value } = await store.commitNow(() => store.rebuildFacts({ clear: body.clear !== false }))
        return { ok: true, state, result: value }
      }
      case 'facts/clear': {
        const { state, value } = await store.commitNow(() => store.clearFacts())
        return { ok: true, state, removed: value }
      }
      case 'summaries/rebuild': {
        const { state, value } = await store.commitNow(() => store.rebuildSummaries({ now: Date.now() }))
        return { ok: true, state, result: value }
      }
      case 'summaries/clear': {
        const { state, value } = await store.commitNow(() => store.clearSummaries())
        return { ok: true, state, removed: value }
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
    { action: 'features', method: 'POST', suffix: '/features' },
    { action: 'facts/rebuild', method: 'POST', suffix: '/facts/rebuild' },
    { action: 'facts/clear', method: 'POST', suffix: '/facts/clear' },
    { action: 'summaries/rebuild', method: 'POST', suffix: '/summaries/rebuild' },
    { action: 'summaries/clear', method: 'POST', suffix: '/summaries/clear' },
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
      '- forget：手动遗忘一条记忆，参数 id，可选 hard=true 彻底删除；soft 遗忘可 restore。',
      '- 自动遗忘（不需要调用工具）：到达遗忘时间后，记忆的可读内容会被永久删除，只剩一个空的「已遗忘」墓碑（不可恢复），之后会被清理掉。',
      '- restore：恢复被遗忘的记忆，参数 id。',
      '- pin：固定/取消固定长期记忆，参数 id、pinned（布尔）。',
      '- 分层记忆（可单独开关）：facts 查结构化事实（主体-属性-值，参数 query/subject/includeSuperseded）；summaries 查会话/每日/每周摘要（参数 level=session|daily|weekly|all）；features 看/改 8 个升级开关；rebuild 重建 facts/summaries（参数 target=facts|summaries|all、clear）。',
      '- sleep：立刻做一次巩固（合并语义记忆 + 清理彻底衰减的记忆）。',
      '- capture：扫描历史任务并补记记忆（首次安装后可用）。',
      '- settings：手动修改记忆设置——forgetAfterDays（遗忘时间，1–60 天，默认 7）、forgettingEnabled（是否启用遗忘，布尔，关掉则记忆冻结、不衰减也不删内容）、autoCapture（布尔）、maxMemories（100–2000）、consolidateEveryHours（1–24）。用户说「把遗忘时间改成 X 天」「关掉遗忘」「开启遗忘」时用它。',
      'QQ 聊天也会被自动捕获：通过 QQ 桥接进行的对话记忆带「QQ」标签（source=qq），可以用 recall 的 tag="QQ" 或 sessionId 检索；它们在记忆网里作为独立的「任务」分组出现。',
      '记忆 id 形如 ep-xxxx，只能从 state/recall 的返回里拿，不要自己编。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['state', 'recall', 'remember', 'tag', 'untag', 'rehearse', 'forget', 'restore', 'pin', 'sleep', 'capture', 'settings', 'features', 'facts', 'summaries', 'rebuild'],
          description: '要执行的操作。',
        },
        id: { type: 'string', description: 'tag/untag/rehearse/forget/restore/pin 的目标记忆 id。' },
        tag: { type: 'string', description: 'tag/untag：标签文本；recall：按标签筛选。' },
        query: { type: 'string', description: 'recall/facts：关键词（可空格分隔多个词）。' },
        sessionId: { type: 'string', description: 'recall/facts：只看某个任务（会话）。' },
        limit: { type: 'number', description: 'recall/facts/summaries：最多返回几条（默认 8 / 20）。' },
        text: { type: 'string', description: 'remember：要记住的内容。' },
        tags: { type: 'array', items: { type: 'string' }, description: 'remember：可选自定义标签。' },
        hard: { type: 'boolean', description: 'forget：true = 彻底删除，不留幽灵。' },
        pinned: { type: 'boolean', description: 'pin：true 固定为长期记忆，false 取消固定。' },
        subject: { type: 'string', description: 'recall/facts：只看某个主体的事实（默认「用户」）。' },
        includeSuperseded: { type: 'boolean', description: 'facts：true = 连已失效的旧事实一起返回（时序）。' },
        layer: { type: 'string', enum: ['auto', 'raw', 'daily', 'weekly'], description: 'recall：检索层（auto = 按问题复杂度自动选）。' },
        level: { type: 'string', enum: ['session', 'daily', 'weekly', 'all'], description: 'summaries：要看的摘要层。' },
        target: { type: 'string', enum: ['facts', 'summaries', 'all'], description: 'rebuild：重建哪一层。' },
        clear: { type: 'boolean', description: 'rebuild/features（facts/clear 时省略）：rebuild 前是否清空。' },
        features: { type: 'object', additionalProperties: { type: 'boolean' }, description: 'features/settings：8 个开关的部分更新，例如 {"factExtraction":false}。' },
        forgetAfterDays: { type: 'number', description: 'settings：遗忘时间（天，1–60，默认 7）。' },
        forgettingEnabled: { type: 'boolean', description: 'settings：是否启用遗忘（false = 记忆冻结、不衰减也不删内容）。' },
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
          const snapshot = store.snapshot()
          return {
            ok: true,
            text: renderStatsText(summary, settings),
            stats: summary,
            settings,
            features: snapshot.features,
            factsStats: snapshot.factsStats,
            summaryStats: snapshot.summaryStats,
          }
        }
        case 'recall': {
          const query = typeof args.query === 'string' ? args.query : ''
          const tag = typeof args.tag === 'string' ? args.tag : ''
          const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
          const limit = Number.isFinite(args.limit) ? args.limit : 8
          const layer = typeof args.layer === 'string' ? args.layer : 'auto'
          const subject = typeof args.subject === 'string' ? args.subject : ''
          const result = store.recallWithContext({ query, tag, sessionId, limit, layer, subject, includeStructured: true })
          const memories = result.items.filter((item) => item.kind === 'episode' || item.kind === 'semantic')
          if (memories.length > 0) {
            store.commitLight(() => store.rehearseMany(memories.map((memory) => memory.id)))
            void store.flush()
          }
          const facts = result.items.filter((item) => item.kind === 'fact')
          const summaries = result.items.filter((item) => typeof item.kind === 'string' && item.kind.endsWith('-summary'))
          return {
            ok: true,
            text: renderRecallText(result.items, { query, tag, layer: result.layer }),
            layer: result.layer,
            complexity: result.complexity,
            items: result.items,
            memories,
            facts,
            summaries,
            count: result.items.length,
          }
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
          const featurePatch = args.features !== null && typeof args.features === 'object' ? args.features : null
          if (args.forgetAfterDays !== undefined) patch.forgetAfterDays = args.forgetAfterDays
          if (args.forgettingEnabled !== undefined) patch.forgettingEnabled = args.forgettingEnabled
          if (args.autoCapture !== undefined) patch.autoCapture = args.autoCapture
          if (args.maxMemories !== undefined) patch.maxMemories = args.maxMemories
          if (args.consolidateEveryHours !== undefined) patch.consolidateEveryHours = args.consolidateEveryHours
          if (Object.keys(patch).length === 0 && featurePatch === null) {
            throw new Error('settings：至少给一个要改的字段（forgetAfterDays / forgettingEnabled / autoCapture / maxMemories / consolidateEveryHours / features）。')
          }
          if (featurePatch !== null) {
            await store.commitNow(() => store.updateFeatures(featurePatch))
          }
          if (Object.keys(patch).length > 0) {
            const { state } = await store.commitNow(() => store.updateSettings(patch))
            return {
              ok: true,
              text: `已手动更新设置：遗忘${state.settings.forgettingEnabled ? '已开启' : '已暂停'}、遗忘时间 ${state.settings.forgetAfterDays} 天、自动捕获 ${state.settings.autoCapture ? '开' : '关'}、记忆上限 ${state.settings.maxMemories}${featurePatch !== null ? '；分层记忆开关已更新' : ''}。`,
              settings: state.settings,
              features: state.features,
            }
          }
          const settings = store.publicSettings()
          return {
            ok: true,
            text: `已更新分层记忆开关：${renderFeaturesText(settings.features)}`,
            settings,
            features: settings.features,
          }
        }
        case 'features': {
          const patch = args.features !== null && typeof args.features === 'object' ? args.features : {}
          if (Object.keys(patch).length === 0) {
            const current = store.publicSettings().features
            return { ok: true, text: renderFeaturesText(current), features: current }
          }
          const { value } = await store.commitNow(() => store.updateFeatures(patch))
          return { ok: true, text: renderFeaturesText(value), features: value }
        }
        case 'facts': {
          const facts = store.listFacts({
            query: typeof args.query === 'string' ? args.query : '',
            subject: typeof args.subject === 'string' ? args.subject : '',
            sessionId: typeof args.sessionId === 'string' ? args.sessionId : '',
            includeSuperseded: args.includeSuperseded === true,
            limit: Number.isFinite(args.limit) ? args.limit : 20,
          })
          return { ok: true, text: renderFactsText(facts), facts, count: facts.length }
        }
        case 'summaries': {
          const level = typeof args.level === 'string' ? args.level : 'all'
          const limit = Number.isFinite(args.limit) ? args.limit : 10
          const summaries = store.listSummaries(level, limit)
          return { ok: true, text: renderSummariesText(summaries), summaries }
        }
        case 'rebuild': {
          const target = typeof args.target === 'string' ? args.target : 'all'
          // Default is a full, idempotent re-extraction over the whole bank.
          const clear = args.clear !== false
          if (target === 'facts') {
            const { value } = await store.commitNow(() => store.rebuildFacts({ clear }))
            return { ok: true, text: `事实重建完成（${clear ? '全量重跑' : '增量'}）：共 ${value.total} 条（有效 ${value.active}，新增 ${value.added}，合并 ${value.merged}，冲突替换 ${value.superseded}）。可重复执行，不会产生重复条目。`, result: value }
          }
          if (target === 'summaries') {
            const { value } = await store.commitNow(() => store.rebuildSummaries({ now: Date.now() }))
            return { ok: true, text: `摘要重建完成：会话 ${value.sessions} 条、每日 ${value.daily} 条、每周 ${value.weekly} 条。`, result: value }
          }
          const { value: factsResult } = await store.commitNow(() => store.rebuildFacts({ clear }))
          const { value: summaryResult } = await store.commitNow(() => store.rebuildSummaries({ now: Date.now() }))
          return {
            ok: true,
            text: `重建完成（${clear ? '全量重跑' : '增量'}）：事实 ${factsResult.total} 条（有效 ${factsResult.active}），会话摘要 ${summaryResult.sessions} 条、每日 ${summaryResult.daily} 条、每周 ${summaryResult.weekly} 条。可重复执行，不会产生重复条目。`,
            facts: factsResult,
            summaries: summaryResult,
          }
        }
        default:
          throw new Error(`未知 action：${action || '(空)'}。可用：state/recall/remember/tag/untag/rehearse/forget/restore/pin/sleep/capture/settings/features/facts/summaries/rebuild。`)
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
        `当前遗忘时间：${store.publicSettings().forgetAfterDays} 天，遗忘开关：${store.publicSettings().forgettingEnabled ? '开启' : '暂停（关掉后记忆冻结、不衰减也不删内容）'}（用户可在设置面板手动改，或让 agent 调 brain_memory 的 settings 动作改 forgetAfterDays / forgettingEnabled）。到时间后记忆内容会被真正删除，只剩空墓碑。`,
        `分层记忆（每个开关都能在设置面板单独关掉回滚）：每轮对话会抽成「主体-属性-值-时间」事实并去重/冲突替换；每个会话有一句摘要，另有每日/每周汇总；recall 会按问题复杂度自动选层（简单问题查原始记忆/事实，复杂问题查汇总）。当前事实 ${store.summary().factCount} 条、摘要层 ${JSON.stringify(store.summary().summaryCounts)}。`,
        '需要回忆旧信息时调用 brain_memory 工具：recall 按关键词/标签检索（检索本身会强化记忆）；state 看统计；remember 主动记住一条重要事实；tag/untag 改标签；rehearse 强化；forget/restore 遗忘或恢复；pin 固定为长期记忆；sleep 做一次巩固；capture 扫描历史会话；facts 查结构化事实；summaries 查摘要层；features 看/改 8 个升级开关。',
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
    `分层记忆：结构化事实 ${stats.factCount ?? 0} 条；摘要层 会话 ${stats.summaryCounts?.sessions ?? 0} / 每日 ${stats.summaryCounts?.daily ?? 0} / 每周 ${stats.summaryCounts?.weekly ?? 0}。`,
  ]
  if (settings !== undefined) {
    lines.push(`当前设置：遗忘${settings.forgettingEnabled ? '开启' : '已暂停'}、遗忘时间 ${settings.forgetAfterDays} 天（可手动改：面板设置，或 brain_memory 的 settings 动作传 forgetAfterDays / forgettingEnabled）。`)
    if (settings.features !== undefined) lines.push(`分层开关：${renderFeaturesText(settings.features)}`)
  }
  return lines.join('\n')
}

/**
 * One-line rendering of the eight layered-memory toggles.
 * @param {Record<string, boolean> | undefined} features Feature map.
 * @returns {string} Text.
 */
function renderFeaturesText(features) {
  const source = features !== null && typeof features === 'object' ? features : {}
  const labels = [
    ['factExtraction', '抽事实'],
    ['factDedup', '去重'],
    ['factConflict', '冲突替换'],
    ['sessionSummary', '会话摘要'],
    ['dailyWeeklySummary', '日周汇总'],
    ['layeredRecall', '分层检索'],
    ['semanticRecall', '语义召回'],
    ['temporalHistory', '时序历史'],
  ]
  return labels.map(([key, label]) => `${label}${source[key] === true ? '开' : '关'}`).join('、')
}

/**
 * Human-readable fact list.
 * @param {Array<Record<string, any>>} facts Facts.
 * @returns {string} Text.
 */
function renderFactsText(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return '还没有结构化事实（事实抽取可能关闭，或还没有可抽取的对话）。'
  const lines = [`共 ${facts.length} 条事实：`]
  for (const fact of facts) {
    const suffix = fact.invalidatedAt > 0 ? '（已失效）' : ''
    lines.push(`- ${fact.subject} · ${fact.attribute} → ${fact.value}${suffix}（${fact.seenCount ?? 1} 次${fact.sessionTitle ? `·${fact.sessionTitle}` : ''}）`)
  }
  return lines.join('\n')
}

/**
 * Human-readable summary layers.
 * @param {{ sessions: Array<Record<string, any>>, daily: Array<Record<string, any>>, weekly: Array<Record<string, any>> }} summaries Layers.
 * @returns {string} Text.
 */
function renderSummariesText(summaries) {
  const sessions = Array.isArray(summaries?.sessions) ? summaries.sessions : []
  const daily = Array.isArray(summaries?.daily) ? summaries.daily : []
  const weekly = Array.isArray(summaries?.weekly) ? summaries.weekly : []
  if (sessions.length + daily.length + weekly.length === 0) return '还没有摘要（摘要层可能关闭，或还没有可汇总的记忆）。'
  const lines = []
  if (sessions.length > 0) {
    lines.push(`会话摘要 ${sessions.length} 条：`)
    for (const summary of sessions.slice(0, 10)) lines.push(`- [${summary.sessionId ?? ''}] ${summary.title ?? ''}：${summary.text}`)
  }
  if (daily.length > 0) {
    lines.push(`每日汇总 ${daily.length} 条：`)
    for (const summary of daily.slice(0, 7)) lines.push(`- ${summary.date}：${summary.text}`)
  }
  if (weekly.length > 0) {
    lines.push(`每周汇总 ${weekly.length} 条：`)
    for (const summary of weekly.slice(0, 4)) lines.push(`- ${summary.week}：${summary.text}`)
  }
  return lines.join('\n')
}

/**
 * Clip one line of recall text so a full answer stays bounded.
 * @param {unknown} value Raw text.
 * @param {number} max Max characters.
 * @returns {string} Clipped text.
 */
function clipText(value, max) {
  const text = typeof value === 'string' ? value : ''
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`
}

/**
 * Human-readable list for the RECALL tool action. Handles raw memories,
 * structured facts and summary-layer entries from layered retrieval. Every
 * line is clipped so the answer cannot flood the model context.
 * @param {Array<Record<string, any>>} items Ranked retrieval items.
 * @param {{ query: string, tag: string, layer?: string }} filters Applied filters.
 * @returns {string} Text.
 */
function renderRecallText(items, filters) {
  const list = Array.isArray(items) ? items.filter((item) => item !== null && typeof item === 'object') : []
  if (list.length === 0) {
    const hints = []
    if (filters.query !== '') hints.push(`关键词「${filters.query}」`)
    if (filters.tag !== '') hints.push(`标签「${filters.tag}」`)
    return hints.length === 0 ? '记忆库里还没有可回忆的内容。' : `没有找到匹配${hints.join('、')}的记忆（可能已经遗忘）。`
  }
  const memories = list.filter((item) => item.kind === 'episode' || item.kind === 'semantic')
  const facts = list.filter((item) => item.kind === 'fact')
  const summaries = list.filter((item) => typeof item.kind === 'string' && item.kind.endsWith('-summary'))
  const lines = []
  if (filters.layer !== undefined && filters.layer !== 'raw') lines.push(`检索层：${filters.layer}`)
  if (facts.length > 0) {
    lines.push(`结构化事实 ${facts.length} 条：`)
    for (const fact of facts) {
      const suffix = fact.invalidated === true ? '（已失效）' : ''
      const task = fact.sessionTitle ? `·${clipText(fact.sessionTitle, 40)}` : ''
      lines.push(`- ${clipText(fact.subject, 30)} · ${clipText(fact.attribute, 20)} → ${clipText(fact.value, 80)}${suffix}（${fact.seenCount ?? 1} 次${task}）`)
    }
  }
  if (summaries.length > 0) {
    lines.push(`摘要 ${summaries.length} 条：`)
    for (const summary of summaries) {
      const label = summary.kind === 'weekly-summary' ? `周 ${summary.week ?? ''}`
        : summary.kind === 'daily-summary' ? `日 ${summary.date ?? ''}`
          : `会话 ${clipText(summary.title ?? summary.sessionId ?? '', 40)}`
      lines.push(`- [${label}] ${clipText(summary.text, 160)}`)
    }
  }
  if (memories.length > 0) {
    lines.push(`想起 ${memories.length} 条记忆：`)
    for (const memory of memories) {
      const percent = Math.round(Number(memory.retention ?? 0) * 100)
      const task = clipText(memory.sessionTitle !== '' ? memory.sessionTitle : memory.sessionId, 40)
      lines.push(`- [${memory.id}]（${memory.kind === 'semantic' ? '语义' : '情节'}·保持 ${percent}%·${task}）${clipText(memory.excerpt, 160)}`)
      if (Array.isArray(memory.tags) && memory.tags.length > 0) lines.push(`  标签：${clipText(memory.tags.join('、'), 60)}`)
    }
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
