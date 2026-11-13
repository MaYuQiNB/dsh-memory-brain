/**
 * Memory Brain — pure memory model.
 *
 * The "brain mechanics" half of the plugin: the Ebbinghaus forgetting curve,
 * the bilingual tag encoder, the sleep-time consolidation pass, and the graph /
 * statistics projections the panel consumes. This module is deliberately
 * dependency-free and side-effect-free:
 *
 *   - ESM, zero imports, zero mutable module state (all module-level values are
 *     frozen primitives / frozen tables);
 *   - every function is total: malformed input yields a safe default instead of
 *     a throw, and no function writes into its arguments;
 *   - every derived value is a pure function of (memory, settings, atTime), so
 *     the host may recompute the read model as often as it likes.
 *
 * The authoritative spec is CONTRACT.md §3. The formulas there are transcribed
 * verbatim; comments mark any place where the spec leaves room and this file
 * had to pick one reading.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Persisted model version; bump only together with CONTRACT.md §3. */
export const ENGINE_VERSION = 1

/** Milliseconds in a day. The forgetting curve works in fractional days. */
export const DAY_MS = 86400000

/**
 * Default settings. Frozen: the store keeps its own mutable copy, nobody may
 * write back into the shared defaults.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  halfLifeDays: 3, // 基础半衰期（天）——由宿主 settings 覆盖
  baseStabilityDays: 1.5, // 新记忆的基础稳定度（天）
  fadingThreshold: 0.35, // retention < 它 => 'fading'
  forgetThreshold: 0.12, // retention < 它 => 'forgotten'
  purgeThreshold: 0.02, // 宿主睡眠清理阈值
  consolidateEveryHours: 6, // 宿主自动巩固周期
  maxMemories: 600,
  rehearsalBoostDays: 0.9, // 每次唤起增加的稳定度
  maxStabilityDays: 90,
  toolSalienceBoost: 0.06, // 预留给 salience 计算；曲线本身不直接读它
  autoCapture: true,
})

// Internal bounds. `resolveSettings` clamps every numeric knob into one of
// these ranges so a corrupt settings file can never poison the curve.
const SETTING_RANGES = Object.freeze({
  halfLifeDays: Object.freeze([0.5, 30]),
  baseStabilityDays: Object.freeze([0.1, 30]),
  fadingThreshold: Object.freeze([0, 1]),
  forgetThreshold: Object.freeze([0, 1]),
  purgeThreshold: Object.freeze([0, 1]),
  consolidateEveryHours: Object.freeze([1, 24]),
  maxMemories: Object.freeze([100, 2000]),
  rehearsalBoostDays: Object.freeze([0, 30]),
  maxStabilityDays: Object.freeze([1, 3650]),
  toolSalienceBoost: Object.freeze([0, 1]),
})

const MAX_AUTO_TAGS = 8
const MAX_THEME_TAGS = 4
const MAX_TOOL_TAGS = 3
const MAX_IDENTIFIER_TAGS = 2
const MAX_TAG_CHARS = 20
const MAX_TAG_SOURCE_CHARS = 24
const MAX_TAG_EDGES_PER_NODE = 6
const MAX_TAG_EDGES = 1500
const MAX_EXCERPT_CHARS = 140
const MAX_SEMANTIC_TEXT_CHARS = 300
const MAX_ACCESS_COUNT = 1e6
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
const ATOMIC_ZERO = Object.freeze({})

// ---------------------------------------------------------------------------
// Tiny internal helpers (not exported: the contract has no room for a second
// vocabulary; everything below is implementation detail).
// ---------------------------------------------------------------------------

/** True only for a real finite number (booleans / numeric strings excluded). */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Lenient number coercion used on record fields (accepts numeric strings). */
function numeric(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/** Safe string coercion; `null` / `undefined` become ''. */
function toText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return String(value)
  } catch {
    return ''
  }
}

/** Treat a value as a plain record; everything else becomes the frozen empty one. */
function objectRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ATOMIC_ZERO
  return value
}

/** Locale-independent deterministic ordering (code-unit order). */
function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** Round to `digits` decimal places without throwing on garbage. */
function roundTo(value, digits) {
  const factor = 10 ** digits
  const scaled = value * factor
  return Number.isFinite(scaled) ? Math.round(scaled) / factor : 0
}

/** Truncate by characters (code points), never splitting a surrogate pair. */
function truncateChars(text, limit) {
  const source = toText(text)
  if (limit <= 0 || source === '') return ''
  if (source.length <= limit) return source
  return Array.from(source).slice(0, limit).join('')
}

/** Coerce a settings-ish flag, tolerating the persisted JSON shapes. */
function toBooleanFlag(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 'true' || value === '1') return true
  if (value === 0 || value === 'false' || value === '0') return false
  return fallback
}

/** Validate records that can participate in the model; one record per id. */
function collectMemories(memories) {
  if (!Array.isArray(memories)) return []
  const list = []
  const seen = new Set()
  for (const raw of memories) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    list.push(raw)
  }
  return list
}

/** Copy a tag list: strings only, trimmed, de-duplicated, order preserved. */
function copyTags(tags) {
  if (!Array.isArray(tags)) return []
  const list = []
  const seen = new Set()
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    list.push(tag)
  }
  return list
}

/** Copy an id list: strings only, trimmed, de-duplicated, sorted ascending. */
function copyIdList(values) {
  if (!Array.isArray(values)) return []
  const list = []
  const seen = new Set()
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    list.push(id)
  }
  list.sort(compareText)
  return list
}

/** Deterministic edge id from its type and endpoints. */
function edgeId(type, source, target) {
  return `e-${hash32(`${type}\u0000${source}\u0000${target}`).toString(36)}`
}

// ---------------------------------------------------------------------------
// Numbers / determinism
// ---------------------------------------------------------------------------

