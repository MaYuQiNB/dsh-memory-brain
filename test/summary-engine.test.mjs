/**
 * Memory Brain — summary-engine contract tests (CONTRACT.md §16).
 *
 * Run from the plugin root:
 *   node --test --test-isolation=none test/summary-engine.test.mjs
 *
 * Covers: query-complexity heuristics (simple/medium/complex -> raw/daily/
 * weekly, Chinese + English keywords, length boundaries, reasons), the
 * feature rollback to raw, deterministic session summaries (<= 90 chars),
 * daily 'YYYY-MM-DD' digests with counts/topTags, ISO-week 'YYYY-Www' roll-ups
 * (including ISO week-year boundaries), buildSummaryLayers filtering of
 * semantic records and contentPurged tombstones, ordering, caps, midnight/day
 * boundaries and malformed-input safety.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSummaryLayers,
  classifyQueryComplexity,
  selectRetrievalLayer,
  summarizeDaily,
  summarizeSession,
  summarizeWeekly,
} from '../lib/summary-engine.js'
import * as summaryEngine from '../lib/summary-engine.js'

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const HOUR = 3600000

/**
 * Epoch ms of a local wall-clock instant. Building the timestamp with the local
 * constructor keeps every expected day key timezone-independent.
 */
function localTime(year, month, day, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

/** Expected local `YYYY-MM-DD` key of an instant (independent of the host TZ). */
function localDayKey(time) {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Code-point length — the unit the 90-character budget uses. */
function charLength(text) {
  return Array.from(text).length
}

// D1 = 2026-11-24 (Tue) and D2 = 2026-11-25 (Wed) are both ISO 2026-W48;
// D3 = 2026-11-30 (Mon) starts ISO 2026-W49.
const D1 = localTime(2026, 11, 24, 10)
const D2 = localTime(2026, 11, 25, 11)
const D3 = localTime(2026, 11, 30, 9)

/** One store-shaped episode record. */
function episode(overrides = {}) {
  return {
    id: 'ep-1',
    kind: 'episode',
    sessionId: 'sess-A',
    sessionTitle: '',
    turn: 1,
    excerpt: '',
    text: '',
    userText: '',
    tags: [],
    createdAt: D1,
    lastAccessAt: D1,
    contentPurged: false,
    ...overrides,
  }
}

/** Mixed bank: two sessions, one semantic record, one tombstone, junk values. */
function sampleBank() {
  return [
    episode({
      id: 'ep-a1',
      sessionId: 'sess-A',
      sessionTitle: '任务甲',
      excerpt: '甲的第一句。第二句。',
      tags: ['代码'],
      createdAt: D1,
      lastAccessAt: D1,
    }),
    episode({
      id: 'ep-a2',
      sessionId: 'sess-A',
      sessionTitle: '任务甲',
      excerpt: '甲的后续',
      tags: ['代码', '插件'],
      createdAt: D1 + HOUR,
      lastAccessAt: D1 + HOUR,
    }),
    episode({
      id: 'ep-b1',
      sessionId: 'sess-B',
      sessionTitle: '任务乙',
      excerpt: '乙的内容',
      tags: ['学习'],
      createdAt: D2,
      lastAccessAt: D2,
    }),
    episode({ id: 'ep-sem', kind: 'semantic', label: '代码', createdAt: D1 }),
    episode({ id: 'ep-tomb', sessionId: 'sess-C', excerpt: '', tags: [], createdAt: D2, contentPurged: true }),
    null,
    'garbage',
  ]
}

// ---------------------------------------------------------------------------
// classifyQueryComplexity
// ---------------------------------------------------------------------------

test('classifyQueryComplexity: a short plain question is simple/raw', () => {
  assert.deepEqual(classifyQueryComplexity('今天天气不错'), {
    level: 'simple',
    layer: 'raw',
    reasons: ['default'],
  })
})

test('classifyQueryComplexity: length thresholds 20/60 are boundaries', () => {
  const twenty = classifyQueryComplexity('字'.repeat(20))
  assert.deepEqual(twenty, { level: 'simple', layer: 'raw', reasons: ['default'] })

  const twentyOne = classifyQueryComplexity('字'.repeat(21))
  assert.deepEqual(twentyOne, { level: 'medium', layer: 'daily', reasons: ['length>20'] })

  const sixty = classifyQueryComplexity('字'.repeat(60))
  assert.equal(sixty.level, 'medium')

  const sixtyOne = classifyQueryComplexity('字'.repeat(61))
  assert.deepEqual(sixtyOne, { level: 'complex', layer: 'weekly', reasons: ['length>60'] })
})

test('classifyQueryComplexity: a complex Chinese keyword wins even in a short query', () => {
  assert.deepEqual(classifyQueryComplexity('帮我总结一下'), {
    level: 'complex',
    layer: 'weekly',
    reasons: ['keyword:总结'],
  })
  // 之前 is a medium keyword, but 回顾/为什么 map to the complex layer.
  assert.equal(classifyQueryComplexity('回顾一下之前的工作').level, 'complex')
  assert.equal(classifyQueryComplexity('这是为什么呀').layer, 'weekly')
})

test('classifyQueryComplexity: a medium Chinese keyword routes to daily', () => {
  const result = classifyQueryComplexity('上次那个方案放哪了')
  assert.equal(result.level, 'medium')
  assert.equal(result.layer, 'daily')
  assert.ok(result.reasons.includes('keyword:上次'))
})

test('classifyQueryComplexity: English keywords mirror the Chinese routing', () => {
  const complex = classifyQueryComplexity('please summarize the whole conversation')
  assert.equal(complex.level, 'complex')
  assert.equal(complex.layer, 'weekly')
  assert.deepEqual(complex.reasons, ['keyword:summarize', 'keyword:whole'])

  const medium = classifyQueryComplexity('what did we decide earlier?')
  assert.equal(medium.level, 'medium')
  assert.equal(medium.layer, 'daily')
  assert.ok(medium.reasons.includes('keyword:what'))
  assert.ok(medium.reasons.includes('keyword:earlier'))

  assert.equal(classifyQueryComplexity('hello there').level, 'simple')
})

test('classifyQueryComplexity: malformed queries never throw', () => {
  assert.deepEqual(classifyQueryComplexity(null), { level: 'simple', layer: 'raw', reasons: ['empty'] })
  assert.deepEqual(classifyQueryComplexity(undefined), { level: 'simple', layer: 'raw', reasons: ['empty'] })
  assert.deepEqual(classifyQueryComplexity('   '), { level: 'simple', layer: 'raw', reasons: ['empty'] })
  assert.equal(classifyQueryComplexity(42).level, 'simple')
  assert.equal(classifyQueryComplexity({}).level, 'simple')
  assert.equal(classifyQueryComplexity(Object.create(null)).level, 'simple')
  assert.doesNotThrow(() => classifyQueryComplexity(Symbol('query')))
})

// ---------------------------------------------------------------------------
// selectRetrievalLayer
// ---------------------------------------------------------------------------

test('selectRetrievalLayer: complexity maps to a layer when features are on', () => {
  const features = { layeredRecall: true, dailyWeeklySummary: true }
  assert.equal(selectRetrievalLayer(classifyQueryComplexity('帮我总结一下'), features), 'weekly')
  assert.equal(selectRetrievalLayer(classifyQueryComplexity('上次那个方案'), features), 'daily')
  assert.equal(selectRetrievalLayer(classifyQueryComplexity('今天天气'), features), 'raw')
  assert.equal(selectRetrievalLayer({ level: 'complex', layer: 'weekly' }), 'weekly')
  assert.equal(selectRetrievalLayer('medium'), 'daily')
  assert.equal(selectRetrievalLayer('weekly'), 'weekly')
})

test('selectRetrievalLayer: every rollback switch falls back to raw', () => {
  assert.equal(selectRetrievalLayer({ layer: 'weekly' }, { layeredRecall: false }), 'raw')
  assert.equal(selectRetrievalLayer({ layer: 'daily' }, { layeredRecall: 0 }), 'raw')
  assert.equal(selectRetrievalLayer({ layer: 'weekly' }, { layeredRecall: 'false' }), 'raw')
  assert.equal(
    selectRetrievalLayer({ layer: 'weekly' }, { layeredRecall: true, dailyWeeklySummary: false }),
    'raw',
  )
  assert.equal(
    selectRetrievalLayer({ layer: 'daily' }, { layeredRecall: true, dailyWeeklySummary: 0 }),
    'raw',
  )
  // Raw is always raw, whatever the switches say.
  assert.equal(selectRetrievalLayer({ layer: 'raw' }, { layeredRecall: false }), 'raw')
})

test('selectRetrievalLayer: malformed complexity/features are safe', () => {
  assert.equal(selectRetrievalLayer(null), 'raw')
  assert.equal(selectRetrievalLayer({}), 'raw')
  assert.equal(selectRetrievalLayer('not-a-layer'), 'raw')
  assert.equal(
    selectRetrievalLayer({ layer: 42, level: 'complex' }, { layeredRecall: true, dailyWeeklySummary: true }),
    'weekly',
  )
  assert.equal(selectRetrievalLayer({ layer: 'weekly' }, null), 'weekly')
  assert.equal(selectRetrievalLayer({ layer: 'weekly' }, 'nonsense'), 'weekly')
})

// ---------------------------------------------------------------------------
// summarizeSession
// ---------------------------------------------------------------------------

test('summarizeSession: one deterministic sentence, never over 90 characters', () => {
  const entries = {
    excerpts: ['今天我们应该把插件的缓存层重写一下，然后再跑一遍测试。后面的内容不应该出现在摘要里。'],
    tags: ['代码'],
    count: 2,
  }
  const first = summarizeSession(entries)
  assert.equal(first, '今天我们应该把插件的缓存层重写一下，然后再跑一遍测试。')
  assert.equal(first, summarizeSession(entries))
  assert.ok(charLength(first) <= 90)
})

test('summarizeSession: long text is truncated to exactly 90 characters', () => {
  const summary = summarizeSession({ excerpts: ['长'.repeat(200)] })
  assert.equal(charLength(summary), 90)
  assert.ok(summary.endsWith('…'))
  assert.equal(summary, summarizeSession({ excerpts: ['长'.repeat(200)] }))
})

test('summarizeSession: falls back through text, title, tags and placeholder', () => {
  assert.equal(summarizeSession({ texts: ['第一行\n第二行'] }), '第一行 第二行')
  assert.equal(summarizeSession({ title: '任务甲' }), '任务甲')
  assert.equal(summarizeSession({ tags: ['代码', '插件'] }), '与 代码、插件 相关的对话')
  assert.equal(summarizeSession({}), '暂无摘要')
  assert.equal(summarizeSession(null), '暂无摘要')
  assert.equal(summarizeSession([]), '暂无摘要')
})

test('summarizeSession: malformed entries stay safe', () => {
  assert.equal(summarizeSession({ excerpts: [null, 42, '有效内容'], tags: [1, '代码'], count: 'many' }), '有效内容')
  assert.equal(typeof summarizeSession(42), 'string')
  assert.equal(typeof summarizeSession([null, 'x', [1, 2], {}]), 'string')
  // Memory records are accepted directly, too.
  assert.equal(summarizeSession([{ excerpt: '记录摘要' }, { excerpt: '' }]), '记录摘要')
})

// ---------------------------------------------------------------------------
// summarizeDaily
// ---------------------------------------------------------------------------

test('summarizeDaily: date/count/topTags and a bounded deterministic text', () => {
  const input = {
    date: '2026-11-23',
    excerpts: ['今天把缓存层改完了。细节先不展开。'],
    tags: ['代码', '代码', '插件'],
    count: 3,
  }
  assert.deepEqual(summarizeDaily(input), {
    date: '2026-11-23',
    text: '2026-11-23 共 3 条记忆（代码、插件）：今天把缓存层改完了。',
    count: 3,
    topTags: ['代码', '插件'],
  })
  assert.deepEqual(summarizeDaily(input), summarizeDaily(input))
})

test('summarizeDaily: an array of records derives the local calendar date', () => {
  const daily = summarizeDaily([
    episode({ id: 'ep-1', excerpt: '第一条', createdAt: D1, lastAccessAt: D1 }),
    episode({ id: 'ep-2', excerpt: '第二条', createdAt: D1 + HOUR, lastAccessAt: D1 + HOUR }),
  ])
  assert.equal(daily.date, localDayKey(D1))
  assert.equal(daily.count, 2)
  assert.ok(daily.text.startsWith(localDayKey(D1)))
  assert.ok(daily.text.includes('共 2 条记忆'))
})

test('summarizeDaily: topTags cap at five with deterministic tie order', () => {
  const daily = summarizeDaily({ date: '2026-11-23', tags: ['b', 'a', 'c', 'd', 'e', 'f'], count: 1 })
  assert.deepEqual(daily.topTags, ['a', 'b', 'c', 'd', 'e'])
})

test('summarizeDaily: empty/malformed input degrades safely', () => {
  assert.deepEqual(summarizeDaily(null), { date: '', text: '', count: 0, topTags: [] })
  assert.deepEqual(summarizeDaily({}), { date: '', text: '', count: 0, topTags: [] })
  assert.deepEqual(summarizeDaily('nope'), { date: '', text: '', count: 0, topTags: [] })
  // An invalid calendar day is rejected instead of being normalised by Date.
  const badDate = summarizeDaily({ date: '2026-02-30', count: 2, excerpts: ['内容'] })
  assert.equal(badDate.date, '')
  assert.equal(badDate.count, 2)
  assert.equal(badDate.text, '共 2 条记忆：内容')
})

// ---------------------------------------------------------------------------
// summarizeWeekly
// ---------------------------------------------------------------------------

test('summarizeWeekly: rolls daily summaries into one ISO week', () => {
  assert.deepEqual(summarizeWeekly([
    { date: '2026-11-23', text: '2026-11-23 共 3 条记忆', count: 3, topTags: ['代码'] },
    { date: '2026-11-25', text: '2026-11-25 共 4 条记忆', count: 4, topTags: ['插件', '代码'] },
  ]), {
    week: '2026-W48',
    text: '2026-W48 共 7 条记忆，覆盖 2 天（2026-11-23 至 2026-11-25），主题：代码、插件',
    count: 7,
    topTags: ['代码', '插件'],
  })
})

test('summarizeWeekly: ISO week-year boundaries follow ISO-8601', () => {
  assert.equal(summarizeWeekly([{ date: '2026-01-01', count: 1 }]).week, '2026-W01')
  assert.equal(summarizeWeekly([{ date: '2025-12-29', count: 1 }]).week, '2026-W01')
  assert.equal(summarizeWeekly([{ date: '2027-01-01', count: 1 }]).week, '2026-W53')
  assert.equal(
    summarizeWeekly([{ date: '2026-11-25', count: 2, topTags: ['学习'] }]).text,
    '2026-W48 共 2 条记忆，覆盖 1 天（2026-11-25），主题：学习',
  )
})

test('summarizeWeekly: empty and malformed input degrades safely', () => {
  assert.deepEqual(summarizeWeekly([]), { week: '', text: '', count: 0, topTags: [] })
  assert.deepEqual(summarizeWeekly(null), { week: '', text: '', count: 0, topTags: [] })
  assert.deepEqual(summarizeWeekly([null, 42, {}, 'x']), { week: '', text: '', count: 0, topTags: [] })
  // A wrapper object around the daily list is accepted.
  assert.equal(summarizeWeekly({ dailySummaries: [{ date: '2026-11-25', count: 1 }] }).week, '2026-W48')
})

// ---------------------------------------------------------------------------
// buildSummaryLayers
// ---------------------------------------------------------------------------

test('buildSummaryLayers: only readable episodes feed the layers', () => {
  const layers = buildSummaryLayers(sampleBank(), { now: D2 })
  assert.equal(layers.sessions.length, 2)
  assert.deepEqual(layers.sessions.map((item) => item.sessionId), ['sess-B', 'sess-A'])

  const [sessionB, sessionA] = layers.sessions
  assert.equal(sessionB.title, '任务乙')
  assert.equal(sessionB.text, '乙的内容')
  assert.equal(sessionB.basedOnCount, 1)
  assert.equal(sessionA.title, '任务甲')
  assert.equal(sessionA.text, '甲的后续')
  assert.equal(sessionA.basedOnCount, 2)
  assert.equal(sessionA.updatedAt, D1 + HOUR)
  assert.ok(layers.sessions.every((item) => item.id.startsWith('sum-session-')))

  // The semantic record and the contentPurged tombstone are invisible.
  assert.equal(layers.sessions.some((item) => item.sessionId === 'sess-C'), false)
  assert.equal(layers.sessions.some((item) => item.sessionId === 'manual'), false)
})

test('buildSummaryLayers: daily layer groups by local calendar day, newest first', () => {
  const layers = buildSummaryLayers(sampleBank(), { now: D2 })
  assert.equal(layers.daily.length, 2)
  assert.deepEqual(layers.daily.map((item) => item.date), [localDayKey(D2), localDayKey(D1)])
  assert.deepEqual(layers.daily.map((item) => item.count), [1, 2])
  assert.deepEqual(layers.daily[1].topTags, ['代码', '插件'])
  assert.match(layers.daily[0].date, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(layers.daily[0].text.startsWith(`${localDayKey(D2)} 共 1 条记忆`))
  assert.ok(layers.daily.every((item) => item.id.startsWith('sum-day-')))
})

test('buildSummaryLayers: weekly layer rolls the daily layer into ISO weeks', () => {
  const layers = buildSummaryLayers(sampleBank(), { now: D2 })
  assert.equal(layers.weekly.length, 1)
  const [week] = layers.weekly
  assert.equal(week.week, '2026-W48')
  assert.equal(week.id, 'sum-week-2026-W48')
  assert.equal(week.count, 3)
  assert.equal(week.count, layers.daily.reduce((sum, item) => sum + item.count, 0))
  assert.match(week.text, /^2026-W48 共 3 条记忆，覆盖 2 天/)
  assert.deepEqual(week.topTags, ['代码', '学习', '插件'])
})

test('buildSummaryLayers: deterministic and does not mutate the input bank', () => {
  const bank = sampleBank()
  const snapshot = JSON.stringify(bank)
  const first = buildSummaryLayers(bank, { now: D2 })
  const second = buildSummaryLayers(bank, { now: D2 })
  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.equal(JSON.stringify(bank), snapshot)
})

test('buildSummaryLayers: maxSessions caps the session layer, newest first', () => {
  const bank = [
    episode({ id: 'ep-1', sessionId: 'sess-1', excerpt: '一', createdAt: D1, lastAccessAt: D1 }),
    episode({ id: 'ep-2', sessionId: 'sess-2', excerpt: '二', createdAt: D2, lastAccessAt: D2 }),
    episode({ id: 'ep-3', sessionId: 'sess-3', excerpt: '三', createdAt: D3, lastAccessAt: D3 }),
  ]
  assert.deepEqual(
    buildSummaryLayers(bank, { maxSessions: 2 }).sessions.map((item) => item.sessionId),
    ['sess-3', 'sess-2'],
  )
  assert.equal(buildSummaryLayers(bank, { maxSessions: 0 }).sessions.length, 0)
  assert.equal(buildSummaryLayers(bank, { maxSessions: -5 }).sessions.length, 0)
  // An invalid cap falls back to the contract default (100), not to 0.
  assert.equal(buildSummaryLayers(bank, { maxSessions: 'abc' }).sessions.length, 3)
  assert.equal(buildSummaryLayers(bank, {}).sessions.length, 3)
})

test('buildSummaryLayers: the midnight boundary splits days but keeps one ISO week', () => {
  const late = localTime(2026, 11, 24, 23, 59)
  const early = localTime(2026, 11, 25, 0, 1)
  const bank = [
    episode({ id: 'ep-late', sessionId: 'sess-x', excerpt: '深夜', createdAt: late, lastAccessAt: late }),
    episode({ id: 'ep-early', sessionId: 'sess-x', excerpt: '凌晨', createdAt: early, lastAccessAt: early }),
  ]
  const layers = buildSummaryLayers(bank)
  assert.equal(layers.daily.length, 2)
  assert.equal(layers.weekly.length, 1)
  assert.equal(layers.weekly[0].week, '2026-W48')
  assert.equal(layers.weekly[0].count, 2)
  assert.equal(layers.sessions.length, 1)
  assert.equal(layers.sessions[0].basedOnCount, 2)
})

test('buildSummaryLayers: records without a sessionId join the manual pseudo task', () => {
  const layers = buildSummaryLayers([
    episode({ id: 'ep-m', sessionId: '', sessionTitle: '', excerpt: '手动记下的事', createdAt: D1, lastAccessAt: D1 }),
  ])
  assert.equal(layers.sessions.length, 1)
  assert.equal(layers.sessions[0].sessionId, 'manual')
  assert.equal(layers.sessions[0].title, '手动记忆')
  assert.equal(layers.sessions[0].text, '手动记下的事')
})

test('buildSummaryLayers: empty/malformed input returns empty layers without throwing', () => {
  assert.deepEqual(buildSummaryLayers(null), { sessions: [], daily: [], weekly: [] })
  assert.deepEqual(buildSummaryLayers('nope'), { sessions: [], daily: [], weekly: [] })
  assert.deepEqual(buildSummaryLayers([]), { sessions: [], daily: [], weekly: [] })
  assert.deepEqual(buildSummaryLayers([null, 42, 'x', []]), { sessions: [], daily: [], weekly: [] })
  assert.deepEqual(buildSummaryLayers([
    episode({ id: 'ep-t', contentPurged: true, createdAt: D1 }),
    episode({ id: 'ep-s', kind: 'semantic', createdAt: D1 }),
  ]), { sessions: [], daily: [], weekly: [] })
  assert.deepEqual(buildSummaryLayers(undefined, { now: D1, maxSessions: 'x' }), {
    sessions: [],
    daily: [],
    weekly: [],
  })
  // A content-less record degrades to the deterministic placeholder text.
  assert.equal(buildSummaryLayers([{}]).sessions[0].text, '暂无摘要')
})

test('buildSummaryLayers: options.now is only a fallback clock for undated records', () => {
  const record = episode({
    id: 'ep-no-time',
    sessionId: 'sess-z',
    excerpt: '没有时间戳的记忆',
    createdAt: 'not-a-number',
    lastAccessAt: undefined,
  })
  const layers = buildSummaryLayers([record], { now: D1 })
  assert.equal(layers.sessions.length, 1)
  assert.equal(layers.sessions[0].updatedAt, D1)
  assert.equal(layers.daily.length, 1)
  assert.equal(layers.daily[0].date, localDayKey(D1))
})

test('buildSummaryLayers: every layer text respects its length budget', () => {
  const layers = buildSummaryLayers([
    episode({ id: 'ep-huge', excerpt: '超长内容'.repeat(200), tags: ['代码'], createdAt: D1, lastAccessAt: D1 }),
  ])
  assert.equal(charLength(layers.sessions[0].text), 90)
  assert.ok(charLength(layers.daily[0].text) <= 120)
  assert.ok(charLength(layers.weekly[0].text) <= 160)
})

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

test('module exposes the six contract functions', () => {
  for (const name of [
    'classifyQueryComplexity',
    'selectRetrievalLayer',
    'summarizeSession',
    'summarizeDaily',
    'summarizeWeekly',
    'buildSummaryLayers',
  ]) {
    assert.equal(typeof summaryEngine[name], 'function', `${name} must be exported`)
  }
})
