/**
 * Memory Brain — batch 1: structured facts (`lib/fact-engine.js`).
 *
 * Pure, dependency-free half of the "layered memory" upgrade: it turns a
 * conversation turn into subject-attribute-value facts (中英文规则), merges them
 * into a fact bank under two independent switches (dedup / conflict), answers
 * fact queries (with an optional temporal history chain), and provides the
 * offline hashed character-embedding used by semantic recall.
 *
 * Invariants (CONTRACT.md §15):
 *   - ESM, zero imports, zero mutable module state (all module-level tables are
 *     frozen and regex sources are recompiled per call);
 *   - every function is total: malformed input yields a safe default instead of
 *     a throw;
 *   - every function is pure: it never writes into its arguments;
 *   - output is deterministic for the same inputs (no clock / random reads).
 *
 * Integration notes for the store:
 *   - `Fact` objects always carry `sourceMemoryIds` and `purgedSourceIds`
 *     arrays (the store copies/persists them blindly) and `attributeKey`.
 *   - `applyFacts` returns fresh fact objects; the store assigns the returned
 *     `facts` array and then decorates `added` + `merged` by id.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Persisted fact model version. */
export const FACT_VERSION = 1

/** Canonical attribute vocabulary; every fact attribute is one of these. */
export const FACT_ATTRIBUTES = Object.freeze([
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

/** Maximum extracted facts per conversation turn. */
const MAX_FACTS_PER_TURN = 4
/** Value length window, in characters (CONTRACT: 1–40). */
const MIN_VALUE_CHARS = 1
const MAX_VALUE_CHARS = 40
/** Stored fact value ceiling (mirrors the store's normalizeFact). */
const MAX_STORED_VALUE_CHARS = 240
/** Fact bank soft ceiling when the caller does not supply one. */
const MAX_FACTS_DEFAULT = 800
/** Source episode ids kept per fact. */
const MAX_FACT_SOURCES = 20
/** Confidence window for extracted facts. */
const MIN_CONFIDENCE = 0.4
const MAX_CONFIDENCE = 0.95
/** Offline embedding dimensions. */
const EMBEDDING_DEFAULT_DIMS = 96
const EMBEDDING_MAX_DIMS = 4096
/** Shared frozen empty record for malformed inputs. */
const EMPTY_RECORD = Object.freeze({})

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function numeric(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function toText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return String(value)
  } catch {
    return ''
  }
}

function objectRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return EMPTY_RECORD
  return value
}

function clampNumber(value, low, high) {
  const fallback = isFiniteNumber(low) ? low : 0
  const ceiling = isFiniteNumber(high) ? high : fallback
  if (!isFiniteNumber(value)) return fallback
  if (value < fallback) return fallback
  if (value > ceiling) return ceiling
  return value
}

function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function truncateChars(text, limit) {
  const source = toText(text)
  if (limit <= 0 || source === '') return ''
  if (source.length <= limit) return source
  return Array.from(source).slice(0, limit).join('')
}

/** FNV-1a 32-bit hash — identical to `memory-engine.hash32`, so fact ids are
 * stable across both modules without importing anything. */
function hash32(text) {
  const input = typeof text === 'string' ? text : toText(text)
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Copy a list of ids: strings only, trimmed, de-duplicated, order kept. */
function copyStringIds(values) {
  if (!Array.isArray(values)) return []
  const list = []
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (id === '' || list.includes(id)) continue
    list.push(id)
  }
  return list
}

// ---------------------------------------------------------------------------
// normalizeText / normalizeSubject / normalizeAttribute
// ---------------------------------------------------------------------------

/**
 * Comparison key: strip whitespace + punctuation, lowercase ASCII only.
 * Chinese (and all other scripts) stay untouched.
 *
 * @param {unknown} text Raw text.
 * @returns {string} Normalized comparison key ('' for unusable input).
 */
export function normalizeText(text) {
  const source = toText(text)
  if (source === '') return ''
  const lowered = source.replace(/[A-Z]/g, (char) => char.toLowerCase())
  return lowered.replace(/[\s\p{P}]+/gu, '')
}

/** Subject forms that always mean "the user". */
const SELF_SUBJECT_KEYS = Object.freeze([
  '我',
  '我的',
  '我自己',
  '自己',
  '本人',
  '俺',
  '咱',
  '咱们',
])
const SELF_SUBJECT_EN = /^(?:i|me|my|myself|mine)$/

/**
 * Normalize a fact subject: empty means '用户'; first-person pronouns map to
 * '用户'; possessives lose their trailing 的 / 's.
 *
 * @param {unknown} subject Raw subject.
 * @returns {string} Display subject (never empty).
 */