/**
 * Clamp a number into [lo, hi]. Non-numbers (including NaN/Infinity and
 * numeric strings) fall back to `lo`, as CONTRACT.md §3 requires.
 *
 * @param {unknown} n Candidate number.
 * @param {unknown} lo Lower bound.
 * @param {unknown} hi Upper bound.
 * @returns {number} Clamped value.
 */
export function clamp(n, lo, hi) {
  const low = isFiniteNumber(lo) ? lo : 0
  const high = isFiniteNumber(hi) ? hi : low
  if (!isFiniteNumber(n)) return low
  if (high < low) return low
  if (n < low) return low
  if (n > high) return high
  return n
}

/**
 * FNV-1a 32-bit hash over the UTF-16 code units of `text`.
 *
 * @param {unknown} text Text to hash (coerced safely).
 * @returns {number} Unsigned 32-bit integer.
 */
export function hash32(text) {
  let input = ''
  if (typeof text === 'string') input = text
  else if (text !== null && text !== undefined) input = toText(text)
  let hash = FNV_OFFSET_BASIS
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/**
 * Deterministic layout seed for a memory id: two independent hashes mapped into
 * [-1, 1]. The client uses it as the initial position of the force graph.
 *
 * @param {unknown} id Memory id.
 * @returns {{ x: number, y: number }} Position in the unit square.
 */
export function seedPosition(id) {
  const key = typeof id === 'string' ? id : ''
  const x = (hash32(`x|${key}`) / 0xffffffff) * 2 - 1
  const y = (hash32(`y|${key}`) / 0xffffffff) * 2 - 1
  return { x: roundTo(x, 6), y: roundTo(y, 6) }
}

/**
 * Merge a partial settings object over DEFAULT_SETTINGS and clamp every numeric
 * knob into its sane range. The result is always a fresh plain object.
 *
 * @param {unknown} partial Raw settings (may be missing / corrupt).
 * @returns {typeof DEFAULT_SETTINGS} Effective settings.
 */
export function resolveSettings(partial) {
  const source = objectRecord(partial)
  const settings = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(SETTING_RANGES)) {
    const range = SETTING_RANGES[key]
    settings[key] = clamp(numeric(source[key], DEFAULT_SETTINGS[key]), range[0], range[1])
  }
  settings.maxMemories = Math.floor(settings.maxMemories)
  settings.autoCapture = toBooleanFlag(source.autoCapture, DEFAULT_SETTINGS.autoCapture)
  // Keep the threshold ladder meaningful even when a corrupt file hands us
  // forgetThreshold > fadingThreshold (or purge > forget).
  settings.forgetThreshold = Math.min(settings.forgetThreshold, settings.fadingThreshold)
  settings.purgeThreshold = Math.min(settings.purgeThreshold, settings.forgetThreshold)
  return settings
}

// ---------------------------------------------------------------------------
// Forgetting model
//
// stabilityDays(memory, settings) = base
//   * (1 + rehearsalBoostDays * max(0, accessCount - 1))   // 唤起增强
//   * salience (default 1, clamped 0.5..3)
//   * (pinned ? 50 : 1)
// capped at maxStabilityDays; pinned is floored at maxStabilityDays.
// base = memory.baseDays override, else:
//   baseStabilityDays * halfLifeDays / DEFAULT_SETTINGS.halfLifeDays
// ---------------------------------------------------------------------------

/** Stability in days for an already-resolved settings object. */
function stabilityFromConfig(memory, config) {
  const record = objectRecord(memory)
  const overrideDays = numeric(record.baseDays, Number.NaN)
  const base = Number.isFinite(overrideDays)
    ? clamp(overrideDays, 0.01, 3650)
    : clamp(
        config.baseStabilityDays * (config.halfLifeDays / DEFAULT_SETTINGS.halfLifeDays),
        0.01,
        3650,
      )
  const accessCount = Math.max(0, Math.min(MAX_ACCESS_COUNT, numeric(record.accessCount, 1)))
  const rehearsal = 1 + Math.max(0, config.rehearsalBoostDays * Math.max(0, accessCount - 1))
  const salience = clamp(numeric(record.salience, 1), 0.5, 3)
  const pinned = record.pinned === true
  let stability = base * rehearsal * salience * (pinned ? 50 : 1)
  if (!Number.isFinite(stability) || stability < 0.01) stability = 0.01
  stability = Math.min(stability, config.maxStabilityDays)
  // Once pinned, stability is at least maxStabilityDays (the "unless larger"
  // branch can never win after the cap, so pinned is exactly the ceiling).
  if (pinned) stability = Math.max(stability, config.maxStabilityDays)
  return stability
}

/**
 * How many days a trace stays "stable" before it decays noticeably.
 * Rehearsal (accessCount) lengthens it, salience weights it, pinning makes it
 * effectively permanent, and `maxStabilityDays` is the hard ceiling.
 *
 * @param {unknown} memory Memory record.
 * @param {unknown} [settings] Settings patch.
 * @returns {number} Stability in days (> 0).
 */
export function stabilityDays(memory, settings) {
  return stabilityFromConfig(memory, resolveSettings(settings))
}

/** A record is forgotten when the host explicitly marked it (forgottenAt > 0). */
function hasForgetMarker(record) {
  return numeric(record.forgottenAt, 0) > 0
}

/** Retention in [0, 1] for an already-resolved settings object. */
function retentionFromConfig(memory, atTime, config) {
  const record = objectRecord(memory)
  if (record.pinned === true) return 1
  if (hasForgetMarker(record)) return 0
  const at = numeric(atTime, 0)
  const lastAccessAt = numeric(record.lastAccessAt, 0)
  const elapsedDays = Math.max(0, at - lastAccessAt) / DAY_MS
  // CONTRACT: atTime / lastAccessAt illegal -> treated as 0 (both => elapsed 0).
  if (!Number.isFinite(elapsedDays) || elapsedDays <= 0) return 1
  const stability = stabilityFromConfig(record, config)
  const retention = Math.exp(-elapsedDays / stability)
  if (!Number.isFinite(retention)) return 0
  return clamp(retention, 0, 1)
}

