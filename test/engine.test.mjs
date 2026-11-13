/**
 * Memory Brain — memory-engine contract tests.
 *
 * Run from the plugin root:
 *   node --test test/engine.test.mjs
 *
 * Every test point listed in CONTRACT.md §3 "引擎测试" is covered here:
 * retention monotonic decay, stability growth, threshold boundaries, pinned
 * immortality, normalizeTag edges, bilingual + tool tagging, deterministic /
 * non-repeating consolidation, graph integrity & determinism, stats
 * self-consistency and seedPosition range/determinism.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ENGINE_VERSION,
  DAY_MS,
  DEFAULT_SETTINGS,
  clamp,
  hash32,
  seedPosition,
  resolveSettings,
  stabilityDays,
  retentionAt,
  memoryState,
  projectRetention,
  normalizeTag,
  extractTags,
  autoTagsForEpisode,
  consolidateEpisodes,
  buildGraph,
  computeStats,
  tagCounts,
} from '../lib/memory-engine.js'

const NOW = 1763040000000
const DAY = DAY_MS
const HOUR = 3600000

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** One store-shaped episode record. */
function episode(overrides = {}) {
  return {
    id: 'ep-1',
    kind: 'episode',
    label: '',
    tags: [],
    sessionId: 'session-1',
    sessionTitle: '',
    turn: 1,
    excerpt: '',
    text: '',
    createdAt: NOW,
    lastAccessAt: NOW,
    accessCount: 1,
    salience: 1,
    pinned: false,
    consolidated: false,
    memberIds: [],
    forgottenAt: 0,
    ...overrides,
  }
}

/** One store-shaped semantic record. */
function semantic(overrides = {}) {
  return episode({ kind: 'semantic', turn: 0, label: '', ...overrides })
}

function daysAgo(days) {
  return NOW - days * DAY
}

