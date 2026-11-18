/**
 * End-to-end tests for the memory store on top of the pure memory engine:
 * encoding, forgetting over time, rehearsal, forgetting/restoring/pinning,
 * sleep consolidation, capacity, persistence round-trip and the read model.
 *
 * Run from the package directory:
 *   <node> --test test/store.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MemoryError,
  MemoryStore,
  buildExcerpt,
  collectTurns,
  extractText,
} from '../lib/memory-store.js'

const DAY = 86_400_000
const START = Date.UTC(2026, 0, 1, 12, 0, 0)

/**
 * Build a store with an injectable clock and an in-memory save sink.
 * @param {{ start?: number, settings?: Record<string, any> }} [options]
 */
function makeStore(options = {}) {
  let clock = Number.isFinite(options.start) ? options.start : START
  /** @type {Record<string, any>[]} */
  const writes = []
  const store = new MemoryStore({
    now: () => clock,
    save: async (payload) => {
      writes.push(JSON.parse(JSON.stringify(payload)))
    },
    settings: options.settings,
  })
  return {
    store,
    writes,
    advance: (ms) => {
      clock += ms
    },
    setClock: (value) => {
      clock = value
    },
    now: () => clock,
  }
}

/**
 * Encode one turn with sensible defaults.
 * @param {MemoryStore} store Store.
 * @param {Record<string, any>} [options] Overrides.
 */
function ingest(store, options = {}) {
  return store.ingestTurn({
    sessionId: options.sessionId ?? 'session-1',
    sessionTitle: options.sessionTitle ?? '记忆插件开发',
    turn: options.turn ?? 1,
    userTexts: options.userTexts ?? ['帮我做一个记忆插件，要自动贴标签并按时间遗忘。'],
    assistantTexts: options.assistantTexts ?? ['好的，我会用艾宾浩斯遗忘曲线实现记忆衰减，并把对话编码成情节记忆。'],
    toolNames: options.toolNames ?? ['write', 'read'],
    startedAt: options.startedAt,
    encodedAt: options.encodedAt ?? options.startedAt,
  })
}

/** @param {MemoryStore} store @param {string} id */
function nodeOf(store, id) {
  return store.snapshot().nodes.find((node) => node.id === id)
}

/** @param {MemoryStore} store @param {string} id */
function stateOf(store, id) {
  return nodeOf(store, id)?.state
}

// ---------------------------------------------------------------------------
// Text folding
// ---------------------------------------------------------------------------

test('extractText folds content blocks into plain text', () => {
  assert.equal(extractText([
    { type: 'text', text: '你好' },
    { type: 'image', attachment: { attachmentId: 'x' } },
    { type: 'text', text: '世界' },
  ]), '你好\n世界')
  assert.equal(extractText('  plain  '), 'plain')
  assert.equal(extractText(null), '')
  assert.equal(extractText([{ type: 'reasoning', text: '内部推理' }]), '')
})

test('buildExcerpt keeps a one-line gist under the ceiling', () => {
  const excerpt = buildExcerpt('  用户   问题  ', '助手回答')
  assert.equal(excerpt, '用户 问题 → 助手回答')
  const long = buildExcerpt('啊'.repeat(500), '')
  assert.ok(long.length <= 180)
})

test('collectTurns folds a session log into turns and reads the title', () => {
  const events = [
    { type: 'session/title', data: { title: '记忆插件开发' }, time: 1 },
    { type: 'turn/start', data: { turn: 1 }, time: 100 },
    { type: 'user/message', data: { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: '第一问' }] } }, time: 110 },
    { type: 'user/message', data: { source: { kind: 'plugin' }, message: { role: 'user', content: [{ type: 'text', text: '插件注入的上下文' }] } }, time: 120 },
    { type: 'tool/call', data: { name: 'write', turn: 1 }, time: 130 },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第一答' }] } }, time: 140 },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 150 },
    { type: 'turn/start', data: { turn: 2 }, time: 200 },
    { type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '第二问' }] } }, time: 210 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二答' }] } }, time: 220 },
    { type: 'turn/end', data: { turn: 2 }, time: 230 },
  ]
  const { turns, title } = collectTurns(events)
  assert.equal(title, '记忆插件开发')
  assert.equal(turns.length, 2)
  assert.deepEqual(turns[0].userTexts, ['第一问'])
  assert.deepEqual(turns[0].assistantTexts, ['第一答'])
  assert.deepEqual(turns[0].toolNames, ['write'])
  assert.deepEqual(turns[1].userTexts, ['第二问'])
  assert.deepEqual(turns[1].assistantTexts, ['第二答'])
})

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