/**
 * Ebbinghaus retention: exp(-elapsedDays / stabilityDays), 1 for pinned, 0 for
 * explicitly forgotten memories. Always in [0, 1].
 *
 * @param {unknown} memory Memory record.
 * @param {unknown} atTime Epoch ms of the observation.
 * @param {unknown} [settings] Settings patch.
 * @returns {number} Retention in [0, 1].
 */
export function retentionAt(memory, atTime, settings) {
  return retentionFromConfig(memory, atTime, resolveSettings(settings))
}

/** State machine for an already-resolved settings object. */
function stateFromConfig(memory, atTime, config) {
  const record = objectRecord(memory)
  if (record.pinned === true) return 'active'
  if (hasForgetMarker(record)) return 'forgotten'
  const retention = retentionFromConfig(record, atTime, config)
  // Strict comparisons on purpose: a trace sitting exactly on a threshold stays
  // in the less-decayed state.
  if (retention < config.forgetThreshold) return 'forgotten'
  if (retention < config.fadingThreshold) return 'fading'
  return 'active'
}

/**
 * Derived memory state: 'active' | 'fading' | 'forgotten'.
 *
 * @param {unknown} memory Memory record.
 * @param {unknown} atTime Epoch ms of the observation.
 * @param {unknown} [settings] Settings patch.
 * @returns {'active'|'fading'|'forgotten'} State key.
 */
export function memoryState(memory, atTime, settings) {
  return stateFromConfig(memory, atTime, resolveSettings(settings))
}

/**
 * Retention after `afterMs` — the client's time-travel helper: the same curve
 * evaluated at a future instant.
 *
 * @param {unknown} memory Memory record.
 * @param {unknown} now Epoch ms "now".
 * @param {unknown} afterMs Offset in ms (may be negative).
 * @param {unknown} [settings] Settings patch.
 * @returns {number} Projected retention in [0, 1].
 */
export function projectRetention(memory, now, afterMs, settings) {
  const at = numeric(now, 0) + numeric(afterMs, 0)
  return retentionFromConfig(memory, at, resolveSettings(settings))
}

// ---------------------------------------------------------------------------
// Tags
//
// Bilingual theme dictionary (>= 20 classes), tool-name mapping, ASCII
// identifier extraction and the canonical tag normaliser.
// ---------------------------------------------------------------------------

/** Build one frozen theme entry. */
function theme(tag, words) {
  return Object.freeze({ tag, words: Object.freeze(words) })
}

/**
 * Theme dictionary: tag -> Chinese + English keywords. Order is meaningful: it
 * is the deterministic tie-breaker when two themes score equally.
 */
