/**
 * Memory Brain — summary layers and layered-recall routing (CONTRACT.md §16).
 *
 * Everything here is a pure function: no imports, no clock, no randomness and
 * no mutation of the input. The same input always produces the same output,
 * which is what lets the store persist summaries and replay a rebuild without
 * the layers drifting. Malformed input never throws; it degrades to an empty,
 * deterministic shape so one corrupt record cannot poison the whole layer.
 *
 * Exports:
 *   classifyQueryComplexity(query)         -> { level, layer, reasons }
 *   selectRetrievalLayer(complexity, features)
 *   summarizeSession(entries)              -> string (<= 90 characters)
 *   summarizeDaily(entries)                -> { date, text, count, topTags }
 *   summarizeWeekly(dailySummaries)        -> { week, text, count, topTags }
 *   buildSummaryLayers(memories, options)  -> { sessions, daily, weekly }
 *
 * Layering rules (heuristic, testable): a long or "big picture" question is
 * answered from the weekly layer, an ordinary follow-up from the daily layer,
 * and a plain short question from the raw episodes. When `layeredRecall` (or
 * the daily/weekly summary feature it depends on) is switched off, recall
 * always falls back to `raw` — that is the per-step rollback contract.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** The session summary is a single sentence of at most 90 characters. */
const SESSION_MAX_CHARS = 90
/** Daily/weekly digests are bounded so the persisted state stays small. */
const DAILY_MAX_CHARS = 120
const WEEKLY_MAX_CHARS = 160
/** Theme chips carried by one digest. */
const MAX_TOP_TAGS = 5
/** Session titles are capped the same way the store caps them. */
const MAX_TITLE_CHARS = 120
/** Default caps for the summary layers (the store may override them). */
const DEFAULT_MAX_SESSIONS = 100
const DEFAULT_MAX_DAYS = 90
const DEFAULT_MAX_WEEKS = 52
/** Query length thresholds: > 60 is complex, > 20 is medium (CONTRACT §16). */
const COMPLEX_LENGTH = 60
const MEDIUM_LENGTH = 20
/** Records with an empty sessionId belong to the manual-memory pseudo task. */
const MANUAL_SESSION_ID = 'manual'
const MANUAL_SESSION_TITLE = '手动记忆'
/** Placeholder text so a session summary is never an empty string. */
const EMPTY_SESSION_SUMMARY = '暂无摘要'

/**
 * Complex-query keywords (Chinese). Order is the deterministic reason order.
 * Mirrors CONTRACT.md §16: 总结/回顾/梳理/规划/整体/为什么/怎么/如何/历史/过去/
 * 最近/对比/所有/大概.
 */
const COMPLEX_KEYWORDS_ZH = Object.freeze([
  '总结', '回顾', '梳理', '规划', '整体', '为什么', '怎么', '如何',
  '历史', '过去', '最近', '对比', '所有', '大概',
])

/** Medium-query keywords (Chinese): a follow-up / lookup question. */
const MEDIUM_KEYWORDS_ZH = Object.freeze([
  '哪些', '上次', '之前', '几天', '哪些人', '什么时候',
])

/**
 * English mirrors of the same intent (matched as whole words, case-insensitive)
 * so a bilingual user gets the same routing as a Chinese one.
 */
const COMPLEX_KEYWORDS_EN = Object.freeze([
  'summarize', 'summarized', 'summary', 'recap', 'overview', 'review',
  'plan', 'planning', 'whole', 'overall', 'why', 'how', 'history',
  'historical', 'past', 'recent', 'recently', 'compare', 'comparison',
  'all', 'everything', 'roughly', 'approximately', 'analyze', 'analyse',
  'analysis', 'trend', 'trends', 'timeline', 'retrospective',
])

const MEDIUM_KEYWORDS_EN = Object.freeze([
  'which', 'what', 'when', 'where', 'who', 'earlier', 'previous',
  'previously', 'last', 'days', 'ago',
])

/** Generic placeholder records so helpers can treat every value uniformly. */
const EMPTY_RECORD = Object.freeze({})

// ---------------------------------------------------------------------------
// Small deterministic helpers (no imports — the engine is self-contained)
// ---------------------------------------------------------------------------