test('ingestTurn encodes an episode with tags and excerpt, idempotently', () => {
  const { store } = makeStore()
  const record = ingest(store, { turn: 1 })
  assert.ok(record, 'record created')
  assert.equal(record.kind, 'episode')
  assert.ok(record.tags.length > 0, 'auto tags extracted')
  assert.ok(record.excerpt.length > 0)
  assert.ok(record.salience >= 0.8)
  assert.equal(store.memories.length, 1)

  const duplicate = ingest(store, { turn: 1 })
  assert.equal(duplicate, null, 'same session#turn never duplicates')
  assert.equal(store.memories.length, 1)
})

test('ingestTurn skips empty turns and keeps task title', () => {
  const { store } = makeStore()
  assert.equal(store.ingestTurn({ sessionId: 's', turn: 1, userTexts: [], assistantTexts: [] }), null)
  const record = ingest(store, { sessionTitle: '一个任务', turn: 2 })
  assert.equal(record?.sessionTitle, '一个任务')
})

// ---------------------------------------------------------------------------
// Forgetting over time
// ---------------------------------------------------------------------------

test('retention decays over time and crosses fading/forgotten thresholds', () => {
  const { store, advance } = makeStore()
  const record = ingest(store)
  const fresh = nodeOf(store, record.id)
  assert.ok(fresh)
  assert.ok(fresh.retention > 0.5, 'fresh memory is retained')
  assert.equal(fresh.state, 'active')

  advance(DAY * 2)
  const aged = nodeOf(store, record.id)
  assert.ok(aged.retention < fresh.retention, 'retention fell with time')
  const afterTwoDays = aged.retention

  advance(DAY * 4)
  const older = nodeOf(store, record.id)
  assert.ok(older.retention < afterTwoDays, 'retention keeps falling')

  advance(DAY * 60)
  const ancient = nodeOf(store, record.id)
  assert.equal(ancient.state, 'forgotten', 'a long-idle memory is forgotten')
  assert.ok(ancient.retention < 0.02)
})

test('rehearsal strengthens a memory and slows its decay', () => {
  const { store, advance } = makeStore()
  const record = ingest(store)
  advance(DAY * 3)
  const before = nodeOf(store, record.id)
  store.rehearse(record.id)
  const after = nodeOf(store, record.id)
  assert.ok(after.retention > before.retention, 'rehearsal reset the forgetting clock')
  assert.ok(after.stabilityDays > before.stabilityDays, 'rehearsal made the trace more stable')
  assert.ok(after.accessCount >= before.accessCount + 1)
})

// ---------------------------------------------------------------------------
// Forgetting / restoring / pinning
// ---------------------------------------------------------------------------

test('soft forget hides from recall, restore brings it back', () => {
  const { store } = makeStore()
  const record = ingest(store)
  store.forget(record.id)
  assert.equal(stateOf(store, record.id), 'forgotten')
  assert.equal(store.recall({ query: '记忆插件' }).some((memory) => memory.id === record.id), false)

  store.restore(record.id)
  assert.equal(stateOf(store, record.id), 'active')
  assert.ok(store.recall({ query: '记忆插件' }).some((memory) => memory.id === record.id))
})

test('pinned memories never fade and survive purge; hard forget erases', () => {
  const { store, advance } = makeStore()
  const pinned = ingest(store, { turn: 1 })
  const ghost = ingest(store, { turn: 2, userTexts: ['另一件小事'], assistantTexts: ['小事回答'] })
  store.pin(pinned.id, true)
  store.forget(ghost.id)
  advance(DAY * 365)
  assert.equal(stateOf(store, pinned.id), 'active', 'pinned memory stays')
  const removed = store.purge()
  assert.ok(removed >= 1, 'ghost purged')
  assert.ok(store.find(pinned.id), 'pinned memory survived purge')
  store.forget(pinned.id, true)
  assert.equal(store.find(pinned.id), undefined, 'hard forget removes the record')
})