const THEME_DICTIONARY = Object.freeze([
  theme('代码', [
    '代码', '编程', '程序', '源码', '函数', '变量', '编译', '重构', '脚本', '接口实现',
    'code', 'coding', 'program', 'programming', 'script', 'function', 'variable',
    'compile', 'refactor', 'syntax', 'bug', 'bugs', 'stack', 'traceback',
  ]),
  theme('插件', [
    '插件', '扩展', '组件', '面板', '注入', '宿主',
    'plugin', 'plugins', 'extension', 'addon', 'widget', 'panel', 'loader', 'cordis',
  ]),
  theme('文档', [
    '文档', '说明', '手册', '注释', '指南', '变更日志',
    'readme', 'doc', 'docs', 'documentation', 'manual', 'guide', 'markdown', 'changelog',
  ]),
  theme('数据', [
    '数据', '数据库', '数据集', '表格', '统计', '分析', '报表数据',
    'data', 'dataset', 'database', 'sql', 'csv', 'json', 'statistics', 'analytics',
    'dataframe', 'pandas',
  ]),
  theme('图像', [
    '图像', '图片', '画图', '绘图', '截图', '图标', '视觉', '渲染', '像素',
    'image', 'images', 'picture', 'photo', 'img', 'png', 'jpg', 'svg', 'icon',
    'draw', 'drawing', 'render', 'canvas', 'pixel',
  ]),
  theme('视频', [
    '视频', '影片', '剪辑', '字幕', '录像', '镜头',
    'video', 'videos', 'movie', 'film', 'clip', 'subtitle', 'ffmpeg', 'footage',
  ]),
  theme('网络', [
    '网络', '联网', '请求', '接口', '抓包', '在线', '网页', '网站',
    'network', 'http', 'https', 'api', 'request', 'endpoint', 'fetch', 'website',
    'web', 'url', 'cookie',
  ]),
  theme('文件', [
    '文件', '文件夹', '目录', '路径', '读写', '附件',
    'file', 'files', 'folder', 'directory', 'path', 'attachment',
  ]),
  theme('学习', [
    '学习', '课程', '知识', '教程', '笔记', '复习', '练习',
    'learn', 'learning', 'study', 'course', 'tutorial', 'lesson', 'notes',
    'knowledge', 'revision',
  ]),
  theme('金融', [
    '金融', '股票', '基金', '投资', '理财', '支付', '账单', '预算', '价格', '成本',
    'finance', 'financial', 'stock', 'fund', 'invest', 'investment', 'payment',
    'bill', 'budget', 'price', 'cost', 'revenue',
  ]),
  theme('游戏', [
    '游戏', '玩家', '关卡', '电竞',
    'game', 'games', 'gaming', 'player', 'steam', 'arcade',
  ]),
  theme('生活', [
    '生活', '日常', '饮食', '睡眠', '心情', '天气', '旅行', '咖啡', '周末',
    'life', 'daily', 'food', 'diet', 'sleep', 'mood', 'weather', 'travel',
    'coffee', 'weekend',
  ]),
  theme('计划', [
    '计划', '规划', '安排', '待办', '日程', '目标', '里程碑',
    'plan', 'plans', 'planning', 'todo', 'agenda', 'goal', 'roadmap', 'milestone',
  ]),
  theme('调试', [
    '调试', '排错', '定位', '日志', '崩溃', '报错', '异常',
    'debug', 'debugging', 'troubleshoot', 'log', 'logs', 'crash', 'trace', 'fix',
  ]),
  theme('部署', [
    '部署', '上线', '发布', '服务器', '容器', '运维', '生产环境',
    'deploy', 'deployment', 'release', 'server', 'docker', 'kubernetes', 'nginx',
    'production',
  ]),
  theme('搜索', [
    '搜索', '检索', '查找', '查询',
    'search', 'grep', 'query', 'lookup', 'retrieve', 'find',
  ]),
  theme('测试', [
    '测试', '用例', '断言', '覆盖率', '回归',
    'test', 'tests', 'testing', 'assert', 'assertion', 'coverage', 'spec', 'regression',
  ]),
  theme('写作', [
    '写作', '文章', '文案', '博客', '润色', '草稿',
    'writing', 'write-up', 'article', 'essay', 'blog', 'draft', 'proofread',
    'copywriting',
  ]),
  theme('翻译', [
    '翻译', '中英', '英文', '中文', '术语', '双语',
    'translate', 'translation', 'english', 'chinese', 'bilingual', 'locale', 'i18n',
  ]),
  theme('办公', [
    '办公', '表格', '演示', '幻灯片', '会议',
    'office', 'excel', 'word', 'ppt', 'powerpoint', 'spreadsheet', 'presentation',
    'slide', 'docx', 'xlsx', 'pptx',
  ]),
  theme('记忆', [
    '记忆', '遗忘', '回忆', '保持率', '巩固', '脑',
    'memory', 'memories', 'remember', 'forget', 'retention', 'recall', 'brain',
    'ebbinghaus',
  ]),
  theme('团队', [
    '团队', '协作', '分工', '队友', '负责人', '成员',
    'team', 'teammate', 'collab', 'collaboration', 'member', 'colleague', 'handoff',
  ]),
  theme('音乐', [
    '音乐', '歌曲', '歌单', '旋律', '乐器', '吉他',
    'music', 'song', 'songs', 'melody', 'guitar', 'playlist', 'lyrics', 'album',
  ]),
  theme('健康', [
    '健康', '运动', '健身', '跑步', '医生', '医疗', '体检',
    'health', 'fitness', 'workout', 'jogging', 'doctor', 'medical', 'exercise',
    'wellness',
  ]),
])

/** Is `char` an ASCII word character (so a keyword match touches no boundary)? */
function isAsciiWordChar(char) {
  return char !== '' && /[a-z0-9_]/.test(char)
}

/**
 * Count non-overlapping occurrences of `needle` in a lower-cased haystack.
 * ASCII keywords must sit on a word boundary so "code" does not match "encode".
 */
function countKeyword(haystack, needle) {
  if (haystack === '' || needle === '') return 0
  const asciiStart = isAsciiWordChar(needle[0])
  const asciiEnd = isAsciiWordChar(needle[needle.length - 1])
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    const before = index === 0 ? '' : haystack[index - 1]
    const after = index + needle.length >= haystack.length ? '' : haystack[index + needle.length]
    const startOk = !asciiStart || !isAsciiWordChar(before)
    const endOk = !asciiEnd || !isAsciiWordChar(after)
    if (startOk && endOk) count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * Score every theme against `text` and return the hits, best first. Ties keep
 * dictionary order so the output is perfectly deterministic.
 *
 * @param {unknown} text Raw text.
 * @returns {string[]} Theme tags ordered by score.
 */
function rankThemes(text) {
  const haystack = toText(text).toLowerCase()
  if (haystack === '') return []
  const ranked = []
  for (let index = 0; index < THEME_DICTIONARY.length; index += 1) {
    const entry = THEME_DICTIONARY[index]
    let score = 0
    for (const word of entry.words) score += countKeyword(haystack, word)
    if (score > 0) ranked.push({ tag: entry.tag, score, index })
  }
  ranked.sort((left, right) => right.score - left.score || left.index - right.index)
  return ranked.map((entry) => entry.tag)
}

/**
 * Map a tool name to its tag, per CONTRACT.md §3 b). Unknown tools keep their
 * own (normalised, truncated) name.
 *
 * @param {unknown} rawName Tool name.
 * @returns {string} Tag, or '' for an unusable name.
 */
function toolTagFor(rawName) {
  const name = toText(rawName).trim()
  if (name === '') return ''
  const lower = name.toLowerCase()
  // Specific image tools first: read_image must not fall into 检索.
  if (
    lower.startsWith('generate_image') ||
    lower.startsWith('edit_image') ||
    lower.startsWith('read_image') ||
    lower === 'image_gen'
  ) {
    return '图像'
  }
  if (lower.startsWith('web_')) return '联网'
  if (lower === 'workflow') return '工作流'
  if (lower === 'skill') return '技能'
  if (lower.startsWith('office_')) return '办公'
  if (lower.startsWith('douyin_')) return '抖音'
  if (
    lower === 'spawn_teammate' ||
    lower === 'send_message' ||
    lower.startsWith('spawn_teammate') ||
    lower.startsWith('team_task_')
  ) {
    return '协作'
  }
  if (lower.startsWith('schedule_')) return '定时'
  if (lower.startsWith('browser_')) return '浏览器'
  if (lower.startsWith('terminal_')) return '终端'
  if (lower === 'write' || lower === 'edit' || lower.startsWith('write_') || lower.startsWith('edit_')) {
    return '代码'
  }
  if (
    lower === 'read' ||
    lower === 'glob' ||
    lower === 'grep' ||
    lower.startsWith('read_') ||
    lower.startsWith('glob_') ||
    lower.startsWith('grep_')
  ) {
    return '检索'
  }
  if (
    lower === 'bash' ||
    lower === 'pwsh' ||
    lower === 'powershell' ||
    lower === 'shell' ||
    lower === 'exec' ||
    lower.startsWith('bash_') ||
    lower.startsWith('pwsh_') ||
    lower.startsWith('shell_')
  ) {
    return '终端'
  }
  const normalized = normalizeTag(name)
  return normalized !== '' ? normalized : truncateChars(name, MAX_TAG_CHARS)
}

/** English stop words that must never become an identifier tag. */
const IDENTIFIER_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'these', 'those', 'from', 'into',
  'function', 'const', 'let', 'var', 'class', 'return', 'import', 'export',
  'default', 'async', 'await', 'true', 'false', 'null', 'undefined', 'typeof',
  'instanceof', 'new', 'delete', 'throw', 'catch', 'finally', 'try', 'else',
  'while', 'switch', 'break', 'continue', 'yield', 'super', 'extends', 'static',
  'public', 'private', 'protected', 'readonly', 'interface', 'type', 'enum',
  'use', 'used', 'using', 'can', 'will', 'would', 'should', 'could', 'are',
  'was', 'were', 'has', 'have', 'had', 'not', 'but', 'you', 'your', 'our',
  'all', 'any', 'some', 'get', 'set', 'src', 'lib', 'etc', 'ok', 'okay',
  'please', 'thanks', 'thank', 'http', 'https', 'www', 'com', 'org', 'net',
  'html', 'body', 'head', 'div', 'span', 'self', 'this', 'then', 'than',
  'also', 'just', 'only', 'more', 'most', 'much', 'very', 'well', 'about',
  'after', 'before', 'because', 'being', 'been', 'does', 'did', 'doing',
  'done', 'each', 'other', 'same', 'such', 'them', 'they', 'their', 'there',
  'here', 'what', 'when', 'where', 'which', 'who', 'why', 'how', 'add', 'fix',
  'run', 'put', 'let', 'make', 'need', 'want', 'like', 'look', 'call',
])

