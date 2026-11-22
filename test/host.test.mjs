/**
 * Integration tests for the Host half: real `apply()` against a fake Cordis
 * context, exercising live capture, history backfill, every HTTP route, the
 * agent tool and the system-prompt section.
 *
 * Run from the package directory:
 *   <node> --test test/host.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DAY = 86_400_000
/** The QQ bridge creates its DSH sessions with this cwd (CONTRACT 十). */
const QQ_AGENTS_CWD = 'C:\\qq\\qq-bridge\\state\\agents'
const TASK_CWD = 'C:\\work\\dsh-workspace'

/**
 * Build a minimal stand-in for the Cordis host context that `apply()` uses.
 * @param {{ services?: Map<string, any> }} [options]
 */
function createFakeContext(options = {}) {
  /** @type {Map<string, any>} */
  const routes = new Map()
  /** @type {Map<string, any>} */
  const tools = new Map()
  /** @type {any[]} */
  const sections = []
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {Function[]} */
  const cleanups = []
  /** @type {Map<string, any>} */
  const services = options.services ?? new Map()
  const logs = []

  const ctx = {
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    get(name) {
      return services.get(name)
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    connection: {
      requestRejection: () => undefined,
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
  }
  return { ctx, routes, tools, sections, listeners, services, cleanups, logs }
}

/**
 * Perform one HTTP round-trip against a registered fake route.
 * @param {Map<string, any>} routes Registered routes.
 * @param {string} path Route path.
 * @param {{ method?: string, body?: unknown }} [options]
 */
async function callRoute(routes, path, options = {}) {
  const route = routes.get(path)
  assert.ok(route, `route ${path} registered`)
  const method = options.method ?? 'GET'
  const payload = options.body === undefined ? '' : JSON.stringify(options.body)
  const req = {
    method,
    headers: { 'content-type': 'application/json' },
    on(event, listener) {
      if (event === 'data' && payload !== '') listener(Buffer.from(payload))
      if (event === 'end') listener()
      return req
    },
    destroy() {},
  }
  const response = await new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: {},
      headersSent: false,
      writableEnded: false,
      setHeader(name, value) {
        this.headers[name] = value
      },
      end(text) {
        this.writableEnded = true
        try {
          resolve({ status: this.statusCode, body: text === undefined ? null : JSON.parse(String(text)) })
        } catch (error) {
          reject(error)
        }
      },
    }
    route.handler(req, res)
  })
  return response
}

/** Emit one session event to the plugin's capture listener. */
function emitSessionEvent(listeners, session, event) {
  for (const listener of listeners.get('session/event') ?? []) listener(session, event)
}

/** One conversation turn as the Session log would commit it. */
function turnEvents(turn, userText, assistantText, toolName = 'write') {
  return [
    { type: 'turn/start', data: { turn }, time: 1000 * turn },
    { type: 'user/message', data: { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: userText }] } }, time: 1000 * turn + 10 },
    { type: 'tool/call', data: { turn, step: 1, name: toolName }, time: 1000 * turn + 20 },
    { type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } }, time: 1000 * turn + 30 },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } }, time: 1000 * turn + 40 },
  ]
}

/**
 * Boot the plugin against a temporary `$DSH_HOME`.
 * @param {{ sessions?: any[], queryAvailable?: boolean }} [options]
 */
async function boot(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memory-brain-test-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { apply } = await import('../index.js')
  /** @type {Map<string, any>} */
  const services = new Map()
  services.set('sessionTitle', {
    get: () => ({ title: '实时任务' }),
  })
  if (options.queryAvailable !== false) {
    services.set('sessionQuery', {
      async listSessions() {
        return (options.sessions ?? []).map((session) => ({
          header: {
            id: session.id,
            createdAt: session.createdAt ?? Date.now() - DAY,
            origin: session.origin,
            cwd: session.cwd,
          },
        }))
      },
      async readSession(id) {
        const session = (options.sessions ?? []).find((candidate) => candidate.id === id)
        return session === undefined ? { session: { id }, events: [] } : { session: { id }, events: session.events }
      },
    })
  }
  const fake = createFakeContext({ services })
  apply(fake.ctx)
  // Let the async load settle; every route also awaits `ready` internally.
  await new Promise((resolve) => setTimeout(resolve, 30))
  return {
    ...fake,
    home,
    async teardown() {
      for (const cleanup of fake.cleanups) {
        try {
          cleanup()
        } catch {
          // ignore teardown noise
        }
      }
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      // A debounced save may still create a file in the temporary home while the
      // directory is being removed; retry briefly instead of failing the test.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
          return
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
    },
  }
}