// ---------------------------------------------------------------------------
// Sleep / consolidation
// ---------------------------------------------------------------------------

test('sleep consolidates episodes that share tags into semantic memories', () => {
  const { store } = makeStore()
  const prompts = [
    ['记忆插件 代码 开发 标签', '这是关于记忆插件代码的回答'],
    ['记忆插件 标签 代码 遗忘', '这是关于记忆插件标签的回答'],
    ['记忆插件 代码 遗忘 曲线', '这是关于记忆插件遗忘曲线的回答'],
  ]
  for (let index = 0; index < prompts.length; index += 1) {
    ingest(store, { sessionId: 'session-sleep', turn: index + 1, userTexts: [prompts[index][0]], assistantTexts: [prompts[index][1]] })
  }
  const result = store.commitLight(() => store.sleep())
  const semantic = store.memories.filter((memory) => memory.kind === 'semantic')
  assert.ok(result.marked >= 2, 'at least two episodes were marked consolidated')
  assert.ok(semantic.length >= 1, 'a semantic memory was created')
  assert.ok(semantic[0].memberIds.length >= 2)
  assert.ok(semantic[0].tags.length > 0)
  // A second sleep must not duplicate the same semantic memory.
  const semanticIds = new Set(store.memories.filter((memory) => memory.kind === 'semantic').map((memory) => memory.id))
  store.commitLight(() => store.sleep())
  const secondIds = new Set(store.memories.filter((memory) => memory.kind === 'semantic').map((memory) => memory.id))
  assert.equal(secondIds.size, semanticIds.size, 'consolidation is idempotent')
})

// ---------------------------------------------------------------------------
// Capacity / persistence
// ---------------------------------------------------------------------------

test('capacity ceiling evicts the least retrievable memories, never pinned ones', () => {
  const { store } = makeStore({ settings: { maxMemories: 100 } })
  const keeper = ingest(store, { sessionId: 'session-keep', turn: 1 })
  store.pin(keeper.id, true)
  for (let index = 0; index < 140; index += 1) {
    ingest(store, { sessionId: `session-${index % 3}`, turn: index + 2, userTexts: [`代码 记忆 第 ${index} 轮`] })
  }
  assert.ok(store.memories.length <= 100, 'capacity cap enforced')
  assert.ok(store.find(keeper.id), 'pinned memory is never evicted')
})

test('serialize/load round-trips and keeps dedupe state', () => {
  const { store } = makeStore()
  const first = ingest(store, { turn: 1 })
  ingest(store, { turn: 2, sessionId: 'session-2' })
  store.pin(first.id, true)
  const payload = store.serialize()
  const restored = new MemoryStore({ now: () => START })
  restored.load(payload)
  assert.equal(restored.memories.length, store.memories.length)
  assert.equal(restored.find(first.id)?.pinned, true)
  const again = restored.ingestTurn({ sessionId: first.sessionId, turn: first.turn, userTexts: ['x'], assistantTexts: ['y'] })
  assert.equal(again, null, 'dedupe index rebuilt after load')
})

test('load tolerates a corrupt payload', () => {
  const { store } = makeStore()
  store.load({ memories: [null, 42, { id: '' }, { id: 'ok', kind: 'episode', tags: ['#代码', ''], createdAt: 'nope' }] })
  assert.equal(store.memories.length, 1)
  assert.equal(store.memories[0].id, 'ok')
  store.load('not-an-object')
  assert.equal(store.memories.length, 1)
})

test('flush writes the persisted payload', async () => {
  const { store, writes } = makeStore()
  ingest(store)
  await store.flush()
  assert.ok(writes.length >= 1)
  const last = writes[writes.length - 1]
  assert.equal(last.version, 1)
  assert.ok(Array.isArray(last.memories) && last.memories.length === 1)
  assert.ok(last.settings !== undefined)
})

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