function approx(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} ≈ ${expected} (tolerance ${tolerance})`,
  )
}

function roundTo(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

function assertGraphIntegrity(graph) {
  assert.ok(Array.isArray(graph.nodes))
  assert.ok(Array.isArray(graph.edges))
  const ids = new Set(graph.nodes.map((node) => node.id))
  assert.equal(ids.size, graph.nodes.length, 'node ids must be unique')
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.source), `dangling edge source: ${edge.source}`)
    assert.ok(ids.has(edge.target), `dangling edge target: ${edge.target}`)
  }
  const edgeIds = new Set(graph.edges.map((edge) => edge.id))
  assert.equal(edgeIds.size, graph.edges.length, 'edge ids must be unique')
}

// ---------------------------------------------------------------------------
// Constants and exports
// ---------------------------------------------------------------------------

test('exports the contract constants and function set', () => {
  assert.equal(ENGINE_VERSION, 1)
  assert.equal(DAY_MS, 86400000)
  assert.deepEqual(DEFAULT_SETTINGS, {
    halfLifeDays: 3,
    baseStabilityDays: 1.5,
    fadingThreshold: 0.35,
    forgetThreshold: 0.12,
    purgeThreshold: 0.02,
    consolidateEveryHours: 6,
    maxMemories: 600,
    rehearsalBoostDays: 0.9,
    maxStabilityDays: 90,
    toolSalienceBoost: 0.06,
    autoCapture: true,
  })
  const functions = [
    clamp,
    hash32,
    seedPosition,
    resolveSettings,
    stabilityDays,
    retentionAt,
    memoryState,
    projectRetention,
    normalizeTag,
    extractTags,
    autoTagsForEpisode,
    consolidateEpisodes,
    buildGraph,
    computeStats,
    tagCounts,
  ]
  for (const fn of functions) assert.equal(typeof fn, 'function')
})

// ---------------------------------------------------------------------------
// clamp / hash32 / seedPosition / resolveSettings
// ---------------------------------------------------------------------------

test('clamp: clamps numbers and falls back to lo for non-numbers', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-5, 0, 10), 0)
  assert.equal(clamp(15, 0, 10), 10)
  assert.equal(clamp(0, 0, 10), 0)
  assert.equal(clamp(10, 0, 10), 10)
  assert.equal(clamp(Number.NaN, 2, 8), 2)
  assert.equal(clamp(Number.POSITIVE_INFINITY, 2, 8), 2)
  assert.equal(clamp('5', 2, 8), 2) // non-number per contract -> lo
  assert.equal(clamp(null, 2, 8), 2)
  assert.equal(clamp(undefined, 1, 3), 1)
  assert.equal(clamp(5, 10, 0), 10) // inverted range collapses to lo
})

test('hash32: stable FNV-1a 32-bit vectors and uint32 output', () => {
  assert.equal(hash32(''), 0x811c9dc5)
  assert.equal(hash32('a'), 0xe40c292c)
  assert.equal(hash32('foobar'), 0xbf9cf968)
  for (const value of ['', 'x', '记忆脑', 'a'.repeat(1000)]) {
    const hash = hash32(value)
    assert.equal(Number.isInteger(hash), true)
    assert.ok(hash >= 0 && hash <= 0xffffffff)
  }
  assert.equal(hash32(null), hash32(''))
  assert.equal(hash32(undefined), hash32(''))
})

test('seedPosition: deterministic, inside [-1, 1], spreads ids', () => {
  assert.deepEqual(seedPosition('ep-abc'), seedPosition('ep-abc'))
  assert.equal(typeof seedPosition('ep-abc').x, 'number')
  assert.equal(typeof seedPosition('ep-abc').y, 'number')
  const seen = new Set()
  for (let index = 0; index < 200; index += 1) {
    const position = seedPosition(`ep-${index}`)
    assert.ok(position.x >= -1 && position.x <= 1, `x out of range: ${position.x}`)
    assert.ok(position.y >= -1 && position.y <= 1, `y out of range: ${position.y}`)
    seen.add(`${position.x},${position.y}`)
  }
  assert.ok(seen.size > 190, 'seed positions should spread out')
  assert.deepEqual(seedPosition(null), seedPosition(''))
  assert.notDeepEqual(seedPosition('ep-1'), seedPosition('ep-2'))
})

test('resolveSettings: defaults, overrides, clamping and no mutation', () => {
  assert.deepEqual(resolveSettings(), { ...DEFAULT_SETTINGS })
  assert.deepEqual(resolveSettings(null), { ...DEFAULT_SETTINGS })
  assert.deepEqual(resolveSettings('nonsense'), { ...DEFAULT_SETTINGS })
  const merged = resolveSettings({ halfLifeDays: 6, autoCapture: false })
  assert.equal(merged.halfLifeDays, 6)
  assert.equal(merged.autoCapture, false)
  assert.equal(merged.baseStabilityDays, DEFAULT_SETTINGS.baseStabilityDays)
  assert.equal(resolveSettings({ halfLifeDays: 100 }).halfLifeDays, 30)
  assert.equal(resolveSettings({ halfLifeDays: 0 }).halfLifeDays, 0.5)
  assert.equal(resolveSettings({ maxMemories: 5 }).maxMemories, 100)
  assert.equal(resolveSettings({ maxMemories: 5000 }).maxMemories, 2000)
  assert.equal(resolveSettings({ fadingThreshold: 2 }).fadingThreshold, 1)
  assert.equal(resolveSettings({ forgetThreshold: -1 }).forgetThreshold, 0)
  assert.equal(resolveSettings({ halfLifeDays: '6' }).halfLifeDays, 6)
  assert.equal(resolveSettings({ halfLifeDays: 'abc' }).halfLifeDays, 3)
  // The threshold ladder stays ordered even in a corrupt settings file.
  assert.equal(resolveSettings({ fadingThreshold: 0.2, forgetThreshold: 0.9 }).forgetThreshold, 0.2)
  assert.equal(resolveSettings({ purgeThreshold: 0.5 }).purgeThreshold, 0.12)
  // Fresh copy each call: writing to the result never leaks into defaults.
  const partial = { halfLifeDays: 100 }
  resolveSettings(partial)
  assert.deepEqual(partial, { halfLifeDays: 100 })
  const first = resolveSettings()
  first.halfLifeDays = 99
  assert.equal(resolveSettings().halfLifeDays, 3)
})

// ---------------------------------------------------------------------------
// stabilityDays
// ---------------------------------------------------------------------------

test('stabilityDays: base = baseStabilityDays * halfLifeDays / default half-life', () => {
  approx(stabilityDays(episode()), 1.5)
  approx(stabilityDays(episode(), { halfLifeDays: 6 }), 3)
  approx(stabilityDays(episode(), { halfLifeDays: 0.5 }), 0.25)
  // A per-memory baseDays override replaces the settings-derived base.
  approx(stabilityDays(episode({ baseDays: 10 }), { halfLifeDays: 6 }), 10)
  approx(stabilityDays(null), 1.5) // malformed memory behaves like a fresh one
})

test('stabilityDays: grows with accessCount and respects maxStabilityDays', () => {
  const fresh = stabilityDays(episode({ accessCount: 1 }))
  const rehearsed = stabilityDays(episode({ accessCount: 2 }))
  const repeated = stabilityDays(episode({ accessCount: 5 }))
  assert.ok(rehearsed > fresh)
  assert.ok(repeated > rehearsed)
  approx(rehearsed, 1.5 * 1.9)
  approx(repeated, 1.5 * (1 + 0.9 * 4))
  assert.equal(stabilityDays(episode({ accessCount: 1000000 }), { maxStabilityDays: 20 }), 20)
})

test('stabilityDays: salience scales (clamped 0.5..3) and pinned hits the ceiling', () => {
  approx(stabilityDays(episode({ salience: 2 })), 3)
  approx(stabilityDays(episode({ salience: 99 })), 4.5) // salience clamped to 3
  approx(stabilityDays(episode({ salience: 0.01 })), 0.75) // salience clamped to 0.5
  assert.equal(
    stabilityDays(episode({ pinned: true, accessCount: 1 })),
    DEFAULT_SETTINGS.maxStabilityDays,
  )
  assert.equal(stabilityDays(episode({ pinned: true, salience: 0.5 })), 90)
  assert.equal(stabilityDays(episode({ pinned: true }), { maxStabilityDays: 12 }), 12)
})

// ---------------------------------------------------------------------------
// retentionAt / projectRetention / memoryState
// ---------------------------------------------------------------------------

test('retentionAt: exp(-elapsedDays / stabilityDays), exactly 1 at the last access', () => {
  const memory = episode()
  assert.equal(retentionAt(memory, NOW), 1)
  approx(retentionAt(memory, NOW + 1.5 * DAY), Math.exp(-1))
  approx(retentionAt(memory, NOW + 1.5 * DAY), 0.36787944117144233)
  approx(retentionAt(memory, NOW + 0.75 * DAY), Math.exp(-0.5))
  // Rehearsal slows the decay: a more rehearsed trace is stronger at the same instant.
  const rehearsed = episode({ accessCount: 5 })
  assert.ok(retentionAt(rehearsed, NOW + 2 * DAY) > retentionAt(memory, NOW + 2 * DAY))
})

test('retentionAt: strictly monotonic decay, always within [0, 1]', () => {
  const memory = episode()
  let previous = Number.POSITIVE_INFINITY
  for (const days of [0, 0.25, 0.5, 1, 2, 4, 8, 16, 60]) {
    const retention = retentionAt(memory, NOW + days * DAY)
    assert.ok(retention >= 0 && retention <= 1)
    assert.ok(retention < previous, `retention should strictly decay at +${days}d`)
    previous = retention
  }
  assert.equal(retentionAt(memory, NOW + 365000 * DAY), 0) // underflow, never negative/NaN
})

test('retentionAt: pinned never forgets, forgottenAt forces 0', () => {
  const pinned = episode({ pinned: true, lastAccessAt: NOW - 5000 * DAY })
  assert.equal(retentionAt(pinned, NOW), 1)
  assert.equal(projectRetention(pinned, NOW, 365 * DAY), 1)
  assert.equal(memoryState(pinned, NOW), 'active')
  const forgotten = episode({ forgottenAt: NOW - DAY, lastAccessAt: NOW })
  assert.equal(retentionAt(forgotten, NOW), 0)
  assert.equal(memoryState(forgotten, NOW), 'forgotten')
  // Pinned is checked first per the contract state machine.
  assert.equal(memoryState(episode({ pinned: true, forgottenAt: NOW }), NOW), 'active')
})

test('retentionAt: store convention forgottenAt: 0 means "not forgotten"', () => {
  const memory = episode({ forgottenAt: 0, lastAccessAt: NOW - 0.5 * DAY })
  assert.ok(retentionAt(memory, NOW) > 0)
  assert.notEqual(memoryState(memory, NOW), 'forgotten')
})

test('retentionAt: invalid timestamps are treated as 0', () => {
  const memory = episode({ lastAccessAt: Number.NaN })
  const retention = retentionAt(memory, NOW)
  assert.ok(retention < 1e-6, `expected ~0, got ${retention}`)
  assert.equal(retentionAt(episode(), Number.NaN), 1) // atTime 0 == lastAccess 0
  for (const value of [null, undefined, {}, 'nope']) {
    const result = retentionAt(value, NOW)
    assert.ok(Number.isFinite(result) && result >= 0 && result <= 1)
  }
})

test('projectRetention: curve evaluated at now + afterMs', () => {
  const memory = episode({ lastAccessAt: NOW - 3 * DAY })
  for (const offset of [0, HOUR, DAY, 30 * DAY]) {
    assert.equal(projectRetention(memory, NOW, offset), retentionAt(memory, NOW + offset))
  }
  assert.equal(projectRetention(memory, NOW, Number.NaN), retentionAt(memory, NOW))
})

test('memoryState: strict threshold boundaries (< means the worse state)', () => {
  const memory = episode({ lastAccessAt: NOW - 2 * DAY })
  const retention = retentionAt(memory, NOW)
  assert.ok(retention > DEFAULT_SETTINGS.forgetThreshold)
  assert.ok(retention < DEFAULT_SETTINGS.fadingThreshold)
  assert.equal(memoryState(memory, NOW), 'fading')
  // Exactly on a threshold stays in the milder state (strict <).
  assert.equal(memoryState(memory, NOW, { fadingThreshold: retention }), 'active')
  assert.equal(
    memoryState(memory, NOW, { fadingThreshold: 0.9, forgetThreshold: retention }),
    'fading',
  )
  assert.equal(
    memoryState(memory, NOW, { fadingThreshold: 0.9, forgetThreshold: retention + 1e-6 }),
    'forgotten',
  )
})

test('memoryState: bands just above/below each threshold', () => {
  const stability = stabilityDays(episode())
  const lastAccessFor = (retention) => NOW - -Math.log(retention) * stability * DAY
  const cases = [
    [0.36, 'active'],
    [0.34, 'fading'],
    [0.13, 'fading'],
    [0.11, 'forgotten'],
  ]
  for (const [retention, expected] of cases) {
    const memory = episode({ lastAccessAt: lastAccessFor(retention) })
    approx(retentionAt(memory, NOW), retention, 1e-3)
    assert.equal(memoryState(memory, NOW), expected, `retention ${retention}`)
  }
})

// ---------------------------------------------------------------------------
// normalizeTag
// ---------------------------------------------------------------------------

test('normalizeTag: trims, strips #, lowercases ASCII, collapses whitespace', () => {
  assert.equal(normalizeTag('  #插件  '), '插件')
  assert.equal(normalizeTag('Code Review'), 'code-review')
  assert.equal(normalizeTag('  Code   REVIEW '), 'code-review')
  assert.equal(normalizeTag('## 代码 ##'), '代码')
  assert.equal(normalizeTag('记忆脑'), '记忆脑')
  assert.equal(normalizeTag('#Tag'), 'tag')
  assert.equal(normalizeTag('a\t b\nc'), 'a-b-c')
  assert.equal(normalizeTag('c++'), 'c++')
  assert.equal(normalizeTag('C_Sharp.v2'), 'c_sharp.v2')
  assert.equal(normalizeTag('ÄBC'), 'Äbc') // only ASCII letters are lowered
})

test('normalizeTag: rejects empty, symbol-only and over-long input', () => {
  assert.equal(normalizeTag(''), '')
  assert.equal(normalizeTag('    '), '')
  assert.equal(normalizeTag('!!!'), '')
  assert.equal(normalizeTag('###'), '')
  assert.equal(normalizeTag('-_-'), '')
  assert.equal(normalizeTag(null), '')
  assert.equal(normalizeTag(undefined), '')
  assert.equal(normalizeTag(42), '')
  assert.equal(normalizeTag('a'.repeat(25)), '')
  assert.equal(normalizeTag('a'.repeat(24)), 'a'.repeat(20))
  assert.equal(normalizeTag('记'.repeat(25)), '')
  assert.equal(normalizeTag('记'.repeat(24)), '记'.repeat(20))
  assert.equal(Array.from(normalizeTag('记'.repeat(24))).length, 20)
})

// ---------------------------------------------------------------------------
// extractTags / autoTagsForEpisode
// ---------------------------------------------------------------------------

test('extractTags: Chinese themes come first', () => {
  const tags = extractTags('帮我写一个插件，处理代码和报错日志', {})
  assert.ok(tags.includes('插件'))
  assert.ok(tags.includes('代码'))
  assert.ok(tags.includes('调试'))
  assert.ok(tags.length <= 8)
  assert.equal(new Set(tags).size, tags.length)
})

test('extractTags: English keywords match on word boundaries', () => {
  const tags = extractTags('Please refactor this plugin code and run the tests', {})
  assert.ok(tags.includes('代码'))
  assert.ok(tags.includes('插件'))
  assert.ok(tags.includes('测试'))
  // "encode" must not count as "code".
  assert.ok(!extractTags('encode decode encoder', {}).includes('代码'))
})

test('extractTags: tool names map to tags in order, capped at three', () => {
  assert.deepEqual(extractTags('', { toolNames: ['web_search'] }), ['联网'])
  assert.deepEqual(extractTags('', { toolNames: ['bash', 'web_search', 'my_custom_tool'] }), [
    '终端',
    '联网',
    'my_custom_tool',
  ])
  assert.deepEqual(
    extractTags('', {
      toolNames: [
        'read_image',
        'read',
        'edit_image',
        'write',
        'office_xlsx',
        'douyin_dm',
        'spawn_teammate',
        'schedule_create',
        'workflow',
        'skill',
        'browser_open',
        'terminal_exec',
      ],
    }),
    ['图像', '检索', '代码'],
  )
  assert.deepEqual(extractTags('', { toolNames: ['office_xlsx', 'douyin_dm', 'spawn_teammate'] }), [
    '办公',
    '抖音',
    '协作',
  ])
  assert.deepEqual(
    extractTags('', { toolNames: ['workflow', 'skill', 'browser_open', 'terminal_exec'] }),
    ['工作流', '技能', '浏览器'],
  )
  assert.deepEqual(extractTags('', { toolNames: ['schedule_create'] }), ['定时'])
})

test('extractTags: session title contributes themes', () => {
  assert.ok(extractTags('', { sessionTitle: '部署上线计划' }).includes('部署'))
  assert.ok(extractTags('', { sessionTitle: 'Deployment release' }).includes('部署'))
})

test('extractTags: every contract theme is reachable in Chinese and English', () => {
  const samples = [
    ['代码', '写代码', 'code review'],
    ['插件', '这个插件', 'a plugin'],
    ['文档', '写文档', 'readme docs'],
    ['数据', '处理数据', 'dataset'],
    ['图像', '生成图片', 'image'],
    ['视频', '剪视频', 'video'],
    ['网络', '网络请求', 'http api'],
    ['文件', '保存文件', 'file'],
    ['学习', '学习教程', 'learning'],
    ['金融', '股票基金', 'finance'],
    ['游戏', '打游戏', 'game'],
    ['生活', '日常生活', 'weekly life'],
    ['计划', '做个计划', 'plan'],
    ['调试', '调试日志', 'debug log'],
    ['部署', '部署上线', 'deployment'],
    ['搜索', '搜索一下', 'search query'],
    ['测试', '跑测试', 'tests'],
    ['写作', '写文章', 'writing article'],
    ['翻译', '翻译英文', 'translate'],
    ['办公', '做表格 excel', 'excel spreadsheet'],
    ['记忆', '记忆遗忘', 'memory retention'],
    ['团队', '团队协作', 'team collab'],
    ['音乐', '听音乐', 'music'],
    ['健康', '关注健康', 'health fitness'],
  ]
  assert.ok(samples.length >= 20)
  for (const [tag, chinese, english] of samples) {
    assert.ok(extractTags(chinese, {}).includes(tag), `Chinese sample should yield ${tag}`)
    assert.ok(extractTags(english, {}).includes(tag), `English sample should yield ${tag}`)
  }
})

test('extractTags: malformed input is safe', () => {
  assert.deepEqual(extractTags(null, null), [])
  assert.deepEqual(extractTags('', {}), [])
  assert.deepEqual(extractTags(42, 'nope'), [])
  assert.deepEqual(extractTags('code', { toolNames: 'not-an-array', sessionTitle: 42 }), ['代码'])
})

test('autoTagsForEpisode: mixes themes, tools and identifiers deterministically', () => {
  const input = {
    userText: '帮我调试这个插件的报错，用 MemoryBrainEngine 看一下',
    assistantText: '我先读代码再跑测试',
    sessionTitle: '记忆插件开发',
    toolNames: ['read', 'pwsh'],
  }
  const tags = autoTagsForEpisode(input)
  assert.ok(tags.includes('调试'))
  assert.ok(tags.includes('插件'))
  assert.ok(tags.includes('代码'))
  assert.ok(tags.includes('检索'))
  assert.ok(tags.includes('终端'))
  assert.ok(tags.length <= 8)
  assert.equal(new Set(tags).size, tags.length)
  assert.deepEqual(autoTagsForEpisode(input), tags)
})

test('autoTagsForEpisode: caps at eight unique tags', () => {
  const tags = autoTagsForEpisode({
    userText:
      '代码 插件 文档 数据 图像 视频 网络 文件 学习 金融 游戏 生活 计划 调试 部署 搜索 测试 写作 翻译 办公 记忆 团队 音乐 健康 code plugin Alpha Beta Gamma Delta',
    assistantText: '',
    sessionTitle: '',
    toolNames: ['web_search', 'write', 'read', 'bash', 'generate_image', 'office_xlsx'],
  })
  assert.equal(tags.length, 8)
  assert.equal(new Set(tags).size, 8)
})

test('autoTagsForEpisode: falls back to 闲聊 when nothing matches', () => {
  assert.deepEqual(autoTagsForEpisode({}), ['闲聊'])
  assert.deepEqual(autoTagsForEpisode(null), ['闲聊'])
  assert.deepEqual(
    autoTagsForEpisode({ userText: '', assistantText: '   ', sessionTitle: '', toolNames: [] }),
    ['闲聊'],
  )
  assert.deepEqual(autoTagsForEpisode({ userText: '你好呀' }), ['闲聊'])
})

test('autoTagsForEpisode: does not mutate the input', () => {
  const input = {
    userText: 'memory plugin code',
    assistantText: '',
    sessionTitle: '记忆',
    toolNames: ['read'],
  }
  const frozen = deepFreeze(structuredClone(input))
  const tags = autoTagsForEpisode(frozen)
  assert.ok(Array.isArray(tags))
  assert.deepEqual(input, {
    userText: 'memory plugin code',
    assistantText: '',
    sessionTitle: '记忆',
    toolNames: ['read'],
  })
})

// ---------------------------------------------------------------------------
// consolidateEpisodes
// ---------------------------------------------------------------------------

function consolidationFixture() {
  return [
    episode({
      id: 'ep-1',
      tags: ['code', 'plugin'],
      excerpt: 'first turn',
      createdAt: NOW - 3 * HOUR,
      lastAccessAt: NOW - HOUR,
      sessionId: 's1',
      sessionTitle: '记忆插件开发',
    }),
    episode({
      id: 'ep-2',
      tags: ['code', 'plugin', 'test'],
      excerpt: 'second turn',
      createdAt: NOW - 2 * HOUR,
      lastAccessAt: NOW - HOUR,
      sessionId: 's2',
      sessionTitle: 'other',
    }),
    episode({
      id: 'ep-3',
      tags: ['test', 'debug'],
      excerpt: 'third turn',
      createdAt: NOW - HOUR,
      lastAccessAt: NOW - HOUR,
    }),
    episode({
      id: 'ep-4',
      tags: ['music', 'life'],
      excerpt: 'fourth turn',
      createdAt: NOW,
      lastAccessAt: NOW,
    }),
  ]
}

test('consolidateEpisodes: clusters episodes sharing >= 2 tags into one semantic memory', () => {
  const { semantic: created, consolidatedIds } = consolidateEpisodes(
    consolidationFixture(),
    NOW,
    {},
  )
  assert.equal(created.length, 1)
  assert.deepEqual(consolidatedIds, ['ep-1', 'ep-2'])
  const memory = created[0]
  assert.ok(memory.id.startsWith('sem-'))
  assert.equal(memory.kind, 'semantic')
  assert.equal(memory.label, 'code')
  assert.deepEqual(memory.tags, ['code', 'plugin', 'test'])
  assert.equal(memory.sessionId, 's1')
  assert.equal(memory.sessionTitle, '记忆插件开发')
  assert.equal(memory.turn, 0)
  assert.equal(memory.text, 'first turn\nsecond turn')
  assert.equal(memory.createdAt, NOW)
  assert.equal(memory.lastAccessAt, NOW)
  assert.equal(memory.accessCount, 1)
  approx(memory.salience, 1.4)
  assert.equal(memory.pinned, false)
  assert.equal(memory.consolidated, false)
  assert.deepEqual(memory.memberIds, ['ep-1', 'ep-2'])
})

test('consolidateEpisodes: transitive groups merge via union-find', () => {
  const memories = [
    episode({ id: 'ep-1', tags: ['a', 'b'], excerpt: 'one', createdAt: NOW - 3 * HOUR }),
    episode({ id: 'ep-2', tags: ['a', 'b', 'c'], excerpt: 'two', createdAt: NOW - 2 * HOUR }),
    episode({ id: 'ep-3', tags: ['b', 'c'], excerpt: 'three', createdAt: NOW - HOUR }),
    episode({ id: 'ep-4', tags: ['z'], excerpt: 'four', createdAt: NOW }),
  ]
  const { semantic: created, consolidatedIds } = consolidateEpisodes(memories, NOW, {})
  assert.equal(created.length, 1)
  assert.deepEqual(created[0].memberIds, ['ep-1', 'ep-2', 'ep-3'])
  assert.equal(created[0].label, 'b')
  assert.deepEqual(created[0].tags, ['b', 'a', 'c'])
  approx(created[0].salience, 1.6)
  assert.deepEqual(consolidatedIds, ['ep-1', 'ep-2', 'ep-3'])
})

test('consolidateEpisodes: deterministic, fresh arrays, stable id', () => {
  const memories = consolidationFixture()
  const first = consolidateEpisodes(memories, NOW, {})
  const second = consolidateEpisodes(memories, NOW, {})
  assert.deepEqual(first, second)
  assert.notEqual(first.semantic, second.semantic)
  assert.notEqual(first.semantic[0].tags, second.semantic[0].tags)
  assert.notEqual(first.consolidatedIds, second.consolidatedIds)
})

test('consolidateEpisodes: never consolidates an episode twice', () => {
  const memories = consolidationFixture()
  memories[0].consolidated = true
  memories[1].consolidated = true
  const result = consolidateEpisodes(memories, NOW, {})
  assert.deepEqual(result.semantic, [])
  assert.deepEqual(result.consolidatedIds, [])
})

test('consolidateEpisodes: existing semantic memories never participate', () => {
  const memories = [
    ...consolidationFixture(),
    semantic({ id: 'sem-existing', label: 'old', tags: ['code', 'plugin'], memberIds: [] }),
  ]
  const result = consolidateEpisodes(memories, NOW, {})
  assert.ok(result.semantic.every((memory) => memory.id !== 'sem-existing'))
  assert.deepEqual(result.consolidatedIds, ['ep-1', 'ep-2'])
})

test('consolidateEpisodes: episodes already listed as semantic members are skipped', () => {
  const memories = [
    ...consolidationFixture(),
    semantic({ id: 'sem-existing', tags: ['code'], memberIds: ['ep-1'] }),
  ]
  const result = consolidateEpisodes(memories, NOW, {})
  assert.deepEqual(result.semantic, [])
  assert.deepEqual(result.consolidatedIds, [])
})

test('consolidateEpisodes: forgotten episodes are excluded', () => {
  const memories = [
    episode({ id: 'ep-1', tags: ['a', 'b'], lastAccessAt: NOW - 100 * DAY }),
    episode({ id: 'ep-2', tags: ['a', 'b'], lastAccessAt: NOW - 100 * DAY }),
    episode({ id: 'ep-3', tags: ['a', 'b'], forgottenAt: NOW - DAY, lastAccessAt: NOW }),
    episode({ id: 'ep-4', tags: ['a', 'b'], lastAccessAt: NOW }),
  ]
  const result = consolidateEpisodes(memories, NOW, {})
  assert.deepEqual(result.semantic, [])
  assert.deepEqual(result.consolidatedIds, [])
})

test('consolidateEpisodes: members ordered by createdAt, text truncated to 300 chars', () => {
  const long = 'x'.repeat(200)
  const memories = [
    episode({ id: 'ep-2', tags: ['a', 'b'], excerpt: long, createdAt: NOW - HOUR }),
    episode({ id: 'ep-1', tags: ['a', 'b'], excerpt: long, createdAt: NOW - 2 * HOUR }),
  ]
  const { semantic: created } = consolidateEpisodes(memories, NOW, {})
  assert.equal(created.length, 1)
  assert.equal(created[0].text.length, 300)
  assert.equal(created[0].text, `${long}\n${long}`.slice(0, 300))
  assert.deepEqual(created[0].memberIds, ['ep-1', 'ep-2'])
})

test('consolidateEpisodes: multiple clusters ordered by smallest member id', () => {
  const memories = [
    episode({ id: 'ep-b2', tags: ['x', 'y'], createdAt: NOW - HOUR }),
    episode({ id: 'ep-b1', tags: ['x', 'y'], createdAt: NOW - 2 * HOUR }),
    episode({ id: 'ep-a2', tags: ['p', 'q'], createdAt: NOW - HOUR }),
    episode({ id: 'ep-a1', tags: ['p', 'q'], createdAt: NOW - 2 * HOUR }),
  ]
  const { semantic: created, consolidatedIds } = consolidateEpisodes(memories, NOW, {})
  assert.equal(created.length, 2)
  assert.deepEqual(created[0].memberIds, ['ep-a1', 'ep-a2'])
  assert.deepEqual(created[1].memberIds, ['ep-b1', 'ep-b2'])
  assert.deepEqual(consolidatedIds, ['ep-a1', 'ep-a2', 'ep-b1', 'ep-b2'])
})

test('consolidateEpisodes: malformed input is safe', () => {
  for (const value of [null, undefined, 'nope', 42, {}, [null, 1, 'x', {}, { id: '' }]]) {
    const result = consolidateEpisodes(value, NOW, {})
    assert.deepEqual(result.semantic, [])
    assert.deepEqual(result.consolidatedIds, [])
  }
})

test('consolidateEpisodes: does not mutate the input memories', () => {
  const memories = consolidationFixture()
  const snapshot = structuredClone(memories)
  consolidateEpisodes(memories, NOW, {})
  assert.deepEqual(memories, snapshot)
})

// ---------------------------------------------------------------------------
// buildGraph
// ---------------------------------------------------------------------------

function graphFixture() {
  const first = episode({
    id: 'ep-1',
    tags: ['code', 'plugin'],
    excerpt: 'y'.repeat(200),
    createdAt: NOW - 3 * HOUR,
    turn: 2,
    sessionId: 's1',
  })
  const second = episode({
    id: 'ep-2',
    tags: ['code', 'plugin', 'test'],
    excerpt: 'second',
    createdAt: NOW - 2 * HOUR,
    turn: 1,
    sessionId: 's1',
  })
  const third = episode({
    id: 'ep-3',
    tags: ['music'],
    excerpt: 'third',
    createdAt: NOW - HOUR,
    turn: 3,
    sessionId: 's2',
  })
  const sem = semantic({
    id: 'sem-1',
    label: 'code',
    tags: ['code', 'plugin'],
    createdAt: NOW,
    memberIds: ['ep-1', 'ep-2'],
  })
  return [third, sem, first, second] // deliberately shuffled
}

test('buildGraph: nodes cover every memory in contract order with full fields', () => {
  const memories = graphFixture()
  const graph = buildGraph(memories, NOW, {})
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ['ep-1', 'ep-2', 'ep-3', 'sem-1'],
  )
  for (const node of graph.nodes) {
    for (const field of [
      'id',
      'kind',
      'label',
      'excerpt',
      'tags',
      'sessionId',
      'sessionTitle',
      'turn',
      'createdAt',
      'lastAccessAt',
      'accessCount',
      'stabilityDays',
      'salience',
      'retention',
      'state',
      'pinned',
      'consolidated',
      'x0',
      'y0',
    ]) {
      assert.ok(field in node, `node ${node.id} missing field ${field}`)
    }
    assert.ok(node.retention >= 0 && node.retention <= 1)
    assert.ok(node.stabilityDays > 0)
    assert.ok(['active', 'fading', 'forgotten'].includes(node.state))
    assert.deepEqual({ x: node.x0, y: node.y0 }, seedPosition(node.id))
    assert.ok(node.x0 >= -1 && node.x0 <= 1 && node.y0 >= -1 && node.y0 <= 1)
  }
  const [firstNode, secondNode, thirdNode, semanticNode] = graph.nodes
  assert.equal(firstNode.label, 'code')
  assert.equal(firstNode.excerpt.length, 140) // 200-char excerpt truncated
  approx(firstNode.retention, retentionAt(memories[2], NOW))
  approx(firstNode.stabilityDays, stabilityDays(memories[2]))
  assert.equal(secondNode.label, 'code')
  assert.equal(thirdNode.label, 'music')
  assert.equal(semanticNode.label, 'code')
  assert.deepEqual(semanticNode.memberIds, ['ep-1', 'ep-2'])
  assert.equal(semanticNode.kind, 'semantic')
  assertGraphIntegrity(graph)
})

test('buildGraph: tag / session / semantic edges are complete and well-formed', () => {
  const graph = buildGraph(graphFixture(), NOW, {})
  const tagEdges = graph.edges.filter((edge) => edge.type === 'tag')
  assert.equal(tagEdges.length, 1)
  assert.deepEqual(tagEdges[0].tags, ['code', 'plugin'])
  assert.equal(tagEdges[0].weight, 2)
  assert.deepEqual(new Set([tagEdges[0].source, tagEdges[0].target]), new Set(['ep-1', 'ep-2']))

  const sessionEdges = graph.edges.filter((edge) => edge.type === 'session')
  assert.equal(sessionEdges.length, 1)
  assert.equal(sessionEdges[0].source, 'ep-2') // turn 1 -> turn 2
  assert.equal(sessionEdges[0].target, 'ep-1')
  assert.equal(sessionEdges[0].weight, 1)

  const semanticEdges = graph.edges.filter((edge) => edge.type === 'semantic')
  assert.deepEqual(
    semanticEdges.map((edge) => [edge.source, edge.target]),
    [
      ['sem-1', 'ep-1'],
      ['sem-1', 'ep-2'],
    ],
  )
  for (const edge of semanticEdges) {
    assert.equal(edge.weight, 1)
    assert.deepEqual(edge.tags, ['code', 'plugin'])
  }
  assertGraphIntegrity(graph)
})

test('buildGraph: same input gives the exact same output', () => {
  const memories = graphFixture()
  const first = buildGraph(memories, NOW, {})
  const second = buildGraph(memories, NOW, {})
  assert.deepEqual(first, second)
  const reversed = buildGraph([...memories].reverse(), NOW, {})
  assert.deepEqual(reversed.nodes, first.nodes)
  assert.deepEqual(reversed.edges, first.edges)
})

test('buildGraph: no dangling edges even when a semantic member is missing', () => {
  const memories = [
    episode({ id: 'ep-1', tags: ['code'] }),
    semantic({ id: 'sem-1', label: 'code', tags: ['code'], memberIds: ['ep-1', 'ep-missing'] }),
  ]
  const graph = buildGraph(memories, NOW, {})
  assertGraphIntegrity(graph)
  const semanticEdges = graph.edges.filter((edge) => edge.type === 'semantic')
  assert.deepEqual(
    semanticEdges.map((edge) => edge.target),
    ['ep-1'],
  )
})

test('buildGraph: forgotten nodes get no tag edges but semantic edges may reach them', () => {
  const memories = [
    episode({ id: 'ep-1', tags: ['code', 'plugin'] }),
    episode({ id: 'ep-2', tags: ['code', 'plugin'], forgottenAt: NOW - DAY }),
    semantic({ id: 'sem-1', label: 'code', tags: ['code'], memberIds: ['ep-2'] }),
  ]
  const graph = buildGraph(memories, NOW, {})
  const forgottenNode = graph.nodes.find((node) => node.id === 'ep-2')
  assert.equal(forgottenNode.state, 'forgotten')
  assert.equal(forgottenNode.retention, 0)
  assert.equal(graph.edges.filter((edge) => edge.type === 'tag').length, 0)
  const semanticEdges = graph.edges.filter((edge) => edge.type === 'semantic')
  assert.deepEqual(
    semanticEdges.map((edge) => [edge.source, edge.target]),
    [['sem-1', 'ep-2']],
  )
  assertGraphIntegrity(graph)
})

test('buildGraph: session edges walk adjacent turns in order', () => {
  const memories = [
    episode({ id: 'ep-c', turn: 3, createdAt: NOW - HOUR, sessionId: 's1' }),
    episode({ id: 'ep-a', turn: 1, createdAt: NOW - 3 * HOUR, sessionId: 's1' }),
    episode({ id: 'ep-b', turn: 2, createdAt: NOW - 2 * HOUR, sessionId: 's1' }),
    episode({ id: 'ep-x', turn: 9, createdAt: NOW - HOUR, sessionId: 's2' }),
  ]
  const graph = buildGraph(memories, NOW, {})
  const sessionEdges = graph.edges.filter((edge) => edge.type === 'session')
  assert.deepEqual(
    sessionEdges.map((edge) => [edge.source, edge.target]),
    [
      ['ep-a', 'ep-b'],
      ['ep-b', 'ep-c'],
    ],
  )
  assert.ok(sessionEdges.every((edge) => edge.weight === 1))
})

test('buildGraph: per-node tag degree <= 6, labels fall back sensibly', () => {
  const memories = []
  for (let index = 0; index < 10; index += 1) {
    memories.push(episode({ id: `ep-${index}`, tags: ['a', 'b'], createdAt: NOW }))
  }
  const graph = buildGraph(memories, NOW, {})
  const degree = new Map()
  for (const edge of graph.edges.filter((item) => item.type === 'tag')) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }
  for (const value of degree.values()) assert.ok(value <= 6)

  assert.equal(buildGraph([semantic({ id: 'sem-x', tags: ['alpha'] })], NOW, {}).nodes[0].label, 'alpha')
  assert.equal(buildGraph([semantic({ id: 'sem-y' })], NOW, {}).nodes[0].label, '记忆')
  assert.equal(buildGraph([episode({ id: 'ep-1' })], NOW, {}).nodes[0].label, '记忆')
})

test('buildGraph: global tag-edge cap of 1500 is enforced', () => {
  const count = 600
  const memories = []
  for (let index = 0; index < count; index += 1) {
    memories.push(episode({ id: `ep-${String(index).padStart(3, '0')}`, tags: [], createdAt: NOW }))
  }
  // Pair (i, j) with 1 <= j - i <= 3 shares one unique tag: 1791 candidates.
  const tagsByNode = memories.map(() => [])
  for (let left = 0; left < count; left += 1) {
    for (let offset = 1; offset <= 3 && left + offset < count; offset += 1) {
      const tag = `pair-${left}-${left + offset}`
      tagsByNode[left].push(tag)
      tagsByNode[left + offset].push(tag)
    }
  }
  for (let index = 0; index < count; index += 1) memories[index].tags = tagsByNode[index]

  const graph = buildGraph(memories, NOW, {})
  const tagEdges = graph.edges.filter((edge) => edge.type === 'tag')
  assert.equal(tagEdges.length, 1500)
  const degree = new Map()
  for (const edge of tagEdges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }
  for (const value of degree.values()) assert.ok(value <= 6)
  assertGraphIntegrity(graph)
  assert.deepEqual(buildGraph(memories, NOW, {}), graph)
})

test('buildGraph: malformed input is safe and id-less records are skipped', () => {
  for (const value of [null, undefined, 'x', 42, {}, [null, 1, 'x', {}]]) {
    assert.deepEqual(buildGraph(value, NOW, {}), { nodes: [], edges: [] })
  }
  const graph = buildGraph([episode({ id: 'ep-1' }), null, { id: '' }], NOW, {})
  assert.equal(graph.nodes.length, 1)
  assert.deepEqual(graph.edges, [])
})

// ---------------------------------------------------------------------------
// computeStats / tagCounts
// ---------------------------------------------------------------------------

function statsFixture() {
  return [
    episode({ id: 'ep-1', tags: ['code'], lastAccessAt: daysAgo(0.5), sessionId: 's1' }),
    episode({ id: 'ep-2', tags: ['code', 'plugin'], lastAccessAt: daysAgo(2), sessionId: 's1' }),
    episode({ id: 'ep-3', tags: ['music'], lastAccessAt: daysAgo(10), sessionId: 's2' }),
    episode({ id: 'ep-4', tags: ['pin'], lastAccessAt: daysAgo(100), pinned: true, sessionId: '' }),
    semantic({ id: 'sem-1', tags: ['code'], lastAccessAt: daysAgo(1), sessionId: 's1' }),
    episode({ id: 'ep-5', tags: ['ghost'], forgottenAt: NOW - DAY, lastAccessAt: NOW, sessionId: 's1' }),
  ]
}

test('computeStats: counts are self-consistent and average retention is correct', () => {
  const memories = statsFixture()
  const stats = computeStats(memories, NOW, {})
  assert.equal(stats.total, 6)
  assert.equal(stats.episodes, 5)
  assert.equal(stats.semantic, 1)
  assert.equal(stats.pinned, 1)
  assert.equal(stats.active + stats.fading + stats.forgotten, stats.total)
  assert.equal(stats.episodes + stats.semantic, stats.total)
  assert.equal(stats.active, 3) // ep-1, ep-4, sem-1
  assert.equal(stats.fading, 1) // ep-2
  assert.equal(stats.forgotten, 2) // ep-3 (decayed), ep-5 (marked)
  assert.equal(stats.sessions, 2) // s1, s2 (ep-4 has no session)
  assert.equal(stats.tags, 5) // code, plugin, music, pin, ghost
  const averaged = [0, 1, 2, 3, 4].map((index) => retentionAt(memories[index], NOW))
  const expected = roundTo(
    averaged.reduce((sum, value) => sum + value, 0) / averaged.length,
    3,
  )
  assert.equal(stats.avgRetention, expected)
  assert.ok(stats.avgRetention >= 0 && stats.avgRetention <= 1)
})

test('computeStats: empty and malformed input yield zeros', () => {
  const empty = computeStats([], NOW, {})
  assert.deepEqual(empty, {
    total: 0,
    active: 0,
    fading: 0,
    forgotten: 0,
    pinned: 0,
    semantic: 0,
    episodes: 0,
    sessions: 0,
    tags: 0,
    avgRetention: 0,
  })
  for (const value of [null, undefined, 'x', 42, {}, [null, 1, 'x', {}]]) {
    const stats = computeStats(value, NOW, {})
    assert.equal(stats.total, 0)
    assert.equal(stats.avgRetention, 0)
  }
})

test('tagCounts: counts memories per tag, sorted by count then tag', () => {
  const memories = [
    episode({ id: 'ep-1', tags: ['code', 'plugin'] }),
    episode({ id: 'ep-2', tags: ['code'] }),
    semantic({ id: 'sem-1', tags: ['code', 'plugin', 'test'] }),
  ]
  assert.deepEqual(tagCounts(memories), [
    { tag: 'code', count: 3 },
    { tag: 'plugin', count: 2 },
    { tag: 'test', count: 1 },
  ])
  const tied = tagCounts([
    episode({ id: 'ep-1', tags: ['b', 'a'] }),
    episode({ id: 'ep-2', tags: ['a', 'b'] }),
  ])
  assert.deepEqual(tied, [
    { tag: 'a', count: 2 },
    { tag: 'b', count: 2 },
  ])
})

test('tagCounts: malformed input is safe', () => {
  assert.deepEqual(tagCounts(null), [])
  assert.deepEqual(tagCounts([null, 42, 'x', {}, { id: 'ep-1', tags: 'nope' }]), [])
  assert.deepEqual(tagCounts([episode({ id: 'ep-1', tags: [null, '', 42, 'ok', 'ok'] })]), [
    { tag: 'ok', count: 1 },
  ])
})

// ---------------------------------------------------------------------------
// Totality / purity
// ---------------------------------------------------------------------------

test('every exported function is total (never throws on malformed input)', () => {
  const junk = [null, undefined, 0, '', 'nope', [], {}, true, Number.NaN]
  for (const value of junk) {
    assert.doesNotThrow(() => clamp(value, 0, 1))
    assert.doesNotThrow(() => hash32(value))
    assert.doesNotThrow(() => seedPosition(value))
    assert.doesNotThrow(() => resolveSettings(value))
    assert.doesNotThrow(() => stabilityDays(value, value))
    assert.doesNotThrow(() => retentionAt(value, value, value))
    assert.doesNotThrow(() => memoryState(value, value, value))
    assert.doesNotThrow(() => projectRetention(value, value, value, value))
    assert.doesNotThrow(() => normalizeTag(value))
    assert.doesNotThrow(() => extractTags(value, value))
    assert.doesNotThrow(() => autoTagsForEpisode(value))
    assert.doesNotThrow(() => consolidateEpisodes(value, value, value))
    assert.doesNotThrow(() => buildGraph(value, value, value))
    assert.doesNotThrow(() => computeStats(value, value, value))
    assert.doesNotThrow(() => tagCounts(value))
  }
})

test('read functions accept deeply frozen records (no mutation attempts)', () => {
  const memories = deepFreeze(structuredClone(graphFixture()))
  assert.doesNotThrow(() => buildGraph(memories, NOW, {}))
  assert.doesNotThrow(() => computeStats(memories, NOW, {}))
  assert.doesNotThrow(() => consolidateEpisodes(memories, NOW, {}))
  assert.doesNotThrow(() => tagCounts(memories))
})

test('functions never mutate their inputs', () => {
  const memories = structuredClone(graphFixture())
  const snapshot = structuredClone(memories)
  consolidateEpisodes(memories, NOW, {})
  buildGraph(memories, NOW, {})
  computeStats(memories, NOW, {})
  tagCounts(memories)
  assert.deepEqual(memories, snapshot)
  const input = { userText: 'code', assistantText: 'test', sessionTitle: '插件', toolNames: ['read'] }
  const inputSnapshot = structuredClone(input)
  autoTagsForEpisode(input)
  extractTags('code', input)
  assert.deepEqual(input, inputSnapshot)
  const partial = { halfLifeDays: 100 }
  resolveSettings(partial)
  assert.deepEqual(partial, { halfLifeDays: 100 })
})