/**
 * Extract up to two ASCII identifier tags (length 3-24) from the text, ranked by
 * frequency then first appearance.
 *
 * @param {unknown} text Raw text.
 * @returns {string[]} Identifier tags, lower-cased and normalised.
 */
function extractIdentifiers(text) {
  const source = toText(text)
  if (source === '') return []
  const pattern = /[A-Za-z][A-Za-z0-9_.-]{2,23}/g
  const counts = new Map()
  const firstIndex = new Map()
  let match = pattern.exec(source)
  while (match !== null) {
    const raw = match[0].replace(/[._-]+$/, '')
    if (raw.length >= 3 && raw.length <= 24) {
      const tag = normalizeTag(raw)
      if (
        tag !== '' &&
        tag.length >= 3 &&
        tag.length <= 24 &&
        !IDENTIFIER_STOPWORDS.has(tag)
      ) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
        if (!firstIndex.has(tag)) firstIndex.set(tag, match.index)
      }
    }
    match = pattern.exec(source)
  }
  return [...counts.entries()]
    .sort(
      (left, right) =>
        right[1] - left[1] ||
        (firstIndex.get(left[0]) ?? 0) - (firstIndex.get(right[0]) ?? 0) ||
        compareText(left[0], right[0]),
    )
    .slice(0, MAX_IDENTIFIER_TAGS)
    .map(([tag]) => tag)
}

/**
 * Normalise one tag: trim, strip edge '#', lower-case ASCII, collapse
 * whitespace to '-', truncate to 20 characters. Chinese is preserved as-is.
 * Empty / symbol-only / too-long (> 24 chars) input yields ''.
 *
 * @param {unknown} raw Raw tag.
 * @returns {string} Normalised tag or ''.
 */
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return ''
  let tag = raw.trim()
  tag = tag.replace(/^#+/, '').replace(/#+$/, '').trim()
  if (tag === '') return ''
  if (Array.from(tag).length > MAX_TAG_SOURCE_CHARS) return ''
  let normalized = tag.replace(/[A-Z]/g, (char) => char.toLowerCase())
  normalized = normalized.replace(/\s+/g, '-')
  normalized = normalized
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  if (!/[\p{L}\p{N}]/u.test(normalized)) return ''
  const truncated = Array.from(normalized).slice(0, MAX_TAG_CHARS).join('')
  return /[\p{L}\p{N}]/u.test(truncated) ? truncated : ''
}

/**
 * Candidate tags for a piece of text plus optional hints: up to 4 themes, then
 * up to 3 tool tags, de-duplicated and capped at 8. Returns [] when nothing
 * matched (the '闲聊' fallback belongs to autoTagsForEpisode).
 *
 * @param {unknown} text User + assistant text.
 * @param {unknown} [hints] `{ sessionTitle?: string, toolNames?: string[] }`.
 * @returns {string[]} Tags, themes before tools.
 */