test('snapshot exposes the complete read model with intact edges', () => {
  const { store } = makeStore()
  const one = ingest(store, { turn: 1 })
  ingest(store, { turn: 2 })
  ingest(store, { turn: 1, sessionId: 'session-2', sessionTitle: '另一个任务' })
  const state = store.snapshot()

  assert.equal(state.version, 1)
  assert.equal(typeof state.revision, 'number')
  assert.ok(state.now > 0)
  assert.ok(state.stats.total >= 3)
  assert.ok(state.stats.sessions >= 2)
  assert.ok(Array.isArray(state.tags) && state.tags.length > 0)
  assert.ok(Array.isArray(state.sessions) && state.sessions.length >= 2)
  assert.ok(Array.isArray(state.nodes) && state.nodes.length === store.memories.length)
  assert.ok(Array.isArray(state.edges))

  const ids = new Set(state.nodes.map((node) => node.id))
  assert.ok(ids.has(one.id))
  for (const edge of state.edges) {
    assert.ok(ids.has(edge.source), 'edge source exists')
    assert.ok(ids.has(edge.target), 'edge target exists')
  }
  for (const node of state.nodes) {
    for (const key of [
      'id', 'kind', 'label', 'excerpt', 'tags', 'sessionId', 'sessionTitle', 'turn',
      'createdAt', 'lastAccessAt', 'accessCount', 'stabilityDays', 'salience',
      'retention', 'state', 'pinned', 'consolidated', 'x0', 'y0',
    ]) {
      assert.ok(key in node, `node.${key} present`)
    }
    assert.ok(node.retention >= 0 && node.retention <= 1)
    assert.ok(node.x0 >= -1 && node.x0 <= 1)
  }
})

test('recall filters by keyword and tag, ranks retained memories first', () => {
  const { store } = makeStore()
  const coding = ingest(store, {
    turn: 1,
    userTexts: ['插件开发 记忆 代码'],
    assistantTexts: ['好，我来实现记忆插件'],
  })
  ingest(store, {
    turn: 2,
    sessionId: 'session-2',
    userTexts: ['今天晚饭吃什么'],
    assistantTexts: ['随便，你决定'],
  })

  const byQuery = store.recall({ query: '插件' })
  assert.ok(byQuery.length >= 1)
  assert.equal(byQuery[0].id, coding.id)

  const tag = coding.tags[0]
  const byTag = store.recall({ tag })
  assert.ok(byTag.length >= 1)
  assert.ok(byTag.every((memory) => memory.tags.includes(tag)))

  const before = store.find(coding.id).accessCount
  store.rehearseMany([coding.id])
  assert.equal(store.find(coding.id).accessCount, before + 1)
})

test('settings update validates ranges and halfLifeDays changes the decay rate', () => {
  const slow = makeStore()
  assert.throws(() => slow.store.updateSettings({ halfLifeDays: 100 }), MemoryError)
  assert.throws(() => slow.store.updateSettings({ maxMemories: 1 }), MemoryError)
  slow.store.updateSettings({ halfLifeDays: 10, maxMemories: 300 })
  assert.equal(slow.store.settings.halfLifeDays, 10)

  const fast = makeStore()
  fast.store.updateSettings({ halfLifeDays: 0.5 })
  const slowRecord = ingest(slow.store)
  const fastRecord = ingest(fast.store)
  slow.advance(DAY)
  fast.advance(DAY)
  const slowRetention = nodeOf(slow.store, slowRecord.id).retention
  const fastRetention = nodeOf(fast.store, fastRecord.id).retention
  assert.ok(slowRetention > fastRetention, 'longer half-life forgets more slowly')
})

test('sessions grouping sorts by recency and carries titles', () => {
  const { store } = makeStore()
  ingest(store, { turn: 1, sessionId: 'session-a', sessionTitle: '任务 A' })
  ingest(store, { turn: 1, sessionId: 'session-b', sessionTitle: '任务 B' })
  const state = store.snapshot()
  const titles = state.sessions.map((session) => session.title)
  assert.ok(titles.includes('任务 A'))
  assert.ok(titles.includes('任务 B'))
  assert.ok(state.sessions.every((session) => session.count >= 1))
})