test('boots, captures a live turn and serves GET /memory-brain/state', async () => {
  const booted = await boot()
  try {
    const session = { id: 'session-live', header: { origin: undefined } }
    emitSessionEvent(booted.listeners, session, { type: 'turn/start', data: { turn: 1 }, time: 500 })
    emitSessionEvent(booted.listeners, session, {
      type: 'user/message',
      data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '帮我做一个记忆插件，要自动贴标签并按时间遗忘。' }] } },
      time: 510,
    })
    emitSessionEvent(booted.listeners, session, {
      type: 'tool/call',
      data: { turn: 1, step: 1, name: 'write' },
      time: 520,
    })
    emitSessionEvent(booted.listeners, session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '好的，用艾宾浩斯遗忘曲线实现记忆衰减。' }] } },
      time: 530,
    })
    emitSessionEvent(booted.listeners, session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 540 })

    const response = await callRoute(booted.routes, '/memory-brain/state')
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    const state = response.body.state
    assert.equal(state.version, 2)
    assert.equal(state.stats.total, 1)
    assert.equal(state.nodes.length, 1)
    assert.equal(state.nodes[0].state, 'active')
    assert.equal(state.sessions[0].title, '实时任务')
    assert.ok(Array.isArray(state.edges))
  } finally {
    await booted.teardown()
  }
})

test('history backfill through POST /memory-brain/capture', async () => {
  const sessions = [{
    id: 'session-old',
    createdAt: Date.now() - 3 * DAY,
    events: [
      { type: 'session/title', data: { title: '旧任务' }, time: 1 },
      ...turnEvents(1, '旧任务第一问：代码和文档', '旧任务第一答'),
      ...turnEvents(2, '旧任务第二问：插件和测试', '旧任务第二答'),
    ],
  }]
  const booted = await boot({ sessions })
  try {
    const response = await callRoute(booted.routes, '/memory-brain/capture', { method: 'POST', body: {} })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.ok(response.body.added >= 2, `backfilled ${response.body.added} memories`)
    const state = response.body.state
    assert.ok(state.stats.total >= 2)
    assert.ok(state.sessions.some((session) => session.title === '旧任务'))
    // Backfilled history starts its forgetting clock at capture time, so the
    // old conversation is freshly remembered rather than instantly forgotten.
    assert.ok(state.nodes.every((node) => node.state === 'active'))
  } finally {
    await booted.teardown()
  }
})

test('capture degrades to a readable error without sessionQuery', async () => {
  const booted = await boot({ queryAvailable: false })
  try {
    const response = await callRoute(booted.routes, '/memory-brain/capture', { method: 'POST', body: {} })
    assert.notEqual(response.status, 200)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'query-unavailable')
  } finally {
    await booted.teardown()
  }
})

test('memory routes: tag, rehearse, forget, restore, pin, settings, sleep, purge, reset', async () => {
  const booted = await boot()
  try {
    const response = await callRoute(booted.routes, '/memory-brain/capture', { method: 'POST', body: {} })
    assert.equal(response.status, 200)
    const session = { id: 'session-ops', header: { origin: undefined } }
    for (const event of turnEvents(1, '代码 插件 记忆 标签', '好')) emitSessionEvent(booted.listeners, session, event)
    const current = await callRoute(booted.routes, '/memory-brain/state')
    const id = current.body.state.nodes[0].id
    assert.ok(id)

    const tagged = await callRoute(booted.routes, '/memory-brain/tag/add', { method: 'POST', body: { id, tag: '#手动标签' } })
    assert.equal(tagged.status, 200)
    assert.ok(tagged.body.state.nodes.find((node) => node.id === id).tags.includes('手动标签'))

    const untagged = await callRoute(booted.routes, '/memory-brain/tag/remove', { method: 'POST', body: { id, tag: '手动标签' } })
    assert.equal(untagged.status, 200)
    assert.equal(untagged.body.state.nodes.find((node) => node.id === id).tags.includes('手动标签'), false)

    const rehearsed = await callRoute(booted.routes, '/memory-brain/rehearse', { method: 'POST', body: { id } })
    assert.equal(rehearsed.status, 200)
    assert.ok(rehearsed.body.state.nodes.find((node) => node.id === id).accessCount >= 2)

    const forgotten = await callRoute(booted.routes, '/memory-brain/forget', { method: 'POST', body: { id } })
    assert.equal(forgotten.status, 200)
    assert.equal(forgotten.body.state.nodes.find((node) => node.id === id).state, 'forgotten')

    const restored = await callRoute(booted.routes, '/memory-brain/restore', { method: 'POST', body: { id } })
    assert.equal(restored.status, 200)
    assert.notEqual(restored.body.state.nodes.find((node) => node.id === id).state, 'forgotten')

    const pinned = await callRoute(booted.routes, '/memory-brain/pin', { method: 'POST', body: { id, pinned: true } })
    assert.equal(pinned.status, 200)
    assert.equal(pinned.body.state.nodes.find((node) => node.id === id).pinned, true)

    const settings = await callRoute(booted.routes, '/memory-brain/settings', { method: 'POST', body: { halfLifeDays: 7, autoCapture: true, maxMemories: 400 } })
    assert.equal(settings.status, 200)
    assert.equal(settings.body.state.settings.halfLifeDays, 7)
    assert.equal(settings.body.state.settings.maxMemories, 400)

    const slept = await callRoute(booted.routes, '/memory-brain/sleep', { method: 'POST', body: {} })
    assert.equal(slept.status, 200)
    assert.equal(slept.body.ok, true)

    const purged = await callRoute(booted.routes, '/memory-brain/purge', { method: 'POST', body: {} })
    assert.equal(purged.status, 200)

    const reset = await callRoute(booted.routes, '/memory-brain/reset', { method: 'POST', body: {} })
    assert.equal(reset.status, 200)
    assert.equal(reset.body.state.stats.total, 0)
  } finally {
    await booted.teardown()
  }
})