export function normalizeSubject(subject) {
  const text = toText(subject).trim()
  if (text === '') return '用户'
  const key = normalizeText(text)
  if (key === '') return '用户'
  if (SELF_SUBJECT_KEYS.includes(key)) return '用户'
  if (SELF_SUBJECT_EN.test(key)) return '用户'
  let display = text.replace(/\s+/g, ' ').trim()
  if (display.length > 1 && display.endsWith('的')) display = display.slice(0, -1).trim()
  if (display.length > 2 && /['’]s$/i.test(display)) display = display.slice(0, -2).trim()
  if (display === '') return '用户'
  return truncateChars(display, 40)
}

/**
 * Attribute synonym groups. First word in each group is the canonical
 * attribute; the rest are mapped onto it. Order inside a group is irrelevant,
 * group order is irrelevant (longest synonym wins on substring match).
 */
const ATTRIBUTE_SYNONYM_GROUPS = Object.freeze([
  Object.freeze([
    '称呼',
    Object.freeze([
      '称呼',
      '名字',
      '名称',
      '昵称',
      '外号',
      '叫',
      'name',
      'nickname',
      'called',
      'call',
    ]),
  ]),
  Object.freeze([
    '身份',
    Object.freeze([
      '身份',
      '职业',
      '工作',
      '岗位',
      '职位',
      '角色',
      'job',
      'profession',
      'occupation',
      'identity',
      'role',
      'work',
    ]),
  ]),
  Object.freeze([
    '偏好',
    Object.freeze([
      '偏好',
      '喜好',
      '爱好',
      '喜欢',
      '喜爱',
      '偏爱',
      '中意',
      '爱',
      'like',
      'likes',
      'loved',
      'love',
      'prefer',
      'prefers',
      'favorite',
      'favourite',
      'enjoy',
    ]),
  ]),
  Object.freeze([
    '不喜欢',
    Object.freeze([
      '不喜欢',
      '讨厌',
      '厌烦',
      '反感',
      '恨',
      'hate',
      'hates',
      'dislike',
      'dislikes',
    ]),
  ]),
  Object.freeze([
    '所在地',
    Object.freeze([
      '所在地',
      '工作地点',
      '住在',
      '居住',
      '居住地',
      '城市',
      '地区',
      '位置',
      '住',
      '在',
      'live',
      'livein',
      'location',
      'city',
      'place',
    ]),
  ]),
  Object.freeze([
    '来自',
    Object.freeze([
      '来自',
      '老家在',
      '老家',
      '出身',
      '故乡',
      '籍贯',
      'from',
      'comefrom',
      'hometown',
    ]),
  ]),
  Object.freeze([
    '拥有',
    Object.freeze([
      '拥有',
      '宠物',
      '养了',
      '养着',
      '养',
      '有',
      'have',
      'has',
      'own',
      'owns',
      'got',
    ]),
  ]),
  Object.freeze([
    '计划',
    Object.freeze([
      '计划',
      '打算',
      '准备',
      '想要',
      '将要',
      'plan',
      'plans',
      'intend',
      'goingto',
      'will',
    ]),
  ]),
  Object.freeze([
    '备注',
    Object.freeze(['备注', '记住', '备忘', 'note', 'remember', 'memo']),
  ]),
  Object.freeze(['其他', Object.freeze(['其他', '其它', 'other', 'misc'])]),
])

/** Frozen exact-lookup table built once at module init. */
const ATTRIBUTE_EXACT = (() => {
  /** @type {Record<string, string>} */
  const table = {}
  for (const group of ATTRIBUTE_SYNONYM_GROUPS) {
    const attribute = group[0]
    for (const word of group[1]) {
      const key = normalizeText(word)
      if (key !== '' && table[key] === undefined) table[key] = attribute
    }
  }
  return Object.freeze(table)
})()

/** Frozen substring fallbacks (length >= 2), longest first. */
const ATTRIBUTE_SUBSTRINGS = (() => {
  /** @type {Array<{ attribute: string, key: string }>} */
  const entries = []
  for (const group of ATTRIBUTE_SYNONYM_GROUPS) {
    const attribute = group[0]
    for (const word of group[1]) {
      const key = normalizeText(word)
      if (key.length >= 2) entries.push({ attribute, key })
    }
  }
  entries.sort((left, right) => right.key.length - left.key.length || compareText(left.key, right.key))
  return Object.freeze(entries.map((entry) => Object.freeze(entry)))
})()

/**
 * Map any attribute-ish label onto FACT_ATTRIBUTES. Exact synonyms win, then
 * the longest contained synonym ("喜欢的颜色" -> 偏好), else '其他'.
 *
 * @param {unknown} raw Raw attribute label.
 * @returns {string} One of FACT_ATTRIBUTES.
 */
export function normalizeAttribute(raw) {
  const key = normalizeText(raw)
  if (key === '') return '其他'
  const exact = ATTRIBUTE_EXACT[key]
  if (exact !== undefined) return exact
  for (const entry of ATTRIBUTE_SUBSTRINGS) {
    if (key.includes(entry.key)) return entry.attribute
  }
  return '其他'
}

// ---------------------------------------------------------------------------
// stripScaffolding — QQ bridge wake prompts are not conversation content
// ---------------------------------------------------------------------------

/** Labels whose whole line is bridge scaffolding and must disappear. */
const SCAFFOLD_LABEL_PATTERN =
  /(当前时间|现在时间|时间|日期|当前角色|角色|你的身份|身份|系统提示|系统|提示词|提示|指令|要求|规则|输出格式|输出|格式|可用工具|工具列表|工具|会话令牌|令牌|会话\s*key|会话key|会话|唤醒原因|唤醒|未读消息|未读|最近消息|消息记录|历史记录|历史消息|上下文|人设|模型|api|token|状态|环境)/i
/** Inline media placeholders that carry no text. */
const INLINE_PLACEHOLDER_PATTERN =
  /\[(?:图片|表情|表情包|语音|视频|文件|动画表情|图片消息|语音消息|视频消息|文件消息|引用|链接|卡片|转发消息[^\]]*|CQ:[^\]]*)\]/g
/** Labels of standalone placeholder lines like `[图片]` or `[03:51]`. */
const BRACKET_PLACEHOLDER_LABELS = Object.freeze([
  '图片',
  '表情',
  '表情包',
  '语音',
  '视频',
  '文件',
  '动画表情',
  '图片消息',
  '语音消息',
  '视频消息',
  '文件消息',
  '引用',
  '链接',
  '卡片',
])
const TIMESTAMP_LABEL_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?$/
const DATE_LABEL_PATTERN = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/
const BRACKET_LINE_PATTERN = /^\[([^\]]{1,40})\]\s*(.*)$/
/** Plain `label：value` scaffolding lines without brackets. */
const SCAFFOLD_PLAIN_LINE_PATTERN =
  /^(?:当前时间|当前角色|你的身份|会话令牌|会话\s*key|系统提示|模型|api|token)\s*[:：]/i

/** Is a bracketed label a pure placeholder or a timestamp? */
function isPlaceholderLabel(label) {
  const text = label.trim()
  if (text === '') return true
  if (BRACKET_PLACEHOLDER_LABELS.includes(text)) return true
  if (text.startsWith('转发消息')) return true
  if (text.toLowerCase().startsWith('cq:')) return true
  return TIMESTAMP_LABEL_PATTERN.test(text) || DATE_LABEL_PATTERN.test(text)
}

/**
 * Remove QQ bridge scaffolding from a message and keep only real conversation
 * content: `【当前时间】…` / `【你的身份】…` / `【会话令牌】…` lines, standalone
 * `[图片]` / `[转发消息 id=…]` markers and inline media placeholders.
 *
 * @param {unknown} text Raw message text.
 * @returns {string} Cleaned text ('' when nothing real remains).
 */
export function stripScaffolding(text) {
  const source = toText(text)
  if (source === '') return ''
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const kept = []
  for (const line of lines) {
    let content = line.replace(/\s+/g, ' ').trim()
    if (content === '') continue
    // Whole-line 【label】 scaffolding.
    if (content.startsWith('【')) {
      const close = content.indexOf('】', 1)
      if (close > 0) {
        const label = content.slice(1, close).trim()
        const rest = content.slice(close + 1).trim()
        if (label === '' || rest === '' || SCAFFOLD_LABEL_PATTERN.test(label)) continue
        content = rest
      }
    }
    if (content === '') continue
    if (SCAFFOLD_PLAIN_LINE_PATTERN.test(content)) continue
    // Leading bracket marker: placeholder / timestamp dropped, unknown label
    // stripped but its content kept (e.g. `【用户】我喜欢火锅`).
    const bracketMatch = BRACKET_LINE_PATTERN.exec(content)
    if (bracketMatch !== null) {
      const label = bracketMatch[1].trim()
      const rest = bracketMatch[2].trim()
      if (isPlaceholderLabel(label)) {
        content = rest
        if (content === '') continue
      }
    }
    content = content.replace(INLINE_PLACEHOLDER_PATTERN, '').replace(/\s+/g, ' ').trim()
    if (content === '') continue
    kept.push(content)
  }
  return kept.join('\n')
}

