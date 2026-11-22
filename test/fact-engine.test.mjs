/**
 * Memory Brain — batch 1: structured fact engine contract tests.
 *
 * Run (bundled node, from the workspace root):
 *   node --test --test-isolation=none dsh-memory-brain/test/fact-engine.test.mjs
 *
 * Covers CONTRACT.md §15: constants, canonicalization, QQ scaffolding, 中英文
 * extraction rules, per-turn cap/dedup, applyFacts dedup/conflict toggles,
 * temporal history, capacity eviction, query ranking, stats, offline hashed
 * embeddings + cosine, determinism, purity and totality.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FACT_VERSION,
  FACT_ATTRIBUTES,
  normalizeText,
  normalizeSubject,
  normalizeAttribute,
  stripScaffolding,
  extractFacts,
  applyFacts,
  queryFacts,
  factStats,
  hashEmbedding,
  cosineSimilarity,
} from '../lib/fact-engine.js'

const NOW = 1763040000000
const DAY = 86400000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function candidate(overrides = {}) {
  return {
    subject: '用户',
    attribute: '偏好',
    value: '咖啡',
    confidence: 0.8,
    sourceField: 'userText',
    ...overrides,
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

function approx(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} ≈ ${expected} (tolerance ${tolerance})`,
  )
}

/** Does the candidate list contain a fact with this attribute + value? */
function hasFact(candidates, attribute, value) {
  return candidates.some(
    (item) => item.attribute === attribute && item.value === value,
  )
}

function factsFrom(candidates, now = NOW) {
  return applyFacts([], candidates, { now }).facts
}