test('QQ source tags and session source survive encoding, grouping and reload', () => {
  const { store } = makeStore()
  const qq = store.ingestTurn({
    sessionId: 'session-qq',
    sessionTitle: 'QQ 聊天',
    turn: 1,
    userTexts: ['今天在 QQ 上聊了数学题和空间动态'],
    assistantTexts: ['好，我记下了'],
    source: 'qq',
    sourceTags: ['QQ'],
  })
  assert.ok(qq, 'QQ turn encoded')
  assert.equal(qq.source, 'qq')
  assert.ok(qq.tags.includes('qq'), 'QQ tag merged into the memory tags (normalized lowercase)')
  const normal = ingest(store, { turn: 1, sessionId: 'session-normal' })
  assert.equal(normal.source, '')

  const state = store.snapshot()
  assert.equal(state.sessions.find((row) => row.sessionId === 'session-qq').source, 'qq')
  assert.equal(state.sessions.find((row) => row.sessionId === 'session-normal').source, '')

  const hits = store.recall({ tag: 'QQ' })
  assert.ok(hits.some((memory) => memory.id === qq.id && memory.source === 'qq'))

  const restored = new MemoryStore({ now: () => START })
  restored.load(store.serialize())
  assert.equal(restored.find(qq.id).source, 'qq')
  assert.ok(restored.find(qq.id).tags.includes('qq'))
  assert.equal(restored.snapshot().sessions.find((row) => row.sessionId === 'session-qq').source, 'qq')
})

test('forgetAfterDays maps to the engine half-life and migrates legacy banks', () => {
  const { store } = makeStore()
  assert.equal(store.publicSettings().forgetAfterDays, 7)
  const expectedHalfLife = 3 * 7 / (1.5 * Math.log(1 / 0.12) * 2.3)
  assert.ok(Math.abs(store.settings.halfLifeDays - expectedHalfLife) < 1e-9, 'default 7-day horizon maps to the engine scale')

  store.updateSettings({ forgetAfterDays: 14 })
  assert.equal(store.publicSettings().forgetAfterDays, 14)
  assert.ok(store.settings.halfLifeDays > expectedHalfLife, 'a longer horizon stretches the forgetting curve')
  assert.throws(() => store.updateSettings({ forgetAfterDays: 0 }), MemoryError)

  // A legacy payload without the horizon adopts the new 7-day policy.
  const legacy = store.serialize()
  delete legacy.settings.forgetAfterDays
  legacy.settings.halfLifeDays = 3
  const migrated = new MemoryStore({ now: () => START })
  migrated.load(legacy)
  assert.equal(migrated.publicSettings().forgetAfterDays, 7)
  assert.ok(Math.abs(migrated.settings.halfLifeDays - expectedHalfLife) < 1e-9)
  assert.equal(migrated.serialize().settings.forgetAfterDays, 7)

  // A typical long turn is still active before day 7 and forgotten after it.
  const { store: fresh, advance } = makeStore()
  const record = fresh.ingestTurn({
    sessionId: 'session-horizon',
    sessionTitle: '遗忘时间验证',
    turn: 1,
    userTexts: ['记'.repeat(700)],
    assistantTexts: ['好'.repeat(120)],
    toolNames: ['write', 'read'],
  })
  advance(DAY * 3)
  assert.notEqual(nodeOf(fresh, record.id).state, 'forgotten')
  advance(DAY * 4)
  const atSeven = nodeOf(fresh, record.id)
  assert.ok(atSeven.retention < 0.2, `typical memory is near the forget threshold on day 7 (got ${atSeven.retention})`)
  advance(DAY * 4)
  assert.equal(nodeOf(fresh, record.id).state, 'forgotten')
})