// ---------------------------------------------------------------------------
// extractFacts — rule-based subject-attribute-value extraction
// ---------------------------------------------------------------------------

/** Characters that end a captured Chinese value. */
const CN_VALUE_STOP = '[^\\s，。！？!?；;、:：]'
/** Characters that end a captured English value. */
const EN_VALUE_STOP = '[^\\n.!?,;:]'

/** Attribute-aware junk prefixes for captured values. */
const VALUE_STOP_PREFIXES = Object.freeze({
  身份: Object.freeze([
    '说',
    '想',
    '觉得',
    '指',
    '开玩笑',
    '这样',
    '那样',
    '在',
    '要',
    '会',
    '能',
    '应该',
    '可能',
    '真的',
    '不',
    '没',
    '是',
    '叫',
    '给',
    '让',
    '帮',
    'from ',
    'in ',
    'at ',
    'to ',
    'going ',
    'trying ',
    'not ',
    'sorry',
    'afraid',
    'living ',
  ]),
  拥有: Object.freeze([
    '时候',
    '时间',
    '点',
    '些',
    '什么',
    '空',
    '办法',
    '感觉',
    '问题',
    '事',
    '想法',
    '兴趣',
    '多',
    '少',
    'to ',
    'been ',
  ]),
  所在地: Object.freeze([]),
})

/** Subjects that make an "X 的 Y 是 Z" match useless as a fact. */
const STOP_EXPLICIT_SUBJECTS = Object.freeze([
  '这个',
  '那个',
  '这些',
  '那些',
  '这',
  '那',
  '它',
  '什么',
  '哪个',
  '谁',
  '事情',
  '问题',
  '原因',
  '结果',
  '方法',
  '方式',
  '时候',
  '地方',
  '东西',
  '这里',
  '那里',
])
const REPORTING_PREFIX_PATTERN = /^(?:他?说|据说|听说|别人说|大家说|有人说|据称|据我|我认为)/
const STOP_ENGLISH_SUBJECTS = Object.freeze([
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'my',
  'your',
  'his',
  'her',
  'its',
  'our',
  'their',
  'the',
  'this',
  'that',
  'there',
  'here',
  'what',
  'who',
  'which',
])