/**
 * Coerce any value to text without ever throwing (Symbols and null-prototype
 * objects included).
 * @param {unknown} value Candidate value.
 * @returns {string} Text form.
 */
function toText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return String(value)
  } catch {
    return ''
  }
}

/** Treat a value as a plain record; everything else becomes an empty one. */
function objectRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return EMPTY_RECORD
  return value
}

/** Locale-independent deterministic ordering (UTF-16 code-unit order). */
function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** Descending comparator for numbers (NaN sorted last via -Infinity keys). */
function compareDesc(left, right) {
  if (left > right) return -1
  if (left < right) return 1
  return 0
}

/** Number of Unicode code points, the unit the contract's 90-character cap uses. */
function charLength(text) {
  return Array.from(text).length
}

/** Clamp a text to `limit` code points, marking a cut with a single ellipsis. */
function truncate(text, limit) {
  const chars = Array.from(text)
  if (limit <= 0) return ''
  if (chars.length <= limit) return text
  return `${chars.slice(0, limit - 1).join('')}…`
}

/** Collapse every whitespace run (newlines included) into one plain space. */
function collapseSpaces(text) {
  return toText(text).replace(/\s+/g, ' ').trim()
}

/** Pad a month/day/week number to two digits. */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Coerce a count-like value: finite -> floored >= 0, else the fallback. */
function toCount(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  return floored < 0 ? 0 : floored
}

/** Coerce a layer cap: finite -> floored >= 0 (bounded), else the fallback. */
function toLimit(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  if (floored < 0) return 0
  return floored > 100000 ? 100000 : floored
}

/** Read one feature flag, tolerating JSON-shaped values; missing -> default. */
function readFlag(features, key) {
  const source = objectRecord(features)
  const value = source[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 'true' || value === '1') return true
  if (value === 0 || value === 'false' || value === '0') return false
  return true
}