export function extractTags(text, hints) {
  const source = objectRecord(hints)
  const body = toText(text)
  const sessionTitle = toText(source.sessionTitle)
  const combined = sessionTitle === '' ? body : `${body}\n${sessionTitle}`
  const tags = []
  const push = (tag) => {
    if (typeof tag !== 'string' || tag === '') return
    if (tags.length >= MAX_AUTO_TAGS || tags.includes(tag)) return
    tags.push(tag)
  }
  for (const tag of rankThemes(combined).slice(0, MAX_THEME_TAGS)) push(tag)
  const toolNames = Array.isArray(source.toolNames) ? source.toolNames : []
  const toolTags = []
  for (const name of toolNames) {
    const tag = toolTagFor(name)
    if (tag === '' || toolTags.includes(tag)) continue
    toolTags.push(tag)
    if (toolTags.length >= MAX_TOOL_TAGS) break
  }
  for (const tag of toolTags) push(tag)
  return tags
}

/**
 * Auto-tag one conversation turn: bilingual themes (rule a/d), tool mapping
 * (rule b), ASCII identifiers (rule c), then dedupe + cap 8; '闲聊' when empty.
 *
 * @param {unknown} input `{ userText, assistantText, sessionTitle, toolNames }`.
 * @returns {string[]} Tags (always at least one).
 */
export function autoTagsForEpisode(input) {
  const source = objectRecord(input)
  const userText = toText(source.userText)
  const assistantText = toText(source.assistantText)
  const sessionTitle = toText(source.sessionTitle)
  const toolNames = Array.isArray(source.toolNames) ? source.toolNames : []
  const body = `${userText}\n${assistantText}`
  const tags = []
  const push = (tag) => {
    if (typeof tag !== 'string' || tag === '') return
    if (tags.length >= MAX_AUTO_TAGS || tags.includes(tag)) return
    tags.push(tag)
  }
  for (const tag of extractTags(body, { sessionTitle, toolNames })) push(tag)
  for (const tag of extractIdentifiers(body)) push(tag)
  return tags.length > 0 ? tags : ['闲聊']
}

// ---------------------------------------------------------------------------
// Consolidation ("sleep")
// ---------------------------------------------------------------------------

/** Minimal deterministic union-find: representative is always the lowest index. */
function createUnionFind(size) {
  const parent = new Array(size)
  for (let index = 0; index < size; index += 1) parent[index] = index
  const find = (start) => {
    let root = start
    while (parent[root] !== root) root = parent[root]
    let cursor = start
    while (parent[cursor] !== root) {
      const next = parent[cursor]
      parent[cursor] = root
      cursor = next
    }
    return root
  }
  const union = (left, right) => {
    const rootLeft = find(left)
    const rootRight = find(right)
    if (rootLeft === rootRight) return
    if (rootLeft < rootRight) parent[rootRight] = rootLeft
    else parent[rootLeft] = rootRight
  }
  return { find, union }
}

/** Normalise a record's tag list for clustering / semantic aggregation. */
function tagListForConsolidation(tags) {
  if (!Array.isArray(tags)) return []
  const list = []
  for (const raw of tags) {
    const tag = normalizeTag(raw)
    if (tag === '' || list.includes(tag)) continue
    list.push(tag)
  }
  return list
}

/** Do two tag sets share at least two tags? */
function sharesAtLeastTwo(left, right) {
  let shared = 0
  for (const tag of left) {
    if (right.has(tag)) {
      shared += 1
      if (shared >= 2) return true
    }
  }
  return false
}

/**
 * The brain's "sleep": group episodes that share >= 2 tags (union-find over a
 * deterministic id-ascending scan) and distil each group of >= 2 into one
 * semantic memory. Episodes already consolidated (or listed as members of an
 * existing semantic memory) never participate again, existing semantic memories
 * are never touched, and nothing is forgotten.
 *
 * @param {unknown} memories All memory records.
 * @param {unknown} now Epoch ms of the sleep.
 * @param {unknown} [settings] Settings patch.
 * @returns {{ semantic: Array<Record<string, any>>, consolidatedIds: string[] }}
 */
export function consolidateEpisodes(memories, now, settings) {
  const config = resolveSettings(settings)
  const time = numeric(now, 0)
  const records = collectMemories(memories)

  // Members of existing semantic memories cannot be consolidated twice even if
  // a stale record lost its `consolidated` flag.
  const existingMembers = new Set()
  for (const record of records) {
    if (record.kind !== 'semantic') continue
    for (const memberId of copyIdList(record.memberIds)) existingMembers.add(memberId)
  }

  const candidates = []
  for (const record of records) {
    if (record.kind !== 'episode') continue
    if (record.consolidated === true) continue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id === '' || existingMembers.has(id)) continue
    if (stateFromConfig(record, time, config) === 'forgotten') continue
    const tags = tagListForConsolidation(record.tags)
    candidates.push({
      id,
      record,
      tags,
      tagSet: new Set(tags),
      createdAt: numeric(record.createdAt, 0),
    })
  }
  candidates.sort((left, right) => compareText(left.id, right.id))

  const unionFind = createUnionFind(candidates.length)
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (sharesAtLeastTwo(candidates[left].tagSet, candidates[right].tagSet)) {
        unionFind.union(left, right)
      }
    }
  }

  const groups = new Map()
  for (let index = 0; index < candidates.length; index += 1) {
    const root = unionFind.find(index)
    let group = groups.get(root)
    if (group === undefined) {
      group = []
      groups.set(root, group)
    }
    group.push(candidates[index])
  }

  const clusters = [...groups.values()]
    .filter((group) => group.length >= 2)
    .sort((left, right) => compareText(left[0].id, right[0].id))

  const semantic = []
  const consolidatedIds = []
  for (const cluster of clusters) {
    const members = [...cluster].sort((left, right) => compareText(left.id, right.id))
    const memberIds = members.map((member) => member.id)
    const tagCounts = new Map()
    for (const member of members) {
      for (const tag of member.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }
    const rankedTags = [...tagCounts.entries()].sort(
      (left, right) => right[1] - left[1] || compareText(left[0], right[0]),
    )
    const label = rankedTags.length > 0 ? rankedTags[0][0] : '记忆'
    const tags = rankedTags.slice(0, MAX_AUTO_TAGS).map(([tag]) => tag)
    const chronological = [...members].sort(
      (left, right) => left.createdAt - right.createdAt || compareText(left.id, right.id),
    )
    const earliest = chronological[0]
    const text = truncateChars(
      chronological
        .map((member) => toText(member.record.excerpt).trim())
        .filter((excerpt) => excerpt !== '')
        .join('\n'),
      MAX_SEMANTIC_TEXT_CHARS,
    )
    semantic.push({
      id: `sem-${hash32(memberIds.join('|')).toString(36)}`,
      kind: 'semantic',
      label,
      tags,
      sessionId: typeof earliest.record.sessionId === 'string' ? earliest.record.sessionId : '',
      sessionTitle:
        typeof earliest.record.sessionTitle === 'string' ? earliest.record.sessionTitle : '',
      turn: 0,
      text,
      createdAt: time,
      lastAccessAt: time,
      accessCount: 1,
      salience: clamp(1 + 0.2 * members.length, 1, 2.5),
      pinned: false,
      consolidated: false,
      memberIds,
    })
    for (const id of memberIds) consolidatedIds.push(id)
  }
  consolidatedIds.sort(compareText)
  return { semantic, consolidatedIds }
}