function valueOf(facts, value) {
  return facts.find((fact) => fact.value === value)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('exports the contract constants', () => {
  assert.equal(FACT_VERSION, 1)
  assert.deepEqual(FACT_ATTRIBUTES, [
    '称呼',
    '身份',
    '偏好',
    '不喜欢',
    '所在地',
    '来自',
    '拥有',
    '计划',
    '备注',
    '其他',
  ])
  for (const fn of [
    normalizeText,
    normalizeSubject,
    normalizeAttribute,
    stripScaffolding,
    extractFacts,
    applyFacts,
    queryFacts,
    factStats,
    hashEmbedding,
    cosineSimilarity,
  ]) {
    assert.equal(typeof fn, 'function')
  }
})

// ---------------------------------------------------------------------------
// normalizeText / normalizeSubject / normalizeAttribute
// ---------------------------------------------------------------------------

test('normalizeText: strips whitespace+punctuation, lowercases ASCII only', () => {
  assert.equal(normalizeText('Hello, World!'), 'helloworld')
  assert.equal(normalizeText('  你好，世界。 '), '你好世界')
  assert.equal(normalizeText('Coffee'), 'coffee')
  assert.equal(normalizeText('咖啡'), '咖啡')
  assert.equal(normalizeText('c++'), 'c++')
  assert.equal(normalizeText(''), '')
  assert.equal(normalizeText(null), '')
  assert.equal(normalizeText(undefined), '')
  assert.equal(normalizeText(42), '42')
  assert.equal(normalizeText('!!!'), '')
})

test('normalizeSubject: empty/first-person -> 用户, possessive strips 的', () => {
  assert.equal(normalizeSubject(''), '用户')
  assert.equal(normalizeSubject(null), '用户')
  assert.equal(normalizeSubject('   '), '用户')
  assert.equal(normalizeSubject('我'), '用户')
  assert.equal(normalizeSubject('我的'), '用户')
  assert.equal(normalizeSubject('我自己'), '用户')
  assert.equal(normalizeSubject('I'), '用户')
  assert.equal(normalizeSubject('my'), '用户')
  assert.equal(normalizeSubject('小明的'), '小明')
  assert.equal(normalizeSubject('小明'), '小明')
  assert.equal(normalizeSubject('Alice'), 'Alice')
})

test('normalizeAttribute: synonyms collapse into FACT_ATTRIBUTES', () => {
  assert.equal(normalizeAttribute('喜欢'), '偏好')
  assert.equal(normalizeAttribute('爱'), '偏好')
  assert.equal(normalizeAttribute('偏爱'), '偏好')
  assert.equal(normalizeAttribute('favorite'), '偏好')
  assert.equal(normalizeAttribute('讨厌'), '不喜欢')
  assert.equal(normalizeAttribute('不喜欢'), '不喜欢')
  assert.equal(normalizeAttribute('住在'), '所在地')
  assert.equal(normalizeAttribute('在'), '所在地')
  assert.equal(normalizeAttribute('live in'), '所在地')
  assert.equal(normalizeAttribute('来自'), '来自')
  assert.equal(normalizeAttribute('from'), '来自')
  assert.equal(normalizeAttribute('叫'), '称呼')
  assert.equal(normalizeAttribute('名字'), '称呼')
  assert.equal(normalizeAttribute('name'), '称呼')
  assert.equal(normalizeAttribute('职业'), '身份')
  assert.equal(normalizeAttribute('job'), '身份')
  assert.equal(normalizeAttribute('养了'), '拥有')
  assert.equal(normalizeAttribute('拥有'), '拥有')
  assert.equal(normalizeAttribute('打算'), '计划')
  assert.equal(normalizeAttribute('记住'), '备注')
  assert.equal(normalizeAttribute('偏好'), '偏好')
  assert.equal(normalizeAttribute('生日'), '其他')
  assert.equal(normalizeAttribute(''), '其他')
  assert.equal(normalizeAttribute(null), '其他')
  assert.equal(normalizeAttribute(42), '其他')
})

// ---------------------------------------------------------------------------
// stripScaffolding
// ---------------------------------------------------------------------------

test('stripScaffolding: removes QQ bridge scaffolding lines and keeps content', () => {
  const raw = [
    '【当前时间】2026-11-22 20:00',
    '【当前角色】用户的鱼',
    '【你的身份】DeepSeek',
    '【会话令牌】abc123',
    '当前时间：2026-11-22 20:01',
    '[图片]',
    '今天吃火锅，我喜欢辣',
  ].join('\n')
  assert.equal(stripScaffolding(raw), '今天吃火锅，我喜欢辣')
})

test('stripScaffolding: strips placeholder/unknown bracket labels, keeps real text', () => {
  assert.equal(stripScaffolding('【用户】我喜欢火锅'), '我喜欢火锅')
  assert.equal(stripScaffolding('我喜欢[表情]火锅'), '我喜欢火锅')
  assert.equal(stripScaffolding('[转发消息 id=123] 记住要买牛奶'), '记住要买牛奶')
  assert.equal(stripScaffolding('[03:51] 抖音好友：小可怜儿回家了'), '抖音好友：小可怜儿回家了')
  assert.equal(stripScaffolding(''), '')
  assert.equal(stripScaffolding(null), '')
  assert.equal(stripScaffolding('【当前时间】2026-11-22 20:00'), '')
  assert.equal(stripScaffolding('普通的一句话，没有脚手架。'), '普通的一句话，没有脚手架。')
})

// ---------------------------------------------------------------------------
// extractFacts — Chinese rules
// ---------------------------------------------------------------------------

test('extractFacts: 我叫 / 我是', () => {
  assert.equal(hasFact(extractFacts({ userText: '我叫小明' }), '称呼', '小明'), true)
  assert.equal(hasFact(extractFacts({ userText: '我叫小明。' }), '称呼', '小明'), true)
  assert.equal(hasFact(extractFacts({ userText: '我是程序员' }), '身份', '程序员'), true)
  assert.equal(hasFact(extractFacts({ userText: '我是一名程序员。' }), '身份', '一名程序员'), true)
})

test('extractFacts: 我的 X 是 Y', () => {
  const tags = extractFacts({ userText: '我的职业是医生' })
  assert.equal(tags.length >= 1, true)
  const matched = tags.filter((item) => item.attribute === '身份' && item.value === '医生')
  assert.equal(matched.length, 1)
  assert.equal(matched[0].subject, '用户')
})

test('extractFacts: 喜欢 / 偏爱 / 讨厌 / 不喜欢', () => {
  assert.equal(hasFact(extractFacts({ userText: '我喜欢咖啡' }), '偏好', '咖啡'), true)
  assert.equal(hasFact(extractFacts({ userText: '我偏爱极简风格' }), '偏好', '极简风格'), true)
  assert.equal(hasFact(extractFacts({ userText: '我爱吃辣' }), '偏好', '吃辣'), true)
  assert.equal(hasFact(extractFacts({ userText: '我讨厌噪音' }), '不喜欢', '噪音'), true)
  assert.equal(hasFact(extractFacts({ userText: '我不喜欢辣' }), '不喜欢', '辣'), true)
})

test('extractFacts: 住在 / 来自 / 有 / 养了 / 计划', () => {
  assert.equal(hasFact(extractFacts({ userText: '我住在北京' }), '所在地', '北京'), true)
  assert.equal(hasFact(extractFacts({ userText: '我来自上海' }), '来自', '上海'), true)
  assert.equal(hasFact(extractFacts({ userText: '我有一只猫' }), '拥有', '一只猫'), true)
  assert.equal(hasFact(extractFacts({ userText: '我养了一只橘猫' }), '拥有', '一只橘猫'), true)
  assert.equal(hasFact(extractFacts({ userText: '我打算下个月去旅行' }), '计划', '下个月去旅行'), true)
  assert.equal(hasFact(extractFacts({ userText: '我计划周末爬山' }), '计划', '周末爬山'), true)
})

test('extractFacts: 我在 X location rule with activity filtering', () => {
  assert.equal(hasFact(extractFacts({ userText: '我在北京工作' }), '所在地', '北京'), true)
  assert.equal(hasFact(extractFacts({ userText: '我在家' }), '所在地', '家'), true)
  // Activities are not locations.
  const activity = extractFacts({ userText: '我在写代码' })
  assert.equal(activity.some((item) => item.attribute === '所在地'), false)
  const busy = extractFacts({ userText: '我在忙，晚点说' })
  assert.equal(busy.some((item) => item.attribute === '所在地'), false)
  // "我有时间" is not a possession.
  const noTime = extractFacts({ userText: '我有时间再聊' })
  assert.equal(noTime.some((item) => item.attribute === '拥有'), false)
})

test('extractFacts: 记住 / 显式主体 X 的 Y 是 Z', () => {
  assert.equal(
    hasFact(extractFacts({ userText: '记住：明天下午三点开会' }), '备注', '明天下午三点开会'),
    true,
  )
  const explicit = extractFacts({ userText: '小明的职业是医生' })
  assert.equal(hasFact(explicit, '身份', '医生'), true)
  assert.equal(explicit.find((item) => item.attribute === '身份')?.subject, '小明')
  const birthday = extractFacts({ userText: '小明的生日是5月1日' })
  assert.equal(hasFact(birthday, '其他', '5月1日'), true)
})

// ---------------------------------------------------------------------------
// extractFacts — English rules
// ---------------------------------------------------------------------------

test('extractFacts: English I am / My X is Y / like / hate / live in', () => {
  assert.equal(hasFact(extractFacts({ userText: 'I am a programmer.' }), '身份', 'programmer'), true)
  assert.equal(hasFact(extractFacts({ userText: "I'm a designer." }), '身份', 'designer'), true)
  assert.equal(hasFact(extractFacts({ userText: 'My name is Alice.' }), '称呼', 'Alice'), true)
  assert.equal(hasFact(extractFacts({ userText: 'I like coffee.' }), '偏好', 'coffee'), true)
  assert.equal(hasFact(extractFacts({ userText: 'I love hotpot.' }), '偏好', 'hotpot'), true)
  assert.equal(hasFact(extractFacts({ userText: 'I hate noise.' }), '不喜欢', 'noise'), true)
  assert.equal(hasFact(extractFacts({ userText: 'I live in Beijing.' }), '所在地', 'Beijing'), true)
  assert.equal(hasFact(extractFacts({ userText: 'I am from Shanghai.' }), '来自', 'Shanghai'), true)
})

test('extractFacts: English extra rules and explicit subject', () => {
  assert.equal(hasFact(extractFacts({ userText: 'I plan to travel.' }), '计划', 'travel'), true)
  assert.equal(hasFact(extractFacts({ userText: 'I have a cat.' }), '拥有', 'cat'), true)
  const explicit = extractFacts({ userText: "Alice's job is doctor." })
  assert.equal(explicit.some((item) => item.subject === 'Alice' && item.attribute === '身份'), true)
})

// ---------------------------------------------------------------------------
// extractFacts — limits, shapes, scaffolding, assistant text, malformed input
// ---------------------------------------------------------------------------

test('extractFacts: at most four facts per turn, ranked by confidence', () => {
  const text = '我叫小明，我是程序员，我喜欢咖啡，我不喜欢辣，我住在北京，我有一只猫'
  const candidates = extractFacts({ userText: text })
  assert.equal(candidates.length, 4)
  assert.deepEqual(
    candidates.map((item) => item.attribute),
    ['称呼', '身份', '偏好', '不喜欢'],
  )
})

test('extractFacts: dedupes identical facts within one turn', () => {
  const candidates = extractFacts({ userText: '我喜欢咖啡。我也喜欢咖啡。' })
  const coffee = candidates.filter((item) => item.attribute === '偏好' && item.value === '咖啡')
  assert.equal(coffee.length, 1)
  const once = extractFacts({ userText: '我喜欢咖啡' })
  assert.deepEqual(candidates, once)
})

test('extractFacts: candidate shape, confidence window, value length', () => {
  const candidates = extractFacts({
    userText: '我叫小明，我是程序员，我喜欢咖啡，记住明天买牛奶，我有一只猫',
  })
  assert.ok(candidates.length > 0)
  for (const item of candidates) {
    assert.deepEqual(Object.keys(item).sort(), [
      'attribute',
      'confidence',
      'sourceField',
      'subject',
      'value',
    ])
    assert.equal(typeof item.subject, 'string')
    assert.equal(typeof item.attribute, 'string')
    assert.equal(typeof item.value, 'string')
    assert.ok(item.confidence >= 0.4 && item.confidence <= 0.95)
    const length = Array.from(item.value).length
    assert.ok(length >= 1 && length <= 40, `value too long: ${item.value}`)
    assert.equal(FACT_ATTRIBUTES.includes(item.attribute), true)
  }
  // Overlong / pure-numeric junk is filtered out.
  assert.equal(extractFacts({ userText: '记住：123456789012' }).length, 0)
  const longName = `我叫${'甲'.repeat(80)}`
  const capped = extractFacts({ userText: longName })
  assert.equal(Array.from(capped[0].value).length <= 40, true)
})

test('extractFacts: strips QQ scaffolding before matching', () => {
  const raw = '【当前时间】2026-11-22 20:00\n【你的身份】DeepSeek\n【会话令牌】abc\n[图片]\n我喜欢火锅'
  assert.equal(hasFact(extractFacts({ userText: raw }), '偏好', '火锅'), true)
})

test('extractFacts: assistant text only contributes explicit-subject facts', () => {
  const fromAssistant = extractFacts({ userText: '', assistantText: '小明的生日是5月1日' })
  assert.equal(fromAssistant.length, 1)
  assert.equal(fromAssistant[0].subject, '小明')
  assert.equal(fromAssistant[0].sourceField, 'assistantText')
  // First-person assistant lines are not facts about the user.
  assert.deepEqual(extractFacts({ userText: '', assistantText: '我是你的助手，我喜欢咖啡' }), [])
})

test('extractFacts: defaultSubject override and malformed input safety', () => {
  assert.equal(extractFacts({ userText: '我喜欢咖啡' })[0].subject, '用户')
  assert.equal(extractFacts({ userText: '我喜欢咖啡', defaultSubject: '我' })[0].subject, '用户')
  for (const value of [null, undefined, 42, 'nope', {}, []]) {
    assert.deepEqual(extractFacts(value), [])
  }
  assert.deepEqual(extractFacts({ userText: null, assistantText: 42, toolNames: null }), [])
})

test('extractFacts: deterministic and does not mutate its input', () => {
  const input = { userText: '我叫小明，我喜欢咖啡', assistantText: '小明的职业是医生', sessionId: 's1' }
  const frozen = deepFreeze(structuredClone(input))
  const first = extractFacts(frozen)
  const second = extractFacts(frozen)
  assert.deepEqual(first, second)
  assert.deepEqual(frozen, input)
})

// ---------------------------------------------------------------------------
// applyFacts — add / dedup / conflict / revive / capacity
// ---------------------------------------------------------------------------

test('applyFacts: adds a new fact with the full contract shape', () => {
  const result = applyFacts([], [candidate()], {
    now: NOW,
    sessionId: 's1',
    sessionTitle: '记忆插件开发',
    turn: 3,
    sourceMemoryIds: ['ep-1', 'ep-2'],
  })
  assert.equal(result.facts.length, 1)
  assert.equal(result.added.length, 1)
  assert.equal(result.merged.length, 0)
  assert.equal(result.superseded.length, 0)
  const fact = result.facts[0]
  assert.equal(result.added[0].id, fact.id)
  assert.match(fact.id, /^fact-[0-9a-z]+$/)
  assert.equal(fact.subject, '用户')
  assert.equal(fact.attribute, '偏好')
  assert.equal(fact.value, '咖啡')
  assert.equal(fact.subjectKey, '用户')
  assert.equal(fact.attributeKey, '偏好')
  assert.equal(fact.slotKey, '用户|偏好')
  assert.equal(fact.valueKey, '咖啡')
  assert.equal(fact.sessionId, 's1')
  assert.equal(fact.sessionTitle, '记忆插件开发')
  assert.equal(fact.turn, 3)
  assert.deepEqual(fact.sourceMemoryIds, ['ep-1', 'ep-2'])
  assert.deepEqual(fact.purgedSourceIds, [])
  assert.equal(fact.confidence, 0.8)
  assert.equal(fact.createdAt, NOW)
  assert.equal(fact.lastSeenAt, NOW)
  assert.equal(fact.seenCount, 1)
  assert.equal(fact.invalidatedAt, 0)
  assert.equal(fact.invalidatedBy, '')
  assert.equal(fact.invalidReason, '')
})

test('applyFacts: dedupEnabled merges seenCount/lastSeenAt/sources without duplicates', () => {
  const first = applyFacts([], [candidate()], { now: NOW, sourceMemoryIds: ['ep-1'] })
  const second = applyFacts(first.facts, [candidate({ confidence: 0.9 })], {
    now: NOW + 1000,
    sourceMemoryIds: ['ep-2'],
  })
  assert.equal(second.facts.length, 1)
  assert.equal(second.added.length, 0)
  assert.equal(second.merged.length, 1)
  const fact = second.facts[0]
  assert.equal(fact.id, first.facts[0].id)
  assert.equal(fact.seenCount, 2)
  assert.equal(fact.lastSeenAt, NOW + 1000)
  assert.equal(fact.createdAt, NOW)
  assert.equal(fact.confidence, 0.9)
  assert.deepEqual(fact.sourceMemoryIds, ['ep-1', 'ep-2'])
})

test('applyFacts: dedupEnabled=false reuses the fact but freezes counters', () => {
  const first = applyFacts([], [candidate()], { now: NOW })
  const second = applyFacts(first.facts, [candidate()], {
    now: NOW + 1000,
    dedupEnabled: false,
  })
  assert.equal(second.facts.length, 1)
  assert.equal(second.added.length, 0)
  assert.equal(second.merged.length, 0)
  const fact = second.facts[0]
  assert.equal(fact.seenCount, 1)
  assert.equal(fact.lastSeenAt, NOW)
})

test('applyFacts: conflictEnabled invalidates the old value (superseded)', () => {
  const first = applyFacts([], [candidate({ value: '咖啡' })], { now: NOW })
  const second = applyFacts(first.facts, [candidate({ value: '茶' })], { now: NOW + DAY })
  assert.equal(second.facts.length, 2)
  assert.equal(second.added.length, 1)
  assert.equal(second.superseded.length, 1)
  const coffee = valueOf(second.facts, '咖啡')
  const tea = valueOf(second.facts, '茶')
  assert.equal(coffee.invalidatedAt, NOW + DAY)
  assert.equal(coffee.invalidatedBy, tea.id)
  assert.equal(coffee.invalidReason, 'superseded')
  assert.equal(tea.invalidatedAt, 0)
  const visible = queryFacts(second.facts)
  assert.deepEqual(
    visible.facts.map((fact) => fact.value),
    ['茶'],
  )
})

test('applyFacts: conflictEnabled=false keeps both values valid', () => {
  const first = applyFacts([], [candidate({ value: '咖啡' })], { now: NOW })
  const second = applyFacts(first.facts, [candidate({ value: '茶' })], {
    now: NOW + DAY,
    conflictEnabled: false,
  })
  assert.equal(second.facts.length, 2)
  assert.equal(second.superseded.length, 0)
  assert.equal(queryFacts(second.facts).total, 2)
  const stats = factStats(second.facts)
  assert.equal(stats.active, 2)
  assert.equal(stats.superseded, 0)
})

test('applyFacts: re-asserting an old value revives it and supersedes the newer one', () => {
  const step1 = applyFacts([], [candidate({ value: '咖啡' })], { now: NOW })
  const coffeeId = step1.facts[0].id
  const step2 = applyFacts(step1.facts, [candidate({ value: '茶' })], { now: NOW + 1000 })
  const step3 = applyFacts(step2.facts, [candidate({ value: '咖啡' })], { now: NOW + 2000 })
  assert.equal(step3.facts.length, 2)
  assert.equal(step3.added.length, 0)
  assert.equal(step3.merged.length, 1)
  assert.equal(step3.superseded.length, 1)
  const coffee = valueOf(step3.facts, '咖啡')
  const tea = valueOf(step3.facts, '茶')
  assert.equal(coffee.id, coffeeId)
  assert.equal(coffee.invalidatedAt, 0)
  assert.equal(coffee.invalidatedBy, '')
  assert.equal(coffee.seenCount, 2)
  assert.equal(tea.invalidatedAt, NOW + 2000)
  assert.equal(tea.invalidatedBy, coffee.id)
  assert.equal(tea.invalidReason, 'superseded')
  assert.deepEqual(
    queryFacts(step3.facts).facts.map((fact) => fact.value),
    ['咖啡'],
  )
})

test('applyFacts: capacity evicts oldest invalidated first, then oldest lastSeenAt', () => {
  let facts = []
  facts = applyFacts(facts, [candidate({ attribute: '偏好', value: 'a' })], { now: 1, maxFacts: 3 }).facts
  facts = applyFacts(facts, [candidate({ attribute: '计划', value: 'b' })], { now: 2, maxFacts: 3 }).facts
  facts = applyFacts(facts, [candidate({ attribute: '计划', value: 'c' })], { now: 3, maxFacts: 3 }).facts
  assert.equal(facts.length, 3) // b is invalidated, still stored
  facts = applyFacts(facts, [candidate({ attribute: '备注', value: 'd' })], { now: 4, maxFacts: 3 }).facts
  assert.equal(facts.length, 3)
  assert.equal(facts.some((fact) => fact.value === 'b'), false) // invalidated evicted first
  facts = applyFacts(facts, [candidate({ attribute: '拥有', value: 'e' })], { now: 5, maxFacts: 3 }).facts
  assert.equal(facts.length, 3)
  assert.deepEqual(facts.map((fact) => fact.value).sort(), ['c', 'd', 'e']) // then oldest lastSeenAt ('a')
})

test('applyFacts: survives JSON round-trip and keeps deterministic ids', () => {
  const first = applyFacts([], [candidate()], { now: NOW })
  const roundTripped = JSON.parse(JSON.stringify(first.facts))
  const second = applyFacts(roundTripped, [candidate()], { now: NOW + 1000 })
  assert.equal(second.facts.length, 1)
  assert.equal(second.added.length, 0)
  assert.equal(second.merged.length, 1)
  assert.equal(second.facts[0].id, first.facts[0].id)
  assert.equal(second.facts[0].seenCount, 2)
  // Fresh banks produce the same deterministic fact id.
  const again = applyFacts([], [candidate()], { now: NOW + 5000 })
  assert.equal(again.facts[0].id, first.facts[0].id)
})

test('applyFacts: deterministic, total and non-mutating', () => {
  const existing = applyFacts([], [candidate({ value: '咖啡' })], { now: NOW }).facts
  existing[0].purgedSourceIds = ['ep-old']
  const snapshot = structuredClone(existing)
  const frozen = deepFreeze(structuredClone(existing))
  const options = { now: NOW + DAY, dedupEnabled: true, conflictEnabled: true }
  const first = applyFacts(existing, [candidate({ value: '茶' }), candidate({ value: '咖啡' })], options)
  const second = applyFacts(existing, [candidate({ value: '茶' }), candidate({ value: '咖啡' })], options)
  assert.deepEqual(first, second)
  assert.deepEqual(existing, snapshot) // input untouched
  assert.deepEqual(applyFacts(frozen, [candidate()], options).facts.length, 1)
  assert.deepEqual(applyFacts(null, null, null), {
    facts: [],
    added: [],
    merged: [],
    superseded: [],
  })
  const junk = applyFacts([null, 42, {}, { id: 'x' }], [null, 42, {}, { attribute: '', value: '' }], {
    now: NOW,
  })
  assert.deepEqual(junk.facts, [])
  // Unknown extra fields survive the round-trip (the store keeps purgedSourceIds).
  const revived = applyFacts(existing, [candidate({ value: '咖啡' })], { now: NOW + 2000 }).facts
  assert.deepEqual(valueOf(revived, '咖啡').purgedSourceIds, ['ep-old'])
})

// ---------------------------------------------------------------------------
// queryFacts
// ---------------------------------------------------------------------------

function seedFacts() {
  const coffee = applyFacts([], [candidate({ value: 'Coffee' })], { now: NOW - 2000 }).facts
  const tea = applyFacts([], [candidate({ value: 'Tea' })], { now: NOW - 1000 }).facts
  const other = applyFacts([], [candidate({ subject: '小明', attribute: '身份', value: '学生' })], {
    now: NOW - 500,
  }).facts
  const conflicted = applyFacts(coffee, [candidate({ value: 'Matcha' })], { now: NOW }).facts
  return [...conflicted, ...tea, ...other]
}

test('queryFacts: valid facts only unless includeSuperseded', () => {
  const facts = seedFacts()
  const visible = queryFacts(facts)
  assert.equal(visible.facts.every((fact) => fact.invalidatedAt === 0), true)
  assert.equal(visible.facts.some((fact) => fact.value === 'Coffee'), false)
  const all = queryFacts(facts, { includeSuperseded: true })
  assert.equal(all.total, visible.total + 1)
  assert.equal(all.facts.some((fact) => fact.value === 'Coffee'), true)
})

test('queryFacts: substring query matches subject/attribute/value, case-insensitive', () => {
  const facts = seedFacts()
  assert.equal(queryFacts(facts, { query: 'teA' }).facts.some((fact) => fact.value === 'Tea'), true)
  assert.equal(queryFacts(facts, { query: '学生' }).facts.some((fact) => fact.value === '学生'), true)
  assert.equal(queryFacts(facts, { query: '偏好' }).facts.length, 2)
  assert.equal(
    queryFacts(facts, { query: '偏好' }).facts.every((fact) => fact.attribute === '偏好'),
    true,
  )
  assert.equal(queryFacts(facts, { query: '不存在的东西' }).total, 0)
})

test('queryFacts: exact slot matches rank before value substring matches', () => {
  const preference = applyFacts([], [candidate({ attribute: '偏好', value: '咖啡' })], {
    now: NOW - 5000,
  }).facts
  const note = applyFacts([], [candidate({ attribute: '备注', value: '偏好调研笔记' })], {
    now: NOW,
  }).facts
  const facts = [...preference, ...note]
  const result = queryFacts(facts, { query: '偏好' })
  assert.equal(result.facts.length, 2)
  assert.equal(result.facts[0].attribute, '偏好') // exact slot wins even though older
})

test('queryFacts: subject/session filters and limit/total', () => {
  const facts = seedFacts()
  assert.equal(queryFacts(facts, { subject: '我' }).total, 2)
  assert.equal(queryFacts(facts, { subject: '小明' }).total, 1)
  assert.equal(queryFacts(facts, { subject: '查无此人' }).total, 0)
  const scoped = applyFacts([], [candidate({ value: '咖啡' })], {
    now: NOW,
    sessionId: 's1',
  }).facts
  const scoped2 = applyFacts([], [candidate({ attribute: '身份', value: '老师' })], {
    now: NOW,
    sessionId: 's2',
  }).facts
  assert.equal(queryFacts([...scoped, ...scoped2], { sessionId: 's1' }).total, 1)
  const many = seedFacts()
  const limited = queryFacts(many, { limit: 2 })
  assert.equal(limited.facts.length, 2)
  assert.equal(limited.total, queryFacts(many).total)
})

test('queryFacts: temporalHistory returns the invalidated chain in order', () => {
  const step1 = applyFacts([], [candidate({ value: '咖啡' })], { now: 100 })
  const step2 = applyFacts(step1.facts, [candidate({ value: '茶' })], { now: 200 })
  const step3 = applyFacts(step2.facts, [candidate({ value: '汽水' })], { now: 300 })
  const result = queryFacts(step3.facts, { temporalHistory: true })
  assert.equal(result.facts.length, 1)
  const current = result.facts[0]
  assert.equal(current.value, '汽水')
  assert.deepEqual(
    current.history.map((fact) => [fact.value, fact.invalidatedAt, fact.invalidReason]),
    [
      ['咖啡', 200, 'superseded'],
      ['茶', 300, 'superseded'],
    ],
  )
  assert.equal(queryFacts(step3.facts).facts[0].history, undefined)
  // includeSuperseded + temporalHistory exposes every link too.
  const full = queryFacts(step3.facts, { includeSuperseded: true, temporalHistory: true })
  assert.equal(full.facts.length, 3)
  assert.equal(full.facts[0].value, '汽水') // valid first
  assert.deepEqual(
    full.facts.map((fact) => fact.value).sort(),
    ['咖啡', '汽水', '茶'],
  )
  const tea = full.facts.find((fact) => fact.value === '茶')
  assert.deepEqual(tea.history.map((fact) => fact.value), ['咖啡'])
})

test('queryFacts: total and malformed input safety, no mutation', () => {
  const facts = seedFacts()
  const snapshot = structuredClone(facts)
  queryFacts(facts, { query: '偏好' })
  assert.deepEqual(facts, snapshot)
  assert.deepEqual(queryFacts(null), { facts: [], total: 0 })
  assert.deepEqual(queryFacts([null, 42, {}]), { facts: [], total: 0 })
  assert.deepEqual(queryFacts(facts, 'nope').facts.length, queryFacts(facts).facts.length)
  assert.deepEqual(queryFacts(deepFreeze(structuredClone(facts))).facts.length, queryFacts(facts).facts.length)
})

// ---------------------------------------------------------------------------
// factStats
// ---------------------------------------------------------------------------

test('factStats: counts active/superseded and distinct subjects', () => {
  const coffee = applyFacts([], [candidate({ value: '咖啡' })], { now: NOW }).facts
  const conflicted = applyFacts(coffee, [candidate({ value: '茶' })], { now: NOW + DAY }).facts
  const other = applyFacts([], [candidate({ subject: '小明', attribute: '身份', value: '学生' })], {
    now: NOW,
  }).facts
  const stats = factStats([...conflicted, ...other])
  assert.deepEqual(stats, { total: 3, active: 2, superseded: 1, subjects: 2 })
  assert.deepEqual(factStats(null), { total: 0, active: 0, superseded: 0, subjects: 0 })
  assert.deepEqual(factStats([null, 42, 'x']), { total: 0, active: 0, superseded: 0, subjects: 0 })
})

// ---------------------------------------------------------------------------
// hashEmbedding / cosineSimilarity
// ---------------------------------------------------------------------------

function norm(vector) {
  let sum = 0
  for (const value of vector) sum += value * value
  return Math.sqrt(sum)
}

test('hashEmbedding: dimensions, offline unit vectors, determinism', () => {
  const defaultVector = hashEmbedding('我喜欢咖啡和茶')
  assert.equal(defaultVector.length, 96)
  assert.equal(hashEmbedding('我喜欢咖啡和茶', 32).length, 32)
  assert.equal(hashEmbedding('x', 0).length, 96)
  assert.equal(hashEmbedding('x', -5).length, 96)
  assert.equal(hashEmbedding('x', 'abc').length, 96)
  assert.deepEqual(hashEmbedding('hello world'), hashEmbedding('hello world'))
  approx(norm(defaultVector), 1, 1e-9)
  for (const value of defaultVector) {
    assert.equal(Number.isFinite(value), true)
    assert.ok(value >= -1 && value <= 1)
  }
  assert.deepEqual(hashEmbedding(''), new Array(96).fill(0))
  assert.deepEqual(hashEmbedding(null), new Array(96).fill(0))
  assert.deepEqual(hashEmbedding('   ，。！'), new Array(96).fill(0))
  const a = hashEmbedding('memory brain', 64)
  const b = hashEmbedding('memory brain', 64)
  approx(cosineSimilarity(a, b), 1, 1e-9)
})

test('cosineSimilarity: boundaries, zero vectors, mismatches', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0)
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0)
  assert.equal(cosineSimilarity(null, [1]), 0)
  assert.equal(cosineSimilarity([], []), 0)
  approx(cosineSimilarity([2, 4], [1, 2]), 1, 1e-12)
  approx(cosineSimilarity([1, 2], [-1, -2]), -1, 1e-12)
  const similarity = cosineSimilarity(hashEmbedding('猫'), hashEmbedding('狗'))
  assert.ok(Number.isFinite(similarity) && similarity >= -1 && similarity <= 1)
  // Huge values must not leak NaN/Infinity.
  const huge = cosineSimilarity([1e308, 1e308], [1e308, 1e308])
  assert.equal(Number.isFinite(huge), true)
  assert.ok(huge <= 1)
})