/** FNV-1a 32-bit hash over the UTF-16 code units (deterministic record ids). */
function hash32(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Escape a literal word so a built RegExp matches it verbatim. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whole-word, case-insensitive match for an English keyword (no 'how' in 'show'). */
function containsLatinWord(lowerText, word) {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`)
  return pattern.test(lowerText)
}

/** Turn an array-ish value into a string list (a bare string counts as one item). */
function asStringArray(value) {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string')
}

// ---------------------------------------------------------------------------
// Calendar helpers: local day keys + ISO week keys
// ---------------------------------------------------------------------------

/**
 * Local calendar day (`YYYY-MM-DD`) of an epoch-ms instant. Local — not UTC —
 * because a "daily summary" is what the user calls that day. Invalid input
 * yields ''.
 * @param {unknown} time Epoch milliseconds.
 * @returns {string} Day key or ''.
 */
function dayKeyFromTime(time) {
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  const year = date.getFullYear()
  const month = date.getMonth()
  const day = date.getDate()
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return ''
  if (year < 1000 || year > 9999) return ''
  return `${year}-${pad2(month + 1)}-${pad2(day)}`
}

/**
 * Parse a strict `YYYY-MM-DD` day key into its calendar parts.
 * @param {unknown} value Candidate key.
 * @returns {{ year: number, month: number, day: number } | null} Parts or null.
 */
function parseDayKey(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1000 || year > 9999) return null
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    return null
  }
  return { year, month, day }
}

/** Format parsed calendar parts back into a `YYYY-MM-DD` key. */
function dayKeyText(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

/**
 * ISO-8601 week key (`YYYY-Www`) of a local day key. Pure calendar arithmetic
 * on the UTC date components, so the result never depends on the host timezone
 * or DST. Invalid keys yield ''.
 * @param {unknown} dayKey `YYYY-MM-DD` key.
 * @returns {string} Week key or ''.
 */
function isoWeekFromDayKey(dayKey) {
  const parts = parseDayKey(dayKey)
  if (parts === null) return ''
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  const isoDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
  // The Thursday of the ISO week decides its year: shift to that Thursday.
  const thursday = new Date(date.getTime() + (4 - isoDay) * 86400000)
  const isoYear = thursday.getUTCFullYear()
  const week = Math.floor((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / 86400000 / 7) + 1
  if (week < 1 || week > 53) return ''
  return `${isoYear}-W${pad2(week)}`
}

// ---------------------------------------------------------------------------
// Query complexity classification (CONTRACT §16)
// ---------------------------------------------------------------------------

/**
 * Classify a recall query into a retrieval layer.
 *
 * Order matters: the complex rule is checked first (so '总结' wins over the
 * medium keywords it may contain), then medium, then simple. Signals are
 * reported in `reasons` for tests and for the panel's debug view.
 *
 * @param {unknown} query Raw user query (any type; coerced safely).
 * @returns {{ level: 'simple' | 'medium' | 'complex', layer: 'raw' | 'daily' | 'weekly', reasons: string[] }} Classification.
 */
export function classifyQueryComplexity(query) {
  const text = collapseSpaces(query)
  if (text === '') {
    return { level: 'simple', layer: 'raw', reasons: ['empty'] }
  }
  const length = charLength(text)
  const lower = text.toLowerCase()

  /** @type {string[]} */
  const complexReasons = []
  if (length > COMPLEX_LENGTH) complexReasons.push(`length>${COMPLEX_LENGTH}`)
  for (const keyword of COMPLEX_KEYWORDS_ZH) {
    if (text.includes(keyword)) complexReasons.push(`keyword:${keyword}`)
  }
  for (const keyword of COMPLEX_KEYWORDS_EN) {
    if (containsLatinWord(lower, keyword)) complexReasons.push(`keyword:${keyword}`)
  }
  if (complexReasons.length > 0) {
    return { level: 'complex', layer: 'weekly', reasons: complexReasons }
  }

  /** @type {string[]} */
  const mediumReasons = []
  if (length > MEDIUM_LENGTH) mediumReasons.push(`length>${MEDIUM_LENGTH}`)
  for (const keyword of MEDIUM_KEYWORDS_ZH) {
    if (text.includes(keyword)) mediumReasons.push(`keyword:${keyword}`)
  }
  for (const keyword of MEDIUM_KEYWORDS_EN) {
    if (containsLatinWord(lower, keyword)) mediumReasons.push(`keyword:${keyword}`)
  }
  if (mediumReasons.length > 0) {
    return { level: 'medium', layer: 'daily', reasons: mediumReasons }
  }

  return { level: 'simple', layer: 'raw', reasons: ['default'] }
}

/**
 * Normalize anything classify-shaped into a retrieval layer token.
 * Accepts the classifier's object, a bare level ('simple'|'medium'|'complex')
 * or a bare layer ('raw'|'daily'|'weekly'). Unknown input -> 'raw'.
 * @param {unknown} complexity Classifier output or equivalent shorthand.
 * @returns {'raw' | 'daily' | 'weekly'} Layer.
 */
function normalizeLayer(complexity) {
  if (typeof complexity === 'string') {
    const value = complexity.trim().toLowerCase()
    if (value === 'raw' || value === 'daily' || value === 'weekly') return value
    if (value === 'simple') return 'raw'
    if (value === 'medium') return 'daily'
    if (value === 'complex') return 'weekly'
    return 'raw'
  }
  const source = objectRecord(complexity)
  const layer = typeof source.layer === 'string' ? source.layer.trim().toLowerCase() : ''
  if (layer === 'raw' || layer === 'daily' || layer === 'weekly') return layer
  const level = typeof source.level === 'string' ? source.level.trim().toLowerCase() : ''
  if (level === 'simple') return 'raw'
  if (level === 'medium') return 'daily'
  if (level === 'complex') return 'weekly'
  return 'raw'
}

/**
 * Pick the layer recall should read from, honouring the rollback switches.
 *
 * A non-raw layer needs `layeredRecall` and the daily/weekly summary feature
 * (`dailyWeeklySummary`) to exist; if either is off, recall returns `raw`.
 * Missing feature maps default to enabled (the store's FEATURE_DEFAULTS).
 *
 * @param {unknown} complexity Classifier output (or level/layer shorthand).
 * @param {unknown} [features] Feature toggle map.
 * @returns {'raw' | 'daily' | 'weekly'} Effective layer.
 */
export function selectRetrievalLayer(complexity, features) {
  const layer = normalizeLayer(complexity)
  if (layer === 'raw') return 'raw'
  if (!readFlag(features, 'layeredRecall')) return 'raw'
  // Both non-raw layers are summary layers: no summaries, no layered recall.
  if (!readFlag(features, 'dailyWeeklySummary')) return 'raw'
  return layer
}

// ---------------------------------------------------------------------------
// Entry normalization (shared by the session / daily / weekly summarisers)
// ---------------------------------------------------------------------------

/** One mutable collection bucket used while normalising summariser input. */
function createCollector() {
  return {
    texts: [],
    excerpts: [],
    tags: [],
    titles: [],
    createdTimes: [],
    records: 0,
    count: -1,
    date: '',
  }
}

/** Push one readable text, skipping blanks and non-strings. */
function pushText(target, value) {
  if (typeof value !== 'string') return
  const text = value.trim()
  if (text !== '') target.push(text)
}

/** Push a tag list, de-duplicating inside this one list (order preserved). */
function pushTags(target, value) {
  const seen = new Set(target)
  for (const raw of asStringArray(value)) {
    const tag = raw.trim()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    target.push(tag)
  }
}

/**
 * Fold one memory-shaped record into the collector. Excerpt is the preferred
 * summary source (already a one-liner); the user text is the fallback.
 * @param {ReturnType<typeof createCollector>} collector Target bucket.
 * @param {unknown} raw Candidate record.
 */
function pushRecord(collector, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
  const record = /** @type {Record<string, any>} */ (raw)
  collector.records += 1
  pushText(collector.excerpts, record.excerpt)
  const userText = typeof record.userText === 'string' ? record.userText : ''
  pushText(collector.texts, userText !== '' ? userText : record.text)
  pushText(collector.titles, record.sessionTitle)
  pushTags(collector.tags, record.tags)
  if (Number.isFinite(record.createdAt)) collector.createdTimes.push(record.createdAt)
  if (Number.isFinite(record.lastAccessAt)) collector.createdTimes.push(record.lastAccessAt)
}

/**
 * Normalize the summariser entry shapes accepted by CONTRACT §16:
 * either `{ texts, excerpts, tags, title, count }`, or an array of records, or
 * an object carrying nested records under entries/memories/records/items.
 *
 * @param {unknown} input Entry bucket.
 * @returns {{ texts: string[], excerpts: string[], tags: string[], titles: string[], createdTimes: number[], records: number, count: number, date: string }} Normalized bucket.
 */
function normalizeEntries(input) {
  const collector = createCollector()
  if (Array.isArray(input)) {
    for (const record of input) pushRecord(collector, record)
  } else if (input !== null && typeof input === 'object') {
    const source = /** @type {Record<string, any>} */ (input)
    for (const value of asStringArray(source.texts)) pushText(collector.texts, value)
    for (const value of asStringArray(source.excerpts)) pushText(collector.excerpts, value)
    pushTags(collector.tags, source.tags)
    const title = collapseSpaces(source.title)
    if (title !== '') collector.titles.push(title)
    if (Number.isFinite(source.createdAt)) collector.createdTimes.push(source.createdAt)
    if (Number.isFinite(source.updatedAt)) collector.createdTimes.push(source.updatedAt)
    const parsedDate = parseDayKey(source.date)
    if (parsedDate !== null) collector.date = dayKeyText(parsedDate)
    for (const key of ['entries', 'memories', 'records', 'items']) {
      const nested = source[key]
      if (!Array.isArray(nested)) continue
      for (const record of nested) pushRecord(collector, record)
    }
    if (Number.isFinite(source.count)) collector.count = toCount(source.count, -1)
  }
  const fallbackCount = collector.records > 0
    ? collector.records
    : Math.max(collector.texts.length, collector.excerpts.length)
  return {
    ...collector,
    count: collector.count >= 0 ? collector.count : fallbackCount,
  }
}

/** First non-empty string of a list, or ''. */
function firstNonEmpty(list) {
  for (const value of list) {
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/**
 * Keep only the opening sentence (a short opener such as "好的。" stays joined
 * to what follows, so the summary is still informative). Pure text slicing.
 * @param {string} text Whitespace-collapsed text.
 * @returns {string} First sentence (or the whole text when it has no ending).
 */
function firstSentence(text) {
  const chars = Array.from(text)
  const endings = new Set(['。', '！', '？', '!', '?'])
  for (let index = 0; index < chars.length; index += 1) {
    if (!endings.has(chars[index])) continue
    if (index + 1 < 4) continue
    return chars.slice(0, index + 1).join('')
  }
  return text
}

/**
 * Pick the most representative one-line sentence from a normalized bucket:
 * first excerpt, then text, then title, then tags. Always ≤ 90 chars.
 * @param {ReturnType<typeof normalizeEntries>} bucket Normalized entries.
 * @returns {string} Sentence or ''.
 */
function pickSentence(bucket) {
  const lead = firstNonEmpty(bucket.excerpts) !== ''
    ? firstNonEmpty(bucket.excerpts)
    : firstNonEmpty(bucket.texts)
  if (lead !== '') {
    return truncate(firstSentence(collapseSpaces(lead)), SESSION_MAX_CHARS)
  }
  const title = firstNonEmpty(bucket.titles)
  if (title !== '') return truncate(collapseSpaces(title), SESSION_MAX_CHARS)
  if (bucket.tags.length > 0) {
    return truncate(`与 ${bucket.tags.slice(0, 3).join('、')} 相关的对话`, SESSION_MAX_CHARS)
  }
  return ''
}

/** Tag cloud of a tag stream: by frequency, then code-unit order, capped. */
function topTagsFrom(tags, limit = MAX_TOP_TAGS) {
  const counts = new Map()
  for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .slice(0, limit)
    .map(([tag]) => tag)
}

// ---------------------------------------------------------------------------
// Session summary
// ---------------------------------------------------------------------------

/**
 * One sentence describing a session (contract: ≤ 90 characters, deterministic).
 *
 * Accepted input: `{ texts, excerpts, tags, title, count }` as specified by
 * CONTRACT §16, an array of memory records, or an object with nested records.
 * Reads the most recent excerpt when a record list is given (the caller sorts
 * the list), otherwise the first readable excerpt; falls back to text, title,
 * tags and finally a placeholder, so the result is never an empty string.
 *
 * @param {unknown} entries Entry bucket / record list.
 * @returns {string} Session summary, never empty, never above 90 characters.
 */
export function summarizeSession(entries) {
  const bucket = normalizeEntries(entries)
  const sentence = pickSentence(bucket)
  return sentence === '' ? EMPTY_SESSION_SUMMARY : sentence
}

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------

/**
 * One day's digest.
 *
 * Input: `{ date?, entries|memories|records|items?, texts?, excerpts?, tags?,
 * count? }` or an array of records (the day is then derived from the newest
 * readable `createdAt`). Output: `{ date, text, count, topTags }` with a
 * `YYYY-MM-DD` date ('' when it cannot be determined) and a text bounded to
 * 120 characters.
 *
 * @param {unknown} entries Day bucket.
 * @returns {{ date: string, text: string, count: number, topTags: string[] }} Daily summary.
 */
export function summarizeDaily(entries) {
  const bucket = normalizeEntries(entries)
  const topTags = topTagsFrom(bucket.tags)
  let date = bucket.date
  if (date === '') {
    let latest = NaN
    for (const time of bucket.createdTimes) {
      if (!Number.isFinite(time)) continue
      if (!Number.isFinite(latest) || time > latest) latest = time
    }
    if (Number.isFinite(latest)) date = dayKeyFromTime(latest)
  }
  const count = bucket.count
  const sentence = pickSentence(bucket)
  if (date === '' && count === 0 && sentence === '') {
    return { date: '', text: '', count: 0, topTags: [] }
  }
  const head = date === '' ? `共 ${count} 条记忆` : `${date} 共 ${count} 条记忆`
  const tagsPart = topTags.length > 0 ? `（${topTags.join('、')}）` : ''
  let text = `${head}${tagsPart}`
  if (sentence !== '') text += `：${sentence}`
  else if (count === 0 && date !== '') text = `${date} 无记录`
  return { date, text: truncate(text, DAILY_MAX_CHARS), count, topTags }
}

// ---------------------------------------------------------------------------
// Weekly summary
// ---------------------------------------------------------------------------

/**
 * Normalize the daily-summary list accepted by the weekly summariser.
 * @param {unknown} input Array of daily summaries (or a wrapper object).
 * @returns {Array<{ date: string, count: number, tags: string[], text: string }>} Items.
 */
function normalizeDailyItems(input) {
  let list = []
  if (Array.isArray(input)) {
    list = input
  } else if (input !== null && typeof input === 'object') {
    const source = /** @type {Record<string, any>} */ (input)
    for (const key of ['dailySummaries', 'daily', 'days', 'entries', 'items']) {
      if (Array.isArray(source[key])) {
        list = source[key]
        break
      }
    }
  }
  const items = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = /** @type {Record<string, any>} */ (raw)
    let date = ''
    const parsed = parseDayKey(item.date)
    if (parsed !== null) {
      date = dayKeyText(parsed)
    } else {
      const time = Number.isFinite(item.createdAt)
        ? item.createdAt
        : (Number.isFinite(item.updatedAt) ? item.updatedAt : NaN)
      if (Number.isFinite(time)) date = dayKeyFromTime(time)
    }
    const rawTags = asStringArray(item.topTags)
    const text = collapseSpaces(item.text)
    const hasRecordContent = typeof item.excerpt === 'string' || typeof item.userText === 'string'
    const count = Number.isFinite(item.count) ? toCount(item.count, 0) : (hasRecordContent ? 1 : 0)
    if (date === '' && count === 0 && rawTags.length === 0 && text === '') continue
    items.push({ date, count, tags: rawTags.map((tag) => tag.trim()).filter((tag) => tag !== ''), text })
  }
  return items
}

/**
 * One ISO week's digest, rolled up from daily summaries.
 *
 * Input: a list of `{ date, count, topTags }` items (a wrapper object with
 * `dailySummaries`/`daily`/`days` is also accepted). The ISO week is derived
 * from the newest day key, so the result never depends on the host timezone.
 * Output: `{ week, text, count, topTags }`; `week` is '' when no item carries a
 * usable date, and the text is bounded to 160 characters.
 *
 * @param {unknown} dailySummaries Daily summary list.
 * @returns {{ week: string, text: string, count: number, topTags: string[] }} Weekly summary.
 */
export function summarizeWeekly(dailySummaries) {
  const items = normalizeDailyItems(dailySummaries)
  if (items.length === 0) return { week: '', text: '', count: 0, topTags: [] }
  const dates = new Set()
  const tagStream = []
  let count = 0
  for (const item of items) {
    if (item.date !== '') dates.add(item.date)
    count += item.count
    for (const tag of item.tags) tagStream.push(tag)
  }
  const sortedDates = [...dates].sort(compareText)
  const earliest = sortedDates.length > 0 ? sortedDates[0] : ''
  const latest = sortedDates.length > 0 ? sortedDates[sortedDates.length - 1] : ''
  const week = latest === '' ? '' : isoWeekFromDayKey(latest)
  const topTags = topTagsFrom(tagStream)
  if (week === '' && count === 0 && topTags.length === 0) {
    return { week: '', text: '', count: 0, topTags: [] }
  }
  const dayCount = sortedDates.length
  let text = ''
  if (week !== '') {
    if (dayCount > 1) {
      text = `${week} 共 ${count} 条记忆，覆盖 ${dayCount} 天（${earliest} 至 ${latest}）`
    } else {
      text = `${week} 共 ${count} 条记忆，覆盖 ${dayCount} 天（${latest}）`
    }
  } else {
    text = `共 ${count} 条记忆`
  }
  if (topTags.length > 0) text += `，主题：${topTags.join('、')}`
  return { week, text: truncate(text, WEEKLY_MAX_CHARS), count, topTags }
}

// ---------------------------------------------------------------------------
// Layer builder
// ---------------------------------------------------------------------------

/**
 * Collect the records that may feed the summary layers: episodes only (a
 * semantic memory is a distilled concept, not a conversation), and never a
 * tombstone whose content was already deleted. Records are de-duplicated by
 * non-empty id; malformed entries are skipped instead of throwing.
 *
 * @param {unknown} memories Raw memory records.
 * @param {number} fallbackTime Epoch ms to use when a record has no timestamp.
 * @returns {Array<{ record: Record<string, any>, day: number, updated: number }>} Episodes.
 */
function collectEpisodes(memories, fallbackTime) {
  if (!Array.isArray(memories)) return []
  const episodes = []
  const seen = new Set()
  for (const raw of memories) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = /** @type {Record<string, any>} */ (raw)
    if (record.kind === 'semantic' || record.contentPurged === true) continue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id !== '') {
      if (seen.has(id)) continue
      seen.add(id)
    }
    const created = Number.isFinite(record.createdAt) ? record.createdAt : NaN
    const accessed = Number.isFinite(record.lastAccessAt) ? record.lastAccessAt : NaN
    const day = Number.isFinite(created) ? created : (Number.isFinite(accessed) ? accessed : fallbackTime)
    const updated = Math.max(
      Number.isFinite(created) ? created : (Number.isFinite(day) ? day : 0),
      Number.isFinite(accessed) ? accessed : 0,
      0,
    )
    episodes.push({ record, day, updated })
  }
  return episodes
}

/** Newest-first ordering for one episode group (missing times sort last). */
function compareEpisodesNewestFirst(left, right) {
  const leftDay = Number.isFinite(left.day) ? left.day : -Infinity
  const rightDay = Number.isFinite(right.day) ? right.day : -Infinity
  if (leftDay !== rightDay) return rightDay - leftDay
  if (left.updated !== right.updated) return right.updated - left.updated
  const leftId = typeof left.record.id === 'string' ? left.record.id : ''
  const rightId = typeof right.record.id === 'string' ? right.record.id : ''
  return compareText(leftId, rightId)
}

/**
 * Session summaries: one record per task (sessionId), newest activity first.
 * @param {ReturnType<typeof collectEpisodes>} episodes Valid episodes.
 * @returns {Array<{ id: string, sessionId: string, title: string, text: string, basedOnCount: number, updatedAt: number }>} Sessions.
 */
function buildSessionSummaries(episodes) {
  const groups = new Map()
  for (const episode of episodes) {
    const rawSessionId = typeof episode.record.sessionId === 'string' ? episode.record.sessionId.trim() : ''
    const sessionId = rawSessionId === '' ? MANUAL_SESSION_ID : rawSessionId
    let group = groups.get(sessionId)
    if (group === undefined) {
      group = []
      groups.set(sessionId, group)
    }
    group.push(episode)
  }
  const sessions = []
  for (const [sessionId, group] of groups) {
    group.sort(compareEpisodesNewestFirst)
    const bucket = normalizeEntries(group.map((episode) => episode.record))
    const rawTitle = firstNonEmpty(bucket.titles)
    const title = rawTitle === ''
      ? (sessionId === MANUAL_SESSION_ID ? MANUAL_SESSION_TITLE : sessionId)
      : truncate(collapseSpaces(rawTitle), MAX_TITLE_CHARS)
    let updatedAt = 0
    for (const episode of group) updatedAt = Math.max(updatedAt, episode.updated)
    sessions.push({
      id: `sum-session-${hash32(sessionId).toString(36)}`,
      sessionId,
      title,
      text: summarizeSession(bucket),
      basedOnCount: group.length,
      updatedAt,
    })
  }
  sessions.sort(
    (left, right) => compareDesc(left.updatedAt, right.updatedAt) || compareText(left.sessionId, right.sessionId),
  )
  return sessions
}

/**
 * Daily summaries grouped by the local calendar day of `createdAt`, newest day
 * first. All days are returned (the caller applies the cap after the weekly
 * roll-up so a cap can never hide a week).
 * @param {ReturnType<typeof collectEpisodes>} episodes Valid episodes.
 * @returns {Array<{ id: string, date: string, text: string, count: number, topTags: string[], updatedAt: number }>} Days.
 */
function buildDailySummaries(episodes) {
  const groups = new Map()
  for (const episode of episodes) {
    const date = dayKeyFromTime(episode.day)
    if (date === '') continue
    let group = groups.get(date)
    if (group === undefined) {
      group = []
      groups.set(date, group)
    }
    group.push(episode)
  }
  const daily = []
  for (const [date, group] of groups) {
    group.sort(compareEpisodesNewestFirst)
    const summary = summarizeDaily({
      date,
      count: group.length,
      entries: group.map((episode) => episode.record),
    })
    let updatedAt = 0
    for (const episode of group) updatedAt = Math.max(updatedAt, episode.updated)
    daily.push({
      id: `sum-day-${date}`,
      date: summary.date,
      text: summary.text,
      count: summary.count,
      topTags: summary.topTags,
      updatedAt,
    })
  }
  daily.sort((left, right) => compareText(right.date, left.date) || compareText(left.id, right.id))
  return daily
}

/**
 * Weekly summaries rolled up from the full daily list, newest ISO week first.
 * @param {ReturnType<typeof buildDailySummaries>} daily Daily summaries.
 * @returns {Array<{ id: string, week: string, text: string, count: number, topTags: string[], updatedAt: number }>} Weeks.
 */
function buildWeeklySummaries(daily) {
  const groups = new Map()
  for (const item of daily) {
    const week = isoWeekFromDayKey(item.date)
    if (week === '') continue
    let group = groups.get(week)
    if (group === undefined) {
      group = []
      groups.set(week, group)
    }
    group.push(item)
  }
  const weekly = []
  for (const [week, group] of groups) {
    group.sort((left, right) => compareText(right.date, left.date))
    const summary = summarizeWeekly(group)
    let updatedAt = 0
    for (const item of group) updatedAt = Math.max(updatedAt, item.updatedAt)
    weekly.push({
      id: `sum-week-${week}`,
      week: summary.week === '' ? week : summary.week,
      text: summary.text,
      count: summary.count,
      topTags: summary.topTags,
      updatedAt,
    })
  }
  weekly.sort((left, right) => compareText(right.week, left.week) || compareText(left.id, right.id))
  return weekly
}

/**
 * Build the three summary layers from the memory bank (CONTRACT §16).
 *
 * Only episodes that still have readable content participate: `semantic`
 * records are distilled concepts and `contentPurged` tombstones have no text
 * left. Layer text is deterministic (no clock, no locale sorting), so calling
 * this twice on the same bank serialises identically. The layers are:
 *
 *   sessions: newest activity first, capped by `maxSessions` (default 100);
 *   daily:    local calendar days, newest first (default cap 90);
 *   weekly:   ISO weeks, newest first (default cap 52).
 *
 * `options.now` is only a fallback clock for records that carry no timestamp.
 *
 * @param {unknown} memories Raw memory records.
 * @param {{ now?: number, maxSessions?: number, maxDays?: number, maxWeeks?: number }} [options] Options.
 * @returns {{ sessions: Record<string, any>[], daily: Record<string, any>[], weekly: Record<string, any>[] }} Layers.
 */
export function buildSummaryLayers(memories, options) {
  const source = objectRecord(options)
  const now = Number.isFinite(source.now) ? source.now : NaN
  const maxSessions = toLimit(source.maxSessions, DEFAULT_MAX_SESSIONS)
  const maxDays = toLimit(source.maxDays, DEFAULT_MAX_DAYS)
  const maxWeeks = toLimit(source.maxWeeks, DEFAULT_MAX_WEEKS)
  const episodes = collectEpisodes(memories, now)
  const sessions = buildSessionSummaries(episodes)
  // Weekly is rolled up from the *complete* daily list, then the caps apply, so
  // a large daily cap can never truncate a week's counts.
  const allDaily = buildDailySummaries(episodes)
  const allWeekly = buildWeeklySummaries(allDaily)
  return {
    sessions: sessions.slice(0, maxSessions),
    daily: allDaily.slice(0, maxDays),
    weekly: allWeekly.slice(0, maxWeeks),
  }
}