test('route failures are structured: unknown method and bad id', async () => {
  const booted = await boot()
  try {
    const wrongMethod = await callRoute(booted.routes, '/memory-brain/state', { method: 'POST', body: {} })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.body.error.code, 'method-not-allowed')

    const badId = await callRoute(booted.routes, '/memory-brain/rehearse', { method: 'POST', body: { id: 'nope' } })
    assert.equal(badId.status, 404)
    assert.equal(badId.body.error.code, 'not-found')
  } finally {
    await booted.teardown()
  }
})

test('agent tool exposes state/recall/remember and the prompt section', async () => {
  const booted = await boot()
  try {
    const session = { id: 'session-tool', header: { origin: undefined } }
    for (const event of turnEvents(1, '插件开发 记忆 代码', '好，开始实现')) emitSessionEvent(booted.listeners, session, event)
    const tool = booted.tools.get('brain_memory')
    assert.ok(tool, 'brain_memory tool registered')

    const state = await tool.execute({ action: 'state' }, { agent: { id: 'session-tool' } })
    assert.equal(state.ok, true)
    assert.ok(state.stats.total >= 1)

    const recall = await tool.execute({ action: 'recall', query: '插件' }, { agent: { id: 'session-tool' } })
    assert.equal(recall.ok, true)
    assert.ok(recall.count >= 1)
    assert.ok(recall.memories[0].tags.length > 0)

    const remembered = await tool.execute({ action: 'remember', text: '用户偏好：回答用中文。', tags: ['偏好'] }, { agent: { id: 'session-tool' } })
    assert.equal(remembered.ok, true)
    assert.ok(remembered.id)

    const section = booted.sections.find((candidate) => candidate.name === 'memory-brain')
    assert.ok(section, 'prompt section registered')
    assert.ok(typeof section.text === 'function')
    assert.match(section.text(), /记忆脑/)

    // No tool op may throw for a normal call.
    const recalled = await tool.execute({ action: 'recall', query: '偏好' }, { agent: { id: 'session-tool' } })
    assert.equal(recalled.ok, true)
    assert.ok(recalled.count >= 1)
  } finally {
    await booted.teardown()
  }
})