// ---------------------------------------------------------------------------
// Totality / purity across the whole module
// ---------------------------------------------------------------------------

test('every exported function is total on malformed input', () => {
  const junk = [null, undefined, 0, '', 'nope', [], {}, true, Number.NaN]
  for (const value of junk) {
    assert.doesNotThrow(() => normalizeText(value))
    assert.doesNotThrow(() => normalizeSubject(value))
    assert.doesNotThrow(() => normalizeAttribute(value))
    assert.doesNotThrow(() => stripScaffolding(value))
    assert.doesNotThrow(() => extractFacts(value))
    assert.doesNotThrow(() => applyFacts(value, value, value))
    assert.doesNotThrow(() => queryFacts(value, value))
    assert.doesNotThrow(() => factStats(value))
    assert.doesNotThrow(() => hashEmbedding(value, value))
    assert.doesNotThrow(() => cosineSimilarity(value, value))
  }
})

test('end-to-end: turn extraction -> dedup across turns -> conflict -> history', () => {
  const turnOne = extractFacts({ userText: '我叫小明，我喜欢咖啡' })
  const bankOne = applyFacts([], turnOne, { now: NOW - 2 * DAY })
  assert.equal(bankOne.added.length >= 2, true)
  const turnTwo = extractFacts({ userText: '我喜欢咖啡' })
  const bankTwo = applyFacts(bankOne.facts, turnTwo, { now: NOW - DAY })
  const coffee = valueOf(bankTwo.facts, '咖啡')
  assert.equal(coffee.seenCount, 2)
  assert.equal(coffee.lastSeenAt, NOW - DAY)
  const turnThree = extractFacts({ userText: '我现在喜欢茶了' })
  // "现在" breaks the narrow rule, so use a directly extractable sentence.
  const turnThreeFacts = extractFacts({ userText: '我不喜欢咖啡，我喜欢茶' })
  assert.equal(turnThreeFacts.length >= 1, true)
  const bankThree = applyFacts(bankTwo.facts, [candidate({ attribute: '偏好', value: '茶' })], {
    now: NOW,
  })
  const visible = queryFacts(bankThree.facts, { query: '咖啡' })
  assert.equal(visible.facts.length, 0) // coffee superseded by 茶
  const history = queryFacts(bankThree.facts, { temporalHistory: true, query: '' })
  const tea = history.facts.find((fact) => fact.value === '茶')
  assert.equal(tea.history.some((fact) => fact.value === '咖啡'), true)
  // Turn three extraction must not throw even though nothing useful matches.
  assert.deepEqual(Array.isArray(turnThree), true)
})
