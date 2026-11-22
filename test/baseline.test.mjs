/**
 * Fixed-question regression baseline for the layered memory upgrade.
 *
 * The store is deterministic (fixed clock + fixed fixture turns), so after any
 * change to extraction, dedup/conflict, summary layers or retrieval you can run
 * this file and compare against the pinned expectations. It also covers the
 * operational requirements: batch re-extraction of old data, idempotent
 * rebuilds, and a hard item cap on every recall answer.
 *
 * Run from the package directory:
 *   <node> --test --test-isolation=none test/baseline.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore } from '../lib/memory-store.js'

const START = Date.UTC(2026, 10, 20, 12, 0, 0)

/** Build a deterministic store. */
function makeStore(features) {
  return new MemoryStore({
    now: () => START,
    settings: { forgetAfterDays: 7 },
    features,
  })
}

/** Encode one fixed turn. */
function ingest(store, options) {
  return store.ingestTurn({
    sessionId: options.sessionId,
    sessionTitle: options.sessionTitle,
    turn: options.turn,
    userTexts: [options.userText],
    assistantTexts: [options.assistantText ?? '好的，记住了。'],
  })
}

/**
 * The fixed fixture: two tasks, one location conflict, one question turn that
 * must not produce facts. Every baseline test builds exactly this bank.
 */
function buildFixture(store) {
  ingest(store, { sessionId: 's1', sessionTitle: '记忆插件', turn: 1, userText: '我叫小明，我喜欢喝咖啡。' })
  ingest(store, { sessionId: 's1', sessionTitle: '记忆插件', turn: 2, userText: '我住在杭州。' })
  ingest(store, { sessionId: 's2', sessionTitle: '晚餐', turn: 1, userText: '晚上吃什么？', assistantText: '火锅。' })
  ingest(store, { sessionId: 's2', sessionTitle: '晚餐', turn: 2, userText: '我住在上海。' })
  ingest(store, { sessionId: 's3', sessionTitle: '数学', turn: 1, userText: '今天讲的求导怎么算？', assistantText: 'x^2 的导数是 2x。' })
}

/** Stable fact summary for comparisons. */
function factTriples(facts) {
  return facts
    .map((fact) => `${fact.subject}|${fact.attribute}|${fact.value}|${fact.seenCount}`)
    .sort()
}

/** @param {MemoryStore} store */
function rebuildAll(store) {
  store.rebuildFacts({ clear: true, now: START })
  store.rebuildSummaries({ now: START })
}

// ---------------------------------------------------------------------------
// 1) Old data batch re-extraction
// ---------------------------------------------------------------------------

test('batch re-extraction works on memories encoded before the feature existed', () => {
  const store = makeStore({ factExtraction: false, sessionSummary: false, dailyWeeklySummary: false })
  buildFixture(store)
  assert.equal(store.facts.length, 0, 'extraction was off while encoding')
  assert.equal(store.summaries.sessions.length, 0)

  store.updateFeatures({ factExtraction: true, sessionSummary: true, dailyWeeklySummary: true })
  // Old memories were encoded without facts; a full rebuild must pick them up.
  const result = store.rebuildFacts({ clear: true, now: START })
  assert.ok(result.total >= 3, `old bank re-extracted ${result.total} facts`)
  assert.deepEqual(factTriples(store.listFacts({ limit: 50 })), [
    '用户|偏好|喝咖啡|1',
    '用户|所在地|上海|1',
    '用户|称呼|小明|1',
  ], 'old memories produce exactly the expected facts')

  const summaryResult = store.rebuildSummaries({ now: START })
  assert.ok(summaryResult.sessions >= 3, 'session summaries cover old tasks')
  assert.ok(summaryResult.daily >= 1)
})

// ---------------------------------------------------------------------------
// 2) Idempotent rebuilds
// ---------------------------------------------------------------------------

