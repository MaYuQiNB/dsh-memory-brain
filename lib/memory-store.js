/**
 * Memory Brain — the memory store.
 *
 * Host-side, framework-free core of the plugin. It owns the memory records and
 * their lifecycle, derives the read model the panel and the agent tool see, and
 * leaves persistence to an injected async `save` callback so the same logic is
 * unit-testable without a Harness context.
 *
 * Model (a deliberately small imitation of human memory):
 *   - One `episode` record per conversation turn of an existing task (Session).
 *     It carries the turn's text, auto-extracted tags, timestamps and an access
 *     counter — the "episodic memory" of what was said and when.
 *   - The Ebbinghaus forgetting curve lives in `lib/memory-engine.js`; this file
 *     only stores the fields that curve needs and asks the engine to derive
 *     retention/state/graph.
 *   - `sleep()` consolidates episode clusters into `semantic` records (a tag
 *     concept, like a fact distilled from several episodes) and purges memories
 *     that decayed past the purge threshold.
 *   - Recalling (`recall`) restrengthens what was recalled, like re-consolidation.
 *
 * The store never throws on malformed persisted data; it throws `MemoryError`
 * only for a caller-visible operation failure (unknown id, invalid settings).
 */
import {
  DEFAULT_SETTINGS,
  autoTagsForEpisode,
  buildGraph,
  clamp,
  computeStats,
  consolidateEpisodes,
  hash32,
  memoryState,
  normalizeTag,
  resolveSettings,
  retentionAt,
  stabilityDays,
  tagCounts,
} from './memory-engine.js'
import {
  applyFacts,
  cosineSimilarity,
  extractFacts,
  factStats,
  hashEmbedding,
  normalizeAttribute,
  normalizeSubject,
  normalizeText,
  queryFacts,
} from './fact-engine.js'
import {
  buildSummaryLayers,
  classifyQueryComplexity,
  selectRetrievalLayer,
} from './summary-engine.js'

/** Persisted payload version; bump when the fold semantics change. */
export const STORE_VERSION = 2

/**
 * Independent feature toggles for the layered memory upgrade (batches 1-3).
 * Every switch is a standalone rollback: turning it off disables that step,
 * while already-derived data is kept and can be cleared manually.
 */
export const FEATURE_DEFAULTS = Object.freeze({
  factExtraction: true,
  factDedup: true,
  factConflict: true,
  sessionSummary: true,
  dailyWeeklySummary: true,
  layeredRecall: true,
  semanticRecall: false,
  temporalHistory: false,
})

/** Structured-fact and summary read-model ceilings. */
const MAX_FACTS = 800
const MAX_FACTS_IN_STATE = 200
const MAX_STORED_EMBEDDING = 96
const MAX_FACT_SOURCES = 20
const MAX_SESSION_SUMMARIES = 200
const MAX_DAILY_SUMMARIES = 90
const MAX_WEEKLY_SUMMARIES = 52
/** Hard ceiling for one retrieval answer; keeps the model context bounded. */
const MAX_RECALL_ITEMS = 30

/** A soft-forgotten ghost is kept this long for the panel, then purged on sleep. */
const PURGE_AFTER_DAYS = 7
const DAY_MS = 86_400_000
/** Longest turn text kept per role; recall only needs the gist. */
const MAX_STORED_TEXT = 1500
/** Read-model ceilings. */
const MAX_SEMANTIC = 120
const MAX_SESSIONS = 200
const MAX_TAGS_PER_RECORD = 12

/** User-facing forgetting horizon (days) for a fresh bank. */
export const DEFAULT_FORGET_AFTER_DAYS = 7
const FORGET_AFTER_MIN = 1
const FORGET_AFTER_MAX = 60
/**
 * Typical salience of a real conversation turn (see `computeSalience`), used to
 * translate the user-facing "forget after N days" horizon into the engine's
 * half-life scale. A memory with average salience reaches the forget threshold
 * (`forgetThreshold`) at the configured horizon.
 */
const SALIENCE_REFERENCE = 2.3
/** The engine normalizes halfLifeDays against its own default (3 days). */
const ENGINE_HALF_LIFE_ANCHOR = 3

/**
 * Days per unit of stability at which an unrehearsed trace crosses the forget
 * threshold: R(t) = exp(-t / S) < forgetThreshold  =>  t = S * ln(1 / threshold).
 * @param {{ forgetThreshold?: number }} settings Resolved settings.
 * @returns {number} Positive multiplier.
 */
function forgetThresholdLog(settings) {
  const threshold = clamp(Number(settings.forgetThreshold) || 0.12, 0.001, 0.999)
  return Math.log(1 / threshold)
}

/**
 * Convert the user-facing "forget after N days" horizon into the engine's
 * `halfLifeDays` scale.
 * @param {number} forgetAfterDays Days until an unrehearsed typical memory is forgotten.
 * @param {{ baseStabilityDays?: number, forgetThreshold?: number }} settings Resolved settings.
 * @returns {number} halfLifeDays within the engine's accepted range.
 */
function halfLifeDaysFor(forgetAfterDays, settings) {
  const base = Math.max(0.01, Number(settings.baseStabilityDays) || 1.5)
  const days = clamp(Number(forgetAfterDays) || DEFAULT_FORGET_AFTER_DAYS, FORGET_AFTER_MIN, FORGET_AFTER_MAX)
  const halfLife = (ENGINE_HALF_LIFE_ANCHOR * days) / (base * forgetThresholdLog(settings) * SALIENCE_REFERENCE)
  return clamp(halfLife, 0.5, 30)
}

/**
 * Inverse of {@link halfLifeDaysFor}: the forgetting horizon implied by a
 * half-life scale (used by the legacy `halfLifeDays` API).
 * @param {number} halfLifeDays Engine half-life scale.
 * @param {{ baseStabilityDays?: number, forgetThreshold?: number }} settings Resolved settings.
 * @returns {number} Days, clamped to the supported range.
 */
function forgetAfterDaysFor(halfLifeDays, settings) {
  const base = Math.max(0.01, Number(settings.baseStabilityDays) || 1.5)
  const halfLife = Number(halfLifeDays)
  if (!Number.isFinite(halfLife) || halfLife <= 0) return DEFAULT_FORGET_AFTER_DAYS
  return clamp(
    (halfLife * base * forgetThresholdLog(settings) * SALIENCE_REFERENCE) / ENGINE_HALF_LIFE_ANCHOR,
    FORGET_AFTER_MIN,
    FORGET_AFTER_MAX,
  )
}