// ---------------------------------------------------------------------------
// Graph & statistics
// ---------------------------------------------------------------------------

/** Insert one candidate tag edge into a node's top-`limit` list. */
function keepTopTagEdge(list, candidate, limit) {
  let position = list.length
  for (let index = 0; index < list.length; index += 1) {
    const current = list[index]
    if (
      candidate.weight > current.weight ||
      (candidate.weight === current.weight &&
        compareText(candidate.otherId, current.otherId) < 0)
    ) {
      position = index
      break
    }
  }
  if (position >= limit) return
  list.splice(position, 0, candidate)
  if (list.length > limit) list.pop()
}

/** Build the node read model for one record. */
function buildNode(entry, time, config) {
  const record = entry.record
  const tags = copyTags(record.tags)
  const kind = entry.kind
  const excerptSource =
    toText(record.excerpt).trim() !== '' ? toText(record.excerpt) : toText(record.text)
  const position = seedPosition(entry.id)
  const node = {
    id: entry.id,
    kind,
    label:
      kind === 'semantic'
        ? toText(record.label).trim() || tags[0] || '记忆'
        : tags[0] || '记忆',
    excerpt: truncateChars(excerptSource, MAX_EXCERPT_CHARS),
    tags,
    sessionId: toText(record.sessionId),
    sessionTitle: toText(record.sessionTitle),
    turn: Math.max(0, Math.floor(numeric(record.turn, 0))),
    createdAt: numeric(record.createdAt, 0),
    lastAccessAt: numeric(record.lastAccessAt, 0),
    accessCount: Math.max(0, Math.floor(numeric(record.accessCount, 0))),
    stabilityDays: stabilityFromConfig(record, config),
    salience: clamp(numeric(record.salience, 1), 0.5, 3),
    retention: retentionFromConfig(record, time, config),
    state: stateFromConfig(record, time, config),
    pinned: record.pinned === true,
    consolidated: record.consolidated === true,
    x0: position.x,
    y0: position.y,
  }
  if (kind === 'semantic') node.memberIds = copyIdList(record.memberIds)
  return node
}

/**
 * Project the memory bank into the force graph the panel renders.
 *
 * Node order: episodes by createdAt ascending, then semantic memories by
 * createdAt ascending (ties by id). Edge types: 'tag' between non-forgotten
 * episodes sharing tags (per-node top 6 by weight, global cap 1500), 'session'
 * between turn-adjacent episodes of one task, 'semantic' from a semantic memory
 * to each of its member ids. No edge ever points at a missing node.
 *
 * @param {unknown} memories All memory records.
 * @param {unknown} now Epoch ms "now".
 * @param {unknown} [settings] Settings patch.
 * @returns {{ nodes: Array<Record<string, any>>, edges: Array<Record<string, any>> }}
 */