/** Edge noise stripped from a captured value (quotes / punctuation / tags). */
const VALUE_EDGE_NOISE =
  /^[\s"'“”‘’「」『』（）()\[\]【】<>《》，。！？!?、；;:：…\-—_~`|·]+|[\s"'“”‘’「」『』（）()\[\]【】<>《》，。！？!?、；;:：…\-—_~`|·]+$/g

/** Value cleanup before range/filter checks. */
function cleanCandidateValue(rawValue) {
  let value = toText(rawValue).replace(/\s+/g, ' ').trim()
  if (value === '') return ''
  value = value.replace(VALUE_EDGE_NOISE, '').replace(/\s+/g, ' ').trim()
  if (value === '') return ''
  value = value.replace(INLINE_PLACEHOLDER_PATTERN, '').replace(/\s+/g, ' ').trim()
  if (value === '') return ''
  if (value.length > MAX_STORED_VALUE_CHARS) value = truncateChars(value, MAX_STORED_VALUE_CHARS)
  return value
}

/** Final value gate shared by every rule (1–40 chars, no pure junk). */
function normalizeCandidateValue(rawValue) {
  let value = cleanCandidateValue(rawValue)
  if (value === '') return ''
  if (/^(?:图片|表情|表情包|语音|视频|文件|转发消息|引用|链接|卡片)$/.test(value)) return ''
  if (/[【】\[\]]/.test(value)) return ''
  if (/^\d{11,}$/.test(value)) return '' // 纯数字超长（手机号/ID 之类）
  const chars = Array.from(value)
  if (chars.length < MIN_VALUE_CHARS) return ''
  if (chars.length > MAX_VALUE_CHARS) value = chars.slice(0, MAX_VALUE_CHARS).join('')
  if (normalizeText(value) === '') return ''
  return value
}

/**
 * Build one candidate (or null when the capture is junk). Also stamps the
 * deterministic collection order so ties can be broken stably.
 */
function buildCandidate(subjectRaw, attributeRaw, rawValue, confidence, sourceField, order) {
  const subject = normalizeSubject(subjectRaw)
  const attribute = normalizeAttribute(attributeRaw)
  let value = normalizeCandidateValue(rawValue)
  if (value === '') return null
  const prefixes = VALUE_STOP_PREFIXES[attribute]
  if (prefixes !== undefined) {
    const lower = value.toLowerCase()
    for (const prefix of prefixes) {
      if (lower.startsWith(prefix.toLowerCase())) return null
    }
  }
  if (attribute === '所在地') {
    value = value.replace(/(?:工作|上班|加班|生活|读书|学习|出差|旅游|玩|呢|啊|呀)+$/u, '').trim()
    if (value === '') return null
  }
  if (attribute === '身份' || attribute === '拥有') {
    value = value.replace(/^(?:a|an|the)\s+/i, '').trim()
    if (value === '') return null
  }
  const subjectKey = normalizeText(subject)
  const valueKey = normalizeText(value)
  if (valueKey === '' || valueKey === subjectKey) return null
  const score = clampNumber(numeric(confidence, 0.5), MIN_CONFIDENCE, MAX_CONFIDENCE)
  return { subject, attribute, value, confidence: score, sourceField, order }
}

/**
 * Chinese first-person rules (applied to userText only). Each rule captures the
 * value in group 1 unless `attributeGroup`/`valueGroup` say otherwise.
 */
const CHINESE_RULES = Object.freeze([
  Object.freeze({
    pattern: new RegExp(`我\\s*叫\\s*(${CN_VALUE_STOP}{1,40})`, 'g'),
    attribute: '称呼',
    confidence: 0.9,
  }),
  Object.freeze({
    pattern: new RegExp(`我\\s*是\\s*(${CN_VALUE_STOP}{1,40})`, 'g'),
    attribute: '身份',
    confidence: 0.8,
  }),
  Object.freeze({
    pattern: new RegExp(
      `我的\\s*(${CN_VALUE_STOP}{1,10}?)\\s*(?:是|叫|为)\\s*(${CN_VALUE_STOP}{1,40})`,
      'g',
    ),
    attributeGroup: 1,
    valueGroup: 2,
    confidence: 0.9,
  }),
  Object.freeze({
    pattern: new RegExp(
      `我\\s*(?:很|特别|超级|非常|最|比较|也|还|挺|真的|超)?\\s*(?:喜欢|偏爱|喜爱|爱)\\s*(${CN_VALUE_STOP}{1,40})`,
      'g',
    ),
    attribute: '偏好',
    confidence: 0.8,
  }),
  Object.freeze({
    pattern: new RegExp(
      `我\\s*(?:很|特别|超级|非常|最|比较|也|还|挺|真的|太)?\\s*(?:不(?:太|怎么|是)?喜欢|讨厌|厌烦|反感|恨)\\s*(${CN_VALUE_STOP}{1,40})`,
      'g',
    ),
    attribute: '不喜欢',
    confidence: 0.8,
  }),
  Object.freeze({
    pattern: new RegExp(`我\\s*(?:住在|居住在|住)\\s*(${CN_VALUE_STOP}{1,40})`, 'g'),
    attribute: '所在地',
    confidence: 0.75,
  }),
  Object.freeze({
    pattern: new RegExp(
      `我\\s*(?:来自|老家在|老家是|出生于|出身于)\\s*(${CN_VALUE_STOP}{1,40})`,
      'g',
    ),
    attribute: '来自',
    confidence: 0.75,
  }),
  Object.freeze({
    pattern: new RegExp(`我\\s*在\\s*(${CN_VALUE_STOP}{1,40})`, 'g'),
    attribute: '所在地',
    confidence: 0.7,
    // "我在写代码 / 我在忙 / 我在等" are activities, not locations.
    rejectPrefixes: Object.freeze([
      '工作',
      '上班',
      '加班',
      '写',
      '看',
      '读',
      '做',
      '忙',
      '等',
      '想',
      '学',
      '说',
      '听',
      '玩',
      '吃',
      '喝',
      '睡',
      '开会',
      '开发',
      '改',
      '修',
      '弄',
      '搞',
      '准备',
      '打算',
      '计划',
      '休息',
      '发呆',
      '路上',
      '哪里',
      '哪儿',
      '哪',
    ]),
  }),
  Object.freeze({
    pattern: new RegExp(`我\\s*(?:养了|养着|养|拥有|有)\\s*(${CN_VALUE_STOP}{1,40})`, 'g'),
    attribute: '拥有',
    confidence: 0.7,
  }),
  Object.freeze({
    pattern: new RegExp(`我\\s*(?:打算|计划|准备|想要|将要)\\s*(${CN_VALUE_STOP}{1,40})`, 'g'),
    attribute: '计划',
    confidence: 0.75,
  }),
  Object.freeze({
    pattern: /记住\s*[:：]?\s*([^\n]{1,60})/g,
    attribute: '备注',
    confidence: 0.9,
  }),
])

/** Chinese explicit-subject rule: X 的 Y 是/叫/为 Z. */
const CHINESE_EXPLICIT_PATTERN = new RegExp(
  `(${CN_VALUE_STOP}{1,20})的\\s*([^\\s，。！？!?；;、:：的]{1,10}?)\\s*(?:是|叫|为)\\s*(${CN_VALUE_STOP}{1,40})`,
  'g',
)

/** English first-person rules (applied to userText only). */
const ENGLISH_RULES = Object.freeze([
  Object.freeze({
    pattern: new RegExp(`\\bi\\s+am\\s+(${EN_VALUE_STOP}{1,60})`, 'gi'),
    attribute: '身份',
    confidence: 0.8,
  }),
  Object.freeze({
    pattern: new RegExp(`\\bi['’]m\\s+(${EN_VALUE_STOP}{1,60})`, 'gi'),
    attribute: '身份',
    confidence: 0.8,
  }),
  Object.freeze({
    pattern: new RegExp(`\\bmy\\s+([a-z][a-z\\s-]{0,20}?)\\s+(?:is|are)\\s+(${EN_VALUE_STOP}{1,60})`, 'gi'),
    attributeGroup: 1,
    valueGroup: 2,
    confidence: 0.85,
  }),
  Object.freeze({
    pattern: new RegExp(
      `\\bi\\s+(?:really\\s+|also\\s+|quite\\s+|very\\s+|just\\s+)?(?:like|love|prefer|enjoy|adore)\\s+(${EN_VALUE_STOP}{1,60})`,
      'gi',
    ),
    attribute: '偏好',
    confidence: 0.8,
  }),
  Object.freeze({
    pattern: new RegExp(
      `\\bi\\s+(?:really\\s+|also\\s+)?(?:hate|dislike|don['’]t\\s+like|do\\s+not\\s+like|can['’]t\\s+stand)\\s+(${EN_VALUE_STOP}{1,60})`,
      'gi',
    ),
    attribute: '不喜欢',
    confidence: 0.8,
  }),
  Object.freeze({
    pattern: new RegExp(
      `\\bi\\s+(?:live|living|stay)\\s+(?:in|at)\\s+(${EN_VALUE_STOP}{1,60})`,
      'gi',
    ),
    attribute: '所在地',
    confidence: 0.75,
  }),
  Object.freeze({
    pattern: new RegExp(
      `\\bi\\s+(?:am\\s+from|come\\s+from|['’]m\\s+from)\\s+(${EN_VALUE_STOP}{1,60})`,
      'gi',
    ),
    attribute: '来自',
    confidence: 0.75,
  }),
  Object.freeze({
    pattern: new RegExp(`\\bi\\s+(?:have|own|got)\\s+(${EN_VALUE_STOP}{1,60})`, 'gi'),
    attribute: '拥有',
    confidence: 0.7,
  }),
  Object.freeze({
    pattern: new RegExp(
      `\\bi\\s+(?:plan|intend|am\\s+going|['’]m\\s+going)\\s+to\\s+(${EN_VALUE_STOP}{1,60})`,
      'gi',
    ),
    attribute: '计划',
    confidence: 0.75,
  }),
])

/** English explicit-subject rule: Alice's job is doctor. */
const ENGLISH_EXPLICIT_PATTERN = new RegExp(
  `\\b([a-z][a-z0-9_-]{1,20})['’]s\\s+([a-z][a-z\\s-]{0,20}?)\\s+(?:is|are)\\s+(${EN_VALUE_STOP}{1,60})`,
  'gi',
)

/** Collect value-capturing rule matches into `out`. */
function collectRuleMatches(sourceText, rule, defaultSubject, out, orderRef, sourceField) {
  if (sourceText === '') return
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
  let match = pattern.exec(sourceText)
  while (match !== null) {
    if (match[0] === '') {
      pattern.lastIndex += 1
      match = pattern.exec(sourceText)
      continue
    }
    const attributeRaw = rule.attributeGroup === undefined ? rule.attribute : match[rule.attributeGroup]
    const valueRaw = rule.valueGroup === undefined ? match[1] : match[rule.valueGroup]
    const candidate = buildCandidate(
      defaultSubject,
      attributeRaw,
      valueRaw,
      rule.confidence,
      sourceField,
      orderRef.value,
    )
    if (candidate !== null) {
      const rejected =
        rule.rejectPrefixes !== undefined &&
        rule.rejectPrefixes.some((prefix) => candidate.value.startsWith(prefix))
      if (!rejected) {
        orderRef.value += 1
        out.push(candidate)
      }
    }
    match = pattern.exec(sourceText)
  }
}

/** Is an explicit-subject capture usable as a fact subject? */
function isAllowedExplicitSubject(subject) {
  const text = toText(subject).trim()
  const key = normalizeText(text)
  if (key === '') return false
  if (STOP_EXPLICIT_SUBJECTS.includes(key)) return false
  if (REPORTING_PREFIX_PATTERN.test(text)) return false
  return true
}

/** Is an English explicit-subject capture usable? */
function isAllowedEnglishSubject(subject) {
  const key = normalizeText(subject)
  if (key === '') return false
  if (STOP_ENGLISH_SUBJECTS.includes(key)) return false
  return true
}

/** Collect explicit-subject rule matches into `out`. */
function collectExplicitMatches(
  sourceText,
  patternFactory,
  subjectAllowed,
  out,
  orderRef,
  sourceField,
  confidence,
) {
  if (sourceText === '') return
  const pattern = patternFactory()
  let match = pattern.exec(sourceText)
  while (match !== null) {
    if (match[0] === '') {
      pattern.lastIndex += 1
      match = pattern.exec(sourceText)
      continue
    }
    const subjectRaw = match[1]
    if (subjectAllowed(subjectRaw)) {
      const candidate = buildCandidate(
        subjectRaw,
        match[2],
        match[3],
        confidence,
        sourceField,
        orderRef.value,
      )
      if (candidate !== null) {
        orderRef.value += 1
        out.push(candidate)
      }
    }
    match = pattern.exec(sourceText)
  }
}

/** Deduplicate candidates by (subject|attribute|value), keeping the first. */
function dedupeCandidates(candidates) {
  const seen = new Set()
  const unique = []
  for (const candidate of candidates) {
    const key = `${candidate.subjectKey ?? normalizeText(candidate.subject)}|${candidate.attribute}|${candidate.valueKey ?? normalizeText(candidate.value)}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(candidate)
  }
  return unique
}

/**
 * Extract up to four structured facts from one conversation turn.
 *
 * First-person rules run on the (scaffolding-stripped) user text; explicit
 * "X 的 Y 是 Z" facts are additionally mined from the assistant text, which is
 * why `FactCandidate.sourceField` exists. Duplicates within the turn collapse,
 * and the survivors are ranked by rule confidence (stable order on ties).
 *
 * @param {unknown} input `{ userText, assistantText?, sessionTitle?, sessionId?, turn?, createdAt?, defaultSubject? }`.
 * @returns {Array<{ subject: string, attribute: string, value: string, confidence: number, sourceField: string }>} Candidates.
 */
export function extractFacts(input) {
  const source = objectRecord(input)
  const defaultSubject = normalizeSubject(
    source.defaultSubject === undefined ? '用户' : source.defaultSubject,
  )
  const userText = stripScaffolding(source.userText)
  const assistantText = stripScaffolding(source.assistantText)
  /** @type {Array<Record<string, any>>} */
  const candidates = []
  const orderRef = { value: 0 }

  if (userText !== '') {
    for (const rule of CHINESE_RULES) {
      collectRuleMatches(userText, rule, defaultSubject, candidates, orderRef, 'userText')
    }
    collectExplicitMatches(
      userText,
      () => new RegExp(CHINESE_EXPLICIT_PATTERN.source, CHINESE_EXPLICIT_PATTERN.flags),
      isAllowedExplicitSubject,
      candidates,
      orderRef,
      'userText',
      0.8,
    )
    for (const rule of ENGLISH_RULES) {
      collectRuleMatches(userText, rule, defaultSubject, candidates, orderRef, 'userText')
    }
    collectExplicitMatches(
      userText,
      () => new RegExp(ENGLISH_EXPLICIT_PATTERN.source, ENGLISH_EXPLICIT_PATTERN.flags),
      isAllowedEnglishSubject,
      candidates,
      orderRef,
      'userText',
      0.8,
    )
  }

  if (assistantText !== '') {
    collectExplicitMatches(
      assistantText,
      () => new RegExp(CHINESE_EXPLICIT_PATTERN.source, CHINESE_EXPLICIT_PATTERN.flags),
      isAllowedExplicitSubject,
      candidates,
      orderRef,
      'assistantText',
      0.65,
    )
    collectExplicitMatches(
      assistantText,
      () => new RegExp(ENGLISH_EXPLICIT_PATTERN.source, ENGLISH_EXPLICIT_PATTERN.flags),
      isAllowedEnglishSubject,
      candidates,
      orderRef,
      'assistantText',
      0.6,
    )
  }

  const unique = dedupeCandidates(candidates)
  unique.sort(
    (left, right) => right.confidence - left.confidence || (left.order ?? 0) - (right.order ?? 0),
  )
  return unique.slice(0, MAX_FACTS_PER_TURN).map(({ subject, attribute, value, confidence, sourceField }) => ({
    subject,
    attribute,
    value,
    confidence,
    sourceField,
  }))
}

// ---------------------------------------------------------------------------
// applyFacts — merge candidates into the fact bank
// ---------------------------------------------------------------------------

function normalizeMaxFacts(value) {
  const raw = numeric(value, MAX_FACTS_DEFAULT)
  if (!(raw >= 1)) return MAX_FACTS_DEFAULT
  return Math.min(5000, Math.floor(raw))
}

function normalizeConfidence(value, fallback) {
  const raw = numeric(value, fallback)
  if (!Number.isFinite(raw)) return fallback
  return clampNumber(raw, 0, 1)
}

/**
 * Canonicalize one fact record: stable id, canonical keys, sane numeric fields
 * and always-present id arrays. Unknown extra fields are preserved (the store
 * attaches `purgedSourceIds` / future metadata).
 *
 * @param {unknown} raw Fact-ish record.
 * @returns {Record<string, any> | null} Canonical fact, or null when hopeless.
 */
function sanitizeFactRecord(raw) {
  const record = objectRecord(raw)
  if (record === EMPTY_RECORD) return null
  const subjectRaw = typeof record.subject === 'string' ? record.subject.trim() : ''
  const attributeRaw = typeof record.attribute === 'string' ? record.attribute.trim() : ''
  const valueRaw = typeof record.value === 'string' ? record.value.trim() : ''
  if (subjectRaw === '' || attributeRaw === '' || valueRaw === '') return null
  const subject = normalizeSubject(subjectRaw)
  const attribute = normalizeAttribute(attributeRaw)
  const value = truncateChars(valueRaw, MAX_STORED_VALUE_CHARS)
  const subjectKey = normalizeText(subject)
  const attributeKey = normalizeAttribute(attribute)
  const valueKey = normalizeText(value)
  if (subjectKey === '' || valueKey === '') return null
  const slotKey = `${subjectKey}|${attributeKey}`
  const fallbackId = `fact-${hash32(`${slotKey}|${valueKey}`).toString(36)}`
  const id = typeof record.id === 'string' && record.id.trim() !== '' ? record.id.trim() : fallbackId
  const createdAtRaw = numeric(record.createdAt, 0)
  const createdAt = createdAtRaw > 0 ? createdAtRaw : 0
  const lastSeenRaw = numeric(record.lastSeenAt, createdAt)
  const lastSeenAt = lastSeenRaw > 0 ? lastSeenRaw : createdAt
  const invalidatedRaw = numeric(record.invalidatedAt, 0)
  const invalidatedAt = invalidatedRaw > 0 ? invalidatedRaw : 0
  const seenCountRaw = Math.floor(numeric(record.seenCount, 1))
  return {
    ...record,
    id,
    subject,
    attribute,
    value,
    subjectKey,
    attributeKey,
    slotKey,
    valueKey,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    sessionTitle:
      typeof record.sessionTitle === 'string' ? truncateChars(record.sessionTitle, 120) : '',
    turn: Math.max(0, Math.floor(numeric(record.turn, 0))),
    sourceMemoryIds: copyStringIds(record.sourceMemoryIds).slice(-MAX_FACT_SOURCES),
    purgedSourceIds: copyStringIds(record.purgedSourceIds).slice(-MAX_FACT_SOURCES),
    confidence: normalizeConfidence(record.confidence, 0.6),
    createdAt,
    lastSeenAt,
    seenCount: seenCountRaw >= 1 ? seenCountRaw : 1,
    invalidatedAt,
    invalidatedBy: typeof record.invalidatedBy === 'string' ? record.invalidatedBy : '',
    invalidReason: typeof record.invalidReason === 'string' ? record.invalidReason : '',
  }
}

/** Normalize one candidate (string, attribute, value, confidence, context). */
function normalizeCandidateInput(raw) {
  const candidate = objectRecord(raw)
  if (candidate === EMPTY_RECORD) return null
  const attributeRaw = toText(candidate.attribute).trim()
  if (attributeRaw === '') return null
  const subject = normalizeSubject(candidate.subject)
  const attribute = normalizeAttribute(attributeRaw)
  let value = toText(candidate.value).replace(/\s+/g, ' ').trim()
  if (value === '') return null
  value = truncateChars(value, MAX_VALUE_CHARS)
  const valueKey = normalizeText(value)
  const subjectKey = normalizeText(subject)
  if (valueKey === '' || subjectKey === '' || valueKey === subjectKey) return null
  return {
    subject,
    attribute,
    value,
    subjectKey,
    attributeKey: attribute,
    valueKey,
    slotKey: `${subjectKey}|${attribute}`,
    confidence: normalizeConfidence(candidate.confidence, 0.6),
    raw: candidate,
  }
}

/** Candidate-level context (optional; the store decorates afterwards). */
function candidateContext(raw, config) {
  const sessionId =
    typeof raw.sessionId === 'string' && raw.sessionId !== ''
      ? raw.sessionId
      : typeof config.sessionId === 'string'
        ? config.sessionId
        : ''
  const sessionTitle =
    typeof raw.sessionTitle === 'string' && raw.sessionTitle !== ''
      ? truncateChars(raw.sessionTitle, 120)
      : typeof config.sessionTitle === 'string'
        ? truncateChars(config.sessionTitle, 120)
        : ''
  const turnRaw = numeric(raw.turn, numeric(config.turn, 0))
  const turn = Math.max(0, Math.floor(turnRaw))
  const sources = []
  const pushSource = (value) => {
    if (typeof value !== 'string') return
    const id = value.trim()
    if (id === '' || sources.includes(id)) return
    sources.push(id)
  }
  if (Array.isArray(raw.sourceMemoryIds)) for (const id of raw.sourceMemoryIds) pushSource(id)
  pushSource(raw.sourceMemoryId)
  if (Array.isArray(config.sourceMemoryIds)) for (const id of config.sourceMemoryIds) pushSource(id)
  pushSource(config.sourceMemoryId)
  pushSource(config.memoryId)
  return { sessionId, sessionTitle, turn, sources: sources.slice(-MAX_FACT_SOURCES) }
}

/** Merge a sighting's metadata into an existing fact (mutates the fact copy). */
function applyFactMetadata(fact, context, timestamp, confidence, incrementSeen) {
  fact.lastSeenAt = timestamp
  if (incrementSeen) fact.seenCount = Math.max(1, Math.floor(fact.seenCount)) + 1
  if (confidence > fact.confidence) fact.confidence = confidence
  if (context.sessionId !== '') fact.sessionId = context.sessionId
  if (context.sessionTitle !== '') fact.sessionTitle = context.sessionTitle
  if (context.turn > 0) fact.turn = context.turn
  if (context.sources.length > 0) {
    const merged = copyStringIds(fact.sourceMemoryIds)
    for (const id of context.sources) if (!merged.includes(id)) merged.push(id)
    fact.sourceMemoryIds = merged.slice(-MAX_FACT_SOURCES)
  }
}

/** Create a brand new fact record from a normalized candidate. */
function createFact(candidate, context, timestamp, createdAt) {
  return {
    id: `fact-${hash32(`${candidate.slotKey}|${candidate.valueKey}`).toString(36)}`,
    subject: candidate.subject,
    attribute: candidate.attribute,
    value: candidate.value,
    subjectKey: candidate.subjectKey,
    attributeKey: candidate.attributeKey,
    slotKey: candidate.slotKey,
    valueKey: candidate.valueKey,
    sessionId: context.sessionId,
    sessionTitle: context.sessionTitle,
    turn: context.turn,
    sourceMemoryIds: [...context.sources],
    purgedSourceIds: [],
    confidence: candidate.confidence,
    createdAt,
    lastSeenAt: timestamp,
    seenCount: 1,
    invalidatedAt: 0,
    invalidatedBy: '',
    invalidReason: '',
  }
}

/** Evict the oldest invalidated facts first, then the oldest lastSeenAt ones. */
function enforceFactCapacity(facts, maxFacts) {
  if (facts.length <= maxFacts) return facts
  const invalidated = []
  const valid = []
  for (const fact of facts) {
    if (fact.invalidatedAt > 0) invalidated.push(fact)
    else valid.push(fact)
  }
  invalidated.sort(
    (left, right) =>
      left.invalidatedAt - right.invalidatedAt ||
      left.createdAt - right.createdAt ||
      compareText(left.id, right.id),
  )
  valid.sort(
    (left, right) =>
      left.lastSeenAt - right.lastSeenAt ||
      left.createdAt - right.createdAt ||
      compareText(left.id, right.id),
  )
  let excess = facts.length - maxFacts
  const victims = new Set()
  for (const fact of [...invalidated, ...valid]) {
    if (excess <= 0) break
    victims.add(fact.id)
    excess -= 1
  }
  return facts.filter((fact) => !victims.has(fact.id))
}

/**
 * Merge extracted candidates into the fact bank, honouring the two independent
 * switches:
 *   - `dedupEnabled`: false keeps `seenCount` frozen (same id is still reused so
 *     the deterministic fact id never collides);
 *   - `conflictEnabled`: false keeps the old value valid next to the new one.
 *
 * New / merged / superseded fact objects are returned separately, and `facts`
 * is a fresh array (input facts are never mutated).
 *
 * @param {unknown} facts Existing fact records.
 * @param {unknown} candidates Candidates from `extractFacts` (or alike).
 * @param {unknown} [options] `{ now?, dedupEnabled?, conflictEnabled?, maxFacts?, sessionId?, sessionTitle?, turn?, sourceMemoryIds?, memoryId?, createdAt? }`.
 * @returns {{ facts: Array<Record<string, any>>, added: Array<Record<string, any>>, merged: Array<Record<string, any>>, superseded: Array<Record<string, any>> }} Result.
 */
export function applyFacts(facts, candidates, options) {
  const config = objectRecord(options)
  const nowRaw = numeric(config.now, 0)
  const timestamp = nowRaw > 0 ? nowRaw : 1
  const createdAtOption = numeric(config.createdAt, timestamp)
  const createdAtBase = createdAtOption > 0 ? createdAtOption : timestamp
  const dedupEnabled = config.dedupEnabled === undefined ? true : config.dedupEnabled === true
  const conflictEnabled =
    config.conflictEnabled === undefined ? true : config.conflictEnabled === true
  const maxFacts = normalizeMaxFacts(config.maxFacts)

  const working = []
  const byId = new Map()
  if (Array.isArray(facts)) {
    for (const rawFact of facts) {
      const fact = sanitizeFactRecord(rawFact)
      if (fact === null || byId.has(fact.id)) continue
      working.push(fact)
      byId.set(fact.id, fact)
    }
  }

  const addedIds = []
  const mergedIds = []
  const supersededIds = []

  const markSuperseded = (target, validOthers) => {
    for (const old of validOthers) {
      if (old.id === target.id) continue
      old.invalidatedAt = timestamp
      old.invalidatedBy = target.id
      old.invalidReason = 'superseded'
      supersededIds.push(old.id)
    }
  }

  const candidateList = Array.isArray(candidates) ? candidates : []
  for (const rawCandidate of candidateList) {
    const candidate = normalizeCandidateInput(rawCandidate)
    if (candidate === null) continue
    const context = candidateContext(objectRecord(rawCandidate), config)
    let target = byId.get(`fact-${hash32(`${candidate.slotKey}|${candidate.valueKey}`).toString(36)}`)
    if (target === undefined) {
      target = working.find(
        (fact) => fact.slotKey === candidate.slotKey && fact.valueKey === candidate.valueKey,
      )
    }
    const validSameSlot = working.filter(
      (fact) => fact.slotKey === candidate.slotKey && fact.invalidatedAt === 0,
    )
    if (target !== undefined) {
      if (target.invalidatedAt > 0) {
        // The same slot+value was superseded before: revive it (the deterministic
        // id means "one record per fact", so a second record could never exist).
        target.invalidatedAt = 0
        target.invalidatedBy = ''
        target.invalidReason = ''
        applyFactMetadata(
          target,
          context,
          timestamp,
          candidate.confidence,
          dedupEnabled === true,
        )
        mergedIds.push(target.id)
      } else if (dedupEnabled) {
        applyFactMetadata(target, context, timestamp, candidate.confidence, true)
        mergedIds.push(target.id)
      }
      // dedupEnabled === false and same valid id: reuse only, no counters move.
      if (conflictEnabled) markSuperseded(target, validSameSlot)
      continue
    }
    const created = createFact(candidate, context, timestamp, createdAtBase)
    working.push(created)
    byId.set(created.id, created)
    addedIds.push(created.id)
    if (conflictEnabled) markSuperseded(created, validSameSlot)
  }

  const finalFacts = enforceFactCapacity(working, maxFacts)
  const finalById = new Map(finalFacts.map((fact) => [fact.id, fact]))
  const collect = (ids) => {
    const seen = new Set()
    const list = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const fact = finalById.get(id)
      if (fact !== undefined) list.push(fact)
    }
    return list
  }
  return {
    facts: finalFacts,
    added: collect(addedIds),
    merged: collect(mergedIds),
    superseded: collect(supersededIds),
  }
}

// ---------------------------------------------------------------------------
// queryFacts
// ---------------------------------------------------------------------------

/** Detached copy of a fact (arrays copied, unknown fields preserved). */
function cloneFact(fact) {
  return {
    ...fact,
    sourceMemoryIds: [...fact.sourceMemoryIds],
    purgedSourceIds: [...fact.purgedSourceIds],
  }
}

/**
 * Query the fact bank.
 *
 * Defaults to valid facts only; `includeSuperseded` brings the invalidated ones
 * back. Substring matching covers subject / attribute / value / sessionTitle
 * (ASCII case-insensitive); exact slot matches rank first, then newest
 * `lastSeenAt`. With `temporalHistory`, every returned fact also carries the
 * invalidated chain of its slot (`history`, `invalidatedAt` ascending).
 *
 * @param {unknown} facts Fact records.
 * @param {unknown} [options] `{ query?, subject?, sessionId?, includeSuperseded?, temporalHistory?, limit? }`.
 * @returns {{ facts: Array<Record<string, any>>, total: number }} Matches and the pre-limit count.
 */
export function queryFacts(facts, options) {
  const config = objectRecord(options)
  const includeSuperseded = config.includeSuperseded === true
  const temporalHistory = config.temporalHistory === true
  const query = toText(config.query).trim()
  const queryLower = query.toLowerCase()
  const queryKey = normalizeText(query)
  const subjectFilter =
    config.subject === undefined ? '' : normalizeText(normalizeSubject(config.subject))
  const sessionFilter = typeof config.sessionId === 'string' ? config.sessionId : ''
  const limitRaw = numeric(config.limit, 10)
  const limit = limitRaw > 0 ? Math.min(500, Math.max(1, Math.floor(limitRaw))) : 10

  const all = []
  if (Array.isArray(facts)) {
    for (const rawFact of facts) {
      const fact = sanitizeFactRecord(rawFact)
      if (fact !== null) all.push(fact)
    }
  }

  const isSlotExact = (fact) => {
    if (queryKey === '') return false
    return (
      fact.attributeKey === queryKey ||
      fact.subjectKey === queryKey ||
      fact.slotKey === queryKey ||
      normalizeText(fact.attribute) === queryKey ||
      normalizeText(fact.subject) === queryKey ||
      normalizeText(`${fact.subject}${fact.attribute}`) === queryKey ||
      normalizeText(`${fact.subject}的${fact.attribute}`) === queryKey
    )
  }

  const matches = []
  for (const fact of all) {
    if (!includeSuperseded && fact.invalidatedAt > 0) continue
    if (sessionFilter !== '' && fact.sessionId !== sessionFilter) continue
    if (subjectFilter !== '' && fact.subjectKey !== subjectFilter) continue
    if (queryLower !== '') {
      const haystack = `${fact.subject}\n${fact.attribute}\n${fact.value}\n${fact.sessionTitle}`.toLowerCase()
      if (!haystack.includes(queryLower)) continue
    }
    matches.push(fact)
  }
  matches.sort(
    (left, right) =>
      (left.invalidatedAt > 0 ? 1 : 0) - (right.invalidatedAt > 0 ? 1 : 0) ||
      (isSlotExact(left) ? 0 : 1) - (isSlotExact(right) ? 0 : 1) ||
      right.lastSeenAt - left.lastSeenAt ||
      right.createdAt - left.createdAt ||
      compareText(left.id, right.id),
  )

  const bySlot = new Map()
  if (temporalHistory) {
    for (const fact of all) {
      if (fact.invalidatedAt <= 0) continue
      let chain = bySlot.get(fact.slotKey)
      if (chain === undefined) {
        chain = []
        bySlot.set(fact.slotKey, chain)
      }
      chain.push(fact)
    }
    for (const chain of bySlot.values()) {
      chain.sort(
        (left, right) =>
          left.invalidatedAt - right.invalidatedAt || compareText(left.id, right.id),
      )
    }
  }

  const total = matches.length
  const results = matches.slice(0, limit).map((fact) => {
    const clone = cloneFact(fact)
    if (temporalHistory) {
      const chain = bySlot.get(fact.slotKey) ?? []
      clone.history = chain.filter((item) => item.id !== fact.id).map(cloneFact)
    }
    return clone
  })
  return { facts: results, total }
}

// ---------------------------------------------------------------------------
// factStats
// ---------------------------------------------------------------------------

/**
 * Aggregate counters for the panel/system prompt.
 *
 * @param {unknown} facts Fact records.
 * @returns {{ total: number, active: number, superseded: number, subjects: number }} Counts.
 */
export function factStats(facts) {
  let total = 0
  let active = 0
  let superseded = 0
  const subjects = new Set()
  if (Array.isArray(facts)) {
    for (const rawFact of facts) {
      if (rawFact === null || typeof rawFact !== 'object' || Array.isArray(rawFact)) continue
      total += 1
      const invalidatedAt = numeric(rawFact.invalidatedAt, 0)
      if (invalidatedAt > 0) superseded += 1
      else active += 1
      const subject = typeof rawFact.subject === 'string' ? rawFact.subject.trim() : ''
      if (subject !== '') subjects.add(normalizeText(normalizeSubject(subject)))
    }
  }
  return { total, active, superseded, subjects: subjects.size }
}

// ---------------------------------------------------------------------------
// Offline hashed character embedding
// ---------------------------------------------------------------------------

function normalizeEmbeddingDims(dims) {
  const raw = numeric(dims, EMBEDDING_DEFAULT_DIMS)
  if (!(raw >= 1)) return EMBEDDING_DEFAULT_DIMS
  return Math.min(EMBEDDING_MAX_DIMS, Math.floor(raw))
}

/**
 * Offline character 2-gram / 3-gram hashed embedding (no network, fully
 * deterministic). The result is L2-normalized, so every component is in
 * [-1, 1] and dot products are cosine similarities. Empty / too-short text
 * yields the zero vector.
 *
 * @param {unknown} text Raw text.
 * @param {unknown} [dims] Vector dimensions (default 96, capped at 4096).
 * @returns {number[]} Unit-length (or zero) vector.
 */
export function hashEmbedding(text, dims) {
  const dimension = normalizeEmbeddingDims(dims)
  const vector = new Array(dimension).fill(0)
  const cleaned = normalizeText(text)
  if (cleaned === '') return vector
  const chars = Array.from(cleaned)
  let peak = 0
  for (let size = 2; size <= 3; size += 1) {
    for (let start = 0; start + size <= chars.length; start += 1) {
      const gram = chars.slice(start, start + size).join('')
      const hash = hash32(`${size}:${gram}`)
      const index = hash % dimension
      const sign = ((hash >>> 8) & 1) === 1 ? -1 : 1
      vector[index] += sign
      if (Math.abs(vector[index]) > peak) peak = Math.abs(vector[index])
    }
  }
  let normSquared = 0
  for (const value of vector) normSquared += value * value
  if (!(normSquared > 0)) return new Array(dimension).fill(0)
  const norm = Math.sqrt(normSquared)
  for (let index = 0; index < dimension; index += 1) vector[index] /= norm
  return vector
}

/**
 * Cosine similarity between two equal-length vectors. Zero vectors, malformed
 * inputs and dimension mismatches yield 0; the result is clamped to [-1, 1].
 *
 * @param {unknown} left First vector.
 * @param {unknown} right Second vector.
 * @returns {number} Similarity in [-1, 1].
 */
export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return 0
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let normLeft = 0
  let normRight = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = numeric(left[index], 0)
    const rightValue = numeric(right[index], 0)
    dot += leftValue * rightValue
    normLeft += leftValue * leftValue
    normRight += rightValue * rightValue
  }
  if (!(normLeft > 0) || !(normRight > 0)) return 0
  const similarity = dot / Math.sqrt(normLeft * normRight)
  if (!Number.isFinite(similarity)) return 0
  return clampNumber(similarity, -1, 1)
}