test('QQ bridge sessions are captured with the QQ tag and source', async () => {
  const sessions = [
    {
      id: 'session-qq',
      createdAt: Date.now() - 2 * DAY,
      cwd: QQ_AGENTS_CWD,
      events: [
        { type: 'session/title', data: { title: '【当前时间】2026/11/13 20:00（Asia/Shanghai）' }, time: 1 },
        ...turnEvents(1, '今天在 QQ 上聊了数学题', '好'),
        ...turnEvents(2, 'QQ 空间那条动态你看了吗', '看了'),
      ],
    },
    {
      id: 'session-task',
      createdAt: Date.now() - DAY,
      cwd: TASK_CWD,
      events: turnEvents(1, '普通任务对话', 'ok'),
    },
  ]
  const booted = await boot({ sessions })
  try {
    const response = await callRoute(booted.routes, '/memory-brain/capture', { method: 'POST', body: {} })
    assert.equal(response.status, 200)
    const state = response.body.state
    const qqRow = state.sessions.find((row) => row.sessionId === 'session-qq')
    const taskRow = state.sessions.find((row) => row.sessionId === 'session-task')
    assert.ok(qqRow, 'QQ session is grouped in state.sessions')
    assert.equal(qqRow.source, 'qq')
    assert.equal(taskRow.source, '')
    const qqNodes = state.nodes.filter((node) => node.sessionId === 'session-qq')
    assert.ok(qqNodes.length >= 2, 'QQ turns become memories')
    assert.ok(qqNodes.every((node) => node.tags.includes('qq')), 'QQ memories carry the QQ tag')
    assert.ok(state.tags.some((entry) => entry.tag === 'qq'), 'QQ shows up in the tag cloud')
    assert.equal(qqRow.title, 'QQ 聊天', 'scaffolding session titles fall back to a readable QQ label')

    const tool = booted.tools.get('brain_memory')
    const recalled = await tool.execute({ action: 'recall', tag: 'QQ' }, { agent: { id: 'session-qq' } })
    assert.equal(recalled.ok, true)
    assert.ok(recalled.count >= 1)
    assert.equal(recalled.memories[0].source, 'qq')
  } finally {
    await booted.teardown()
  }
})

test('live QQ turns are encoded with source=qq', async () => {
  const booted = await boot()
  try {
    const qqSession = { id: 'session-live-qq', header: { origin: undefined, cwd: QQ_AGENTS_CWD } }
    for (const event of turnEvents(1, 'QQ 上问我一道题', '马上回你')) emitSessionEvent(booted.listeners, qqSession, event)
    const response = await callRoute(booted.routes, '/memory-brain/state')
    const state = response.body.state
    const node = state.nodes.find((candidate) => candidate.sessionId === 'session-live-qq')
    assert.ok(node, 'live QQ turn encoded')
    assert.ok(node.tags.includes('qq'))
    assert.equal(state.sessions.find((row) => row.sessionId === 'session-live-qq').source, 'qq')
    // Normal DSH tasks keep an empty source.
    const normalSession = { id: 'session-normal-live', header: { origin: undefined, cwd: TASK_CWD } }
    for (const event of turnEvents(1, '普通任务', '好')) emitSessionEvent(booted.listeners, normalSession, event)
    const after = (await callRoute(booted.routes, '/memory-brain/state')).body.state
    assert.equal(after.sessions.find((row) => row.sessionId === 'session-normal-live').source, '')
  } finally {
    await booted.teardown()
  }
})

test('agent tool can manually change the forgetting time', async () => {
  const booted = await boot()
  try {
    const tool = booted.tools.get('brain_memory')
    const configured = await tool.execute({ action: 'settings', forgetAfterDays: 14 }, { agent: { id: 'session-tool' } })
    assert.equal(configured.ok, true)
    assert.equal(configured.settings.forgetAfterDays, 14)
    const state = await tool.execute({ action: 'state' }, { agent: { id: 'session-tool' } })
    assert.equal(state.ok, true)
    assert.equal(state.settings.forgetAfterDays, 14)
    assert.match(state.text, /遗忘时间 14 天/)
    await assert.rejects(async () => tool.execute({ action: 'settings' }, {}), /至少给一个要改的字段/)
    const paused = await tool.execute({ action: 'settings', forgettingEnabled: false }, { agent: { id: 'session-tool' } })
    assert.equal(paused.ok, true)
    assert.equal(paused.settings.forgettingEnabled, false)
    const resumed = await tool.execute({ action: 'settings', forgettingEnabled: true, forgetAfterDays: 7 }, { agent: { id: 'session-tool' } })
    assert.equal(resumed.settings.forgettingEnabled, true)
  } finally {
    await booted.teardown()
  }
})