export function buildGraph(memories, now, settings) {
  const config = resolveSettings(settings)
  const time = numeric(now, 0)
  const records = collectMemories(memories)

  const episodeEntries = []
  const semanticEntries = []
  for (const record of records) {
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id === '') continue
    const entry = { id, record, kind: record.kind === 'semantic' ? 'semantic' : 'episode' }
    if (entry.kind === 'semantic') semanticEntries.push(entry)
    else episodeEntries.push(entry)
  }
  const byCreatedAt = (left, right) =>
    numeric(left.record.createdAt, 0) - numeric(right.record.createdAt, 0) ||
    compareText(left.id, right.id)
  episodeEntries.sort(byCreatedAt)
  semanticEntries.sort(byCreatedAt)

  const nodes = []
  const nodeIds = new Set()
  for (const entry of episodeEntries) {
    nodes.push(buildNode(entry, time, config))
    nodeIds.add(entry.id)
  }
  for (const entry of semanticEntries) {
    nodes.push(buildNode(entry, time, config))
    nodeIds.add(entry.id)
  }

  // ---- tag edges: episode <-> episode sharing >= 1 tag -------------------
  const episodeCount = episodeEntries.length
  const episodeNodes = nodes.slice(0, episodeCount)
  const tagSets = episodeNodes.map((node) => new Set(node.tags))
  const topEdges = episodeNodes.map(() => [])
  for (let left = 0; left < episodeCount; left += 1) {
    if (episodeNodes[left].state === 'forgotten') continue
    if (tagSets[left].size === 0) continue
    for (let right = left + 1; right < episodeCount; right += 1) {
      if (episodeNodes[right].state === 'forgotten') continue
      if (tagSets[right].size === 0) continue
      const shared = []
      for (const tag of tagSets[left]) {
        if (tagSets[right].has(tag)) shared.push(tag)
      }
      if (shared.length === 0) continue
      shared.sort(compareText)
      keepTopTagEdge(
        topEdges[left],
        { otherIndex: right, otherId: episodeNodes[right].id, weight: shared.length, shared },
        MAX_TAG_EDGES_PER_NODE,
      )
      keepTopTagEdge(
        topEdges[right],
        { otherIndex: left, otherId: episodeNodes[left].id, weight: shared.length, shared },
        MAX_TAG_EDGES_PER_NODE,
      )
    }
  }
  // An edge survives only when *both* endpoints chose it, so every node really
  // keeps at most its six heaviest tag edges.
  const tagCandidates = []
  for (let left = 0; left < episodeCount; left += 1) {
    for (const candidate of topEdges[left]) {
      const right = candidate.otherIndex
      if (right <= left) continue
      if (!topEdges[right].some((entry) => entry.otherIndex === left)) continue
      tagCandidates.push({
        sourceIndex: left,
        targetIndex: right,
        weight: candidate.weight,
        tags: candidate.shared,
      })
    }
  }
  tagCandidates.sort(
    (left, right) =>
      right.weight - left.weight ||
      compareText(episodeNodes[left.sourceIndex].id, episodeNodes[right.sourceIndex].id) ||
      compareText(episodeNodes[left.targetIndex].id, episodeNodes[right.targetIndex].id),
  )
  const edges = []
  for (const candidate of tagCandidates.slice(0, MAX_TAG_EDGES)) {
    const source = episodeNodes[candidate.sourceIndex].id
    const target = episodeNodes[candidate.targetIndex].id
    edges.push({
      id: edgeId('tag', source, target),
      source,
      target,
      type: 'tag',
      weight: candidate.weight,
      tags: [...candidate.tags],
    })
  }

  // ---- session edges: turn-adjacent episodes of one task ------------------
  const sessionGroups = new Map()
  for (let index = 0; index < episodeCount; index += 1) {
    const node = episodeNodes[index]
    if (node.sessionId === '') continue
    let group = sessionGroups.get(node.sessionId)
    if (group === undefined) {
      group = []
      sessionGroups.set(node.sessionId, group)
    }
    group.push({ id: node.id, turn: node.turn, createdAt: node.createdAt })
  }
  for (const sessionId of [...sessionGroups.keys()].sort(compareText)) {
    const group = sessionGroups.get(sessionId)
    group.sort(
      (left, right) =>
        left.turn - right.turn ||
        left.createdAt - right.createdAt ||
        compareText(left.id, right.id),
    )
    for (let index = 1; index < group.length; index += 1) {
      edges.push({
        id: edgeId('session', group[index - 1].id, group[index].id),
        source: group[index - 1].id,
        target: group[index].id,
        type: 'session',
        weight: 1,
      })
    }
  }

  // ---- semantic edges: semantic -> each existing member -------------------
  for (let index = episodeCount; index < nodes.length; index += 1) {
    const node = nodes[index]
    for (const memberId of node.memberIds ?? []) {
      if (!nodeIds.has(memberId)) continue // never emit a dangling edge
      edges.push({
        id: edgeId('semantic', node.id, memberId),
        source: node.id,
        target: memberId,
        type: 'semantic',
        weight: 1,
        tags: [...node.tags],
      })
    }
  }

  return { nodes, edges }
}

/**
 * Aggregate statistics for the status chips and the system-prompt digest.
 * `avgRetention` averages every memory that was not explicitly forgotten
 * (i.e. no `forgottenAt` marker); forced ghosts would otherwise drag it to 0.
 *
 * @param {unknown} memories All memory records.
 * @param {unknown} now Epoch ms "now".
 * @param {unknown} [settings] Settings patch.
 * @returns {{ total: number, active: number, fading: number, forgotten: number, pinned: number, semantic: number, episodes: number, sessions: number, tags: number, avgRetention: number }} Stats.
 */
export function computeStats(memories, now, settings) {
  const config = resolveSettings(settings)
  const time = numeric(now, 0)
  const records = collectMemories(memories)
  let active = 0
  let fading = 0
  let forgotten = 0
  let pinned = 0
  let semanticCount = 0
  let retentionSum = 0
  let retentionCount = 0
  const sessions = new Set()
  const tags = new Set()
  for (const record of records) {
    const state = stateFromConfig(record, time, config)
    if (state === 'active') active += 1
    else if (state === 'fading') fading += 1
    else forgotten += 1
    if (record.pinned === true) pinned += 1
    if (record.kind === 'semantic') semanticCount += 1
    if (typeof record.sessionId === 'string' && record.sessionId.trim() !== '') {
      sessions.add(record.sessionId.trim())
    }
    for (const tag of copyTags(record.tags)) tags.add(tag)
    if (!hasForgetMarker(record)) {
      retentionSum += retentionFromConfig(record, time, config)
      retentionCount += 1
    }
  }
  const total = records.length
  return {
    total,
    active,
    fading,
    forgotten,
    pinned,
    semantic: semanticCount,
    episodes: total - semanticCount,
    sessions: sessions.size,
    tags: tags.size,
    avgRetention: retentionCount === 0 ? 0 : roundTo(retentionSum / retentionCount, 3),
  }
}

/**
 * Tag cloud: how many memories carry each tag, most common first.
 *
 * @param {unknown} memories All memory records.
 * @returns {Array<{ tag: string, count: number }>} Sorted counts.
 */
export function tagCounts(memories) {
  const counts = new Map()
  for (const record of collectMemories(memories)) {
    for (const tag of copyTags(record.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .map(([tag, count]) => ({ tag, count }))
}