/** One caller-visible memory operation failure. */
export class MemoryError extends Error {
  /**
   * @param {number} status HTTP status the API should answer with.
   * @param {string} code Stable machine-readable failure key.
   * @param {string} message Human-readable reason.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'MemoryError'
    this.status = status
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Collect the text blocks out of an unknown message/content value.
 * The Harness message shapes are rich and versioned (content block arrays,
 * nested messages, tool results); instead of freezing one shape this walks the
 * value and joins every `{ type: 'text', text }` block in order. Plain strings
 * are accepted as-is.
 * @param {unknown} value Message, content array, block or plain string.
 * @returns {string} Joined text.
 */
export function extractText(value) {
  /** @type {string[]} */
  const parts = []
  /** @param {unknown} node Depth-bounded walk. @param {number} depth */
  const walk = (node, depth) => {
    if (depth > 6 || node === null || node === undefined) return
    if (typeof node === 'string') {
      const trimmed = node.trim()
      if (trimmed !== '') parts.push(trimmed)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    const record = /** @type {Record<string, any>} */ (node)
    if (record.type === 'text' && typeof record.text === 'string') {
      const trimmed = record.text.trim()
      if (trimmed !== '') parts.push(trimmed)
      return
    }
    if (typeof record.text === 'string' && record.type !== 'reasoning') {
      const trimmed = record.text.trim()
      if (trimmed !== '') parts.push(trimmed)
      return
    }
    if (Array.isArray(record.content)) walk(record.content, depth + 1)
    if (Array.isArray(record.blocks)) walk(record.blocks, depth + 1)
  }
  walk(value, 0)
  return parts.join('\n')
}

/**
 * Fold a raw session event log into conversation turns, the way the capture
 * path reads both live events and historical sessions.
 * @param {readonly any[]} events Session events in sequence order.
 * @returns {{ turns: Array<{ turn: number, userTexts: string[], assistantTexts: string[], toolNames: string[], startedAt: number, endedAt: number }>, title: string }}
 */
export function collectTurns(events) {
  /** @type {Array<{ turn: number, userTexts: string[], assistantTexts: string[], toolNames: string[], startedAt: number, endedAt: number }>} */
  const turns = []
  let title = ''
  /** @type {{ turn: number, userTexts: string[], assistantTexts: string[], toolNames: string[], startedAt: number, endedAt: number } | null} */
  let current = null

  const open = (turn, time) => {
    current = {
      turn: Number.isFinite(turn) ? turn : turns.length + 1,
      userTexts: [],
      assistantTexts: [],
      toolNames: [],
      startedAt: Number.isFinite(time) ? time : Date.now(),
      endedAt: Number.isFinite(time) ? time : Date.now(),
    }
    return current
  }

  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    const type = event.type
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    const time = Number.isFinite(event.time) ? event.time : Date.now()

    // Session titles are stored as their own event; the exact type name is a
    // Harness detail, so match the `session/title*` family instead of one name.
    if (typeof type === 'string' && type.startsWith('session/title')) {
      const next = typeof data.title === 'string' ? data.title.trim() : ''
      if (next !== '') title = next
      continue
    }
    if (type === 'turn/start') {
      current = open(data.turn, time)
      continue
    }
    if (type === 'user/message') {
      // Plugin-injected context also appears as user messages; only real human
      // prompts become episodic memories.
      if (data.source !== null && typeof data.source === 'object' && typeof data.source.kind === 'string' && data.source.kind !== 'user') continue
      if (current === null) open(0, time)
      const text = extractText(data.message ?? data)
      if (current !== null && text !== '') current.userTexts.push(text)
      continue
    }
    if (type === 'assistant/message') {
      if (current === null) open(0, time)
      const text = extractText(data.message ?? data)
      if (current !== null && text !== '') current.assistantTexts.push(text)
      continue
    }
    if (type === 'tool/call') {
      if (current === null) open(0, time)
      if (current !== null && typeof data.name === 'string' && data.name !== '') current.toolNames.push(data.name)
      continue
    }
    if (type === 'turn/end') {
      const turn = current !== null ? current.turn : (Number.isFinite(data.turn) ? data.turn : turns.length + 1)
      const bucket = current !== null ? current : open(turn, time)
      bucket.turn = Number.isFinite(data.turn) ? data.turn : turn
      bucket.endedAt = time
      turns.push(bucket)
      current = null
    }
  }
  return { turns, title }
}

/**
 * One-line gist of a turn for the graph label tooltip and the detail panel.
 * @param {string} userText User side of the turn.
 * @param {string} assistantText Assistant side of the turn.
 * @returns {string} Excerpt, at most ~180 characters.
 */
export function buildExcerpt(userText, assistantText) {
  const user = userText.replace(/\s+/g, ' ').trim()
  const assistant = assistantText.replace(/\s+/g, ' ').trim()
  const head = user === '' ? assistant : user
  const tail = user === '' ? '' : assistant
  const joined = tail === '' ? head : `${head} → ${tail}`
  return joined.length <= 180 ? joined : `${joined.slice(0, 179)}…`
}

/**
 * Salience — how strongly an episode encodes. Longer, tool-rich turns leave a
 * deeper trace, which the forgetting curve slows down through `stabilityDays`.
 * @param {number} textLength Total stored characters of the turn.
 * @param {number} toolCount Number of tool calls in the turn.
 * @returns {number} Salience in [0.8, 2.5].
 */
function computeSalience(textLength, toolCount) {
  return clamp(0.9 + Math.min(1.2, textLength / 700) + Math.min(0.6, toolCount * 0.12), 0.8, 2.5)
}

/**
 * Validate and canonicalize one persisted record. Unknown fields are dropped,
 * wrong types fall back to defaults: a corrupted file must not poison the read
 * model.
 * @param {unknown} raw Candidate record.
 * @returns {Record<string, any> | null} Canonical record, or null when hopeless.
 */
function normalizeRecord(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const record = /** @type {Record<string, any>} */ (raw)
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (id === '') return null
  const kind = record.kind === 'semantic' ? 'semantic' : 'episode'
  const tags = Array.isArray(record.tags)
    ? dedupeTags(record.tags.map((tag) => normalizeTag(tag)).filter((tag) => tag !== ''))
    : []
  const createdAt = Number.isFinite(record.createdAt) ? record.createdAt : Date.now()
  const lastAccessAt = Number.isFinite(record.lastAccessAt) ? record.lastAccessAt : createdAt
  const numeric = (value, fallback) => (Number.isFinite(value) ? value : fallback)
  const contentPurged = record.contentPurged === true
  return {
    id,
    kind,
    /** Where the memory came from: '' (DSH task) or 'qq' (QQ bridge chat). */
    source: record.source === 'qq' ? 'qq' : '',
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    sessionTitle: contentPurged ? '' : (typeof record.sessionTitle === 'string' ? record.sessionTitle : ''),
    turn: Math.max(0, Math.floor(numeric(record.turn, 0))),
    turnKey: typeof record.turnKey === 'string' ? record.turnKey : '',
    seq: Math.max(0, Math.floor(numeric(record.seq, 0))),
    userText: contentPurged ? '' : (typeof record.userText === 'string' ? record.userText.slice(0, MAX_STORED_TEXT) : ''),
    assistantText: contentPurged ? '' : (typeof record.assistantText === 'string' ? record.assistantText.slice(0, MAX_STORED_TEXT) : ''),
    excerpt: contentPurged ? '' : (typeof record.excerpt === 'string' ? record.excerpt.slice(0, 240) : ''),
    text: contentPurged ? '' : (typeof record.text === 'string' ? record.text.slice(0, 600) : ''),
    label: contentPurged ? '' : (typeof record.label === 'string' ? record.label : ''),
    tags: contentPurged ? [] : tags,
    toolNames: contentPurged ? [] : (Array.isArray(record.toolNames) ? record.toolNames.filter((name) => typeof name === 'string').slice(0, 24) : []),
    createdAt,
    lastAccessAt,
    accessCount: Math.max(1, Math.floor(numeric(record.accessCount, 1))),
    salience: clamp(numeric(record.salience, 1), 0.5, 3),
    pinned: record.pinned === true,
    consolidated: record.consolidated === true,
    memberIds: Array.isArray(record.memberIds) ? record.memberIds.filter((member) => typeof member === 'string').slice(0, 400) : [],
    forgottenAt: Number.isFinite(record.forgottenAt) && record.forgottenAt > 0 ? record.forgottenAt : 0,
    /** 'manual' = user pressed 遗忘 (reversible); 'time' = reached the forgetting time (content deleted). */
    forgottenVia: record.forgottenVia === 'manual' || record.forgottenVia === 'time' ? record.forgottenVia : '',
    /** True once the readable content was deleted at the forgetting time (tombstone). */
    contentPurged: record.contentPurged === true,
    /** Offline hashed embedding (batch 3); empty unless semantic recall was used. */
    embedding: contentPurged
      ? []
      : (Array.isArray(record.embedding)
        ? record.embedding.filter((value) => Number.isFinite(value)).slice(0, MAX_STORED_EMBEDDING).map((value) => Number(value))
        : []),
  }
}

/**
 * Delete everything readable from a memory that reached its forgetting time.
 * Only structural metadata survives (a tombstone): no user text, assistant
 * text, excerpt, tags, tool names or task title can be read or restored.
 * @param {Record<string, any>} memory Memory record (mutated in place).
 * @returns {boolean} True when the record was scrubbed by this call.
 */
function scrubMemoryContent(memory) {
  if (memory === null || typeof memory !== 'object' || memory.contentPurged === true) return false
  memory.contentPurged = true
  memory.userText = ''
  memory.assistantText = ''
  memory.excerpt = ''
  memory.text = ''
  memory.label = ''
  memory.tags = []
  memory.toolNames = []
  memory.sessionTitle = ''
  memory.embedding = []
  return true
}

/**
 * @param {readonly string[]} tags Tags in priority order.
 * @returns {string[]} Unique tags, capped.
 */
function dedupeTags(tags) {
  const seen = new Set()
  /** @type {string[]} */
  const unique = []
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag === '' || seen.has(tag)) continue
    seen.add(tag)
    unique.push(tag)
    if (unique.length >= MAX_TAGS_PER_RECORD) break
  }
  return unique
}

/**
 * Copy a record into a fresh plain object (persistence must not alias state).
 * @param {Record<string, any>} record Source record.
 * @returns {Record<string, any>} Detached copy.
 */
function cloneRecord(record) {
  return {
    ...record,
    tags: [...record.tags],
    toolNames: [...record.toolNames],
    memberIds: [...record.memberIds],
    embedding: Array.isArray(record.embedding) ? [...record.embedding] : [],
  }
}

/**
 * Canonicalize the eight independent feature toggles, falling back to the
 * documented defaults for anything missing or malformed.
 * @param {unknown} raw Persisted or supplied feature map.
 * @returns {Record<string, boolean>} Effective toggles.
 */
function normalizeFeatures(raw) {
  const source = raw !== null && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {}
  /** @type {Record<string, boolean>} */
  const features = { ...FEATURE_DEFAULTS }
  for (const key of Object.keys(FEATURE_DEFAULTS)) {
    if (source[key] !== undefined) features[key] = source[key] !== false
  }
  return features
}

/**
 * Validate and canonicalize one persisted structured fact.
 * @param {unknown} raw Candidate fact.
 * @returns {Record<string, any> | null} Canonical fact, or null when hopeless.
 */
function normalizeFact(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const fact = /** @type {Record<string, any>} */ (raw)
  const subject = typeof fact.subject === 'string' ? fact.subject.trim().slice(0, 60) : ''
  const attribute = typeof fact.attribute === 'string' ? fact.attribute.trim().slice(0, 40) : ''
  const value = typeof fact.value === 'string' ? fact.value.trim().slice(0, 240) : ''
  if (subject === '' || attribute === '' || value === '') return null
  const subjectKey = typeof fact.subjectKey === 'string' && fact.subjectKey !== ''
    ? fact.subjectKey
    : normalizeSubject(subject)
  const attributeKey = typeof fact.attributeKey === 'string' && fact.attributeKey !== ''
    ? fact.attributeKey
    : normalizeAttribute(attribute)
  const valueKey = typeof fact.valueKey === 'string' && fact.valueKey !== ''
    ? fact.valueKey
    : normalizeText(value)
  const createdAt = Number.isFinite(fact.createdAt) ? fact.createdAt : Date.now()
  const slotKey = typeof fact.slotKey === 'string' && fact.slotKey !== ''
    ? fact.slotKey
    : `${subjectKey}|${attributeKey}`
  return {
    id: typeof fact.id === 'string' && fact.id !== ''
      ? fact.id
      : `fact-${hash32(`${slotKey}|${valueKey}`).toString(36)}`,
    subject,
    attribute,
    value,
    subjectKey,
    attributeKey,
    slotKey,
    valueKey,
    sessionId: typeof fact.sessionId === 'string' ? fact.sessionId : '',
    sessionTitle: typeof fact.sessionTitle === 'string' ? fact.sessionTitle.slice(0, 120) : '',
    turn: Math.max(0, Math.floor(Number(fact.turn) || 0)),
    sourceMemoryIds: Array.isArray(fact.sourceMemoryIds)
      ? fact.sourceMemoryIds.filter((id) => typeof id === 'string').slice(-MAX_FACT_SOURCES)
      : [],
    purgedSourceIds: Array.isArray(fact.purgedSourceIds)
      ? fact.purgedSourceIds.filter((id) => typeof id === 'string').slice(-MAX_FACT_SOURCES)
      : [],
    confidence: clamp(Number(fact.confidence) || 0.6, 0, 1),
    createdAt,
    lastSeenAt: Number.isFinite(fact.lastSeenAt) ? fact.lastSeenAt : createdAt,
    seenCount: Math.max(1, Math.floor(Number(fact.seenCount) || 1)),
    invalidatedAt: Number.isFinite(fact.invalidatedAt) && fact.invalidatedAt > 0 ? fact.invalidatedAt : 0,
    invalidatedBy: typeof fact.invalidatedBy === 'string' ? fact.invalidatedBy : '',
    invalidReason: typeof fact.invalidReason === 'string' ? fact.invalidReason : '',
  }
}

/**
 * @param {Record<string, any>} fact Fact record.
 * @returns {Record<string, any>} Detached copy.
 */
function cloneFact(fact) {
  return {
    ...fact,
    sourceMemoryIds: [...fact.sourceMemoryIds],
    purgedSourceIds: [...fact.purgedSourceIds],
  }
}

/**
 * Canonicalize persisted summary layers.
 * @param {unknown} raw Persisted summaries.
 * @returns {{ sessions: Record<string, any>[], daily: Record<string, any>[], weekly: Record<string, any>[] }} Layers.
 */