test('reaching the forgetting time deletes the readable content', () => {
  const { store, advance } = makeStore()
  const record = ingest(store, {
    sessionId: 'session-forget',
    sessionTitle: '秘密任务',
    turn: 1,
    userTexts: ['这是一条会被遗忘的秘密记忆，里面有关键词 蓝鲸计划'],
    assistantTexts: ['好的，我记住了蓝鲸计划'],
    toolNames: ['write'],
  })
  assert.ok(record)
  assert.ok(store.find(record.id).userText.includes('蓝鲸计划'))
  assert.equal(store.sweepForgotten(), 0, 'nothing is forgotten while still retained')

  advance(DAY * 30)
  assert.equal(store.sweepForgotten(), 1, 'one memory reached the forgetting time')

  const tombstone = store.find(record.id)
  assert.ok(tombstone, 'the record survives as an empty tombstone')
  assert.equal(tombstone.contentPurged, true)
  assert.equal(tombstone.forgottenVia, 'time')
  assert.ok(tombstone.forgottenAt > 0)
  for (const field of ['userText', 'assistantText', 'excerpt', 'text', 'label', 'sessionTitle']) {
    assert.equal(tombstone[field], '', `${field} was deleted`)
  }
  assert.deepEqual(tombstone.tags, [])
  assert.deepEqual(tombstone.toolNames, [])
  const persisted = JSON.stringify(store.serialize())
  assert.equal(persisted.includes('蓝鲸计划'), false, 'content is gone from the persisted payload')
  assert.equal(store.recall({ query: '蓝鲸计划' }).length, 0, 'cannot be recalled any more')
  assert.throws(() => store.restore(record.id), MemoryError)
  assert.equal(store.sweepForgotten(), 0, 'sweep is idempotent')

  const reloaded = new MemoryStore({ now: () => START })
  reloaded.load(store.serialize())
  const reloadedTombstone = reloaded.find(record.id)
  assert.equal(reloadedTombstone.contentPurged, true)
  assert.equal(reloadedTombstone.excerpt, '')

  const slept = store.commitLight(() => store.sleep())
  assert.equal(slept.consolidated, 0)
  assert.equal(store.memories.filter((memory) => memory.kind === 'semantic').length, 0)
  advance(DAY * 10)
  store.commitLight(() => store.sleep())
  assert.equal(store.find(record.id), undefined, 'the tombstone was eventually purged')
})

test('manual forgetting stays reversible, sweep only deletes time-driven forgetting', () => {
  const { store, advance } = makeStore()
  const manual = ingest(store, { turn: 1, sessionId: 'session-manual' })
  store.forget(manual.id)
  advance(DAY * 2)
  assert.equal(store.sweepForgotten(), 0, 'manual ghosts are not scrubbed by the time sweep')
  assert.equal(store.find(manual.id).contentPurged, false)
  assert.notEqual(store.find(manual.id).excerpt, '')
  store.restore(manual.id)
  assert.equal(store.find(manual.id).forgottenAt, 0)
  assert.equal(store.find(manual.id).forgottenVia, '')
  assert.notEqual(store.find(manual.id).excerpt, '', 'restored memory keeps its content')
})

test('forgetting can be paused and resumed without losing or jumping memories', () => {
  const { store, advance } = makeStore()
  const record = ingest(store, { turn: 1, sessionId: 'session-pause', userTexts: ['这是一条暂停遗忘期间必须保住的记忆'], assistantTexts: ['好'] })
  store.updateSettings({ forgettingEnabled: false })
  assert.equal(store.publicSettings().forgettingEnabled, false)
  advance(DAY * 30)
  const pausedNode = store.snapshot().nodes.find((node) => node.id === record.id)
  assert.ok(pausedNode.retention > 0.99, 'retention is frozen while forgetting is paused')
  assert.equal(pausedNode.state, 'active')
  assert.equal(store.sweepForgotten(), 0, 'sweep does nothing while paused')
  const slept = store.commitLight(() => store.sleep())
  assert.equal(slept.scrubbed, 0)
  assert.ok(store.find(record.id), 'nothing is purged while paused')
  assert.notEqual(store.find(record.id).excerpt, '', 'content is intact while paused')

  store.updateSettings({ forgettingEnabled: true })
  assert.equal(store.publicSettings().forgettingEnabled, true)
  const afterResume = store.snapshot().nodes.find((node) => node.id === record.id)
  assert.notEqual(afterResume.state, 'forgotten', 'resuming does not instantly forget everything')

  store.updateSettings({ forgettingEnabled: false })
  const pausedPayload = store.serialize()
  assert.equal(pausedPayload.settings.forgettingEnabled, false)
  assert.ok(pausedPayload.forgettingPausedAt > 0)
  const reloaded = new MemoryStore({ now: () => pausedPayload.forgettingPausedAt + DAY })
  reloaded.load(pausedPayload)
  assert.equal(reloaded.publicSettings().forgettingEnabled, false)
  assert.equal(reloaded.effectiveNow(), pausedPayload.forgettingPausedAt)
})