test('layered-memory routes: features toggle, fact/summary rebuild and clear', async () => {
  const booted = await boot()
  try {
    const session = { id: 'session-layered', header: { origin: undefined } }
    emitSessionEvent(booted.listeners, session, { type: 'turn/start', data: { turn: 1 }, time: 500 })
    emitSessionEvent(booted.listeners, session, {
      type: 'user/message',
      data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '我叫小明，我喜欢喝茶。' }] } },
      time: 510,
    })
    emitSessionEvent(booted.listeners, session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '记住了。' }] } },
      time: 520,
    })
    emitSessionEvent(booted.listeners, session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 530 })

    const stateResponse = await callRoute(booted.routes, '/memory-brain/state')
    assert.equal(stateResponse.status, 200)
    const state = stateResponse.body.state
    assert.equal(state.version, 2)
    assert.equal(state.features.factExtraction, true)
    assert.ok(Array.isArray(state.facts))
    assert.ok(Array.isArray(state.summaries.sessions))
    assert.ok(state.factsStats.total >= 1, 'live turn produced structured facts')

    const rebuiltFacts = await callRoute(booted.routes, '/memory-brain/facts/rebuild', { method: 'POST', body: { clear: true } })
    assert.equal(rebuiltFacts.status, 200)
    assert.equal(rebuiltFacts.body.ok, true)
    assert.ok(rebuiltFacts.body.state.factsStats.active >= 1)

    // Re-running the same full rebuild must not grow or duplicate the bank.
    const rebuiltFactsAgain = await callRoute(booted.routes, '/memory-brain/facts/rebuild', { method: 'POST', body: {} })
    assert.equal(rebuiltFactsAgain.status, 200)
    assert.equal(rebuiltFactsAgain.body.state.factsStats.active, rebuiltFacts.body.state.factsStats.active, 'rebuild route is idempotent')
    assert.equal(rebuiltFactsAgain.body.state.factsStats.total, rebuiltFacts.body.state.factsStats.total)

    const rebuiltSummaries = await callRoute(booted.routes, '/memory-brain/summaries/rebuild', { method: 'POST', body: {} })
    assert.equal(rebuiltSummaries.status, 200)
    assert.ok(rebuiltSummaries.body.state.summaryStats.sessions >= 1)

    const featureResponse = await callRoute(booted.routes, '/memory-brain/features', { method: 'POST', body: { features: { factExtraction: false } } })
    assert.equal(featureResponse.status, 200)
    assert.equal(featureResponse.body.state.features.factExtraction, false)
    assert.equal(featureResponse.body.state.facts.length, 0, 'facts hidden when the step is off')
    assert.ok(featureResponse.body.state.factsStats.total >= 1, 'stored facts are retained for rollback')

    const clearedFacts = await callRoute(booted.routes, '/memory-brain/facts/clear', { method: 'POST', body: {} })
    assert.equal(clearedFacts.status, 200)
    assert.ok(clearedFacts.body.removed >= 1)
    const clearedSummaries = await callRoute(booted.routes, '/memory-brain/summaries/clear', { method: 'POST', body: {} })
    assert.equal(clearedSummaries.status, 200)
    assert.ok(clearedSummaries.body.removed >= 1)
  } finally {
    await booted.teardown()
  }
})

test('agent tool exposes layered-memory actions', async () => {
  const booted = await boot()
  try {
    const session = { id: 'session-tool-layered', header: { origin: undefined } }
    emitSessionEvent(booted.listeners, session, { type: 'turn/start', data: { turn: 1 }, time: 500 })
    emitSessionEvent(booted.listeners, session, {
      type: 'user/message',
      data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '我叫小明，我喜欢喝茶。' }] } },
      time: 510,
    })
    emitSessionEvent(booted.listeners, session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '记住了。' }] } },
      time: 520,
    })
    emitSessionEvent(booted.listeners, session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 530 })
    const tool = booted.tools.get('brain_memory')
    assert.ok(tool)

    const facts = await tool.execute({ action: 'facts', query: '小明' }, { agent: { id: 'session-tool-layered' } })
    assert.equal(facts.ok, true)
    assert.ok(facts.count >= 1)
    assert.ok(facts.facts.some((fact) => fact.value.includes('小明')))

    const summaries = await tool.execute({ action: 'summaries', level: 'all' }, { agent: { id: 'session-tool-layered' } })
    assert.equal(summaries.ok, true)
    assert.ok(typeof summaries.summaries === 'object')

    const toggled = await tool.execute({ action: 'features', features: { temporalHistory: true } }, { agent: { id: 'session-tool-layered' } })
    assert.equal(toggled.ok, true)
    assert.equal(toggled.features.temporalHistory, true)

    const rebuilt = await tool.execute({ action: 'rebuild', target: 'all' }, { agent: { id: 'session-tool-layered' } })
    assert.equal(rebuilt.ok, true)

    const recall = await tool.execute({ action: 'recall', query: '我叫什么', layer: 'auto' }, { agent: { id: 'session-tool-layered' } })
    assert.equal(recall.ok, true)
    assert.equal(typeof recall.layer, 'string')
    assert.ok(Array.isArray(recall.facts))
    assert.ok(Array.isArray(recall.summaries))
  } finally {
    await booted.teardown()
  }
})