function normalizeSummaries(raw) {
  const source = raw !== null && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {}
  const sessions = []
  for (const item of Array.isArray(source.sessions) ? source.sessions : []) {
    if (item === null || typeof item !== 'object') continue
    const text = typeof item.text === 'string' ? item.text.slice(0, 240) : ''
    if (text === '') continue
    sessions.push({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : `sum-session-${sessions.length}`,
      sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
      title: typeof item.title === 'string' ? item.title.slice(0, 120) : '',
      text,
      basedOnCount: Math.max(0, Math.floor(Number(item.basedOnCount) || 0)),
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
    })
  }
  const daily = []
  for (const item of Array.isArray(source.daily) ? source.daily : []) {
    if (item === null || typeof item !== 'object') continue
    const text = typeof item.text === 'string' ? item.text.slice(0, 240) : ''
    const date = typeof item.date === 'string' ? item.date : ''
    if (text === '' || date === '') continue
    daily.push({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : `sum-day-${date}`,
      date,
      text,
      count: Math.max(0, Math.floor(Number(item.count) || 0)),
      topTags: Array.isArray(item.topTags) ? item.topTags.filter((tag) => typeof tag === 'string').slice(0, 6) : [],
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
    })
  }
  const weekly = []
  for (const item of Array.isArray(source.weekly) ? source.weekly : []) {
    if (item === null || typeof item !== 'object') continue
    const text = typeof item.text === 'string' ? item.text.slice(0, 240) : ''
    const week = typeof item.week === 'string' ? item.week : ''
    if (text === '' || week === '') continue
    weekly.push({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : `sum-week-${week}`,
      week,
      text,
      count: Math.max(0, Math.floor(Number(item.count) || 0)),
      topTags: Array.isArray(item.topTags) ? item.topTags.filter((tag) => typeof tag === 'string').slice(0, 6) : [],
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
    })
  }
  return {
    sessions: sessions.slice(0, MAX_SESSION_SUMMARIES),
    daily: daily.slice(0, MAX_DAILY_SUMMARIES),
    weekly: weekly.slice(0, MAX_WEEKLY_SUMMARIES),
  }
}

/**
 * @param {Record<string, any>} summary Summary record.
 * @returns {Record<string, any>} Detached copy.
 */