test('running the full rebuild twice produces identical facts and summaries', () => {
  const store = makeStore()
  buildFixture(store)
  rebuildAll(store)
  const firstFacts = JSON.stringify(store.facts)
  const firstSummaries = JSON.stringify(store.summaries)
  const firstCounts = { facts: store.facts.length, ...store.summaryCounts() }

  rebuildAll(store)
  assert.equal(JSON.stringify(store.facts), firstFacts, 'facts are byte-identical on a second run')
  assert.equal(JSON.stringify(store.summaries), firstSummaries, 'summaries are byte-identical on a second run')
  assert.deepEqual({ facts: store.facts.length, ...store.summaryCounts() }, firstCounts)

  const keys = store.facts.map((fact) => `${fact.slotKey}|${fact.valueKey}`)
  assert.equal(new Set(keys).size, keys.length, 'no duplicate subject+attribute+value entries')
})

test('incremental rebuild never creates duplicate active facts', () => {
  const store = makeStore()
  buildFixture(store)
  store.rebuildFacts({ clear: true, now: START })
  const before = store.facts.filter((fact) => fact.invalidatedAt === 0).length
  // A non-clearing pass may refresh counters, but must not add duplicate slots.
  store.rebuildFacts({ clear: false, now: START })
  const active = store.facts.filter((fact) => fact.invalidatedAt === 0)
  const keys = active.map((fact) => `${fact.slotKey}|${fact.valueKey}`)
  assert.equal(new Set(keys).size, keys.length, 'active facts stay unique')
  assert.equal(active.length, before, 'no new active entries from a repeat run')
})

// ---------------------------------------------------------------------------
// 3) Hard recall cap
// ---------------------------------------------------------------------------

test('every retrieval answer is capped by the requested limit', () => {
  const store = makeStore()
  for (let turn = 1; turn <= 12; turn += 1) {
    ingest(store, { sessionId: 'cap', sessionTitle: '容量', turn, userText: `第 ${turn} 轮：这是用于容量测试的记忆内容。` })
  }
  const three = store.recallWithContext({ query: '', limit: 3, includeFacts: true })
  assert.ok(three.items.length <= 3, `limit 3 returned ${three.items.length}`)
  const huge = store.recallWithContext({ query: '', limit: 999, includeFacts: true })
  assert.ok(huge.items.length <= 30, 'hard ceiling is 30 items')
  // Structured helpers are capped too.
  assert.ok(store.listFacts({ limit: 2 }).length <= 2)
  const summaries = store.listSummaries('all', 2)
  assert.ok(summaries.sessions.length <= 2)
  assert.ok(summaries.daily.length <= 2)
  assert.ok(summaries.weekly.length <= 2)
})

// ---------------------------------------------------------------------------
// 4) Fixed-question regression baseline
// ---------------------------------------------------------------------------

test('fixed question set keeps its expected layers and contents', () => {
  const store = makeStore()
  buildFixture(store)
  rebuildAll(store)

  const EXPECTED = [
    { query: '记忆插件', layer: 'raw', kinds: ['episode', 'session-summary'] },
    { query: '上次我们聊了哪些内容', layer: 'daily', kinds: ['daily-summary'] },
    { query: '帮我总结一下最近都做了什么，整体回顾', layer: 'weekly', kinds: ['weekly-summary'] },
    { query: '', layer: 'raw', kinds: [] },
    { query: '小明', layer: 'raw', kinds: ['fact'] },
  ]

  for (const item of EXPECTED) {
    const result = store.recallWithContext({ query: item.query, limit: 6, includeFacts: true })
    assert.equal(result.layer, item.layer, `layer for «${item.query}»`)
    if (item.kinds.length > 0) {
      for (const kind of item.kinds) {
        assert.ok(result.items.some((entry) => entry.kind === kind), `«${item.query}» returns a ${kind}`)
      }
    }
  }

  // Pinned fact baseline: name / preference / latest location only.
  assert.deepEqual(factTriples(store.listFacts({ limit: 50 })), [
    '用户|偏好|喝咖啡|1',
    '用户|所在地|上海|1',
    '用户|称呼|小明|1',
  ])
  // Conflict history is still reachable through the temporal view.
  const history = store.listFacts({ includeSuperseded: true, limit: 50 })
  assert.ok(history.some((fact) => fact.invalidatedAt > 0 && fact.value === '杭州'), 'old location kept as history')
})