function cloneSummary(summary) {
  return { ...summary, topTags: Array.isArray(summary.topTags) ? [...summary.topTags] : [] }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * In-memory memory store whose only external dependency is an async saver.
 * Create it in `apply`, load a persisted payload with `load`, then use
 * `commit`/`commitNow` for every mutation so the revision and the debounced
 * persistence stay consistent.
 */
export class MemoryStore {
  /**
   * @param {{ settings?: Record<string, any>, now?: () => number, save?: (payload: Record<string, any>) => Promise<void> }} [options]
   */
  constructor(options = {}) {
    const initial = options.settings !== null && typeof options.settings === 'object'
      ? /** @type {Record<string, any>} */ (options.settings)
      : {}
    /** @type {ReturnType<typeof resolveSettings>} Effective settings. */
    this.settings = resolveSettings(initial)
    /** @type {number} User-facing forgetting horizon (days) for a typical memory. */
    this.forgetAfterDays = DEFAULT_FORGET_AFTER_DAYS
    if (Number.isFinite(initial.forgetAfterDays)) {
      this.forgetAfterDays = clamp(Number(initial.forgetAfterDays), FORGET_AFTER_MIN, FORGET_AFTER_MAX)
      this.settings.halfLifeDays = halfLifeDaysFor(this.forgetAfterDays, this.settings)
    } else if (Number.isFinite(initial.halfLifeDays)) {
      // Legacy caller that only knows the half-life scale.
      this.forgetAfterDays = Math.round(forgetAfterDaysFor(this.settings.halfLifeDays, this.settings))
    } else {
      this.settings.halfLifeDays = halfLifeDaysFor(this.forgetAfterDays, this.settings)
    }
    /** @type {Record<string, any>[]} Memory records (episodes + semantic). */
    this.memories = []
    this.revision = 0
    this.lastSleepAt = 0
    /** @type {() => number} */
    this.clock = typeof options.now === 'function' ? options.now : () => Date.now()
    /** @type {((payload: Record<string, any>) => Promise<void>) | null} */
    this.saver = typeof options.save === 'function' ? options.save : null
    /** @type {Map<string, Record<string, any>>} turnKey -> episode, rebuilt on load. */
    this.turnIndex = new Map()
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.saveTimer = null
    /** @type {Promise<void>} */
    this.saveChain = Promise.resolve()
    /** Whether time-driven forgetting is enabled (user toggle). */
    this.forgettingEnabled = initial.forgettingEnabled !== false
    /** Frozen clock while forgetting is disabled (0 = running). */
    this.forgettingPausedAt = 0
    if (!this.forgettingEnabled) this.forgettingPausedAt = this.now()
    /** Independent feature toggles for the layered memory upgrade. */
    this.features = normalizeFeatures(options.features)
    /** @type {Record<string, any>[]} Structured subject-attribute-value facts. */
    this.facts = []
    /** @type {{ sessions: Record<string, any>[], daily: Record<string, any>[], weekly: Record<string, any>[] }} */
    this.summaries = { sessions: [], daily: [], weekly: [] }
  }

  /** Current epoch milliseconds. */
  now() {
    const value = this.clock()
    return Number.isFinite(value) ? value : Date.now()
  }

  /**
   * Clock used by the forgetting model: real time while forgetting is enabled,
   * frozen at the pause moment while it is disabled. This keeps every retention
   * value, graph and statistic stable while the user has forgetting switched off.
   * @returns {number} Effective epoch milliseconds.
   */
  effectiveNow() {
    if (!this.forgettingEnabled && this.forgettingPausedAt > 0) return this.forgettingPausedAt
    return this.now()
  }

  /**
   * Clamp a freshly written timestamp to the frozen pause clock, so memories
   * encoded while forgetting is paused do not "age" from the real time.
   * @param {number} timestamp Epoch milliseconds.
   * @returns {number} Possibly clamped timestamp.
   */
  clampToPauseClock(timestamp) {
    if (this.forgettingEnabled || !(this.forgettingPausedAt > 0)) return timestamp
    return Math.min(timestamp, this.forgettingPausedAt)
  }

  /**
   * Resume the forgetting clock after a pause: shift every time-based field by
   * the paused duration so that re-enabling forgetting does not instantly
   * forget everything that happened while it was off.
   * @returns {number} Paused duration in milliseconds (0 when not paused).
   */
  resumeForgettingClock() {
    const pausedAt = this.forgettingPausedAt
    if (!(pausedAt > 0)) return 0
    const shift = Math.max(0, this.now() - pausedAt)
    this.forgettingPausedAt = 0
    if (shift === 0) return 0
    for (const memory of this.memories) {
      if (memory.lastAccessAt > 0) memory.lastAccessAt += shift
      if (memory.forgottenAt > 0) memory.forgottenAt += shift
    }
    if (this.lastSleepAt > 0) this.lastSleepAt += shift
    return shift
  }

  /**
   * Adopt a persisted payload. Never throws: a corrupt payload leaves the store
   * empty instead of taking the plugin activation down with it.
   * @param {unknown} payload Parsed `memory-brain.json`.
   */
  load(payload) {
    if (payload === null || typeof payload !== 'object') return
    const data = /** @type {Record<string, any>} */ (payload)
    const persisted = data.settings !== null && typeof data.settings === 'object'
      ? /** @type {Record<string, any>} */ (data.settings)
      : {}
    this.settings = resolveSettings(persisted)
    this.forgettingEnabled = persisted.forgettingEnabled !== false
    this.forgettingPausedAt = 0
    if (!this.forgettingEnabled) {
      const pausedAt = Number(data.forgettingPausedAt ?? persisted.forgettingPausedAt)
      this.forgettingPausedAt = Number.isFinite(pausedAt) && pausedAt > 0 ? pausedAt : this.now()
    }
    if (Number.isFinite(persisted.forgetAfterDays) && persisted.forgetAfterDays > 0) {
      this.forgetAfterDays = clamp(Number(persisted.forgetAfterDays), FORGET_AFTER_MIN, FORGET_AFTER_MAX)
    } else {
      // Bank persisted before the explicit horizon existed: adopt the new
      // default policy and derive the matching half-life scale.
      this.forgetAfterDays = DEFAULT_FORGET_AFTER_DAYS
      this.settings.halfLifeDays = halfLifeDaysFor(this.forgetAfterDays, this.settings)
    }
    this.revision = Number.isFinite(data.revision) && data.revision > 0 ? Math.floor(data.revision) : 0
    this.lastSleepAt = Number.isFinite(data.lastSleepAt) ? data.lastSleepAt : 0
    /** @type {Record<string, any>[]} */
    const records = []
    for (const raw of Array.isArray(data.memories) ? data.memories : []) {
      const record = normalizeRecord(raw)
      if (record !== null) records.push(record)
    }
    this.memories = records
    this.rebuildIndex()
    // Layered-memory migration (batch 1-2): the persisted payload may predate
    // facts/summaries, so derive them once from the existing bank when enabled.
    this.features = normalizeFeatures(data.features)
    this.facts = Array.isArray(data.facts)
      ? data.facts.map(normalizeFact).filter((fact) => fact !== null).slice(0, MAX_FACTS)
      : []
    this.summaries = normalizeSummaries(data.summaries)
    const hasReadableEpisodes = this.memories.some((memory) => memory.kind === 'episode' && memory.contentPurged !== true)
    if (this.features.factExtraction && this.facts.length === 0 && hasReadableEpisodes) {
      try {
        this.rebuildFacts({ clear: false, silent: true })
      } catch {
        // A derivation failure must not take the whole bank down.
      }
    }
    if ((this.features.sessionSummary || this.features.dailyWeeklySummary) && this.summariesEmpty()) {
      try {
        this.rebuildSummaries()
      } catch {
        // Same rule: keep the bank usable even if a summary pass fails.
      }
    }
  }

  /** @returns {boolean} True when no summary layer has content. */
  summariesEmpty() {
    return this.summaries.sessions.length === 0
      && this.summaries.daily.length === 0
      && this.summaries.weekly.length === 0
  }

  /** Rebuild the turn dedupe index from current records. */
  rebuildIndex() {
    this.turnIndex = new Map()
    for (const memory of this.memories) {
      if (memory.kind === 'episode' && memory.turnKey !== '') this.turnIndex.set(memory.turnKey, memory)
    }
  }

  /** @returns {Record<string, any>} Serializable payload. */
  serialize() {
    return {
      version: STORE_VERSION,
      revision: this.revision,
      settings: {
        ...this.settings,
        forgetAfterDays: this.forgetAfterDays,
        forgettingEnabled: this.forgettingEnabled,
      },
      features: { ...this.features },
      memories: this.memories.map(cloneRecord),
      facts: this.facts.map(cloneFact),
      summaries: {
        sessions: this.summaries.sessions.map(cloneSummary),
        daily: this.summaries.daily.map(cloneSummary),
        weekly: this.summaries.weekly.map(cloneSummary),
      },
      lastSleepAt: this.lastSleepAt,
      forgettingPausedAt: this.forgettingPausedAt,
      savedAt: this.now(),
    }
  }

  /** Coalesce persistence writes: many turn captures, one disk write. */
  scheduleSave() {
    if (this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, 250)
    if (typeof this.saveTimer?.unref === 'function') this.saveTimer.unref()
  }

  /** Await one durable write of the current state. */
  async flush() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const saver = this.saver
    if (saver === null) return
    const payload = this.serialize()
    const pending = this.saveChain.then(() => saver(payload))
    this.saveChain = pending.catch(() => {})
    await pending
  }

  /**
   * Apply one mutation and return the fresh read model. Used by HTTP routes and
   * the agent tool, where the caller answers with the whole state.
   * @template T
   * @param {() => T} mutate Mutation; may throw MemoryError.
   * @returns {{ state: Record<string, any>, value: T }}
   */
  commit(mutate) {
    const value = mutate()
    this.revision += 1
    const state = this.snapshot()
    this.scheduleSave()
    return { state, value }
  }

  /**
   * Awaiting variant of `commit` for route handlers.
   * @template T
   * @param {() => T} mutate Mutation.
   * @returns {Promise<{ state: Record<string, any>, value: T }>}
   */
  async commitNow(mutate) {
    const result = this.commit(mutate)
    await this.flush()
    return result
  }

  /**
   * Apply one mutation without building the (more expensive) snapshot; used by
   * fire-and-forget capture and by recall's rehearsal bookkeeping.
   * @template T
   * @param {() => T} mutate Mutation.
   * @returns {T} Mutation result.
   */
  commitLight(mutate) {
    const value = mutate()
    this.revision += 1
    this.scheduleSave()
    return value
  }

  /** Stop the pending timer; the caller should `flush()` during teardown. */
  dispose() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  // -------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------

  /** @returns {Record<string, any>} The public settings slice the panel edits. */
  publicSettings() {
    return {
      forgetAfterDays: this.forgetAfterDays,
      forgettingEnabled: this.forgettingEnabled,
      halfLifeDays: this.settings.halfLifeDays,
      baseStabilityDays: this.settings.baseStabilityDays,
      fadingThreshold: this.settings.fadingThreshold,
      forgetThreshold: this.settings.forgetThreshold,
      autoCapture: this.settings.autoCapture,
      maxMemories: this.settings.maxMemories,
      consolidateEveryHours: this.settings.consolidateEveryHours,
      features: { ...this.features },
    }
  }

  /**
   * Build the whole read model: graph, statistics, tag cloud and task groups.
   * @returns {Record<string, any>} The `state` payload the panel consumes.
   */
  snapshot() {
    const now = this.effectiveNow()
    const graph = buildGraph(this.memories, now, this.settings)
    const stats = computeStats(this.memories, now, this.settings)
    return {
      version: 2,
      revision: this.revision,
      now,
      settings: this.publicSettings(),
      stats,
      tags: tagCounts(this.memories),
      sessions: this.deriveSessions(now),
      nodes: graph.nodes,
      edges: graph.edges,
      features: { ...this.features },
      facts: this.features.factExtraction ? this.factsForState() : [],
      factsStats: typeof factStats === 'function' ? factStats(this.facts) : { total: this.facts.length, active: this.facts.filter((fact) => fact.invalidatedAt === 0).length, superseded: this.facts.filter((fact) => fact.invalidatedAt > 0).length, subjects: 0 },
      summaries: (this.features.sessionSummary || this.features.dailyWeeklySummary)
        ? this.summariesForState()
        : { sessions: [], daily: [], weekly: [] },
      summaryStats: this.summaryCounts(),
    }
  }

  /** Cheap statistics for the system-prompt digest (no graph build). */
  summary() {
    const now = this.effectiveNow()
    const stats = computeStats(this.memories, now, this.settings)
    return {
      ...stats,
      revision: this.revision,
      autoCapture: this.settings.autoCapture,
      forgettingEnabled: this.forgettingEnabled,
      factCount: this.facts.filter((fact) => fact.invalidatedAt === 0).length,
      summaryCounts: this.summaryCounts(),
    }
  }

  /**
   * Group memories by their task (Session) for the panel's left rail.
   * @param {number} now Current time.
   * @returns {Array<Record<string, any>>} Sessions, most recently active first.
   */
  deriveSessions(now) {
    /** @type {Map<string, { sessionId: string, source: string, title: string, titleAt: number, count: number, activeCount: number, lastAt: number, tagCounts: Map<string, number> }>} */
    const groups = new Map()
    for (const memory of this.memories) {
      const sessionId = memory.sessionId !== '' ? memory.sessionId : 'manual'
      let group = groups.get(sessionId)
      if (group === undefined) {
        group = { sessionId, source: '', title: '', titleAt: -1, count: 0, activeCount: 0, lastAt: 0, tagCounts: new Map() }
        groups.set(sessionId, group)
      }
      group.count += 1
      if (memory.source === 'qq') group.source = 'qq'
      if (memoryState(memory, now, this.settings) === 'active') group.activeCount += 1
      group.lastAt = Math.max(group.lastAt, memory.lastAccessAt, memory.createdAt)
      if (memory.sessionTitle !== '' && memory.lastAccessAt >= group.titleAt) {
        group.title = memory.sessionTitle
        group.titleAt = memory.lastAccessAt
      }
      for (const tag of memory.tags) group.tagCounts.set(tag, (group.tagCounts.get(tag) ?? 0) + 1)
    }
    const sessions = [...groups.values()].map((group) => ({
      sessionId: group.sessionId,
      source: group.source,
      title: group.title !== '' ? group.title : (group.sessionId === 'manual' ? '手动记忆' : group.sessionId),
      count: group.count,
      activeCount: group.activeCount,
      lastAt: group.lastAt,
      topTags: [...group.tagCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([tag]) => tag),
    }))
    sessions.sort((a, b) => b.lastAt - a.lastAt)
    return sessions.slice(0, MAX_SESSIONS)
  }

  // -------------------------------------------------------------------
  // Encoding (capture)
  // -------------------------------------------------------------------

  /**
   * Encode one conversation turn as an episodic memory. Idempotent per
   * `sessionId#turn`: a replayed turn never duplicates its memory.
   * `source`/`sourceTags` let the capture layer mark where the turn came from
   * (the QQ bridge uses `'qq'` + the `QQ` tag).
   * @param {{ sessionId: string, sessionTitle?: string, turn: number, userTexts?: readonly string[], assistantTexts?: readonly string[], toolNames?: readonly string[], startedAt?: number, endedAt?: number, encodedAt?: number, seq?: number, source?: string, sourceTags?: readonly string[] }} input Turn payload.
   * @returns {Record<string, any> | null} The new record, or null when skipped.
   */
  ingestTurn(input) {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    if (sessionId === '') return null
    const turn = Number.isFinite(input.turn) ? Math.max(0, Math.floor(input.turn)) : 0
    const turnKey = `${sessionId}#${turn}`
    if (this.turnIndex.has(turnKey)) return null
    const userText = (Array.isArray(input.userTexts) ? input.userTexts.join('\n') : '').slice(0, MAX_STORED_TEXT)
    const assistantText = (Array.isArray(input.assistantTexts) ? input.assistantTexts.join('\n') : '').slice(0, MAX_STORED_TEXT)
    if (userText.trim() === '' && assistantText.trim() === '') return null
    const toolNames = Array.isArray(input.toolNames) ? input.toolNames.filter((name) => typeof name === 'string') : []
    const now = this.now()
    const createdAt = Number.isFinite(input.startedAt) ? input.startedAt : now
    // Backfilled history is "recalled" at capture time, so encoding resets the
    // forgetting clock while `createdAt` keeps the real conversation date.
    // While forgetting is paused the clock is frozen, so clamp to the pause point.
    const lastAccessAt = this.clampToPauseClock(Number.isFinite(input.encodedAt) ? input.encodedAt : now)
    const sessionTitle = typeof input.sessionTitle === 'string' ? input.sessionTitle.slice(0, 120) : ''
    const autoTags = autoTagsForEpisode({
      userText,
      assistantText,
      sessionTitle,
      toolNames,
    })
    // Source tags come last so the topic tags keep their natural priority.
    const sourceTags = Array.isArray(input.sourceTags)
      ? input.sourceTags.map((tag) => normalizeTag(tag)).filter((tag) => tag !== '')
      : []
    const tags = dedupeTags([...autoTags, ...sourceTags])
    const record = normalizeRecord({
      id: `ep-${hash32(turnKey).toString(36)}`,
      kind: 'episode',
      source: input.source === 'qq' ? 'qq' : '',
      sessionId,
      sessionTitle,
      turn,
      turnKey,
      seq: Number.isFinite(input.seq) ? input.seq : 0,
      userText,
      assistantText,
      excerpt: buildExcerpt(userText, assistantText),
      tags,
      toolNames,
      createdAt,
      lastAccessAt,
      accessCount: 1,
      salience: computeSalience(userText.length + assistantText.length, toolNames.length),
      pinned: false,
      consolidated: false,
      memberIds: [],
      forgottenAt: 0,
    })
    if (record === null) return null
    this.memories.push(record)
    this.turnIndex.set(turnKey, record)
    this.enforceCapacity(this.effectiveNow())
    if (this.features.factExtraction) {
      this.ingestFactsForRecord(record, { userText, assistantText, sessionTitle, sessionId, turn, now })
    }
    return record
  }

  // -------------------------------------------------------------------
  // Structured facts (batch 1) and summary layers (batch 2)
  // -------------------------------------------------------------------

  /**
   * Extract subject-attribute-value facts from one turn and merge them under
   * the independent dedup/conflict toggles. Never throws: the memory path must
   * stay usable even when a rule trips.
   * @param {Record<string, any> | null} record Source episode.
   * @param {{ userText?: string, assistantText?: string, sessionTitle?: string, sessionId?: string, turn?: number, now?: number }} input Turn context.
   * @returns {{ added: Record<string, any>[], merged: Record<string, any>[], superseded: Record<string, any>[] }} What changed.
   */
  ingestFactsForRecord(record, input) {
    const empty = { added: [], merged: [], superseded: [] }
    if (!this.features.factExtraction || typeof extractFacts !== 'function') return empty
    const now = Number.isFinite(input.now) ? input.now : this.now()
    let candidates = []
    try {
      candidates = extractFacts({
        userText: typeof input.userText === 'string' ? input.userText : '',
        assistantText: typeof input.assistantText === 'string' ? input.assistantText : '',
        sessionTitle: typeof input.sessionTitle === 'string' ? input.sessionTitle : '',
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
        turn: Number.isFinite(input.turn) ? input.turn : 0,
        createdAt: now,
        defaultSubject: '用户',
      })
    } catch {
      return empty
    }
    const filtered = this.filterFactCandidates(candidates)
    return this.applyFactCandidates(filtered, {
      now,
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
      sessionTitle: typeof input.sessionTitle === 'string' ? input.sessionTitle : '',
      turn: Number.isFinite(input.turn) ? input.turn : 0,
      memoryId: record !== null && typeof record === 'object' && typeof record.id === 'string' ? record.id : '',
    })
  }

  /**
   * Drop low-quality rule-extraction noise before it reaches the fact bank:
   * grammatical fragments as subjects, punctuation-laden values, and
   * non-first-person "other" facts that the explicit-subject rule over-matches.
   * @param {readonly Record<string, any>[]} candidates Raw candidates.
   * @returns {Record<string, any>[]} Candidates worth keeping.
   */
  filterFactCandidates(candidates) {
    if (!Array.isArray(candidates)) return []
    const GENERIC_SUBJECTS = new Set(['这一轮', '接下来', '现在', '之前', '上次', '今天', '明天', '以后', '目前', '这里', '那里'])
    return candidates.filter((candidate) => {
      if (candidate === null || typeof candidate !== 'object') return false
      const subject = typeof candidate.subject === 'string' ? candidate.subject.trim() : ''
      const attribute = typeof candidate.attribute === 'string' ? candidate.attribute.trim() : ''
      const value = typeof candidate.value === 'string' ? candidate.value.trim() : ''
      if (subject === '' || attribute === '' || value === '') return false
      if (!/^[\u4e00-\u9fffA-Za-z0-9_·-]{1,12}$/u.test(subject)) return false
      if (!/^[^[\]{}<>「」『』"`|=¥\\]{1,40}$/u.test(value)) return false
      if (subject !== '用户' && attribute === '其他') return false
      if (GENERIC_SUBJECTS.has(subject)) return false
      // A one-character non-CJK value is almost always a code fragment ("C").
      if ([...value].length < 2 && !/[\u4e00-\u9fff]/u.test(value)) return false
      return true
    })
  }

  /**
   * Merge fact candidates into the fact bank using the dedup/conflict toggles.
   * @param {readonly Record<string, any>[]} candidates Candidates from `extractFacts`.
   * @param {Record<string, any>} [context] Source turn/memory metadata.
   * @returns {{ added: Record<string, any>[], merged: Record<string, any>[], superseded: Record<string, any>[] }} What changed.
   */
  applyFactCandidates(candidates, context = {}) {
    const empty = { added: [], merged: [], superseded: [] }
    if (!Array.isArray(candidates) || candidates.length === 0 || typeof applyFacts !== 'function') return empty
    let result
    try {
      result = applyFacts(this.facts, candidates, {
        now: Number.isFinite(context.now) ? context.now : this.now(),
        dedupEnabled: this.features.factDedup,
        conflictEnabled: this.features.factConflict,
        maxFacts: MAX_FACTS,
      })
    } catch {
      return empty
    }
    this.facts = Array.isArray(result.facts) ? result.facts : this.facts
    const touched = new Set()
    for (const collection of [result.added, result.merged]) {
      for (const fact of Array.isArray(collection) ? collection : []) {
        if (fact !== null && typeof fact === 'object' && typeof fact.id === 'string') touched.add(fact.id)
      }
    }
    for (const fact of this.facts) {
      if (fact !== null && typeof fact === 'object' && touched.has(fact.id)) this.decorateFact(fact, context)
    }
    return {
      added: Array.isArray(result.added) ? result.added : [],
      merged: Array.isArray(result.merged) ? result.merged : [],
      superseded: Array.isArray(result.superseded) ? result.superseded : [],
    }
  }

  /**
   * Fill in missing fact metadata (keys, source turn/memory) after applyFacts.
   * @param {Record<string, any>} fact Fact record (mutated in place).
   * @param {Record<string, any>} [context] Source turn/memory metadata.
   */
  decorateFact(fact, context = {}) {
    if (fact === null || typeof fact !== 'object') return
    if (fact.sessionId === '' || fact.sessionId === undefined) {
      if (typeof context.sessionId === 'string') fact.sessionId = context.sessionId
    }
    if (fact.sessionTitle === '' || fact.sessionTitle === undefined) {
      if (typeof context.sessionTitle === 'string') fact.sessionTitle = context.sessionTitle.slice(0, 120)
    }
    if (!(fact.turn > 0) && Number.isFinite(context.turn)) fact.turn = Math.max(0, Math.floor(context.turn))
    try {
      if (typeof fact.subjectKey !== 'string' || fact.subjectKey === '') fact.subjectKey = normalizeSubject(fact.subject)
      if (typeof fact.attributeKey !== 'string' || fact.attributeKey === '') fact.attributeKey = normalizeAttribute(fact.attribute)
      if (typeof fact.valueKey !== 'string' || fact.valueKey === '') fact.valueKey = normalizeText(fact.value)
      if (typeof fact.slotKey !== 'string' || fact.slotKey === '') fact.slotKey = `${fact.subjectKey}|${fact.attributeKey}`
    } catch {
      // Keys are an optimisation; a rule failure must not break capture.
    }
    const memoryId = typeof context.memoryId === 'string' ? context.memoryId : ''
    if (memoryId !== '' && fact.id !== memoryId) {
      const sources = Array.isArray(fact.sourceMemoryIds) ? fact.sourceMemoryIds : []
      if (!sources.includes(memoryId)) fact.sourceMemoryIds = [...sources, memoryId].slice(-MAX_FACT_SOURCES)
    }
    if (!Array.isArray(fact.purgedSourceIds)) fact.purgedSourceIds = []
    if (!(fact.seenCount >= 1)) fact.seenCount = 1
    if (!(fact.lastSeenAt > 0)) fact.lastSeenAt = Number.isFinite(context.now) ? context.now : this.now()
    if (!(fact.createdAt > 0)) fact.createdAt = Number.isFinite(context.now) ? context.now : this.now()
  }

  /**
   * Invalidate facts whose every source memory lost its readable content, so a
   * fact never outlives the memory it was extracted from (deletion contract).
   * @param {readonly string[]} memoryIds Removed/purged memory ids.
   * @param {number} at Epoch milliseconds.
   * @param {string} [reason] Invalidation reason.
   * @returns {number} Number of facts invalidated by this call.
   */
  invalidateFactsForMemories(memoryIds, at, reason = 'source-forgotten') {
    const removed = new Set(Array.isArray(memoryIds) ? memoryIds : [])
    if (removed.size === 0) return 0
    const time = Number.isFinite(at) ? at : this.now()
    let count = 0
    for (const fact of this.facts) {
      if (fact === null || typeof fact !== 'object' || fact.invalidatedAt > 0) continue
      const sources = Array.isArray(fact.sourceMemoryIds) ? fact.sourceMemoryIds : []
      if (sources.length === 0) continue
      if (!sources.some((id) => removed.has(id))) continue
      const purged = Array.isArray(fact.purgedSourceIds) ? fact.purgedSourceIds : []
      for (const id of removed) if (sources.includes(id) && !purged.includes(id)) purged.push(id)
      fact.purgedSourceIds = purged.slice(-MAX_FACT_SOURCES)
      if (sources.every((id) => purged.includes(id))) {
        fact.invalidatedAt = time
        fact.invalidatedBy = reason
        fact.invalidReason = reason
        count += 1
      }
    }
    return count
  }

  /**
   * Re-derive the structured-fact bank from memory records (manual rebuild /
   * first-run migration). Respects the factExtraction toggle.
   * @param {{ clear?: boolean, memories?: Record<string, any>[], now?: number }} [options] Rebuild options.
   * @returns {{ total: number, active: number, added: number, merged: number, superseded: number }} Counts.
   */
  rebuildFacts(options = {}) {
    const now = Number.isFinite(options.now) ? options.now : this.now()
    if (options.clear !== false) this.facts = []
    if (!this.features.factExtraction || typeof extractFacts !== 'function') {
      return { total: this.facts.length, active: this.facts.filter((fact) => fact.invalidatedAt === 0).length, added: 0, merged: 0, superseded: 0 }
    }
    const source = Array.isArray(options.memories) ? options.memories : this.memories
    let added = 0
    let merged = 0
    let superseded = 0
    for (const memory of source) {
      if (memory === null || typeof memory !== 'object') continue
      if (memory.kind !== 'episode' || memory.contentPurged === true) continue
      const userText = typeof memory.userText === 'string' ? memory.userText : ''
      if (userText.trim() === '') continue
      const result = this.ingestFactsForRecord(memory, {
        userText,
        assistantText: typeof memory.assistantText === 'string' ? memory.assistantText : '',
        sessionTitle: typeof memory.sessionTitle === 'string' ? memory.sessionTitle : '',
        sessionId: typeof memory.sessionId === 'string' ? memory.sessionId : '',
        turn: Number.isFinite(memory.turn) ? memory.turn : 0,
        now,
      })
      added += Array.isArray(result.added) ? result.added.length : 0
      merged += Array.isArray(result.merged) ? result.merged.length : 0
      superseded += Array.isArray(result.superseded) ? result.superseded.length : 0
    }
    return {
      total: this.facts.length,
      active: this.facts.filter((fact) => fact.invalidatedAt === 0).length,
      added,
      merged,
      superseded,
    }
  }

  /** @returns {number} Number of structured facts removed. */
  clearFacts() {
    const before = this.facts.length
    this.facts = []
    return before
  }

  /**
   * Rebuild the session/daily/weekly summary layers from the memory bank.
   * @param {{ now?: number }} [options] Options.
   * @returns {{ sessions: number, daily: number, weekly: number }} Layer counts.
   */
  rebuildSummaries(options = {}) {
    const now = Number.isFinite(options.now) ? options.now : this.now()
    if (typeof buildSummaryLayers !== 'function'
      || (!this.features.sessionSummary && !this.features.dailyWeeklySummary)) {
      return this.summaryCounts()
    }
    let layers
    try {
      // Summaries read better from human-meaningful tags; ASCII tool/scaffold
      // tokens (access, action, asia, …) crowd out the real topics.
      const summarySource = this.memories.map((memory) => ({
        ...memory,
        tags: Array.isArray(memory.tags) ? memory.tags.filter((tag) => /[\u4e00-\u9fff]/.test(tag)) : [],
      }))
      layers = buildSummaryLayers(summarySource, { now, maxSessions: MAX_SESSION_SUMMARIES })
    } catch {
      return this.summaryCounts()
    }
    const sessions = Array.isArray(layers.sessions) ? layers.sessions : []
    const daily = Array.isArray(layers.daily) ? layers.daily : []
    const weekly = Array.isArray(layers.weekly) ? layers.weekly : []
    this.summaries = {
      sessions: this.features.sessionSummary ? sessions.slice(0, MAX_SESSION_SUMMARIES) : [],
      daily: this.features.dailyWeeklySummary ? daily.slice(0, MAX_DAILY_SUMMARIES) : [],
      weekly: this.features.dailyWeeklySummary ? weekly.slice(0, MAX_WEEKLY_SUMMARIES) : [],
    }
    return this.summaryCounts()
  }

  /** @returns {number} Number of summary entries removed. */
  clearSummaries() {
    const before = this.summaries.sessions.length + this.summaries.daily.length + this.summaries.weekly.length
    this.summaries = { sessions: [], daily: [], weekly: [] }
    return before
  }

  /** @returns {Record<string, number>} Summary layer counts. */
  summaryCounts() {
    return {
      sessions: this.summaries.sessions.length,
      daily: this.summaries.daily.length,
      weekly: this.summaries.weekly.length,
    }
  }

  /**
   * Apply a partial feature-toggle patch. Unknown keys are ignored; enabling
   * semantic recall derives embeddings, and summary/fact features backfill
   * their data so the panel has something to show immediately.
   * @param {unknown} patch Partial feature map.
   * @returns {Record<string, boolean>} Effective toggles.
   */
  updateFeatures(patch) {
    const source = patch !== null && typeof patch === 'object' ? /** @type {Record<string, any>} */ (patch) : {}
    const next = { ...this.features }
    for (const key of Object.keys(FEATURE_DEFAULTS)) {
      if (source[key] === undefined) continue
      next[key] = source[key] !== false
    }
    this.features = next
    if (this.features.semanticRecall) this.ensureEmbeddings()
    if (this.features.sessionSummary || this.features.dailyWeeklySummary) this.rebuildSummaries()
    if (this.features.factExtraction && this.facts.length === 0) this.rebuildFacts({ clear: false })
    return { ...this.features }
  }

  /**
   * Compute the offline hashed embedding for every memory that lacks one.
   * @returns {number} Number of memories that gained (or lost) an embedding.
   */
  ensureEmbeddings() {
    if (typeof hashEmbedding !== 'function') return 0
    let computed = 0
    for (const memory of this.memories) {
      if (memory.contentPurged === true) {
        if (Array.isArray(memory.embedding) && memory.embedding.length > 0) {
          memory.embedding = []
          computed += 1
        }
        continue
      }
      if (Array.isArray(memory.embedding) && memory.embedding.length > 0) continue
      const text = [
        memory.sessionTitle,
        memory.excerpt,
        memory.text,
        memory.label,
        ...(Array.isArray(memory.tags) ? memory.tags : []),
      ].filter((part) => typeof part === 'string' && part !== '').join(' ').slice(0, 800)
      if (text.trim() === '') continue
      memory.embedding = hashEmbedding(text)
      computed += 1
    }
    return computed
  }

  /** @returns {Record<string, any>[]} Valid facts for the panel read model. */
  factsForState() {
    const active = this.facts.filter((fact) => fact.invalidatedAt === 0)
    active.sort((left, right) => (right.lastSeenAt - left.lastSeenAt) || (right.createdAt - left.createdAt))
    return active.slice(0, MAX_FACTS_IN_STATE).map((fact) => ({
      id: fact.id,
      subject: fact.subject,
      attribute: fact.attribute,
      value: fact.value,
      seenCount: fact.seenCount,
      confidence: fact.confidence,
      sessionId: fact.sessionId,
      sessionTitle: fact.sessionTitle,
      createdAt: fact.createdAt,
      lastSeenAt: fact.lastSeenAt,
    }))
  }

  /** @returns {{ sessions: Record<string, any>[], daily: Record<string, any>[], weekly: Record<string, any>[] }} Summary read model. */
  summariesForState() {
    const sessions = [...this.summaries.sessions]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 100)
      .map((summary) => ({ ...summary }))
    const daily = [...this.summaries.daily]
      .sort((left, right) => (right.date < left.date ? -1 : right.date > left.date ? 1 : 0))
      .slice(0, 30)
      .map((summary) => ({ ...summary, topTags: [...summary.topTags] }))
    const weekly = [...this.summaries.weekly]
      .sort((left, right) => (right.week < left.week ? -1 : right.week > left.week ? 1 : 0))
      .slice(0, 12)
      .map((summary) => ({ ...summary, topTags: [...summary.topTags] }))
    return { sessions, daily, weekly }
  }

  /**
   * Encode a manually remembered fact ("remember this"), not tied to a turn.
   * @param {{ text: string, tags?: readonly string[], sessionId?: string, sessionTitle?: string }} input Content.
   * @returns {Record<string, any>} The new record.
   */
  remember(input) {
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, MAX_STORED_TEXT) : ''
    if (text === '') throw new MemoryError(400, 'empty-text', '要记住的内容不能为空。')
    const now = this.now()
    const sessionId = typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : 'manual'
    const manualTags = Array.isArray(input.tags) ? dedupeTags(input.tags.map((tag) => normalizeTag(tag)).filter((tag) => tag !== '')) : []
    const autoTags = autoTagsForEpisode({
      userText: text,
      assistantText: '',
      sessionTitle: typeof input.sessionTitle === 'string' ? input.sessionTitle : '',
      toolNames: [],
    })
    const tags = dedupeTags([...manualTags, ...autoTags])
    const record = normalizeRecord({
      id: `ep-m-${hash32(`${text}\u0000${now}`).toString(36)}`,
      kind: 'episode',
      sessionId,
      sessionTitle: typeof input.sessionTitle === 'string' ? input.sessionTitle.slice(0, 120) : '',
      turn: 0,
      userText: text,
      assistantText: '',
      excerpt: buildExcerpt(text, ''),
      tags: tags.length > 0 ? tags : ['手动'],
      toolNames: [],
      createdAt: now,
      lastAccessAt: this.clampToPauseClock(now),
      accessCount: 1,
      salience: 1.6,
      pinned: true,
      consolidated: false,
      memberIds: [],
      forgottenAt: 0,
    })
    if (record === null) throw new MemoryError(500, 'encode-failed', '记忆编码失败。')
    this.memories.push(record)
    this.enforceCapacity(this.effectiveNow())
    if (this.features.factExtraction) {
      this.ingestFactsForRecord(record, { userText: text, assistantText: '', sessionTitle: record.sessionTitle, sessionId, turn: 0, now })
    }
    return record
  }

  // -------------------------------------------------------------------
  // Memory operations
  // -------------------------------------------------------------------

  /**
   * @param {string} id Memory id.
   * @returns {Record<string, any> | undefined} The record, when present.
   */
  find(id) {
    if (typeof id !== 'string' || id === '') return undefined
    return this.memories.find((memory) => memory.id === id)
  }

  /**
   * @param {unknown} id Raw id from an HTTP body or tool argument.
   * @returns {Record<string, any>} The existing record.
   * @throws {MemoryError} When the id is missing or unknown.
   */
  requireMemory(id) {
    const key = typeof id === 'string' ? id.trim() : ''
    if (key === '') throw new MemoryError(400, 'invalid-id', '缺少记忆 id。')
    const memory = this.find(key)
    if (memory === undefined) throw new MemoryError(404, 'not-found', `没有找到记忆 ${key}。`)
    return memory
  }

  /**
   * Tag one memory (manual tag, like naming a memory in the brain).
   * @param {unknown} id Memory id.
   * @param {unknown} rawTag Tag text.
   * @returns {Record<string, any>} The updated record.
   * @throws {MemoryError} On a missing id or an empty tag.
   */
  addTag(id, rawTag) {
    const memory = this.requireMemory(id)
    const tag = normalizeTag(rawTag)
    if (tag === '') throw new MemoryError(400, 'invalid-tag', '标签不能为空。')
    if (!memory.tags.includes(tag)) memory.tags = dedupeTags([tag, ...memory.tags])
    return memory
  }

  /**
   * @param {unknown} id Memory id.
   * @param {unknown} rawTag Tag text.
   * @returns {Record<string, any>} The updated record.
   */
  removeTag(id, rawTag) {
    const memory = this.requireMemory(id)
    const tag = normalizeTag(rawTag)
    memory.tags = memory.tags.filter((existing) => existing !== tag)
    return memory
  }

  /**
   * Rehearse a memory: an extra exposure resets the forgetting clock and makes
   * the trace more stable (spacing effect).
   * @param {string} id Memory id.
   * @returns {Record<string, any>} The updated record.
   */
  rehearse(id) {
    const memory = this.requireMemory(id)
    memory.accessCount = Math.max(1, memory.accessCount) + 1
    memory.lastAccessAt = this.clampToPauseClock(this.now())
    return memory
  }

  /**
   * Forget one memory. Soft forgetting marks it forgotten and keeps a ghost for
   * the panel (its content is still there until the user restores or it reaches
   * the forgetting time); hard forgetting erases the record immediately.
   * @param {string} id Memory id.
   * @param {boolean} [hard] Erase instead of turning the memory into a ghost.
   * @returns {Record<string, any> | null} The ghost, or null when erased.
   */
  forget(id, hard = false) {
    const memory = this.requireMemory(id)
    if (hard === true) {
      this.memories = this.memories.filter((candidate) => candidate.id !== memory.id)
      if (memory.turnKey !== '') this.turnIndex.delete(memory.turnKey)
      if (memory.consolidated) {
        for (const semantic of this.memories) {
          if (semantic.kind !== 'semantic') continue
          semantic.memberIds = semantic.memberIds.filter((memberId) => memberId !== memory.id)
        }
      }
      this.invalidateFactsForMemories([memory.id], this.effectiveNow())
      this.clearSummaries()
      if (this.features.sessionSummary || this.features.dailyWeeklySummary) {
        this.rebuildSummaries({ now: this.effectiveNow() })
      }
      return null
    }
    memory.forgottenAt = this.now()
    memory.forgottenVia = 'manual'
    memory.pinned = false
    return memory
  }

  /**
   * Walk every memory and enforce the forgetting time: once an unpinned memory
   * crosses into the "forgotten" state on its own (not via the manual 遗忘
   * button), its readable content is deleted immediately and the record becomes
   * an empty tombstone. Idempotent and cheap (O(n)).
   * @param {number} [now] Current time (tests inject a clock).
   * @returns {number} Number of memories whose content was scrubbed.
   */
  sweepForgotten(now) {
    if (!this.forgettingEnabled) return 0
    const time = Number.isFinite(now) ? now : this.now()
    let scrubbed = 0
    const scrubbedIds = []
    for (const memory of this.memories) {
      if (memory.pinned || memory.contentPurged) continue
      // Manual "遗忘" stays reversible until a purge; only time-driven decay
      // deletes the content for good.
      if (memory.forgottenVia === 'manual') continue
      if (memoryState(memory, time, this.settings) !== 'forgotten') continue
      if (!(memory.forgottenAt > 0)) memory.forgottenAt = time
      memory.forgottenVia = 'time'
      if (scrubMemoryContent(memory)) {
        scrubbed += 1
        scrubbedIds.push(memory.id)
      }
    }
    if (scrubbed > 0) {
      // Facts and summaries must not outlive the content they were derived
      // from; drop the derived read model and rebuild the summaries from the
      // remaining (readable) memories.
      this.invalidateFactsForMemories(scrubbedIds, time)
      this.clearSummaries()
      if (this.features.sessionSummary || this.features.dailyWeeklySummary) {
        this.rebuildSummaries({ now: time })
      }
    }
    return scrubbed
  }

  /**
   * Recall a manually forgotten memory back into the active set. Memories whose
   * content was deleted by the forgetting time cannot be restored.
   * @param {string} id Memory id.
   * @returns {Record<string, any>} The restored record.
   * @throws {MemoryError} When the memory's content was already deleted.
   */
  restore(id) {
    const memory = this.requireMemory(id)
    if (memory.contentPurged === true) {
      throw new MemoryError(409, 'content-purged', '这条记忆已过遗忘时间，内容已被删除，无法恢复。')
    }
    memory.forgottenAt = 0
    memory.forgottenVia = ''
    memory.lastAccessAt = this.clampToPauseClock(this.now())
    memory.accessCount = Math.max(1, memory.accessCount) + 1
    return memory
  }

  /**
   * Pin / unpin one memory. Pinned memories are long-term: the curve no longer
   * applies and automatic purging never removes them.
   * @param {string} id Memory id.
   * @param {unknown} pinned Raw boolean.
   * @returns {Record<string, any>} The updated record.
   */
  pin(id, pinned) {
    const memory = this.requireMemory(id)
    memory.pinned = pinned === true
    if (memory.pinned) {
      memory.forgottenAt = 0
      memory.forgottenVia = ''
    }
    return memory
  }

  /**
   * The brain's "sleep": enforce the forgetting time (delete forgotten
   * content), consolidate similar episodes into semantic memories, then purge
   * what decayed past the purge threshold.
   * @param {number} [at] Explicit time (tests inject a clock).
   * @returns {{ consolidated: number, marked: number, purged: number, scrubbed: number }} What changed.
   */
  sleep(at) {
    const time = this.forgettingEnabled ? (Number.isFinite(at) ? at : this.now()) : this.effectiveNow()
    const scrubbed = this.sweepForgotten(time)
    // Tombstones carry no tags/content, so they never take part in
    // consolidation (otherwise every empty ghost would merge into one).
    const consolidatable = this.memories.filter((memory) => memory.contentPurged !== true)
    const { semantic, consolidatedIds } = consolidateEpisodes(consolidatable, time, this.settings)
    const consolidated = new Set(consolidatedIds)
    let marked = 0
    for (const memory of this.memories) {
      if (memory.kind !== 'episode' || memory.consolidated || !consolidated.has(memory.id)) continue
      memory.consolidated = true
      marked += 1
    }
    let semanticCount = this.memories.reduce((count, memory) => count + (memory.kind === 'semantic' ? 1 : 0), 0)
    let added = 0
    for (const candidate of semantic) {
      if (semanticCount >= MAX_SEMANTIC) break
      const record = normalizeRecord(candidate)
      if (record === null) continue
      if (this.memories.some((memory) => memory.id === record.id)) continue
      this.memories.push(record)
      semanticCount += 1
      added += 1
    }
    let purged = 0
    const purgedIds = []
    if (this.forgettingEnabled) {
      const before = this.memories.length
      this.memories = this.memories.filter((memory) => {
        if (memory.pinned) return true
        if (memory.forgottenAt > 0) {
          if (time - memory.forgottenAt < PURGE_AFTER_DAYS * DAY_MS) return true
          purgedIds.push(memory.id)
          return false
        }
        if (retentionAt(memory, time, this.settings) >= this.settings.purgeThreshold) return true
        purgedIds.push(memory.id)
        return false
      })
      purged = before - this.memories.length
      if (purged > 0) {
        this.invalidateFactsForMemories(purgedIds, time)
        this.clearSummaries()
      }
    }
    this.rebuildIndex()
    this.lastSleepAt = time
    this.enforceCapacity(time)
    if (this.features.sessionSummary || this.features.dailyWeeklySummary) {
      this.rebuildSummaries({ now: time })
    }
    return { consolidated: added, marked, purged, scrubbed }
  }

  /**
   * Delete every forgotten memory (the ghosts) right now. Manual cleanup works
   * even while forgetting is paused.
   * @returns {number} Number of memories removed.
   */
  purge() {
    const now = this.effectiveNow()
    const before = this.memories.length
    const removedIds = []
    this.memories = this.memories.filter((memory) => {
      if (memory.pinned) return true
      if (memory.forgottenAt > 0) {
        removedIds.push(memory.id)
        return false
      }
      if (memoryState(memory, now, this.settings) === 'forgotten') {
        removedIds.push(memory.id)
        return false
      }
      return true
    })
    if (removedIds.length > 0) {
      this.invalidateFactsForMemories(removedIds, now)
      this.clearSummaries()
      if (this.features.sessionSummary || this.features.dailyWeeklySummary) {
        this.rebuildSummaries({ now })
      }
    }
    this.rebuildIndex()
    return before - this.memories.length
  }

  /** Erase the whole memory bank. */
  reset() {
    this.memories = []
    this.facts = []
    this.summaries = { sessions: [], daily: [], weekly: [] }
    this.turnIndex = new Map()
    this.lastSleepAt = 0
  }

  /**
   * Update the tunable settings the panel exposes.
   * @param {unknown} patch Partial settings.
   * @returns {Record<string, any>} The effective settings.
   * @throws {MemoryError} On a value outside its allowed range.
   */
  updateSettings(patch) {
    const source = patch !== null && typeof patch === 'object' ? /** @type {Record<string, any>} */ (patch) : {}
    const next = { ...this.settings }
    let nextForgetAfter = this.forgetAfterDays
    if (source.forgettingEnabled !== undefined) {
      const enabled = source.forgettingEnabled !== false
      if (enabled !== this.forgettingEnabled) {
        if (enabled) this.resumeForgettingClock()
        else this.forgettingPausedAt = this.now()
        this.forgettingEnabled = enabled
      }
    }
    if (source.forgetAfterDays !== undefined) {
      const value = Number(source.forgetAfterDays)
      if (!Number.isFinite(value) || value < FORGET_AFTER_MIN || value > FORGET_AFTER_MAX) {
        throw new MemoryError(400, 'invalid-setting', `遗忘时间必须是 ${FORGET_AFTER_MIN}–${FORGET_AFTER_MAX} 天之间的数字。`)
      }
      nextForgetAfter = clamp(value, FORGET_AFTER_MIN, FORGET_AFTER_MAX)
      next.halfLifeDays = halfLifeDaysFor(nextForgetAfter, next)
    }
    if (source.halfLifeDays !== undefined && source.forgetAfterDays === undefined) {
      // Legacy API: keep an explicit half-life scale, report the implied horizon.
      const value = Number(source.halfLifeDays)
      if (!Number.isFinite(value) || value < 0.5 || value > 30) {
        throw new MemoryError(400, 'invalid-setting', 'halfLifeDays 必须是 0.5–30 之间的数字。')
      }
      next.halfLifeDays = value
      nextForgetAfter = Math.round(forgetAfterDaysFor(value, next))
    }
    if (source.autoCapture !== undefined) next.autoCapture = source.autoCapture === true
    if (source.maxMemories !== undefined) {
      const value = Number(source.maxMemories)
      if (!Number.isFinite(value) || value < 100 || value > 2000) {
        throw new MemoryError(400, 'invalid-setting', 'maxMemories 必须是 100–2000 之间的整数。')
      }
      next.maxMemories = Math.floor(value)
    }
    if (source.consolidateEveryHours !== undefined) {
      const value = Number(source.consolidateEveryHours)
      if (!Number.isFinite(value) || value < 1 || value > 24) {
        throw new MemoryError(400, 'invalid-setting', 'consolidateEveryHours 必须是 1–24 之间的数字。')
      }
      next.consolidateEveryHours = value
    }
    this.settings = resolveSettings(next)
    this.forgetAfterDays = nextForgetAfter
    return this.settings
  }

  /**
   * List/search structured facts (valid by default; superseded only when asked).
   * @param {{ query?: string, subject?: string, sessionId?: string, includeSuperseded?: boolean, limit?: number }} [options] Filters.
   * @returns {Array<Record<string, any>>} Matching facts.
   */
  listFacts(options = {}) {
    if (!this.features.factExtraction || typeof queryFacts !== 'function') return []
    /** @type {Record<string, any>} */
    const filters = {
      includeSuperseded: options.includeSuperseded === true,
      temporalHistory: options.includeSuperseded === true,
      limit: Math.floor(clamp(Number.isFinite(options.limit) ? options.limit : 20, 1, 50)),
    }
    if (typeof options.query === 'string' && options.query !== '') filters.query = options.query
    if (typeof options.subject === 'string' && options.subject !== '') filters.subject = options.subject
    if (typeof options.sessionId === 'string' && options.sessionId !== '') filters.sessionId = options.sessionId
    try {
      const result = queryFacts(this.facts, filters)
      return Array.isArray(result) ? result : (Array.isArray(result.facts) ? result.facts : [])
    } catch {
      return []
    }
  }

  /**
   * Read one summary layer (or all of them) in the panel-shaped format.
   * @param {'session'|'daily'|'weekly'|'all'} [level] Requested layer.
   * @param {number} [limit] Max entries per layer (default 10, max 20).
   * @returns {{ sessions: Record<string, any>[], daily: Record<string, any>[], weekly: Record<string, any>[] }} Summaries.
   */
  listSummaries(level = 'all', limit = 10) {
    const cap = Math.floor(clamp(Number.isFinite(limit) ? limit : 10, 1, 20))
    const all = this.summariesForState()
    const sessions = all.sessions.slice(0, cap)
    const daily = all.daily.slice(0, cap)
    const weekly = all.weekly.slice(0, cap)
    if (level === 'session') return { sessions, daily: [], weekly: [] }
    if (level === 'daily') return { sessions: [], daily, weekly: [] }
    if (level === 'weekly') return { sessions: [], daily: [], weekly }
    return { sessions, daily, weekly }
  }

  /**
   * Retrieve memories by keyword / tag / task, most retrievable first.
   * Pinned and recently rehearsed memories win; a decayed trace ranks lower.
   * Pure read: route/tool callers decide whether to rehearse the result.
   * @param {{ query?: string, tag?: string, sessionId?: string, limit?: number, includeFacts?: boolean, includeStructured?: boolean, layer?: string, subject?: string }} [options] Retrieval filters.
   * @returns {Array<Record<string, any>>} Ranked memories (and structured items when requested).
   */
  recall(options = {}) {
    return this.recallWithContext(options).items
  }

  /**
   * Layered retrieval: raw memories plus (optionally) structured facts and the
   * session/daily/weekly summary layer chosen by question complexity.
   * @param {{ query?: string, tag?: string, sessionId?: string, limit?: number, includeFacts?: boolean, includeStructured?: boolean, layer?: string, subject?: string }} [options] Retrieval filters.
   * @returns {{ layer: string, complexity: Record<string, any>, items: Array<Record<string, any>> }} Retrieval result.
   */
  recallWithContext(options = {}) {
    const now = this.effectiveNow()
    const query = typeof options.query === 'string' ? options.query.trim() : ''
    const queryLower = query.toLowerCase()
    const tag = typeof options.tag === 'string' ? normalizeTag(options.tag) : ''
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : ''
    const limit = Math.floor(clamp(Number.isFinite(options.limit) ? options.limit : 8, 1, MAX_RECALL_ITEMS))
    const effectiveLimit = Math.min(limit, MAX_RECALL_ITEMS)
    const words = queryLower.split(/[\s,，、。;；:：/]+/).filter((word) => word.length > 0)
    const includeStructured = options.includeStructured === true || options.includeFacts === true
    const requestedLayer = typeof options.layer === 'string' ? options.layer : 'auto'

    let complexity = { level: 'simple', layer: 'raw', reasons: [] }
    if (typeof classifyQueryComplexity === 'function') {
      try {
        complexity = classifyQueryComplexity(query)
      } catch {
        // Classification is a heuristic; fall back to the simple layer.
      }
    }
    let layer = 'raw'
    if (requestedLayer === 'raw' || requestedLayer === 'daily' || requestedLayer === 'weekly') {
      layer = requestedLayer
    } else if (this.features.layeredRecall) {
      try {
        layer = typeof selectRetrievalLayer === 'function'
          ? selectRetrievalLayer(complexity, this.features)
          : (complexity.layer || 'raw')
      } catch {
        layer = 'raw'
      }
    }

    /** @type {Array<{ memory: Record<string, any>, score: number }>} */
    const ranked = []
    for (const memory of this.memories) {
      if (memory.contentPurged === true) continue
      if (memory.forgottenAt > 0) continue
      const state = memoryState(memory, now, this.settings)
      if (state === 'forgotten') continue
      if (tag !== '' && !memory.tags.includes(tag)) continue
      if (sessionId !== '' && memory.sessionId !== sessionId) continue
      let score = retentionAt(memory, now, this.settings)
      if (memory.pinned) score += 1
      if (words.length > 0) {
        const haystack = `${memory.excerpt}\n${memory.userText}\n${memory.assistantText}\n${memory.text}\n${memory.tags.join(' ')}\n${memory.sessionTitle}`.toLowerCase()
        const hits = words.reduce((count, word) => count + (haystack.includes(word) ? 1 : 0), 0)
        if (hits === 0) continue
        score += hits * 0.6
      }
      ranked.push({ memory, score })
    }

    // Batch 3: offline hashed-embedding rescoring (vector + keyword fusion).
    if (this.features.semanticRecall && typeof hashEmbedding === 'function' && typeof cosineSimilarity === 'function') {
      let queryVector = []
      try {
        queryVector = query !== '' ? hashEmbedding(query) : []
      } catch {
        queryVector = []
      }
      if (Array.isArray(queryVector) && queryVector.length > 0) {
        for (const entry of ranked) {
          const memory = entry.memory
          if (!Array.isArray(memory.embedding) || memory.embedding.length !== queryVector.length) {
            const text = [memory.sessionTitle, memory.excerpt, memory.text, memory.label, ...(Array.isArray(memory.tags) ? memory.tags : [])]
              .filter((part) => typeof part === 'string' && part !== '').join(' ')
            try {
              memory.embedding = text.trim() !== '' ? hashEmbedding(text) : []
            } catch {
              memory.embedding = []
            }
          }
          if (Array.isArray(memory.embedding) && memory.embedding.length === queryVector.length) {
            entry.score += cosineSimilarity(queryVector, memory.embedding) * 0.8
          }
        }
      }
    }
    ranked.sort((left, right) => right.score - left.score || right.memory.lastAccessAt - left.memory.lastAccessAt)

    const memoryItem = (memory) => ({
      id: memory.id,
      kind: memory.kind,
      source: memory.source,
      label: memory.kind === 'semantic' ? memory.label : (memory.tags[0] ?? ''),
      excerpt: memory.excerpt !== '' ? memory.excerpt : memory.text,
      tags: [...memory.tags],
      sessionId: memory.sessionId,
      sessionTitle: memory.sessionTitle,
      turn: memory.turn,
      createdAt: memory.createdAt,
      lastAccessAt: memory.lastAccessAt,
      accessCount: memory.accessCount,
      stabilityDays: stabilityDays(memory, this.settings),
      retention: retentionAt(memory, now, this.settings),
      state: memoryState(memory, now, this.settings),
      pinned: memory.pinned,
    })

    if (!includeStructured) {
      return { layer, complexity, items: ranked.slice(0, effectiveLimit).map(({ memory }) => memoryItem(memory)) }
    }

    /** @type {Array<{ score: number, item: Record<string, any> }>} */
    const combined = ranked.slice(0, Math.max(effectiveLimit, 6)).map(({ memory, score }) => ({ score, item: memoryItem(memory) }))

    if (this.features.factExtraction && typeof queryFacts === 'function') {
      let found = []
      /** @type {Record<string, any>} */
      const filters = {
        includeSuperseded: this.features.temporalHistory === true,
        temporalHistory: this.features.temporalHistory === true,
        limit: Math.min(10, Math.max(effectiveLimit, 6)),
      }
      if (query !== '') filters.query = query
      if (typeof options.subject === 'string' && options.subject !== '') filters.subject = options.subject
      if (sessionId !== '') filters.sessionId = sessionId
      try {
        const result = queryFacts(this.facts, filters)
        found = Array.isArray(result) ? result : (Array.isArray(result.facts) ? result.facts : [])
      } catch {
        found = []
      }
      for (const fact of found) {
        combined.push({
          score: 1.4 + (fact.invalidatedAt > 0 ? -0.1 : 0),
          item: {
            id: fact.id,
            kind: 'fact',
            subject: fact.subject,
            attribute: fact.attribute,
            value: fact.value,
            seenCount: fact.seenCount,
            confidence: fact.confidence,
            sessionId: fact.sessionId,
            sessionTitle: fact.sessionTitle,
            turn: fact.turn,
            createdAt: fact.createdAt,
            lastSeenAt: fact.lastSeenAt,
            invalidated: fact.invalidatedAt > 0,
            invalidatedAt: fact.invalidatedAt,
            invalidReason: fact.invalidReason,
          },
        })
      }
    }

    const summaryMatches = (summary) => {
      if (summary === null || typeof summary !== 'object') return false
      if (words.length === 0) return true
      const haystack = `${summary.text ?? ''} ${summary.title ?? ''} ${summary.date ?? ''} ${summary.week ?? ''}`.toLowerCase()
      return words.some((word) => haystack.includes(word))
    }
    // A complex question ("summarize/overview") may not share keywords with a
    // summary; in a non-raw layer we fall back to the most recent summaries.
    const pickSummaries = (source, max) => {
      const matched = source.filter(summaryMatches)
      return matched.length > 0
        ? matched.slice(0, max)
        : (layer === 'raw' ? [] : [...source].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)).slice(0, max))
    }
    if (this.features.sessionSummary) {
      for (const summary of pickSummaries(
        this.summaries.sessions.filter((summary) => sessionId === '' || summary.sessionId === sessionId),
        3,
      )) {
        combined.push({
          score: 1.45,
          item: {
            id: summary.id,
            kind: 'session-summary',
            sessionId: summary.sessionId,
            title: summary.title,
            text: summary.text,
            basedOnCount: summary.basedOnCount,
            updatedAt: summary.updatedAt,
          },
        })
      }
    }
    if (this.features.dailyWeeklySummary) {
      if (layer === 'daily' || layer === 'weekly') {
        for (const summary of pickSummaries(this.summaries.daily, 5)) {
          combined.push({
            score: 1.5,
            item: { id: summary.id, kind: 'daily-summary', date: summary.date, text: summary.text, count: summary.count, topTags: [...summary.topTags], updatedAt: summary.updatedAt },
          })
        }
      }
      if (layer === 'weekly') {
        for (const summary of pickSummaries(this.summaries.weekly, 3)) {
          combined.push({
            score: 1.6,
            item: { id: summary.id, kind: 'weekly-summary', week: summary.week, text: summary.text, count: summary.count, topTags: [...summary.topTags], updatedAt: summary.updatedAt },
          })
        }
      }
    }
    combined.sort((left, right) => right.score - left.score)
    return { layer, complexity, items: combined.slice(0, effectiveLimit).map(({ item }) => item) }
  }

  /**
   * Reinforce several memories at once; the recall path uses this so retrieval
   * itself strengthens what was retrieved (re-consolidation).
   * @param {readonly string[]} ids Memory ids.
   * @returns {number} Number reinforced.
   */
  rehearseMany(ids) {
    const now = this.clampToPauseClock(this.now())
    let count = 0
    for (const id of Array.isArray(ids) ? ids : []) {
      const memory = this.find(id)
      if (memory === undefined) continue
      memory.accessCount = Math.max(1, memory.accessCount) + 1
      memory.lastAccessAt = now
      count += 1
    }
    return count
  }

  /**
   * Keep the bank under `maxMemories`, evicting the least retrievable memories
   * first (never pinned ones).
   * @param {number} [now] Current time.
   * @returns {number} Number evicted.
   */
  enforceCapacity(now) {
    const time = Number.isFinite(now) ? now : this.now()
    const limit = Math.max(50, Math.floor(this.settings.maxMemories))
    if (this.memories.length <= limit) return 0
    const removable = this.memories.filter((memory) => !memory.pinned)
    removable.sort((a, b) => {
      const aGhost = a.forgottenAt > 0 ? 1 : 0
      const bGhost = b.forgottenAt > 0 ? 1 : 0
      if (aGhost !== bGhost) return bGhost - aGhost
      const aRetention = retentionAt(a, time, this.settings)
      const bRetention = retentionAt(b, time, this.settings)
      if (aRetention !== bRetention) return aRetention - bRetention
      return a.lastAccessAt - b.lastAccessAt
    })
    const excess = this.memories.length - limit
    const victims = new Set(removable.slice(0, excess).map((memory) => memory.id))
    this.memories = this.memories.filter((memory) => !victims.has(memory.id))
    this.rebuildIndex()
    return victims.size
  }
}
