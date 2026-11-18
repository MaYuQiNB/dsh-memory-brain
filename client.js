/**
 * Client half of the `dsh-memory-brain` bundle.
 *
 * Registers two slots in the DSH Web UI:
 *
 *   1. `sidebar.panellist` — an original "brain + neural nodes" glyph that opens
 *      the panel.
 *   2. `main` (keyed by the panel id `memory-brain`) — the full-page Memory
 *      Network panel: toolbar with live stats, a filter rail (tasks / tags /
 *      search / ghost switch / legend), a Canvas 2D force-directed memory web,
 *      a memory inspector with tag editing and a retention curve, a 0–60 day
 *      time-travel slider that recomputes projected retention locally, and the
 *      settings form.
 *
 * Only React is imported (`require('react')`); everything is plain
 * `React.createElement` — no JSX, no Client package imports, no npm deps.
 * Business state lives in the Host; this file keeps exactly one snapshot store
 * (created in `apply`) and treats every HTTP response's `state` as
 * authoritative.
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-brain',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace shared by both slot registrations. */
    const NS = 'memory-brain'
    /** The id of the sidebar row and the key of the main panel it opens. */
    const PANEL_ID = 'memory-brain'
    const STYLE_TAG_ID = 'dsh-memory-brain-styles'
    const TRAVEL_INPUT_ID = 'dsh-memory-brain-travel-range'

    const POLL_INTERVAL_MS = 2000
    const DAY_MS = 86400000
    const MAX_TRAVEL_DAYS = 60

    /** Host routes; every mutation answers with `{ ok, state }`. */
    const ROUTES = {
      state: '/memory-brain/state',
      tagAdd: '/memory-brain/tag/add',
      tagRemove: '/memory-brain/tag/remove',
      rehearse: '/memory-brain/rehearse',
      forget: '/memory-brain/forget',
      restore: '/memory-brain/restore',
      pin: '/memory-brain/pin',
      sleep: '/memory-brain/sleep',
      capture: '/memory-brain/capture',
      settings: '/memory-brain/settings',
      purge: '/memory-brain/purge',
      reset: '/memory-brain/reset',
    }

    // Canvas layout / simulation constants, in world (layout) units.
    const SEED_RADIUS = 440
    const IDEAL_DISTANCE = 64
    const GRAVITY = 0.008
    const MAX_REPULSION_SAMPLE = 96
    const SIM_START_TEMPERATURE = 16
    const SIM_STOP_TEMPERATURE = 0.55
    const WORLD_BOUND = 2600

    // ---------------------------------------------------------------------
    // Copy
    // ---------------------------------------------------------------------

    const zh = {
      'panel.label': '记忆脑',
      'page.title': '记忆网',
      'page.subtitle': '仿生记忆库：每轮对话落成一条情节记忆，按艾宾浩斯曲线随时间消退；唤起越多，记得越牢。',
      'stats.total': '记忆',
      'stats.active': '活跃',
      'stats.fading': '消退',
      'stats.forgotten': '遗忘',
      'stats.pinned': '固定',
      'stats.avgRetention': '平均保持',
      'action.refresh': '刷新',
      'action.refreshing': '刷新中…',
      'action.sleep': '巩固睡眠',
      'action.sleeping': '巩固中…',
      'action.capture': '扫描历史',
      'action.capturing': '扫描中…',
      'action.settings': '设置',
      'action.purge': '清理遗忘',
      'action.purging': '清理中…',
      'action.purgeConfirm': '再点确认清理',
      'action.reset': '清空记忆',
      'action.resetting': '清空中…',
      'action.resetConfirm': '再点确认清空',
      'action.filter': '筛选',
      'action.filterHide': '收起筛选',
      'error.dismiss': '知道了',
      'error.badState': '宿主返回的记忆快照不完整。',
      'left.tasks': '任务',
      'left.tasksEmpty': '还没有任务记忆',
      'left.untitled': '未命名任务',
      'left.sessionMeta': '{count} 条',
      'left.tags': '标签',
      'left.tagsEmpty': '还没有标签',
      'left.tagMode': '多选为 AND：只留下同时带这些标签的记忆。',
      'left.searchLabel': '搜索记忆',
      'left.searchPlaceholder': '搜摘要 / 标签 / 任务',
      'left.showForgotten': '显示已遗忘的幽灵记忆',
      'left.clearFilters': '清除筛选',
      'left.legend': '图例',
      'left.qqBadge': 'QQ',
      'legend.episode': '情节记忆',
      'legend.semantic': '语义记忆',
      'legend.fading': '消退中',
      'legend.forgotten': '已遗忘',
      'legend.pinned': '已固定',
      'legend.edgeTag': '标签边',
      'legend.edgeSession': '同任务边',
      'legend.edgeSemantic': '语义成员边',
      'canvas.meta': '{nodes} 个节点 · {edges} 条连接',
      'canvas.hint': '滚轮缩放 · 拖空白平移 · 拖节点挪动 · 双击归位',
      'canvas.aria': '记忆网络力导向图：滚轮缩放、拖动平移，点节点查看详情',
      'canvas.loading': '正在读取记忆…',
      'canvas.empty.title': '这张网还是空的',
      'canvas.empty.body': '新对话会在每轮结束后自动记入记忆。想立刻看到内容，可以扫描这台电脑上的历史会话。',
      'canvas.empty.cta': '扫描历史会话',
      'canvas.noMatch': '当前的筛选没有留下任何记忆。',
      'canvas.tooltip.retention': '保持率 {value}%',
      'canvas.tooltip.session': '任务：{title}',
      'canvas.tooltip.turn': '第 {turn} 轮',
      'canvas.hint3d': '拖拽旋转 · 滚轮缩放 · 点击节点看详情',
      'canvas.aria3d': '三维记忆网络：拖拽旋转、滚轮缩放，点节点看详情',
      'canvas.turnSuffix': '第{turn}轮',
      'view.switchLabel': '视图模式',
      'view.3d': '3D 立体',
      'view.2d': '2D 平面',
      'view.reset': '复位视角',
      'view.autoRotate': '自转',
      'view.fullscreen': '全屏',
      'view.exitFullscreen': '退出全屏',
      'view.fullscreenHint': 'Esc 退出全屏',
      'view.immersiveHint': '当前浏览器不允许页面全屏，已切成沉浸模式',
      'view.fullscreenBar': '全屏控制条',
      'task.tab': '记忆',
      'task.title': '本任务记忆',
      'task.qq': 'QQ',
      'task.stats': '{total} 条记忆 · 活跃 {active} · 平均保持 {retention}%',
      'task.refresh': '刷新',
      'task.refreshing': '刷新中…',
      'task.openGlobal': '在记忆脑中打开',
      'task.empty.title': '这个任务还没有记忆',
      'task.empty.body': '每轮对话结束后会自动记入，也可以扫描历史任务。',
      'task.capture': '扫描历史',
      'task.list': '本任务记忆列表',
      'task.loading': '正在读取这个任务的记忆…',
      'task.error': '记忆读取失败：{message}',
      'task.turn': '第 {turn} 轮',
      'task.retention': '保持率 {value}%',
      'travel.label': '时间旅行 +{days} 天',
      'travel.aria': '时间旅行：模拟未来多少天的遗忘',
      'travel.hint': '拖动滑块模拟未来的遗忘',
      'travel.banner': '模拟 {days} 天后：保持率按遗忘曲线在本地重算，宿主数据未改变。',
      'travel.back': '回到现在',
      'detail.title': '记忆详情',
      'detail.close': '关闭详情',
      'detail.none.title': '还没选中记忆',
      'detail.none.body': '点画布里的节点，看摘要、标签和保持率曲线。',
      'detail.excerpt': '摘要',
      'detail.tombstone': '这条记忆已到遗忘时间，内容已被永久删除（不可恢复）。',
      'tombstone.label': '已遗忘',
      'detail.semanticNote': '语义记忆：由 {count} 条情节记忆巩固合并而成。',
      'detail.meta': '元信息',
      'detail.session': '任务',
      'detail.turn': '轮次',
      'detail.created': '创建',
      'detail.lastAccess': '上次激活',
      'detail.accessCount': '访问次数',
      'detail.stability': '稳定度',
      'detail.days': '{value} 天',
      'detail.retention': '当前保持率',
      'detail.retentionSim': '模拟保持率（+{days} 天）',
      'detail.state': '状态',
      'detail.times': '{count} 次',
      'detail.tags': '标签',
      'detail.tagsEmpty': '还没有标签',
      'detail.addTag': '添加标签',
      'detail.removeTag': '删除标签 {tag}',
      'detail.tagPlaceholder': '输入标签后回车',
      'detail.curve': '保持率衰减曲线',
      'detail.curveNow': '现在',
      'detail.curveTravel': '+{days} 天',
      'detail.curveStart': '上次激活',
      'detail.curveEnd': '+{days} 天',
      'detail.ops': '操作',
      'detail.rehearse': '唤醒',
      'detail.rehearsing': '唤醒中…',
      'detail.pin': '置顶',
      'detail.unpin': '取消置顶',
      'detail.forget': '遗忘',
      'detail.forgetting': '遗忘中…',
      'detail.hardForget': '彻底遗忘',
      'detail.hardForgetConfirm': '再点确认彻底遗忘',
      'detail.restore': '恢复',
      'detail.restoring': '恢复中…',
      'state.active': '活跃',
      'state.fading': '消退',
      'state.forgotten': '已遗忘',
      'state.pinned': '固定',
      'settings.title': '设置',
      'settings.close': '收起',
      'settings.halfLife': '遗忘时间（天）',
      'settings.halfLifeHint': '记忆大约多少天不回忆就会进入遗忘（1–60 天，默认 7）；重要的、常被想起的记忆会更久。',
      'settings.presets': '快捷选择',
      'settings.daysShort': '{days} 天',
      'settings.maxMemories': '记忆上限',
      'settings.autoCapture': '自动记录新对话',
      'settings.autoCaptureHint': '每轮对话结束后自动写一条情节记忆。',
      'settings.save': '保存设置',
      'settings.saving': '保存中…',
      'settings.invalid': '遗忘时间需在 1–60 天，记忆上限需在 100–2000。',
      'time.justNow': '刚刚',
      'time.minutesAgo': '{count} 分钟前',
      'time.hoursAgo': '{count} 小时前',
      'time.daysAgo': '{count} 天前',
      'time.older': '{count} 个月前',
      'poll.hint': '每 2 秒自动同步一次；页面切到后台就暂停。',
    }

    const en = {
      'panel.label': 'Memory Brain',
      'page.title': 'Memory Network',
      'page.subtitle': 'A bionic memory store: each turn becomes an episodic memory that decays along an Ebbinghaus curve. The more you recall it, the longer it lasts.',
      'stats.total': 'Memories',
      'stats.active': 'Active',
      'stats.fading': 'Fading',
      'stats.forgotten': 'Forgotten',
      'stats.pinned': 'Pinned',
      'stats.avgRetention': 'Avg. retention',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Refreshing…',
      'action.sleep': 'Consolidate',
      'action.sleeping': 'Consolidating…',
      'action.capture': 'Scan history',
      'action.capturing': 'Scanning…',
      'action.settings': 'Settings',
      'action.purge': 'Purge forgotten',
      'action.purging': 'Purging…',
      'action.purgeConfirm': 'Click again to purge',
      'action.reset': 'Erase all',
      'action.resetting': 'Erasing…',
      'action.resetConfirm': 'Click again to erase',
      'action.filter': 'Filters',
      'action.filterHide': 'Hide filters',
      'error.dismiss': 'Dismiss',
      'error.badState': 'The Host returned an incomplete memory snapshot.',
      'left.tasks': 'Tasks',
      'left.tasksEmpty': 'No task memories yet',
      'left.untitled': 'Untitled task',
      'left.sessionMeta': '{count} mem.',
      'left.tags': 'Tags',
      'left.tagsEmpty': 'No tags yet',
      'left.tagMode': 'Multiple tags combine with AND: only memories carrying all of them stay.',
      'left.searchLabel': 'Search memories',
      'left.searchPlaceholder': 'Search excerpt / tags / task',
      'left.showForgotten': 'Show forgotten ghost memories',
      'left.clearFilters': 'Clear filters',
      'left.legend': 'Legend',
      'left.qqBadge': 'QQ',
      'legend.episode': 'Episodic',
      'legend.semantic': 'Semantic',
      'legend.fading': 'Fading',
      'legend.forgotten': 'Forgotten',
      'legend.pinned': 'Pinned',
      'legend.edgeTag': 'Tag edge',
      'legend.edgeSession': 'Same-task edge',
      'legend.edgeSemantic': 'Semantic member edge',
      'canvas.meta': '{nodes} nodes · {edges} edges',
      'canvas.hint': 'Wheel to zoom · drag empty space to pan · drag a node to move · double-click to refit',
      'canvas.aria': 'Force-directed memory network: wheel to zoom, drag to pan, click a node for details',
      'canvas.loading': 'Reading memories…',
      'canvas.empty.title': 'This network is still empty',
      'canvas.empty.body': 'New conversations are recorded automatically after each turn. To see something now, scan the session history on this computer.',
      'canvas.empty.cta': 'Scan session history',
      'canvas.noMatch': 'No memories left under the current filters.',
      'canvas.tooltip.retention': 'Retention {value}%',
      'canvas.tooltip.session': 'Task: {title}',
      'canvas.tooltip.turn': 'Turn {turn}',
      'canvas.hint3d': 'Drag to rotate · wheel to zoom · click a node for details',
      'canvas.aria3d': '3D memory network: drag to rotate, wheel to zoom, click a node for details',
      'canvas.turnSuffix': 'turn {turn}',
      'view.switchLabel': 'View mode',
      'view.3d': '3D',
      'view.2d': '2D',
      'view.reset': 'Reset view',
      'view.autoRotate': 'Auto-rotate',
      'view.fullscreen': 'Fullscreen',
      'view.exitFullscreen': 'Exit fullscreen',
      'view.fullscreenHint': 'Press Esc to exit fullscreen',
      'view.immersiveHint': 'Browser fullscreen is unavailable here; switched to immersive mode',
      'view.fullscreenBar': 'Fullscreen controls',
      'task.tab': 'Memory',
      'task.title': 'Task memories',
      'task.qq': 'QQ',
      'task.stats': '{total} memories · {active} active · {retention}% avg. retention',
      'task.refresh': 'Refresh',
      'task.refreshing': 'Refreshing…',
      'task.openGlobal': 'Open in Memory Brain',
      'task.empty.title': 'No memories for this task yet',
      'task.empty.body': 'Each turn is recorded automatically after it ends, or scan past tasks now.',
      'task.capture': 'Scan history',
      'task.list': 'Task memory list',
      'task.loading': 'Reading this task’s memories…',
      'task.error': 'Could not read memories: {message}',
      'task.turn': 'Turn {turn}',
      'task.retention': 'Retention {value}%',
      'travel.label': 'Time travel +{days} d',
      'travel.aria': 'Time travel: simulate how many days into the future',
      'travel.hint': 'Drag the slider to simulate future forgetting',
      'travel.banner': 'Simulating {days} days ahead: retention is recomputed locally from the forgetting curve; Host data is unchanged.',
      'travel.back': 'Back to now',
      'detail.title': 'Memory detail',
      'detail.close': 'Close details',
      'detail.none.title': 'No memory selected',
      'detail.none.body': 'Click a node in the canvas to see its excerpt, tags, and retention curve.',
      'detail.excerpt': 'Excerpt',
      'detail.tombstone': 'This memory reached its forgetting time; its content was permanently deleted (unrecoverable).',
      'tombstone.label': 'Forgotten',
      'detail.semanticNote': 'Semantic memory: consolidated from {count} episodic memories.',
      'detail.meta': 'Details',
      'detail.session': 'Task',
      'detail.turn': 'Turn',
      'detail.created': 'Created',
      'detail.lastAccess': 'Last activated',
      'detail.accessCount': 'Access count',
      'detail.stability': 'Stability',
      'detail.days': '{value} days',
      'detail.retention': 'Current retention',
      'detail.retentionSim': 'Simulated retention (+{days} d)',
      'detail.state': 'State',
      'detail.times': '{count}×',
      'detail.tags': 'Tags',
      'detail.tagsEmpty': 'No tags yet',
      'detail.addTag': 'Add tag',
      'detail.removeTag': 'Remove tag {tag}',
      'detail.tagPlaceholder': 'Type a tag and press Enter',
      'detail.curve': 'Retention decay curve',
      'detail.curveNow': 'now',
      'detail.curveTravel': '+{days} d',
      'detail.curveStart': 'last activated',
      'detail.curveEnd': '+{days} d',
      'detail.ops': 'Actions',
      'detail.rehearse': 'Recall',
      'detail.rehearsing': 'Recalling…',
      'detail.pin': 'Pin',
      'detail.unpin': 'Unpin',
      'detail.forget': 'Forget',
      'detail.forgetting': 'Forgetting…',
      'detail.hardForget': 'Erase permanently',
      'detail.hardForgetConfirm': 'Click again to erase',
      'detail.restore': 'Restore',
      'detail.restoring': 'Restoring…',
      'state.active': 'Active',
      'state.fading': 'Fading',
      'state.forgotten': 'Forgotten',
      'state.pinned': 'Pinned',
      'settings.title': 'Settings',
      'settings.close': 'Hide',
      'settings.halfLife': 'Forget after (days)',
      'settings.halfLifeHint': 'How many days without recall before a memory is forgotten (1–60, default 7). Important or often-recalled memories last longer.',
      'settings.presets': 'Quick presets',
      'settings.daysShort': '{days} d',
      'settings.maxMemories': 'Memory cap',
      'settings.autoCapture': 'Auto-record new conversations',
      'settings.autoCaptureHint': 'Write one episodic memory after each turn.',
      'settings.save': 'Save settings',
      'settings.saving': 'Saving…',
      'settings.invalid': 'Forgetting time must be 1–60 days; the memory cap must be 100–2000.',
      'time.justNow': 'just now',
      'time.minutesAgo': '{count} min ago',
      'time.hoursAgo': '{count} h ago',
      'time.daysAgo': '{count} d ago',
      'time.older': '{count} mo ago',
      'poll.hint': 'Syncs every 2 seconds; pauses while the page is hidden.',
    }

    // ---------------------------------------------------------------------
    // Styles — colors only through theme tokens so light/dark both work.
    // Canvas-internal HSL colors are the documented exception (self-drawn).
    // ---------------------------------------------------------------------

    const CSS = `
.dsh-memory-brain-page{display:flex;flex:1;flex-direction:column;width:100%;min-width:0;min-height:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6;overflow:hidden}
.dsh-memory-brain-header{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:10px 20px;flex:none;padding:20px clamp(14px,2.4vw,32px) 12px}
[data-platform=darwin] .dsh-memory-brain-header{padding-top:calc(20px + var(--dsh-frame-top-clearance,0px))}
.dsh-memory-brain-heading{flex:1 1 280px;min-width:0}
.dsh-memory-brain-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dsh-memory-brain-subtitle{margin:4px 0 0;max-width:66ch;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dsh-memory-brain-chips{display:flex;flex:1 1 auto;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.dsh-memory-brain-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.dsh-memory-brain-chip b{font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-chip[data-tone=active] b{color:var(--dsw-alias-state-success-primary)}
.dsh-memory-brain-chip[data-tone=fading] b{color:var(--dsw-alias-state-warn-primary)}
.dsh-memory-brain-chip[data-tone=forgotten] b{color:var(--dsw-alias-label-caption)}
.dsh-memory-brain-chip[data-tone=pinned] b{color:var(--dsw-alias-state-business-primary)}
.dsh-memory-brain-chip[data-tone=retention] b{color:var(--dsw-alias-state-business-primary)}
.dsh-memory-brain-headerActions{display:flex;flex:none;flex-wrap:wrap;align-items:center;gap:8px;max-width:100%}
.dsh-memory-brain-banner{display:flex;flex:none;align-items:flex-start;gap:10px;margin:0 clamp(14px,2.4vw,32px) 10px;padding:8px 12px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.dsh-memory-brain-bannerText{flex:1;min-width:0;overflow-wrap:anywhere}
.dsh-memory-brain-body{display:grid;grid-template-columns:292px minmax(0,1fr) 322px;gap:12px;flex:1;min-height:0;padding:0 clamp(14px,2.4vw,32px) 16px;overflow:hidden}
.dsh-memory-brain-page[data-left=off] .dsh-memory-brain-body{grid-template-columns:minmax(0,1fr) 322px}
.dsh-memory-brain-left,.dsh-memory-brain-right{display:flex;flex-direction:column;min-width:0;min-height:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-memory-brain-scroll{flex:1;min-height:0;padding:12px;overflow:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}
.dsh-memory-brain-section{margin:0;padding:0}
.dsh-memory-brain-section + .dsh-memory-brain-section{margin-top:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l3)}
.dsh-memory-brain-sectionTitle{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}
.dsh-memory-brain-subSectionTitle{margin:10px 0 4px;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}
.dsh-memory-brain-list{display:flex;flex-direction:column;gap:1px;margin:0;padding:0;max-height:220px;overflow:auto;list-style:none}
.dsh-memory-brain-listItem{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:28px;margin:0;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;appearance:none}
.dsh-memory-brain-listItem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-listItem:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-memory-brain-listItem[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-listLabel{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-memory-brain-listMeta{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dsh-memory-brain-qqBadge{display:inline-flex;flex:none;align-items:center;justify-content:center;padding:0 5px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary);font-size:10px;font-weight:600;line-height:15px;letter-spacing:.02em;white-space:nowrap}
.dsh-memory-brain-tagCloud{display:flex;flex-wrap:wrap;gap:6px;max-height:190px;overflow:auto}
.dsh-memory-brain-tag{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;appearance:none}
.dsh-memory-brain-tag:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-tag:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-memory-brain-tag[aria-pressed=true]{border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-tagCount{color:var(--dsw-alias-label-caption);font-size:11px}
.dsh-memory-brain-hint{margin:6px 0 0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-caption)}
.dsh-memory-brain-errorText{margin:6px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dsh-memory-brain-search,.dsh-memory-brain-input{box-sizing:border-box;width:100%;height:30px;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none}
.dsh-memory-brain-search::placeholder,.dsh-memory-brain-input::placeholder{color:var(--dsw-alias-label-caption)}
.dsh-memory-brain-search:focus,.dsh-memory-brain-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}
.dsh-memory-brain-switchRow{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;margin:8px 0 0;padding:2px 0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;appearance:none}
.dsh-memory-brain-switchRow:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-switchRow:disabled{cursor:default;opacity:.5}
.dsh-memory-brain-switchRow:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-memory-brain-switchTrack{position:relative;display:inline-block;flex:none;width:34px;height:20px;border-radius:10px;background:var(--dsw-alias-state-idle-primary);transition:background-color .15s}
.dsh-memory-brain-switchTrack[data-on=true]{background:var(--dsw-alias-state-business-primary)}
.dsh-memory-brain-switchThumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 25%,transparent);transition:transform .15s}
.dsh-memory-brain-switchTrack[data-on=true] .dsh-memory-brain-switchThumb{transform:translateX(14px)}
.dsh-memory-brain-switchLabel{min-width:0;overflow-wrap:anywhere}
.dsh-memory-brain-legend{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dsh-memory-brain-legendItem{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.dsh-memory-brain-legendMark{position:relative;display:inline-block;flex:none;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-state-business-primary);opacity:.9}
.dsh-memory-brain-legendMark[data-mark=diamond]{border-radius:0;transform:rotate(45deg);background:var(--dsw-alias-state-business-primary)}
.dsh-memory-brain-legendMark[data-mark=dotDash]{background:transparent;border:1px dashed var(--dsw-alias-label-tertiary);opacity:.85}
.dsh-memory-brain-legendMark[data-mark=dotFaded]{background:color-mix(in srgb,var(--dsw-alias-label-caption) 30%,transparent);border:1px dashed var(--dsw-alias-label-caption);opacity:.85}
.dsh-memory-brain-legendMark[data-mark=star]{background:transparent;border-radius:0;opacity:1;color:var(--dsw-alias-state-warn-primary)}
.dsh-memory-brain-legendMark[data-mark=line]{width:16px;height:0;border:0;border-top:1.5px solid var(--dsw-alias-label-tertiary);border-radius:0;background:transparent;opacity:.8}
.dsh-memory-brain-legendMark[data-mark=lineDash]{width:16px;height:0;border:0;border-top:1.5px dashed var(--dsw-alias-label-tertiary);border-radius:0;background:transparent;opacity:.8}
.dsh-memory-brain-legendMark[data-mark=lineCold]{width:16px;height:0;border:0;border-top:1.5px solid var(--dsw-alias-state-business-primary);border-radius:0;background:transparent;opacity:.9}
.dsh-memory-brain-canvasCard{display:flex;flex-direction:column;min-width:0;min-height:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-memory-brain-canvasHead{display:flex;flex:none;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 14px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsh-memory-brain-canvasMeta{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.dsh-memory-brain-canvasHint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dsh-memory-brain-canvasControls{display:flex;flex:1 1 auto;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px;min-width:0}
.dsh-memory-brain-viewSwitch{display:inline-flex;align-items:center;padding:2px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base)}
.dsh-memory-brain-viewSwitchBtn{box-sizing:border-box;height:24px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:24px;white-space:nowrap;cursor:pointer;appearance:none;transition:background-color .12s,color .12s}
.dsh-memory-brain-viewSwitchBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-viewSwitchBtn[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-viewSwitchBtn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-memory-brain-canvas3dWrap{position:relative;flex:1;min-width:0;min-height:420px;overflow:hidden;cursor:grab;touch-action:none;user-select:none;background:var(--dsw-alias-bg-base)}
.dsh-memory-brain-canvas3dWrap[data-dragging=true]{cursor:grabbing}
.dsh-memory-brain-canvas3d{display:block;width:100%;height:100%}
.dsh-memory-brain-simBanner{display:flex;flex:none;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;border-bottom:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.dsh-memory-brain-canvasWrap{position:relative;flex:1;min-width:0;min-height:420px;overflow:hidden;cursor:grab;touch-action:none;user-select:none;background-image:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-border-l2) 75%,transparent) 1px,transparent 1px);background-size:18px 18px}
.dsh-memory-brain-canvasWrap[data-dragging=true]{cursor:grabbing}
.dsh-memory-brain-canvas{display:block;width:100%;height:100%}
.dsh-memory-brain-canvasEmpty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px;overflow:auto;text-align:center;color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 74%,transparent)}
.dsh-memory-brain-emptyTitle{margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dsh-memory-brain-emptyBody{margin:0;max-width:46ch;font-size:13px;line-height:20px}
.dsh-memory-brain-spinner{width:20px;height:20px;margin-bottom:8px;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:dsh-memory-brain-spin .8s linear infinite}
.dsh-memory-brain-tooltip{position:absolute;z-index:2;max-width:240px;padding:6px 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px;box-shadow:0 6px 20px color-mix(in srgb,var(--dsw-alias-label-tertiary) 30%,transparent);pointer-events:none;transform:translate(-50%,calc(-100% - 10px))}
.dsh-memory-brain-tooltipTitle{font-weight:600;overflow-wrap:anywhere}
.dsh-memory-brain-tooltipMeta{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-memory-brain-travel{display:flex;flex:none;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:8px 12px;border-top:.5px solid var(--dsw-alias-border-l3)}
.dsh-memory-brain-travelLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-memory-brain-travelRange{flex:1 1 140px;min-width:110px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.dsh-memory-brain-travelRange:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-memory-brain-travelHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}
.dsh-memory-brain-detailHead{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.dsh-memory-brain-detailTitle{margin:0;font-size:14px;font-weight:600;line-height:20px;overflow-wrap:anywhere}
.dsh-memory-brain-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap}
.dsh-memory-brain-badge[data-tone=active]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsh-memory-brain-badge[data-tone=fading]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dsh-memory-brain-badge[data-tone=forgotten]{background:color-mix(in srgb,var(--dsw-alias-label-caption) 18%,transparent);color:var(--dsw-alias-label-tertiary)}
.dsh-memory-brain-badge[data-tone=pinned]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}
.dsh-memory-brain-excerpt{margin:8px 0 0;max-height:136px;padding:8px 10px;overflow:auto;border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-memory-brain-metaList{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin:8px 0 0;font-size:12px;line-height:18px}
.dsh-memory-brain-metaKey{color:var(--dsw-alias-label-caption);white-space:nowrap}
.dsh-memory-brain-metaVal{min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-memory-brain-tagEditor{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dsh-memory-brain-chipTag{display:inline-flex;align-items:center;gap:2px;padding:1px 4px 1px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-memory-brain-chipRemove{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:1;cursor:pointer;appearance:none}
.dsh-memory-brain-chipRemove:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}
.dsh-memory-brain-chipRemove:disabled{cursor:default;opacity:.4}
.dsh-memory-brain-chipRemove:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-memory-brain-curve{display:block;width:100%;height:auto;margin-top:6px;overflow:visible}
.dsh-memory-brain-ops{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.dsh-memory-brain-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:.5px solid transparent;border-radius:8px;font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;appearance:none;transition:background-color .12s,border-color .12s,color .12s,opacity .12s}
.dsh-memory-brain-btn:disabled{cursor:default;opacity:.45}
.dsh-memory-brain-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-memory-brain-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-memory-brain-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-memory-brain-btn-secondary{border-color:var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-memory-brain-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.dsh-memory-brain-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-btn-ghost[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-btn-danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
.dsh-memory-brain-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 84%,var(--dsw-alias-label-primary))}
.dsh-memory-brain-btn-dangerGhost{border-color:transparent;background:transparent;color:var(--dsw-alias-state-error-primary)}
.dsh-memory-brain-btn-dangerGhost:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.dsh-memory-brain-btn-small{height:26px;padding:0 8px;border-radius:7px;font-size:12px}
.dsh-memory-brain-linkBtn{padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:17px;cursor:pointer;appearance:none;border-radius:4px}
.dsh-memory-brain-linkBtn:hover{color:var(--dsw-alias-state-business-primary)}
.dsh-memory-brain-linkBtn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-memory-brain-settingsForm{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.dsh-memory-brain-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsh-memory-brain-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-memory-brain-presetRow{display:flex;flex-wrap:wrap;gap:6px;margin-top:-2px}
.dsh-memory-brain-presetBtn{box-sizing:border-box;height:24px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:22px;white-space:nowrap;cursor:pointer;appearance:none}
.dsh-memory-brain-presetBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-presetBtn[aria-pressed=true]{border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-presetBtn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-memory-brain-footNote{margin:10px 0 0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-caption)}
.dsh-memory-brain-page[data-fullscreen=on],.dsh-memory-brain-page:fullscreen{box-sizing:border-box;width:100vw;height:100vh;position:relative;overflow:hidden;background:var(--dsw-alias-bg-base)}
/* In-panel immersive fallback: the element is NOT in the browser fullscreen top
   layer, so 100vw/100vh would overflow the main panel; keep it inside the slot. */
.dsh-memory-brain-page[data-fullscreen=on]:not(:fullscreen){width:100%;height:100%}
.dsh-memory-brain-page[data-fullscreen=on] .dsh-memory-brain-header,.dsh-memory-brain-page:fullscreen .dsh-memory-brain-header{display:none}
.dsh-memory-brain-page[data-fullscreen=on] .dsh-memory-brain-left,.dsh-memory-brain-page:fullscreen .dsh-memory-brain-left{display:none}
.dsh-memory-brain-page[data-fullscreen=on] .dsh-memory-brain-right,.dsh-memory-brain-page:fullscreen .dsh-memory-brain-right{display:none}
.dsh-memory-brain-page[data-fullscreen=on] .dsh-memory-brain-travelBar,.dsh-memory-brain-page:fullscreen .dsh-memory-brain-travelBar{display:none}
.dsh-memory-brain-page[data-fullscreen=on] .dsh-memory-brain-canvasHead,.dsh-memory-brain-page:fullscreen .dsh-memory-brain-canvasHead{display:none}
.dsh-memory-brain-page[data-fullscreen=on] .dsh-memory-brain-body,.dsh-memory-brain-page:fullscreen .dsh-memory-brain-body{display:flex;flex:1;flex-direction:column;min-height:0;padding:0;overflow:hidden}
.dsh-memory-brain-page[data-fullscreen=on] .dsh-memory-brain-canvasCard,.dsh-memory-brain-page:fullscreen .dsh-memory-brain-canvasCard{flex:1;min-height:0;height:auto;border:0;border-radius:0}
.dsh-memory-brain-fullscreenBar{position:absolute;top:12px;right:12px;z-index:3;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;max-width:calc(100% - 24px);padding:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 88%,transparent);box-shadow:0 8px 28px color-mix(in srgb,var(--dsw-alias-label-tertiary) 26%,transparent);backdrop-filter:blur(6px)}
.dsh-memory-brain-fullscreenHint{position:absolute;left:12px;bottom:12px;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;max-width:calc(100% - 24px);padding:4px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 82%,transparent);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;pointer-events:none;backdrop-filter:blur(6px)}
.dsh-memory-brain-fullscreenHintNote{color:var(--dsw-alias-label-caption)}
.dsh-memory-brain-fullscreenDetail{position:absolute;top:56px;right:12px;z-index:2;display:flex;flex-direction:column;width:min(340px,42vw);max-height:min(72vh,720px);overflow:hidden;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 94%,transparent);box-shadow:0 14px 40px color-mix(in srgb,var(--dsw-alias-label-tertiary) 30%,transparent);backdrop-filter:blur(8px)}
.dsh-memory-brain-fullscreenDetailHead{display:flex;flex:none;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsh-memory-brain-fullscreenDetailTitle{margin:0;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-memory-brain-fullscreenDetailClose{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:16px;line-height:1;cursor:pointer;appearance:none}
.dsh-memory-brain-fullscreenDetailClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-fullscreenDetailClose:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-memory-brain-fullscreenDetailScroll{flex:1;min-height:0;padding:10px 12px;overflow:auto;scrollbar-gutter:stable}
@media (max-width:720px){.dsh-memory-brain-fullscreenDetail{top:96px;left:12px;width:auto;max-height:60vh}}
.dsh-memory-brain-task{display:flex;flex:1;flex-direction:column;width:100%;min-width:0;min-height:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;overflow:hidden}
.dsh-memory-brain-taskHeader{display:flex;flex:none;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsh-memory-brain-taskHeading{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;min-width:0}
.dsh-memory-brain-taskTitle{margin:0;font-size:14px;font-weight:600;line-height:20px}
.dsh-memory-brain-taskStats{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-memory-brain-taskActions{display:flex;flex:none;flex-wrap:wrap;gap:6px}
.dsh-memory-brain-taskBanner{display:flex;flex:none;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:8px 14px 0;padding:6px 10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 36%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dsh-memory-brain-taskBannerText{flex:1;min-width:0;overflow-wrap:anywhere}
.dsh-memory-brain-taskBody{display:flex;flex:1;min-height:0;gap:10px;padding:10px 14px 14px;overflow:hidden}
.dsh-memory-brain-taskMain{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;gap:10px;overflow:auto}
.dsh-memory-brain-taskCanvasCard{position:relative;flex:1 1 auto;min-height:260px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-memory-brain-taskListCard{flex:none;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-memory-brain-taskListHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-memory-brain-taskList{display:flex;flex-direction:column;gap:1px;margin:0;padding:4px;max-height:220px;overflow:auto;list-style:none}
.dsh-memory-brain-taskListItem{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:30px;margin:0;padding:4px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer;appearance:none}
.dsh-memory-brain-taskListItem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-taskListItem:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-memory-brain-taskListItem[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-taskListTurn{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;white-space:nowrap}
.dsh-memory-brain-taskListLabel{flex:none;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-memory-brain-taskListRetention{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}
.dsh-memory-brain-taskListExcerpt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.dsh-memory-brain-taskDetail{position:absolute;top:10px;right:10px;z-index:2;display:flex;flex-direction:column;width:min(320px,46%);max-height:calc(100% - 20px);overflow:hidden;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 94%,transparent);box-shadow:0 10px 30px color-mix(in srgb,var(--dsw-alias-label-tertiary) 26%,transparent);backdrop-filter:blur(8px)}
.dsh-memory-brain-taskDetailHead{display:flex;flex:none;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsh-memory-brain-taskDetailTitle{margin:0;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-memory-brain-taskDetailClose{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:16px;line-height:1;cursor:pointer;appearance:none}
.dsh-memory-brain-taskDetailClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-memory-brain-taskDetailClose:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-memory-brain-taskDetailScroll{flex:1;min-height:0;padding:8px 10px;overflow:auto;scrollbar-gutter:stable}
.dsh-memory-brain-taskEmpty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:240px;padding:24px;overflow:auto;text-align:center;color:var(--dsw-alias-label-tertiary)}
.dsh-memory-brain-taskEmptyTitle{margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dsh-memory-brain-taskEmptyBody{margin:0;max-width:46ch;font-size:13px;line-height:20px}
.dsh-memory-brain-taskEmptyActions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:10px}
.dsh-memory-brain-taskLoading{display:flex;flex:1;align-items:center;justify-content:center;gap:8px;min-height:200px;color:var(--dsw-alias-label-tertiary);font-size:13px}
@media (max-width:820px){
.dsh-memory-brain-taskBody{flex-direction:column;overflow-y:auto;overflow-x:hidden}
.dsh-memory-brain-taskMain{overflow:visible}
.dsh-memory-brain-taskDetail{top:8px;left:8px;right:8px;width:auto;max-height:70%}
}
@keyframes dsh-memory-brain-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-memory-brain-spinner{animation:none}}
@media (max-width:1120px){
.dsh-memory-brain-body{display:flex;flex-direction:column;overflow-x:hidden;overflow-y:auto}
.dsh-memory-brain-left,.dsh-memory-brain-right{overflow:visible;flex:none}
.dsh-memory-brain-scroll{overflow:visible}
.dsh-memory-brain-canvasCard{flex:none;height:520px}
.dsh-memory-brain-canvasWrap{min-height:420px}
}
`

    // ---------------------------------------------------------------------
    // Small utilities
    // ---------------------------------------------------------------------

    /**
     * Minimal observable snapshot store, same shape as the one shipped plugins
     * use: `getSnapshot()` plus `subscribe(listener)`.
     * @param {object} initial Initial snapshot.
     */
    function createSnapshotStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set: (next) => {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /**
     * Subscribe a component to a snapshot store.
     * @param {{ getSnapshot: () => any, subscribe: (listener: () => void) => () => void }} store
     * @returns {any} The current snapshot.
     */
    function useStore(store) {
      const [snapshot, setSnapshot] = React.useState(store.getSnapshot)
      React.useEffect(() => {
        let active = true
        const sync = () => {
          if (active) setSnapshot(store.getSnapshot())
        }
        const dispose = store.subscribe(sync)
        sync()
        return () => {
          active = false
          dispose()
        }
      }, [store])
      return snapshot
    }

    /**
     * One JSON round-trip against the Host half. Never throws: transport and
     * protocol failures both come back as `{ ok: false, message }`.
     * @param {string} path Route path.
     * @param {{ method?: string, body?: unknown }} [options]
     * @returns {Promise<{ ok: true, payload: any } | { ok: false, message: string }>}
     */
    async function requestJson(path, options) {
      const init = {
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
      }
      if (options !== undefined) {
        if (typeof options.method === 'string') init.method = options.method
        if (options.body !== undefined) init.body = JSON.stringify(options.body)
      }
      try {
        const response = await fetch(path, init)
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        if (response.ok && payload !== null && payload.ok === true) return { ok: true, payload }
        const message = payload !== null
          && typeof payload === 'object'
          && payload.error !== null
          && typeof payload.error === 'object'
          && typeof payload.error.message === 'string'
          && payload.error.message !== ''
          ? payload.error.message
          : `HTTP ${response.status}`
        return { ok: false, message }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }

    function isObject(value) {
      return value !== null && typeof value === 'object'
    }

    function num(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    function clamp(value, low, high) {
      const number = num(value, low)
      if (number < low) return low
      if (number > high) return high
      return number
    }

    function textOf(value, fallback) {
      return typeof value === 'string' ? value : (typeof fallback === 'string' ? fallback : '')
    }

    function stringList(value) {
      return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []
    }

    /** FNV-1a, 32-bit — mirrors the engine helper so client seeds are stable. */
    function hash32(input) {
      const source = typeof input === 'string' ? input : String(input === undefined || input === null ? '' : input)
      let hash = 0x811c9dc5
      for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
      }
      return hash >>> 0
    }

    /** Deterministic seed in [-1, 1] per axis, used when Host x0/y0 are absent. */
    function seedPosition(id) {
      return {
        x: (hash32(`${id}#x`) % 1000) / 500 - 1,
        y: (hash32(`${id}#y`) % 1000) / 500 - 1,
      }
    }

    function formatPercent(value) {
      return `${Math.round(clamp(num(value, 0), 0, 1) * 100)}%`
    }

    function formatNumber(value) {
      const number = num(value, 0)
      if (number >= 10) return String(Math.round(number))
      return String(Math.round(number * 10) / 10)
    }

    function formatAbsolute(timestamp) {
      if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
      try {
        return new Date(timestamp).toLocaleString()
      } catch {
        return '—'
      }
    }

    function formatRelative(timestamp, now, t) {
      if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
      const difference = Math.max(0, now - timestamp)
      const minutes = Math.floor(difference / 60000)
      if (minutes < 1) return t('time.justNow')
      if (minutes < 60) return t('time.minutesAgo', { count: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hoursAgo', { count: hours })
      const days = Math.floor(hours / 24)
      if (days < 30) return t('time.daysAgo', { count: days })
      return t('time.older', { count: Math.max(1, Math.floor(days / 30)) })
    }

    /**
     * Local projection used by time travel: pinned is always 1, an already
     * forgotten node is 0, otherwise the exponential forgetting curve is
     * evaluated at `now + offsetMs` (contract cross-section 4).
     */
    function projectRetention(node, now, offsetMs) {
      if (node.pinned) return 1
      if (node.state === 'forgotten') return 0
      if (!Number.isFinite(offsetMs) || offsetMs <= 0) return clamp(num(node.retention, 0), 0, 1)
      const stability = num(node.stabilityDays, 0) > 0 ? num(node.stabilityDays, 0) : 1
      const elapsed = Math.max(0, now + offsetMs - num(node.lastAccessAt, 0))
      return clamp(Math.exp(-elapsed / DAY_MS / stability), 0, 1)
    }

    /** Same curve, evaluated for the SVG chart (attribute-agnostic helper). */
    function retentionAt(node, at) {
      if (node.pinned) return 1
      if (node.state === 'forgotten') return 0
      const stability = num(node.stabilityDays, 0) > 0 ? num(node.stabilityDays, 0) : 1
      const elapsed = Math.max(0, num(at, 0) - num(node.lastAccessAt, 0))
      return clamp(Math.exp(-elapsed / DAY_MS / stability), 0, 1)
    }

    // ---------------------------------------------------------------------
    // Snapshot normalization — the panel never renders data it cannot reason
    // about: unknown shapes fall back, dangling edges are dropped.
    // ---------------------------------------------------------------------

    function normalizeNode(raw) {
      if (!isObject(raw)) return null
      const id = textOf(raw.id)
      if (id === '') return null
      const kind = raw.kind === 'semantic' ? 'semantic' : 'episode'
      const tags = stringList(raw.tags)
      const createdAt = num(raw.createdAt, 0)
      const lastAccessRaw = num(raw.lastAccessAt, createdAt)
      const lastAccessAt = lastAccessRaw > 0 ? lastAccessRaw : createdAt
      const stabilityDays = num(raw.stabilityDays, 0) > 0 ? num(raw.stabilityDays, 0) : 1
      const pinned = raw.pinned === true
      let state = raw.state === 'forgotten' || raw.state === 'fading' ? raw.state : 'active'
      if (pinned) state = 'active'
      const retentionRaw = num(raw.retention, NaN)
      const retention = Number.isFinite(retentionRaw)
        ? clamp(retentionRaw, 0, 1)
        : (state === 'forgotten' ? 0 : 1)
      const fallbackSeed = seedPosition(id)
      return {
        id,
        kind,
        label: textOf(raw.label) || tags[0] || (kind === 'semantic' ? '语义' : '记忆'),
        excerpt: textOf(raw.excerpt),
        tags,
        sessionId: textOf(raw.sessionId),
        sessionTitle: textOf(raw.sessionTitle),
        turn: clamp(num(raw.turn, 0), 0, 100000),
        createdAt,
        lastAccessAt,
        accessCount: clamp(num(raw.accessCount, 1), 0, 100000),
        stabilityDays,
        salience: clamp(num(raw.salience, 1), 0.5, 3),
        retention,
        state,
        pinned,
        consolidated: raw.consolidated === true,
        memberIds: kind === 'semantic' ? stringList(raw.memberIds) : [],
        x0: clamp(num(raw.x0, fallbackSeed.x), -1, 1),
        y0: clamp(num(raw.y0, fallbackSeed.y), -1, 1),
      }
    }

    function normalizeSnapshot(raw) {
      if (!isObject(raw)) return null
      if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null
      const nodes = []
      const byId = new Map()
      for (const item of raw.nodes) {
        const node = normalizeNode(item)
        if (node === null || byId.has(node.id)) continue
        byId.set(node.id, node)
        nodes.push(node)
      }
      const edges = []
      const edgeKeys = new Set()
      for (const item of raw.edges) {
        if (!isObject(item)) continue
        const source = textOf(item.source)
        const target = textOf(item.target)
        if (source === '' || target === '' || source === target) continue
        if (!byId.has(source) || !byId.has(target)) continue
        const type = item.type === 'session' || item.type === 'semantic' ? item.type : 'tag'
        const key = `${source}|${target}|${type}`
        if (edgeKeys.has(key)) continue
        edgeKeys.add(key)
        edges.push({
          id: textOf(item.id) || key,
          source,
          target,
          type,
          weight: clamp(num(item.weight, 1), 1, 12),
          tags: stringList(item.tags),
        })
      }
      const neighbors = new Map()
      for (const node of nodes) neighbors.set(node.id, new Set())
      for (const edge of edges) {
        const sourceNeighbors = neighbors.get(edge.source)
        const targetNeighbors = neighbors.get(edge.target)
        if (sourceNeighbors !== undefined) sourceNeighbors.add(edge.target)
        if (targetNeighbors !== undefined) targetNeighbors.add(edge.source)
      }
      const rawSettings = isObject(raw.settings) ? raw.settings : {}
      const settings = {
        forgetAfterDays: clamp(num(rawSettings.forgetAfterDays, 7), 1, 60),
        halfLifeDays: clamp(num(rawSettings.halfLifeDays, 3), 0.1, 60),
        baseStabilityDays: clamp(num(rawSettings.baseStabilityDays, 1.5), 0.1, 90),
        fadingThreshold: clamp(num(rawSettings.fadingThreshold, 0.35), 0, 1),
        forgetThreshold: clamp(num(rawSettings.forgetThreshold, 0.12), 0, 1),
        autoCapture: rawSettings.autoCapture !== false,
        maxMemories: clamp(num(rawSettings.maxMemories, 600), 10, 5000),
        consolidateEveryHours: clamp(num(rawSettings.consolidateEveryHours, 6), 1, 168),
      }
      const rawStats = isObject(raw.stats) ? raw.stats : {}
      const stats = {
        total: clamp(num(rawStats.total, nodes.length), 0, 1e9),
        active: clamp(num(rawStats.active, 0), 0, 1e9),
        fading: clamp(num(rawStats.fading, 0), 0, 1e9),
        forgotten: clamp(num(rawStats.forgotten, 0), 0, 1e9),
        pinned: clamp(num(rawStats.pinned, 0), 0, 1e9),
        semantic: clamp(num(rawStats.semantic, 0), 0, 1e9),
        episodes: clamp(num(rawStats.episodes, 0), 0, 1e9),
        sessions: clamp(num(rawStats.sessions, 0), 0, 1e9),
        tags: clamp(num(rawStats.tags, 0), 0, 1e9),
        avgRetention: clamp(num(rawStats.avgRetention, 0), 0, 1),
      }
      const tags = []
      if (Array.isArray(raw.tags)) {
        for (const item of raw.tags) {
          if (!isObject(item)) continue
          const tag = textOf(item.tag)
          if (tag === '') continue
          tags.push({ tag, count: clamp(num(item.count, 1), 1, 1e9) })
        }
      }
      tags.sort((left, right) => (right.count - left.count) || (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0))
      const sessions = []
      if (Array.isArray(raw.sessions)) {
        for (const item of raw.sessions) {
          if (!isObject(item)) continue
          const sessionId = textOf(item.sessionId)
          if (sessionId === '') continue
          sessions.push({
            sessionId,
            title: textOf(item.title),
            count: clamp(num(item.count, 0), 0, 1e9),
            activeCount: clamp(num(item.activeCount, 0), 0, 1e9),
            lastAt: num(item.lastAt, 0),
            topTags: stringList(item.topTags),
            // QQ-bridge sessions are tagged by the Host; older Hosts omit it.
            source: item.source === 'qq' ? 'qq' : '',
          })
        }
      }
      sessions.sort((left, right) => right.lastAt - left.lastAt)
      return {
        version: clamp(num(raw.version, 1), 1, 1000),
        revision: clamp(num(raw.revision, 0), 0, Number.MAX_SAFE_INTEGER),
        now: num(raw.now, Date.now()),
        settings,
        stats,
        tags,
        sessions,
        nodes,
        edges,
        byId,
        neighbors,
      }
    }

    /** Cheap stable signature of the graph topology, used to restart the sim. */
    function topologySignature(data) {
      if (data === null) return 'empty'
      let hash = 0x811c9dc5
      for (const node of data.nodes) {
        hash ^= hash32(node.id)
        hash = Math.imul(hash, 16777619) >>> 0
      }
      for (const edge of data.edges) {
        hash ^= hash32(`${edge.source}>${edge.target}|${edge.type}`)
        hash = Math.imul(hash, 16777619) >>> 0
      }
      return `${data.nodes.length}:${data.edges.length}:${hash >>> 0}`
    }

    function computeProjected(data, offsetMs) {
      const projected = new Map()
      if (data === null) return projected
      for (const node of data.nodes) projected.set(node.id, projectRetention(node, data.now, offsetMs))
      return projected
    }

    /** Filter predicate shared by the canvas, the counters, and hit testing. */
    function nodeMatchesFilters(node, filters) {
      if (node === null || node === undefined) return false
      if (node.state === 'forgotten' && filters.showForgotten !== true) return false
      if (filters.session !== null && filters.session !== undefined && node.sessionId !== filters.session) return false
      if (Array.isArray(filters.tags) && filters.tags.length > 0) {
        for (const tag of filters.tags) {
          if (node.tags.indexOf(tag) === -1) return false
        }
      }
      if (typeof filters.search === 'string' && filters.search.trim() !== '') {
        const needle = filters.search.trim().toLowerCase()
        const haystack = `${node.excerpt}\n${node.label}\n${node.tags.join(' ')}\n${node.sessionTitle}`.toLowerCase()
        if (haystack.indexOf(needle) === -1) return false
      }
      return true
    }

    // ---------------------------------------------------------------------
    // Task-scoped data (CONTRACT 9)
    // ---------------------------------------------------------------------

    const EMPTY_TASK_STATS = {
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
    }

    /** Default filters for the task-scoped canvas (no session/search filter). */
    const TASK_DEFAULT_FILTERS = { session: null, tags: [], search: '', showForgotten: false }

    /**
     * Scope the full snapshot to one task (CONTRACT 9.2): that task's episodes
     * plus semantic memories whose members intersect them, and every edge whose
     * both ends survive. Returns a normalizeSnapshot-compatible object with
     * derived byId/neighbors and task-scoped stats. Never throws.
     * @param {any} fullData Normalized full snapshot (or anything).
     * @param {any} sessionId Target task/session id.
     * @returns {any}
     */
    function buildTaskScopedData(fullData, sessionId) {
      const full = isObject(fullData) ? fullData : {}
      const targetId = typeof sessionId === 'string' ? sessionId : ''
      const empty = {
        ...full,
        nodes: [],
        edges: [],
        byId: new Map(),
        neighbors: new Map(),
        stats: { ...EMPTY_TASK_STATS },
      }
      if (targetId === '' || !Array.isArray(full.nodes) || !Array.isArray(full.edges)) return empty
      const episodeIds = new Set()
      for (const node of full.nodes) {
        if (!isObject(node) || node.kind !== 'episode' || typeof node.id !== 'string') continue
        if (node.sessionId === targetId) episodeIds.add(node.id)
      }
      const nodes = []
      for (const node of full.nodes) {
        if (!isObject(node) || typeof node.id !== 'string') continue
        if (node.kind === 'episode') {
          if (episodeIds.has(node.id)) nodes.push(node)
        } else if (node.kind === 'semantic' && Array.isArray(node.memberIds)) {
          for (const memberId of node.memberIds) {
            if (episodeIds.has(memberId)) {
              nodes.push(node)
              break
            }
          }
        }
      }
      const scopedIds = new Set(nodes.map((node) => node.id))
      const edges = []
      for (const edge of full.edges) {
        if (!isObject(edge) || typeof edge.source !== 'string' || typeof edge.target !== 'string') continue
        if (!scopedIds.has(edge.source) || !scopedIds.has(edge.target)) continue
        edges.push(edge)
      }
      const byId = new Map()
      const neighbors = new Map()
      for (const node of nodes) {
        byId.set(node.id, node)
        neighbors.set(node.id, new Set())
      }
      for (const edge of edges) {
        neighbors.get(edge.source).add(edge.target)
        neighbors.get(edge.target).add(edge.source)
      }
      let active = 0
      let fading = 0
      let forgotten = 0
      let pinned = 0
      let semantic = 0
      let episodes = 0
      let retentionSum = 0
      let retentionCount = 0
      const tagSet = new Set()
      for (const node of nodes) {
        if (node.state === 'forgotten') forgotten += 1
        else if (node.state === 'fading') fading += 1
        else active += 1
        if (node.pinned === true) pinned += 1
        if (node.kind === 'semantic') semantic += 1
        else episodes += 1
        if (Array.isArray(node.tags)) {
          for (const tag of node.tags) {
            if (typeof tag === 'string' && tag !== '') tagSet.add(tag)
          }
        }
        if (node.state !== 'forgotten') {
          retentionSum += clamp(num(node.retention, 0), 0, 1)
          retentionCount += 1
        }
      }
      const stats = {
        total: nodes.length,
        active,
        fading,
        forgotten,
        pinned,
        semantic,
        episodes,
        sessions: episodes > 0 ? 1 : 0,
        tags: tagSet.size,
        avgRetention: retentionCount > 0 ? Math.round((retentionSum / retentionCount) * 1000) / 1000 : 0,
      }
      return { ...full, nodes, edges, byId, neighbors, stats }
    }

    // ---------------------------------------------------------------------
    // Canvas helpers
    // ---------------------------------------------------------------------

    /** Width/height radius of a node in world units (salience + retention). */
    function nodeBaseRadius(node, retention) {
      const salience = clamp(num(node.salience, 1), 0.5, 3)
      const kept = clamp(num(retention, 0), 0, 1)
      let radius = 6.5 + 3.4 * Math.sqrt(salience) + 6 * kept
      if (node.kind === 'semantic') radius *= 1.18
      return radius
    }

    function nodeScreenRadius(node, retention, scale) {
      return Math.max(2.5, nodeBaseRadius(node, retention) * clamp(scale, 0.55, 1.6))
    }

    function sessionHue(sessionId) {
      return hash32(typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'unknown') % 360
    }

    function projectPoint(position, view, width, height) {
      return {
        x: (position.x - view.center.x) * view.scale + width / 2,
        y: (position.y - view.center.y) * view.scale + height / 2,
      }
    }

    function unprojectPoint(x, y, view, width, height) {
      return {
        x: view.center.x + (x - width / 2) / view.scale,
        y: view.center.y + (y - height / 2) / view.scale,
      }
    }

    function shortLabel(value) {
      const text = typeof value === 'string' && value !== '' ? value : '·'
      return text.length > 10 ? `${text.slice(0, 9)}…` : text
    }

    function drawStarMark(context, centerX, centerY, radius, color, alpha) {
      context.save()
      context.globalAlpha = clamp(alpha, 0, 1) * 0.95
      context.fillStyle = color
      context.beginPath()
      for (let index = 0; index < 10; index += 1) {
        const angle = (Math.PI / 5) * index - Math.PI / 2
        const length = index % 2 === 0 ? radius : radius * 0.46
        const x = centerX + Math.cos(angle) * length
        const y = centerY + Math.sin(angle) * length
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      }
      context.closePath()
      context.fill()
      context.restore()
    }

    /** Theme tokens for the canvas; cached briefly so theme flips catch up. */
    const FALLBACK_TOKENS = {
      'label-primary': '#1f2328',
      'label-secondary': '#4b5563',
      'label-tertiary': '#6b7280',
      'label-caption': '#9ca3af',
      'border-l2': '#e5e7eb',
      'border-l3': '#d1d5db',
      'state-business-primary': '#3b82f6',
      'state-warn-primary': '#d97706',
      'state-success-primary': '#16a34a',
      'bg-base': '#ffffff',
      'bg-layer-1': '#f9fafb',
      'bg-overlay': '#ffffff',
    }
    const TOKEN_NAMES = Object.keys(FALLBACK_TOKENS)

    function readTokens(element, tokensRef) {
      const timestamp = Date.now()
      const cached = tokensRef.current
      if (cached !== null && timestamp - cached.at < 1500) return cached.colors
      const colors = {}
      try {
        const computed = window.getComputedStyle(element)
        for (const name of TOKEN_NAMES) {
          const value = computed.getPropertyValue(`--dsw-alias-${name}`).trim()
          colors[name] = value !== '' ? value : FALLBACK_TOKENS[name]
        }
      } catch {
        for (const name of TOKEN_NAMES) colors[name] = FALLBACK_TOKENS[name]
      }
      tokensRef.current = { at: timestamp, colors }
      return colors
    }

    function drawScene(context, options) {
      const width = options.width
      const height = options.height
      const props = options.props
      const positions = options.positions
      const view = options.view
      const hoverId = options.hoverId
      const data = props.data

      const ratio = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1))
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      if (data === null || data.nodes.length === 0) return

      const colors = readTokens(options.wrap, options.tokensRef)
      const filters = props.filters
      const projected = props.projected
      const selectedId = props.selectedId
      const neighbors = selectedId !== null && data.neighbors.has(selectedId) ? data.neighbors.get(selectedId) : null
      const scale = view.scale

      const isVisible = (id) => {
        const node = data.byId.get(id)
        return node !== undefined && nodeMatchesFilters(node, filters)
      }

      // --- edges -------------------------------------------------------
      for (const edge of data.edges) {
        if (!isVisible(edge.source) || !isVisible(edge.target)) continue
        const sourcePosition = positions.get(edge.source)
        const targetPosition = positions.get(edge.target)
        if (sourcePosition === undefined || targetPosition === undefined) continue
        const sourcePoint = projectPoint(sourcePosition, view, width, height)
        const targetPoint = projectPoint(targetPosition, view, width, height)
        if (sourcePoint.x < -60 && targetPoint.x < -60) continue
        if (sourcePoint.x > width + 60 && targetPoint.x > width + 60) continue
        if (sourcePoint.y < -60 && targetPoint.y < -60) continue
        if (sourcePoint.y > height + 60 && targetPoint.y > height + 60) continue
        const related = selectedId !== null && (edge.source === selectedId || edge.target === selectedId)
        context.beginPath()
        context.moveTo(sourcePoint.x, sourcePoint.y)
        context.lineTo(targetPoint.x, targetPoint.y)
        if (edge.type === 'session') {
          context.setLineDash([3, 3])
          context.strokeStyle = colors['label-tertiary']
          context.globalAlpha = related ? 0.55 : 0.18
          context.lineWidth = 1
        } else if (edge.type === 'semantic') {
          context.setLineDash([])
          context.strokeStyle = colors['state-business-primary']
          context.globalAlpha = related ? 0.65 : 0.28
          context.lineWidth = related ? 1.6 : 1.05
        } else {
          context.setLineDash([])
          context.strokeStyle = colors['label-tertiary']
          const weight = clamp(edge.weight, 1, 4)
          context.globalAlpha = (related ? 0.5 : 0.16) + weight * 0.045
          context.lineWidth = related ? 1.8 : 0.6 + weight * 0.26
        }
        context.stroke()
      }
      context.setLineDash([])
      context.globalAlpha = 1

      // --- nodes -------------------------------------------------------
      for (const node of data.nodes) {
        if (!nodeMatchesFilters(node, filters)) continue
        const position = positions.get(node.id)
        if (position === undefined) continue
        const point = projectPoint(position, view, width, height)
        const retention = projected.has(node.id) ? projected.get(node.id) : node.retention
        const radius = nodeScreenRadius(node, retention, scale)
        const margin = radius + 90
        if (point.x < -margin || point.x > width + margin) continue
        if (point.y < -margin || point.y > height + margin) continue
        const hue = sessionHue(node.sessionId === '' ? node.id : node.sessionId)
        const selected = node.id === selectedId
        const hovered = node.id === hoverId
        let alpha = 1
        let fill = `hsla(${hue},58%,55%,.30)`
        let stroke = `hsla(${hue},58%,50%,.95)`
        let dashed = false
        if (node.state === 'fading') {
          alpha = 0.62
          dashed = true
        }
        if (node.state === 'forgotten') {
          fill = 'hsla(220,7%,50%,.14)'
          stroke = 'hsla(220,7%,52%,.75)'
          dashed = true
          alpha = 0.5
        }
        if (node.state !== 'forgotten' && !node.pinned && retention < 0.4) {
          alpha *= clamp(0.45 + retention, 0.5, 1)
        }
        if (neighbors !== null && !selected && !neighbors.has(node.id)) alpha *= 0.2
        if (hovered) alpha = Math.min(1, alpha + 0.18)
        context.globalAlpha = alpha
        context.lineWidth = selected ? 2.6 : hovered ? 2 : 1.5
        context.setLineDash(dashed ? [3, 3] : [])
        context.beginPath()
        if (node.kind === 'semantic') {
          context.moveTo(point.x, point.y - radius)
          context.lineTo(point.x + radius, point.y)
          context.lineTo(point.x, point.y + radius)
          context.lineTo(point.x - radius, point.y)
          context.closePath()
        } else {
          context.arc(point.x, point.y, radius, 0, Math.PI * 2)
        }
        context.fillStyle = fill
        context.fill()
        context.strokeStyle = selected ? colors['state-business-primary'] : stroke
        context.stroke()
        context.setLineDash([])
        if (node.pinned) {
          context.beginPath()
          context.arc(point.x, point.y, radius + 3.5, 0, Math.PI * 2)
          context.globalAlpha = alpha * 0.85
          context.strokeStyle = colors['state-warn-primary']
          context.lineWidth = 1.1
          context.setLineDash([2, 3])
          context.stroke()
          context.setLineDash([])
          drawStarMark(
            context,
            point.x + radius * 0.82,
            point.y - radius * 0.82,
            Math.max(2.4, radius * 0.3),
            colors['state-warn-primary'],
            alpha,
          )
        }
        if (selected || hovered || (scale >= 0.75 && radius >= 8) || node.kind === 'semantic') {
          context.globalAlpha = Math.min(1, alpha + 0.25)
          context.fillStyle = colors['label-secondary']
          context.font = '11px ui-sans-serif, system-ui, -apple-system, sans-serif'
          context.textAlign = 'center'
          context.textBaseline = 'top'
          context.fillText(shortLabel(node.label), point.x, point.y + radius + 4)
        }
      }
      context.globalAlpha = 1
    }

    /** One force-simulation tick: repulsion + collision + springs + gravity. */
    function simulateStep(sim) {
      const items = sim.items
      const total = items.length
      if (total === 0) {
        sim.temperature = 0
        return 0
      }
      for (const item of items) {
        item.dx = 0
        item.dy = 0
      }
      const sampled = total > 300
      const sampleSize = sampled ? Math.min(total - 1, MAX_REPULSION_SAMPLE) : total - 1
      const repulsionScale = sampled ? (total - 1) / Math.max(1, sampleSize) : 1
      const idealSquared = IDEAL_DISTANCE * IDEAL_DISTANCE
      for (let index = 0; index < total; index += 1) {
        const itemA = items[index]
        const positionA = itemA.pos
        for (let step = 1; step <= sampleSize; step += 1) {
          const otherIndex = sampled ? (index + step) % total : index + step
          const itemB = items[otherIndex]
          if (itemB === undefined || itemB === itemA) continue
          const positionB = itemB.pos
          let dx = positionA.x - positionB.x
          let dy = positionA.y - positionB.y
          let distanceSquared = dx * dx + dy * dy
          if (distanceSquared < 0.0001) {
            dx = ((index * 37 + step * 11) % 13) / 13 - 0.5
            dy = ((index * 53 + step * 7) % 11) / 11 - 0.5
            distanceSquared = dx * dx + dy * dy
            if (distanceSquared < 0.0001) {
              dx = 0.5
              dy = 0.5
              distanceSquared = 0.5
            }
          }
          const distance = Math.sqrt(distanceSquared)
          const normalX = dx / distance
          const normalY = dy / distance
          const repulsion = (idealSquared / distance) * repulsionScale
          itemA.dx += normalX * repulsion
          itemA.dy += normalY * repulsion
          const minimumDistance = itemA.radius + itemB.radius + 5
          if (distance < minimumDistance) {
            const push = (minimumDistance - distance) * 0.9 * repulsionScale
            itemA.dx += normalX * push
            itemA.dy += normalY * push
          }
        }
      }
      for (const edge of sim.edges) {
        const itemA = edge.a
        const itemB = edge.b
        let dx = itemA.pos.x - itemB.pos.x
        let dy = itemA.pos.y - itemB.pos.y
        let distance = Math.sqrt(dx * dx + dy * dy)
        if (distance < 0.01) {
          dx = 0.01
          dy = 0.01
          distance = 0.014
        }
        const attraction = ((distance * distance) / IDEAL_DISTANCE) * edge.stiffness
        const forceX = (dx / distance) * attraction
        const forceY = (dy / distance) * attraction
        itemA.dx -= forceX
        itemA.dy -= forceY
        itemB.dx += forceX
        itemB.dy += forceY
      }
      for (const item of items) {
        item.dx += -item.pos.x * GRAVITY
        item.dy += -item.pos.y * GRAVITY
      }
      const temperature = sim.temperature
      let maxDisplacement = 0
      for (const item of items) {
        if (item.id === sim.dragId) continue
        const dx = item.dx
        const dy = item.dy
        const distance = Math.sqrt(dx * dx + dy * dy)
        if (distance < 0.0001) continue
        const limited = Math.min(distance, temperature)
        item.pos.x += (dx / distance) * limited
        item.pos.y += (dy / distance) * limited
        if (item.pos.x > WORLD_BOUND) item.pos.x = WORLD_BOUND
        if (item.pos.x < -WORLD_BOUND) item.pos.x = -WORLD_BOUND
        if (item.pos.y > WORLD_BOUND) item.pos.y = WORLD_BOUND
        if (item.pos.y < -WORLD_BOUND) item.pos.y = -WORLD_BOUND
        if (limited > maxDisplacement) maxDisplacement = limited
      }
      sim.temperature = Math.max(0.35, temperature * 0.985)
      return maxDisplacement
    }

    function edgeStiffness(edge) {
      if (edge.type === 'session') return 0.06
      if (edge.type === 'semantic') return 0.12
      return 0.15 * (1 + 0.22 * (clamp(num(edge.weight, 1), 1, 4) - 1))
    }

    // ---------------------------------------------------------------------
    // 3D view (CONTRACT 7) — orbit camera, 3D force layout, labelled nodes.
    // The 2D path above stays untouched; this section is additive.
    // ---------------------------------------------------------------------

    const SEED_RADIUS_3D = 430
    const IDEAL_DISTANCE_3D = 96
    const GRAVITY_3D = 0.006
    const WORLD_BOUND_3D = 2600
    const DEFAULT_YAW = -0.55
    const DEFAULT_PITCH = 0.34
    const PITCH_LIMIT = 1.25
    const DISTANCE_MIN = 260
    const DISTANCE_MAX = 8000
    const AUTO_ROTATE_STEP = 0.0015
    const INTERACTION_PAUSE_MS = 2000
    const STAR_COUNT = 96
    const LABEL_MAX_CHARS = 16
    const TASK_NAME_MAX_CHARS = 8

    /** Character-safe truncation with the contract's ellipsis. */
    function truncateDisplayName(value, maxChars) {
      const text = typeof value === 'string' ? value.trim() : ''
      const chars = Array.from(text)
      return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text
    }

    /** First `count` characters (code points) of a string. */
    function firstChars(value, count) {
      const text = typeof value === 'string' ? value.trim() : ''
      return Array.from(text).slice(0, count).join('')
    }

    /**
     * A memory whose readable content was deleted when it reached the forgetting
     * time (CONTRACT 11): the episode keeps only structural metadata, so it has
     * no excerpt, no tags and no task title left.
     * @param {any} node Normalized memory node.
     * @returns {boolean}
     */
    function isTombstoneNode(node) {
      if (!isObject(node) || node.kind !== 'episode') return false
      if (typeof node.excerpt === 'string' && node.excerpt !== '') return false
      const tags = Array.isArray(node.tags) ? node.tags : []
      const title = typeof node.sessionTitle === 'string' ? node.sessionTitle : ''
      return tags.length === 0 && title === ''
    }

    /**
     * Name of a node in the 3D view (CONTRACT 7.5): semantic uses its label;
     * an episode uses "short task · turn" when it has a task title, otherwise
     * the first tag / label / excerpt prefix. Always capped at 16 characters.
     * @param {any} node Normalized memory node.
     * @param {(key: string, params?: object) => string} [t] Optional translator
     *        for the turn suffix ("第N轮" / "turn N").
     * @returns {string}
     */
    function nodeDisplayName(node, t) {
      if (!isObject(node)) return '·'
      if (node.kind === 'semantic') return truncateDisplayName(node.label, LABEL_MAX_CHARS) || '·'
      if (isTombstoneNode(node)) {
        const label = typeof t === 'function' ? t('tombstone.label') : '已遗忘'
        return truncateDisplayName(label, LABEL_MAX_CHARS) || '·'
      }
      const title = typeof node.sessionTitle === 'string' ? node.sessionTitle.trim() : ''
      if (title !== '') {
        const turn = Math.max(0, Math.round(num(node.turn, 0)))
        const suffix = typeof t === 'function' ? t('canvas.turnSuffix', { turn }) : `第${turn}轮`
        return truncateDisplayName(`${firstChars(title, TASK_NAME_MAX_CHARS)}·${suffix}`, LABEL_MAX_CHARS) || '·'
      }
      const tags = stringList(node.tags)
      const fallback = tags[0] || node.label || firstChars(node.excerpt, TASK_NAME_MAX_CHARS) || '·'
      return truncateDisplayName(fallback, LABEL_MAX_CHARS) || '·'
    }

    /**
     * Deterministic 3D seed: seedPosition() is mapped onto a sphere and the
     * hashed radial jitter keeps z off a single layout plane.
     * @param {string} id Node id.
     * @returns {{ x: number, y: number, z: number }}
     */
    function seedPosition3d(id) {
      const seed = seedPosition(id)
      const theta = clamp(seed.x, -1, 1) * Math.PI
      const z = clamp(seed.y, -1, 1)
      const ring = Math.sqrt(Math.max(0, 1 - z * z))
      const radial = 0.55 + 0.45 * ((hash32(`${id}|r3d`) % 1000) / 1000)
      return {
        x: Math.cos(theta) * ring * SEED_RADIUS_3D * radial,
        y: Math.sin(theta) * ring * SEED_RADIUS_3D * radial,
        z: z * SEED_RADIUS_3D * radial,
      }
    }

    /**
     * Camera distance auto-fitted to the layout radius (CONTRACT 7.2):
     * max(900, 2.4 * radius), clamped to 260–8000.
     * @param {Map<string, {x: number, y: number, z: number}>} positions
     */
    function autoCameraDistance(positions) {
      let radiusSquared = 0
      for (const point of positions.values()) {
        const distanceSquared = point.x * point.x + point.y * point.y + point.z * point.z
        if (distanceSquared > radiusSquared) radiusSquared = distanceSquared
      }
      return clamp(Math.max(900, 2.4 * Math.sqrt(radiusSquared)), DISTANCE_MIN, DISTANCE_MAX)
    }

    /**
     * Perspective orbit-camera projection (CONTRACT 7.2). Returns null for a
     * point at/behind the camera (zCamera <= 1) and never produces NaN for
     * finite or malformed input.
     * @param {{x: number, y: number, z: number}} point World point.
     * @param {{yaw: number, pitch: number, distance: number}} camera
     * @param {number} width CSS pixel width.
     * @param {number} height CSS pixel height.
     * @returns {{ x: number, y: number, zCamera: number, scale: number, depthScale: number } | null}
     */
    function projectCamera(point, camera, width, height) {
      if (!(width > 0) || !(height > 0)) return null
      const safePoint = isObject(point) ? point : {}
      const safeCamera = isObject(camera) ? camera : {}
      const x = num(safePoint.x, 0)
      const y = num(safePoint.y, 0)
      const z = num(safePoint.z, 0)
      const yaw = num(safeCamera.yaw, DEFAULT_YAW)
      const pitch = clamp(num(safeCamera.pitch, DEFAULT_PITCH), -PITCH_LIMIT, PITCH_LIMIT)
      const distance = clamp(num(safeCamera.distance, 1200), DISTANCE_MIN, DISTANCE_MAX)
      const cosYaw = Math.cos(yaw)
      const sinYaw = Math.sin(yaw)
      const xRotated = x * cosYaw - z * sinYaw
      const zRotated = x * sinYaw + z * cosYaw
      const cosPitch = Math.cos(pitch)
      const sinPitch = Math.sin(pitch)
      const yRotated = y * cosPitch - zRotated * sinPitch
      const zCamera = y * sinPitch + zRotated * cosPitch + distance
      if (!(zCamera > 1)) return null
      const focal = 0.9 * Math.min(width, height)
      return {
        x: width / 2 + (xRotated * focal) / zCamera,
        y: height / 2 - (yRotated * focal) / zCamera,
        zCamera,
        scale: focal / zCamera,
        depthScale: distance / zCamera,
      }
    }

    /**
     * World-space right/up vectors of the orbit camera, used to drag a node in
     * the plane that faces the camera (CONTRACT 7.4).
     * @param {number} yaw
     * @param {number} pitch
     */
    function cameraBasis(yaw, pitch) {
      const cosYaw = Math.cos(num(yaw, DEFAULT_YAW))
      const sinYaw = Math.sin(num(yaw, DEFAULT_YAW))
      const cosPitch = Math.cos(clamp(num(pitch, DEFAULT_PITCH), -PITCH_LIMIT, PITCH_LIMIT))
      const sinPitch = Math.sin(clamp(num(pitch, DEFAULT_PITCH), -PITCH_LIMIT, PITCH_LIMIT))
      return {
        right: { x: cosYaw, y: 0, z: -sinYaw },
        up: { x: -sinPitch * sinYaw, y: cosPitch, z: -sinPitch * cosYaw },
      }
    }

    /** Depth factor for edges/nodes: 1.0 near → 0.18 far (CONTRACT 7.2). */
    function depthFactor(zCamera, distance) {
      const safeDistance = Math.max(1, num(distance, 1200))
      return clamp(1 - (num(zCamera, safeDistance) - safeDistance) / safeDistance, 0.18, 1)
    }

    /** Label depth alpha: clamp(0.25, 1 - (zCam - distance)/distance, 0.95). */
    function labelDepthAlpha(zCamera, distance) {
      const safeDistance = Math.max(1, num(distance, 1200))
      return clamp(1 - (num(zCamera, safeDistance) - safeDistance) / safeDistance, 0.25, 0.95)
    }

    /**
     * One 3D force-simulation tick: repulsion + collision + 3D springs +
     * gravity, mirroring the 2D simulation with a z axis (CONTRACT 7.3).
     * @param {{ items: any[], edges: any[], temperature: number, dragId: string | null }} sim
     * @returns {number} Largest displacement applied this tick.
     */
    function simulateStep3D(sim) {
      const items = sim.items
      const total = items.length
      if (total === 0) {
        sim.temperature = 0
        return 0
      }
      for (const item of items) {
        item.dx = 0
        item.dy = 0
        item.dz = 0
      }
      const sampled = total > 300
      const sampleSize = sampled ? Math.min(total - 1, MAX_REPULSION_SAMPLE) : total - 1
      const repulsionScale = sampled ? (total - 1) / Math.max(1, sampleSize) : 1
      const idealSquared = IDEAL_DISTANCE_3D * IDEAL_DISTANCE_3D
      for (let index = 0; index < total; index += 1) {
        const itemA = items[index]
        const positionA = itemA.pos
        for (let step = 1; step <= sampleSize; step += 1) {
          const otherIndex = sampled ? (index + step) % total : index + step
          const itemB = items[otherIndex]
          if (itemB === undefined || itemB === itemA) continue
          const positionB = itemB.pos
          let dx = positionA.x - positionB.x
          let dy = positionA.y - positionB.y
          let dz = positionA.z - positionB.z
          let distanceSquared = dx * dx + dy * dy + dz * dz
          if (distanceSquared < 0.0001) {
            dx = ((index * 37 + step * 11) % 13) / 13 - 0.5
            dy = ((index * 53 + step * 7) % 11) / 11 - 0.5
            dz = ((index * 29 + step * 5) % 17) / 17 - 0.5
            distanceSquared = dx * dx + dy * dy + dz * dz
            if (distanceSquared < 0.0001) {
              dx = 0.5
              dy = 0.5
              dz = 0.5
              distanceSquared = 0.75
            }
          }
          const distance = Math.sqrt(distanceSquared)
          const normalX = dx / distance
          const normalY = dy / distance
          const normalZ = dz / distance
          const repulsion = (idealSquared / distance) * repulsionScale
          itemA.dx += normalX * repulsion
          itemA.dy += normalY * repulsion
          itemA.dz += normalZ * repulsion
          const minimumDistance = itemA.radius + itemB.radius + 5
          if (distance < minimumDistance) {
            const push = (minimumDistance - distance) * 0.9 * repulsionScale
            itemA.dx += normalX * push
            itemA.dy += normalY * push
            itemA.dz += normalZ * push
          }
        }
      }
      for (const edge of sim.edges) {
        const itemA = edge.a
        const itemB = edge.b
        let dx = itemA.pos.x - itemB.pos.x
        let dy = itemA.pos.y - itemB.pos.y
        let dz = itemA.pos.z - itemB.pos.z
        let distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (distance < 0.01) {
          dx = 0.01
          dy = 0.01
          dz = 0.01
          distance = 0.017
        }
        const attraction = ((distance * distance) / IDEAL_DISTANCE_3D) * edge.stiffness
        const forceX = (dx / distance) * attraction
        const forceY = (dy / distance) * attraction
        const forceZ = (dz / distance) * attraction
        itemA.dx -= forceX
        itemA.dy -= forceY
        itemA.dz -= forceZ
        itemB.dx += forceX
        itemB.dy += forceY
        itemB.dz += forceZ
      }
      for (const item of items) {
        item.dx += -item.pos.x * GRAVITY_3D
        item.dy += -item.pos.y * GRAVITY_3D
        item.dz += -item.pos.z * GRAVITY_3D
      }
      const temperature = sim.temperature
      let maxDisplacement = 0
      for (const item of items) {
        if (item.id === sim.dragId) continue
        const dx = item.dx
        const dy = item.dy
        const dz = item.dz
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (distance < 0.0001) continue
        const limited = Math.min(distance, temperature)
        item.pos.x += (dx / distance) * limited
        item.pos.y += (dy / distance) * limited
        item.pos.z += (dz / distance) * limited
        if (item.pos.x > WORLD_BOUND_3D) item.pos.x = WORLD_BOUND_3D
        if (item.pos.x < -WORLD_BOUND_3D) item.pos.x = -WORLD_BOUND_3D
        if (item.pos.y > WORLD_BOUND_3D) item.pos.y = WORLD_BOUND_3D
        if (item.pos.y < -WORLD_BOUND_3D) item.pos.y = -WORLD_BOUND_3D
        if (item.pos.z > WORLD_BOUND_3D) item.pos.z = WORLD_BOUND_3D
        if (item.pos.z < -WORLD_BOUND_3D) item.pos.z = -WORLD_BOUND_3D
        if (limited > maxDisplacement) maxDisplacement = limited
      }
      sim.temperature = Math.max(0.35, temperature * 0.985)
      return maxDisplacement
    }

    /** Axis-aligned label-box intersection test used by the de-overlap pass. */
    function labelsOverlap(box, placed) {
      for (const other of placed) {
        if (box.x < other.x + other.width + 1
          && box.x + box.width + 1 > other.x
          && box.y < other.y + other.height + 1
          && box.y + box.height + 1 > other.y) return true
      }
      return false
    }

    /** Rounded-rectangle path helper (avoids relying on ctx.roundRect). */
    function roundedRectPath(context, x, y, width, height, radius) {
      const r = Math.max(0, Math.min(radius, width / 2, height / 2))
      context.beginPath()
      context.moveTo(x + r, y)
      context.lineTo(x + width - r, y)
      context.arcTo(x + width, y, x + width, y + r, r)
      context.lineTo(x + width, y + height - r)
      context.arcTo(x + width, y + height, x + width - r, y + height, r)
      context.lineTo(x + r, y + height)
      context.arcTo(x, y + height, x, y + height - r, r)
      context.lineTo(x, y + r)
      context.arcTo(x, y, x + r, y, r)
      context.closePath()
    }

    /** measureText cache keyed by text + font (CONTRACT 7.5). */
    const LABEL_MEASURE_CACHE = new Map()
    function measureLabelWidth(context, text, font) {
      const key = `${font}|${text}`
      const cached = LABEL_MEASURE_CACHE.get(key)
      if (typeof cached === 'number') return cached
      let width = 0
      try {
        context.font = font
        width = context.measureText(text).width
      } catch {
        width = 0
      }
      if (!Number.isFinite(width) || width <= 0) width = Math.max(1, Array.from(text).length) * 6
      if (LABEL_MEASURE_CACHE.size >= 800) LABEL_MEASURE_CACHE.clear()
      LABEL_MEASURE_CACHE.set(key, width)
      return width
    }

    /** Fixed-seed world-space star snippets for the faint depth texture. */
    const STAR_FIELD = (() => {
      const stars = []
      for (let index = 0; index < STAR_COUNT; index += 1) {
        const seed = seedPosition(`mb-star-${index}`)
        const z = clamp(seed.y, -1, 1)
        const ring = Math.sqrt(Math.max(0, 1 - z * z))
        const theta = clamp(seed.x, -1, 1) * Math.PI
        const radius = 2400 + ((hash32(`mb-star-r-${index}`) % 1000) / 1000) * 900
        stars.push({ x: Math.cos(theta) * ring * radius, y: Math.sin(theta) * ring * radius, z: z * radius })
      }
      return stars
    })()

    /**
     * Draw the 3D memory network (CONTRACT 7.2–7.5): background, depth stars,
     * distance-sorted edges, distance-sorted nodes, then one label per visible
     * node (labels are never dropped; collisions fall back to alpha 0.45).
     * @returns {{ visibleNodes: number, labelsDrawn: number }} Draw counters.
     */
    function drawScene3D(context, options) {
      const width = options.width
      const height = options.height
      const props = options.props
      const positions = options.positions
      const camera = options.camera
      const hoverId = options.hoverId
      const data = props.data
      const ratio = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1))
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      if (!(width > 0) || !(height > 0)) return { visibleNodes: 0, labelsDrawn: 0 }
      const colors = readTokens(options.wrap, options.tokensRef)
      // Background: bg-base + a soft token-colour radial glow (no literals).
      context.fillStyle = colors['bg-base']
      context.fillRect(0, 0, width, height)
      const glow = context.createRadialGradient(
        width / 2,
        height * 0.45,
        0,
        width / 2,
        height * 0.45,
        Math.max(width, height) * 0.72,
      )
      glow.addColorStop(0, colors['state-business-primary'])
      glow.addColorStop(1, 'transparent')
      context.globalAlpha = 0.06
      context.fillStyle = glow
      context.fillRect(0, 0, width, height)
      context.globalAlpha = 1
      // Faint fixed-seed depth stars.
      context.fillStyle = colors['label-caption']
      for (const star of STAR_FIELD) {
        const starPoint = projectCamera(star, camera, width, height)
        if (starPoint === null) continue
        if (starPoint.x < -20 || starPoint.x > width + 20) continue
        if (starPoint.y < -20 || starPoint.y > height + 20) continue
        context.globalAlpha = 0.16 * depthFactor(starPoint.zCamera, camera.distance)
        context.beginPath()
        context.arc(starPoint.x, starPoint.y, Math.max(0.6, starPoint.scale * 12), 0, Math.PI * 2)
        context.fill()
      }
      context.globalAlpha = 1
      if (data === null || data.nodes.length === 0) return { visibleNodes: 0, labelsDrawn: 0 }

      const filters = props.filters
      const projected = props.projected
      const selectedId = props.selectedId
      const neighbors = selectedId !== null && data.neighbors.has(selectedId) ? data.neighbors.get(selectedId) : null

      // Project every visible node once.
      const projectedNodes = []
      const projectedById = new Map()
      for (const node of data.nodes) {
        if (!nodeMatchesFilters(node, filters)) continue
        const position = positions.get(node.id)
        if (position === undefined) continue
        const point = projectCamera(position, camera, width, height)
        if (point === null) continue
        const retention = projected.has(node.id) ? projected.get(node.id) : node.retention
        const radius = clamp(nodeBaseRadius(node, retention) * point.scale, 2.5, 46)
        const item = { node, position, point, retention, radius }
        projectedNodes.push(item)
        projectedById.set(node.id, item)
      }

      // Edges first, far to near (painter's algorithm).
      const edgeLines = []
      for (const edge of data.edges) {
        const source = projectedById.get(edge.source)
        const target = projectedById.get(edge.target)
        if (source === undefined || target === undefined) continue
        const depth = (source.point.zCamera + target.point.zCamera) / 2
        edgeLines.push({ edge, source, target, depth })
      }
      edgeLines.sort((left, right) => right.depth - left.depth)
      for (const line of edgeLines) {
        const factor = depthFactor(line.depth, camera.distance)
        const related = selectedId !== null && (line.edge.source === selectedId || line.edge.target === selectedId)
        context.beginPath()
        context.moveTo(line.source.point.x, line.source.point.y)
        context.lineTo(line.target.point.x, line.target.point.y)
        if (line.edge.type === 'session') {
          context.setLineDash([3, 3])
          context.strokeStyle = colors['label-tertiary']
          context.globalAlpha = (related ? 0.55 : 0.2) * factor
          context.lineWidth = Math.max(0.4, 1 * factor)
        } else if (line.edge.type === 'semantic') {
          context.setLineDash([])
          context.strokeStyle = colors['state-business-primary']
          context.globalAlpha = (related ? 0.68 : 0.3) * factor
          context.lineWidth = Math.max(0.45, (related ? 1.6 : 1.05) * factor)
        } else {
          context.setLineDash([])
          context.strokeStyle = colors['label-tertiary']
          const weight = clamp(line.edge.weight, 1, 4)
          context.globalAlpha = ((related ? 0.5 : 0.16) + weight * 0.045) * factor
          context.lineWidth = Math.max(0.4, (related ? 1.8 : 0.6 + weight * 0.26) * factor)
        }
        context.stroke()
      }
      context.setLineDash([])
      context.globalAlpha = 1

      // Nodes, far to near.
      projectedNodes.sort((left, right) => right.point.zCamera - left.point.zCamera)
      for (const item of projectedNodes) {
        const node = item.node
        const point = item.point
        const radius = item.radius
        const hue = sessionHue(node.sessionId === '' ? node.id : node.sessionId)
        const selected = node.id === selectedId
        const hovered = node.id === hoverId
        const depth = depthFactor(point.zCamera, camera.distance)
        let alpha = depth
        if (node.state === 'fading') alpha *= 0.62
        if (node.state === 'forgotten') alpha *= 0.4
        if (node.state !== 'forgotten' && !node.pinned && item.retention < 0.4) {
          alpha *= clamp(0.45 + item.retention, 0.5, 1)
        }
        if (neighbors !== null && !selected && !neighbors.has(node.id)) alpha *= 0.2
        if (hovered) alpha = Math.min(1, alpha + 0.18)
        context.globalAlpha = alpha
        const dashed = node.state === 'fading' || node.state === 'forgotten'
        context.setLineDash(dashed ? [3, 3] : [])
        if (node.kind === 'semantic') {
          // Octahedron-like diamond with a vertical face gradient.
          const face = context.createLinearGradient(point.x, point.y - radius, point.x, point.y + radius)
          if (node.state === 'forgotten') {
            face.addColorStop(0, 'hsla(220,7%,64%,.9)')
            face.addColorStop(1, 'hsla(220,7%,36%,.9)')
          } else {
            face.addColorStop(0, `hsla(${hue},62%,70%,.95)`)
            face.addColorStop(1, `hsla(${hue},62%,36%,.95)`)
          }
          context.beginPath()
          context.moveTo(point.x, point.y - radius * 1.15)
          context.lineTo(point.x + radius, point.y)
          context.lineTo(point.x, point.y + radius * 1.15)
          context.lineTo(point.x - radius, point.y)
          context.closePath()
          context.fillStyle = face
          context.fill()
          context.beginPath()
          context.moveTo(point.x, point.y - radius * 1.15)
          context.lineTo(point.x, point.y + radius * 1.15)
          context.moveTo(point.x - radius, point.y)
          context.lineTo(point.x + radius, point.y)
          context.strokeStyle = selected
            ? colors['state-business-primary']
            : `hsla(${hue},58%,${node.state === 'forgotten' ? 30 : 34}%,.9)`
          context.lineWidth = selected ? 2.4 : Math.max(0.8, 1.1 * depth)
          context.stroke()
        } else {
          // Episode node: sphere-like radial gradient with a top-left highlight.
          if (radius >= 3.5) {
            const sphere = context.createRadialGradient(
              point.x - radius * 0.38,
              point.y - radius * 0.38,
              Math.max(0.5, radius * 0.12),
              point.x,
              point.y,
              Math.max(1, radius),
            )
            if (node.state === 'forgotten') {
              sphere.addColorStop(0, 'hsla(220,8%,80%,.92)')
              sphere.addColorStop(0.55, 'hsla(220,7%,52%,.8)')
              sphere.addColorStop(1, 'hsla(220,8%,30%,.85)')
            } else {
              sphere.addColorStop(0, `hsla(${hue},72%,78%,.95)`)
              sphere.addColorStop(0.55, `hsla(${hue},62%,52%,.92)`)
              sphere.addColorStop(1, `hsla(${hue},58%,32%,.95)`)
            }
            context.beginPath()
            context.arc(point.x, point.y, Math.max(1, radius), 0, Math.PI * 2)
            context.fillStyle = sphere
            context.fill()
          } else {
            context.beginPath()
            context.arc(point.x, point.y, Math.max(1, radius), 0, Math.PI * 2)
            context.fillStyle = node.state === 'forgotten'
              ? 'hsla(220,7%,50%,.7)'
              : `hsla(${hue},62%,52%,.9)`
            context.fill()
          }
          context.beginPath()
          context.arc(point.x, point.y, Math.max(1, radius), 0, Math.PI * 2)
          context.strokeStyle = selected
            ? colors['state-business-primary']
            : `hsla(${hue},60%,${node.state === 'forgotten' ? 32 : 40}%,.9)`
          context.lineWidth = selected ? 2.4 : Math.max(0.7, 1.1 * depth)
          if (selected) {
            context.shadowColor = colors['state-business-primary']
            context.shadowBlur = 12
          }
          context.stroke()
          context.shadowBlur = 0
          context.shadowColor = 'transparent'
        }
        context.setLineDash([])
        if (node.pinned) {
          context.beginPath()
          context.arc(point.x, point.y, radius + 3.5, 0, Math.PI * 2)
          context.globalAlpha = alpha * 0.85
          context.strokeStyle = colors['state-warn-primary']
          context.lineWidth = 1.1
          context.setLineDash([2, 3])
          context.stroke()
          context.setLineDash([])
          drawStarMark(
            context,
            point.x + radius * 0.82,
            point.y - radius * 0.82,
            Math.max(2.4, radius * 0.3),
            colors['state-warn-primary'],
            alpha,
          )
        }
      }
      context.globalAlpha = 1

      // Labels: one per visible node, near-first placement priority. A label is
      // never dropped — if every candidate overlaps, it still draws at alpha
      // 0.45 on top (CONTRACT 7.5).
      const labelItems = projectedNodes.slice().sort((left, right) => left.point.zCamera - right.point.zCamera)
      const placedBoxes = []
      const labels = []
      for (const item of labelItems) {
        const node = item.node
        const point = item.point
        const fontSize = clamp(10, 10 + (num(camera.distance, 1200) / Math.max(1, point.zCamera)) * 1.5, 13)
        const font = `${fontSize.toFixed(1)}px ui-sans-serif, system-ui, -apple-system, sans-serif`
        const text = nodeDisplayName(node, props.t)
        const textWidth = measureLabelWidth(context, text, font)
        const boxWidth = textWidth + 12
        const boxHeight = fontSize + 7
        const radius = item.radius
        const belowCandidate = { x: point.x - boxWidth / 2, y: point.y + radius + 6 }
        const aboveCandidate = { x: point.x - boxWidth / 2, y: point.y - radius - 6 - boxHeight }
        const leftCandidate = { x: point.x - radius - 6 - boxWidth, y: point.y - boxHeight / 2 }
        const rightCandidate = { x: point.x + radius + 6, y: point.y - boxHeight / 2 }
        // CONTRACT 7.5: default below the node; if that would leave the canvas,
        // keep the label readable by drawing it above first (then left/right).
        const candidates = belowCandidate.y + boxHeight > height - 2
          ? [aboveCandidate, belowCandidate, leftCandidate, rightCandidate]
          : [belowCandidate, aboveCandidate, leftCandidate, rightCandidate]
        let chosen = null
        for (const candidate of candidates) {
          const box = {
            x: clamp(candidate.x, 2, Math.max(2, width - boxWidth - 2)),
            y: clamp(candidate.y, 2, Math.max(2, height - boxHeight - 2)),
            width: boxWidth,
            height: boxHeight,
          }
          if (!labelsOverlap(box, placedBoxes)) {
            chosen = box
            break
          }
        }
        let alpha = labelDepthAlpha(point.zCamera, camera.distance)
        if (chosen === null) {
          chosen = {
            x: clamp(candidates[0].x, 2, Math.max(2, width - boxWidth - 2)),
            y: clamp(candidates[0].y, 2, Math.max(2, height - boxHeight - 2)),
            width: boxWidth,
            height: boxHeight,
          }
          alpha = 0.45
        }
        const selected = node.id === selectedId
        const hovered = node.id === hoverId
        if (selected || hovered) alpha = Math.max(alpha, 0.95)
        placedBoxes.push(chosen)
        labels.push({ node, box: chosen, text, font, alpha })
      }
      for (const label of labels) {
        context.globalAlpha = label.alpha
        context.fillStyle = colors['bg-overlay'] || colors['bg-layer-1']
        context.strokeStyle = colors['border-l3']
        context.lineWidth = 1
        roundedRectPath(context, label.box.x, label.box.y, label.box.width, label.box.height, 5)
        context.fill()
        context.stroke()
        context.globalAlpha = label.alpha
        context.fillStyle = colors['label-primary']
        context.font = label.font
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText(label.text, label.box.x + label.box.width / 2, label.box.y + label.box.height / 2 + 0.5)
      }
      context.globalAlpha = 1
      return { visibleNodes: projectedNodes.length, labelsDrawn: labels.length }
    }

    // ---------------------------------------------------------------------
    // Sidebar glyph + shared little components
    // ---------------------------------------------------------------------

    /**
     * Original "brain + neural network" glyph, 64×64, drawn in currentColor.
     * The sidebar row owns the button shell; this only draws.
     * @param {{ size?: number, active?: boolean }} props Slot props.
     */
    function BrainGlyph({ size, active }) {
      const pixels = typeof size === 'number' && size > 0 ? size : 18
      return h('svg', {
        width: pixels,
        height: pixels,
        viewBox: '0 0 64 64',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none', color: 'currentColor', opacity: active === true ? 1 : 0.9 },
      },
        h('path', {
          d: 'M31 11c-6.2 0-11.2 4-12.6 9.4C14.8 22.6 12 26.5 12 31c0 3.2 1.4 6 3.6 8-.4 1-.6 2-.6 3.1C15 46.9 19.1 51 24.1 51H31V11Z',
          fill: 'currentColor',
          fillOpacity: 0.26,
        }),
        h('path', {
          d: 'M33 11c6.2 0 11.2 4 12.6 9.4C49.2 22.6 52 26.5 52 31c0 3.2-1.4 6-3.6 8 .4 1 .6 2 .6 3.1C49 46.9 44.9 51 39.9 51H33V11Z',
          fill: 'currentColor',
          fillOpacity: 0.26,
        }),
        h('path', {
          d: 'M32 33 22 26M32 33l10-7M32 33l-8 11M32 33l8 11',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 22, cy: 26, r: 3.2, fill: 'currentColor' }),
        h('circle', { cx: 42, cy: 26, r: 3.2, fill: 'currentColor' }),
        h('circle', { cx: 24, cy: 44, r: 3.2, fill: 'currentColor' }),
        h('circle', { cx: 40, cy: 44, r: 3.2, fill: 'currentColor' }),
        h('circle', { cx: 32, cy: 33, r: 3.8, fill: 'currentColor' }),
      )
    }

    function StarMark() {
      return h('svg', {
        width: 10,
        height: 10,
        viewBox: '0 0 20 20',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      }, h('path', {
        fill: 'currentColor',
        d: 'M10 1.6l2.5 5.2 5.7.8-4.1 4 1 5.7L10 14.6l-5.1 2.7 1-5.7-4.1-4 5.7-.8L10 1.6Z',
      }))
    }

    /**
     * Switch-shaped button, keyboard accessible without any primitives package.
     * @param {{ label: string, checked?: boolean, disabled?: boolean, hint?: string, onChange: (next: boolean) => void }} props
     */
    function Toggle({ label, checked, disabled, hint, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        className: 'dsh-memory-brain-switchRow',
        disabled: disabled === true,
        title: hint,
        onClick: () => {
          if (disabled === true) return
          onChange(checked !== true)
        },
      },
        h('span', { className: 'dsh-memory-brain-switchTrack', 'data-on': checked === true, 'aria-hidden': 'true' },
          h('span', { className: 'dsh-memory-brain-switchThumb' })),
        h('span', { className: 'dsh-memory-brain-switchLabel' }, label),
      )
    }

    /**
     * Two-step destructive button: first click arms it, second click runs.
     * @param {{ idleLabel: string, confirmLabel: string, pendingLabel: string, pending?: boolean, disabled?: boolean, className?: string, onConfirm: () => void }} props
     */
    function DangerButton({ idleLabel, confirmLabel, pendingLabel, pending, disabled, className, onConfirm }) {
      const [armed, setArmed] = React.useState(false)
      React.useEffect(() => {
        if (!armed) return undefined
        const timer = window.setTimeout(() => setArmed(false), 5000)
        return () => {
          window.clearTimeout(timer)
        }
      }, [armed])
      const classes = `dsh-memory-brain-btn ${className === undefined ? '' : className}`
      return h('button', {
        type: 'button',
        className: classes,
        disabled: disabled === true || pending === true,
        'data-armed': armed,
        onClick: () => {
          if (disabled === true || pending === true) return
          if (!armed) {
            setArmed(true)
            return
          }
          setArmed(false)
          onConfirm()
        },
      }, pending === true ? pendingLabel : (armed ? confirmLabel : idleLabel))
    }

    function ErrorBanner({ message, onDismiss, t }) {
      return h('div', { className: 'dsh-memory-brain-banner', role: 'alert' },
        h('span', { className: 'dsh-memory-brain-bannerText' }, message),
        h('button', {
          type: 'button',
          className: 'dsh-memory-brain-btn dsh-memory-brain-btn-small dsh-memory-brain-btn-secondary',
          onClick: onDismiss,
        }, t('error.dismiss')))
    }

    function StatChip({ label, value, tone }) {
      return h('span', { className: 'dsh-memory-brain-chip', 'data-tone': tone },
        h('span', null, label),
        h('b', null, value))
    }

    function Legend({ t }) {
      const items = [
        { key: 'episode', mark: 'dot' },
        { key: 'semantic', mark: 'diamond' },
        { key: 'fading', mark: 'dotDash' },
        { key: 'forgotten', mark: 'dotFaded' },
        { key: 'pinned', mark: 'star' },
        { key: 'edgeTag', mark: 'line' },
        { key: 'edgeSession', mark: 'lineDash' },
        { key: 'edgeSemantic', mark: 'lineCold' },
      ]
      return h('div', { className: 'dsh-memory-brain-legend', role: 'group', 'aria-label': t('left.legend') },
        items.map((item) => h('span', { key: item.key, className: 'dsh-memory-brain-legendItem' },
          h('span', { className: 'dsh-memory-brain-legendMark', 'data-mark': item.mark, 'aria-hidden': 'true' },
            item.mark === 'star' ? h(StarMark) : null),
          t(`legend.${item.key}`))))
    }

    /**
     * Filter rail: tasks, tag cloud, search, ghost switch, legend.
     * All callbacks only touch local UI state — the Host is the source of truth
     * for memories, not for filters.
     */
    function LeftPanel({ data, sessionFilter, tagFilter, search, showForgotten, onToggleSession, onToggleTag, onSearchChange, onToggleForgotten, onClearFilters, t }) {
      const sessions = data === null ? [] : data.sessions
      const tags = data === null ? [] : data.tags
      const filtered = sessionFilter !== null || tagFilter.length > 0 || search.trim() !== ''
      const taskSection = h('section', { className: 'dsh-memory-brain-section' },
        h('h2', { className: 'dsh-memory-brain-sectionTitle' },
          h('span', null, t('left.tasks')),
          filtered
            ? h('button', { type: 'button', className: 'dsh-memory-brain-linkBtn', onClick: onClearFilters }, t('left.clearFilters'))
            : null),
        sessions.length === 0
          ? h('p', { className: 'dsh-memory-brain-hint' }, t('left.tasksEmpty'))
          : h('ul', { className: 'dsh-memory-brain-list' },
            sessions.map((session) => h('li', { key: session.sessionId },
              h('button', {
                type: 'button',
                className: 'dsh-memory-brain-listItem',
                'aria-pressed': sessionFilter === session.sessionId,
                title: session.title,
                onClick: () => onToggleSession(session.sessionId),
              },
                h('span', { className: 'dsh-memory-brain-listLabel' }, session.title || t('left.untitled')),
                session.source === 'qq'
                  ? h('span', {
                    className: 'dsh-memory-brain-qqBadge',
                    title: t('left.qqBadge'),
                    'aria-label': t('left.qqBadge'),
                  }, t('left.qqBadge'))
                  : null,
                h('span', { className: 'dsh-memory-brain-listMeta' }, t('left.sessionMeta', { count: session.count })))))))
      const tagButtons = tags.map((entry) => h('button', {
        key: entry.tag,
        type: 'button',
        className: 'dsh-memory-brain-tag',
        'aria-pressed': tagFilter.indexOf(entry.tag) !== -1,
        onClick: () => onToggleTag(entry.tag),
      },
        h('span', null, `#${entry.tag}`),
        h('span', { className: 'dsh-memory-brain-tagCount' }, String(entry.count))))
      const tagSection = h('section', { className: 'dsh-memory-brain-section' },
        h('h2', { className: 'dsh-memory-brain-sectionTitle' }, t('left.tags')),
        tags.length === 0
          ? h('p', { className: 'dsh-memory-brain-hint' }, t('left.tagsEmpty'))
          : h('div', { className: 'dsh-memory-brain-tagCloud' }, tagButtons),
        h('p', { className: 'dsh-memory-brain-hint' }, t('left.tagMode')))
      const searchSection = h('section', { className: 'dsh-memory-brain-section' },
        h('input', {
          className: 'dsh-memory-brain-search',
          type: 'search',
          value: search,
          placeholder: t('left.searchPlaceholder'),
          'aria-label': t('left.searchLabel'),
          onChange: (event) => onSearchChange(event.target.value),
        }),
        h(Toggle, {
          label: t('left.showForgotten'),
          checked: showForgotten,
          onChange: onToggleForgotten,
        }))
      const legendSection = h('section', { className: 'dsh-memory-brain-section' },
        h('h2', { className: 'dsh-memory-brain-sectionTitle' }, t('left.legend')),
        h(Legend, { t }))
      return h('div', { className: 'dsh-memory-brain-scroll' }, taskSection, tagSection, searchSection, legendSection)
    }

    /**
     * Empty-state overlay drawn over the (still mounted) canvas.
     */
    function CanvasEmpty({ pending, onCapture, t }) {
      return h('div', { className: 'dsh-memory-brain-canvasEmpty' },
        h(BrainGlyph, { size: 40, active: false }),
        h('p', { className: 'dsh-memory-brain-emptyTitle' }, t('canvas.empty.title')),
        h('p', { className: 'dsh-memory-brain-emptyBody' }, t('canvas.empty.body')),
        h('button', {
          type: 'button',
          className: 'dsh-memory-brain-btn dsh-memory-brain-btn-primary',
          disabled: pending !== null,
          onClick: onCapture,
        }, pending === 'capture' ? t('action.capturing') : t('canvas.empty.cta')))
    }

    function CanvasNoMatch({ onClear, t }) {
      return h('div', { className: 'dsh-memory-brain-canvasEmpty' },
        h('p', { className: 'dsh-memory-brain-emptyBody' }, t('canvas.noMatch')),
        h('button', {
          type: 'button',
          className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary',
          onClick: onClear,
        }, t('left.clearFilters')))
    }

    function TravelBar({ days, onChange, t }) {
      return h('div', { className: 'dsh-memory-brain-travel dsh-memory-brain-travelBar' },
        h('label', { className: 'dsh-memory-brain-travelLabel', htmlFor: TRAVEL_INPUT_ID }, t('travel.label', { days })),
        h('input', {
          id: TRAVEL_INPUT_ID,
          className: 'dsh-memory-brain-travelRange',
          type: 'range',
          min: 0,
          max: MAX_TRAVEL_DAYS,
          step: 1,
          value: days,
          'aria-label': t('travel.aria'),
          onChange: (event) => onChange(clamp(Number(event.target.value), 0, MAX_TRAVEL_DAYS)),
        }),
        h('span', { className: 'dsh-memory-brain-travelHint' }, t('travel.hint')))
    }

    /**
     * SVG mini chart of R(t) = exp(-t / stabilityDays) with the "now" line, the
     * time-travel line, and the current dot.
     */
    function RetentionCurve({ node, now, travelDays, t }) {
      const width = 300
      const height = 120
      const padLeft = 8
      const padRight = 8
      const padTop = 12
      const padBottom = 24
      const stability = num(node.stabilityDays, 0) > 0 ? num(node.stabilityDays, 0) : 1
      const anchor = num(node.lastAccessAt, 0) > 0 ? num(node.lastAccessAt, 0) : num(node.createdAt, now)
      const start = Math.min(num(node.createdAt, 0) > 0 ? num(node.createdAt, 0) : anchor, anchor)
      const horizonDays = Math.max(10, Math.min(90, Math.ceil(stability * 4)))
      const travelAt = now + travelDays * DAY_MS
      let end = now + horizonDays * DAY_MS
      if (travelAt > end) end = travelAt + DAY_MS
      const span = Math.max(1, end - start)
      const toX = (at) => padLeft + ((clamp(at, start, end) - start) / span) * (width - padLeft - padRight)
      const toY = (value) => padTop + (1 - clamp(value, 0, 1)) * (height - padTop - padBottom)
      const steps = 64
      const points = []
      for (let index = 0; index <= steps; index += 1) {
        const at = start + (span * index) / steps
        points.push([toX(at), toY(retentionAt(node, at))])
      }
      const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point[0].toFixed(2)} ${point[1].toFixed(2)}`).join(' ')
      const areaPath = `${linePath} L${toX(end).toFixed(2)} ${toY(0).toFixed(2)} L${toX(start).toFixed(2)} ${toY(0).toFixed(2)} Z`
      const nowX = toX(now)
      const travelX = toX(travelAt)
      const markerAt = travelDays > 0 ? travelAt : now
      const markerY = toY(retentionAt(node, markerAt))
      const travelLabelX = travelX > width * 0.62 ? travelX - 3 : travelX + 3
      const travelAnchor = travelX > width * 0.62 ? 'end' : 'start'
      return h('svg', {
        className: 'dsh-memory-brain-curve',
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': t('detail.curve'),
        style: { display: 'block' },
      },
        h('line', {
          x1: padLeft,
          y1: toY(0),
          x2: width - padRight,
          y2: toY(0),
          style: { stroke: 'var(--dsw-alias-border-l3)', strokeWidth: 1 },
        }),
        h('line', {
          x1: padLeft,
          y1: toY(1),
          x2: width - padRight,
          y2: toY(1),
          style: { stroke: 'var(--dsw-alias-border-l3)', strokeWidth: 1, strokeDasharray: '2 4' },
        }),
        h('path', {
          d: areaPath,
          style: { fill: 'var(--dsw-alias-state-business-primary)', fillOpacity: 0.12, stroke: 'none' },
        }),
        h('path', {
          d: linePath,
          style: { fill: 'none', stroke: 'var(--dsw-alias-state-business-primary)', strokeWidth: 2, strokeLinecap: 'round' },
        }),
        h('line', {
          x1: nowX,
          y1: padTop - 4,
          x2: nowX,
          y2: toY(0),
          style: { stroke: 'var(--dsw-alias-label-tertiary)', strokeWidth: 1, strokeDasharray: '3 3' },
        }),
        h('text', {
          x: clamp(nowX, padLeft, width - padRight - 28),
          y: height - 4,
          style: { fill: 'var(--dsw-alias-label-caption)', fontSize: 9 },
          textAnchor: 'start',
        }, t('detail.curveNow')),
        travelDays > 0
          ? h('line', {
            x1: travelX,
            y1: padTop - 4,
            x2: travelX,
            y2: toY(0),
            style: { stroke: 'var(--dsw-alias-state-warn-primary)', strokeWidth: 1.4, strokeDasharray: '4 3' },
          })
          : null,
        travelDays > 0
          ? h('text', {
            x: travelLabelX,
            y: height - 4,
            style: { fill: 'var(--dsw-alias-state-warn-primary)', fontSize: 9 },
            textAnchor: travelAnchor,
          }, t('detail.curveTravel', { days: travelDays }))
          : null,
        h('circle', {
          cx: markerAt === now ? nowX : travelX,
          cy: markerY,
          r: 3.4,
          style: { fill: travelDays > 0 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-business-primary)' },
        }),
        h('text', {
          x: padLeft,
          y: padTop + 8,
          style: { fill: 'var(--dsw-alias-label-caption)', fontSize: 9 },
          textAnchor: 'start',
        }, '100%'),
        h('text', {
          x: padLeft,
          y: toY(0) - 3,
          style: { fill: 'var(--dsw-alias-label-caption)', fontSize: 9 },
          textAnchor: 'start',
        }, '0%'),
        h('text', {
          x: width - padRight,
          y: height - 4,
          style: { fill: 'var(--dsw-alias-label-caption)', fontSize: 9 },
          textAnchor: 'end',
        }, t('detail.curveEnd', { days: horizonDays })),
      )
    }

    function DetailEmpty({ t }) {
      return h('section', { className: 'dsh-memory-brain-section' },
        h('h2', { className: 'dsh-memory-brain-sectionTitle' }, t('detail.title')),
        h('p', { className: 'dsh-memory-brain-emptyTitle' }, t('detail.none.title')),
        h('p', { className: 'dsh-memory-brain-hint' }, t('detail.none.body')),
      )
    }

    /**
     * Inspector for the selected memory; remounted per id (key in the page) so
     * the tag draft starts fresh.
     */
    function DetailCard({ node, data, projected, travelDays, actions, pending, t }) {
      const [tagDraft, setTagDraft] = React.useState('')
      const busy = pending !== null
      const now = data.now
      const tombstone = isTombstoneNode(node)
      const retention = projected.has(node.id) ? projected.get(node.id) : node.retention
      const tone = node.pinned ? 'pinned' : node.state
      const stateLabel = node.pinned ? t('state.pinned') : t(`state.${node.state}`)
      const submitTag = async () => {
        const value = tagDraft.trim()
        if (value === '' || busy) return
        const result = await actions.tagAdd(node.id, value)
        if (result.ok) setTagDraft('')
      }
      const retentionLabel = travelDays > 0
        ? t('detail.retentionSim', { days: travelDays })
        : t('detail.retention')
      const metaRows = [
        [t('detail.session'), node.sessionTitle || '—'],
        [t('detail.turn'), node.kind === 'semantic' ? '—' : String(Math.round(num(node.turn, 0)))],
        [t('detail.created'), formatAbsolute(node.createdAt)],
        [t('detail.lastAccess'), `${formatAbsolute(node.lastAccessAt)} · ${formatRelative(node.lastAccessAt, now, t)}`],
        [t('detail.accessCount'), t('detail.times', { count: Math.round(num(node.accessCount, 0)) })],
        [t('detail.stability'), t('detail.days', { value: formatNumber(node.stabilityDays) })],
        [retentionLabel, formatPercent(retention)],
        [t('detail.state'), stateLabel],
      ]
      return h('section', { className: 'dsh-memory-brain-section' },
        h('div', { className: 'dsh-memory-brain-detailHead' },
          h('h2', { className: 'dsh-memory-brain-detailTitle' }, tombstone ? t('tombstone.label') : `${node.label || '·'}`),
          h('span', { className: 'dsh-memory-brain-badge', 'data-tone': tone }, stateLabel)),
        node.kind === 'semantic'
          ? h('p', { className: 'dsh-memory-brain-hint' }, t('detail.semanticNote', { count: node.memberIds.length }))
          : null,
        h('h3', { className: 'dsh-memory-brain-subSectionTitle' }, t('detail.excerpt')),
        h('div', { className: 'dsh-memory-brain-excerpt' }, tombstone ? t('detail.tombstone') : (node.excerpt || '—')),
        h('h3', { className: 'dsh-memory-brain-subSectionTitle' }, t('detail.meta')),
        h('div', { className: 'dsh-memory-brain-metaList' }, metaRows.map((row) => h(React.Fragment, { key: row[0] },
          h('span', { className: 'dsh-memory-brain-metaKey' }, row[0]),
          h('span', { className: 'dsh-memory-brain-metaVal' }, row[1])))),
        h('h3', { className: 'dsh-memory-brain-subSectionTitle' }, t('detail.tags')),
        node.tags.length === 0
          ? h('p', { className: 'dsh-memory-brain-hint' }, t('detail.tagsEmpty'))
          : null,
        h('div', { className: 'dsh-memory-brain-tagEditor' }, node.tags.map((tag) => h('span', { key: tag, className: 'dsh-memory-brain-chipTag' },
          h('span', null, `#${tag}`),
          h('button', {
            type: 'button',
            className: 'dsh-memory-brain-chipRemove',
            title: t('detail.removeTag', { tag }),
            'aria-label': t('detail.removeTag', { tag }),
            disabled: busy,
            onClick: () => {
              void actions.tagRemove(node.id, tag)
            },
          }, '×')))),
        h('label', { className: 'dsh-memory-brain-field', style: { marginTop: '6px' } },
          h('span', { className: 'dsh-memory-brain-label' }, t('detail.addTag')),
          h('input', {
            className: 'dsh-memory-brain-input',
            type: 'text',
            value: tagDraft,
            maxLength: 24,
            placeholder: t('detail.tagPlaceholder'),
            'aria-label': t('detail.addTag'),
            disabled: busy,
            onChange: (event) => setTagDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              void submitTag()
            },
          })),
        h('h3', { className: 'dsh-memory-brain-subSectionTitle' }, t('detail.curve')),
        h(RetentionCurve, { node, now, travelDays, t }),
        h('h3', { className: 'dsh-memory-brain-subSectionTitle' }, t('detail.ops')),
        h('div', { className: 'dsh-memory-brain-ops' },
          tombstone
            ? null
            : h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary dsh-memory-brain-btn-small',
              disabled: busy,
              onClick: () => {
                void actions.rehearse(node.id)
              },
            }, pending === 'rehearse' ? t('detail.rehearsing') : t('detail.rehearse')),
          tombstone
            ? null
            : h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary dsh-memory-brain-btn-small',
              disabled: busy,
              onClick: () => {
                void actions.pin(node.id, !node.pinned)
              },
            }, node.pinned ? t('detail.unpin') : t('detail.pin')),
          tombstone
            ? null
            : (node.state === 'forgotten'
              ? h('button', {
                type: 'button',
                className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary dsh-memory-brain-btn-small',
                disabled: busy,
                onClick: () => {
                  void actions.restore(node.id)
                },
              }, pending === 'restore' ? t('detail.restoring') : t('detail.restore'))
              : h('button', {
                type: 'button',
                className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary dsh-memory-brain-btn-small',
                disabled: busy,
                onClick: () => {
                  void actions.forget(node.id)
                },
              }, pending === 'forget' ? t('detail.forgetting') : t('detail.forget'))),
          h(DangerButton, {
            idleLabel: t('detail.hardForget'),
            confirmLabel: t('detail.hardForgetConfirm'),
            pendingLabel: t('detail.forgetting'),
            pending: pending === 'forgetHard',
            disabled: busy,
            className: 'dsh-memory-brain-btn-dangerGhost dsh-memory-brain-btn-small',
            onConfirm: () => {
              void actions.forgetHard(node.id)
            },
          })),
      )
    }

    /** Settings form; the draft is local until "save" POSTs `/settings`. */
    function SettingsPanel({ open, settings, actions, pending, t }) {
      const [draft, setDraft] = React.useState(null)
      const [invalid, setInvalid] = React.useState(false)
      const forgetAfterDays = settings === null ? null : settings.forgetAfterDays
      const maxMemories = settings === null ? null : settings.maxMemories
      const autoCapture = settings === null ? null : settings.autoCapture
      React.useEffect(() => {
        if (!open || settings === null) return
        setDraft({
          forgetAfterDays: String(settings.forgetAfterDays),
          maxMemories: String(settings.maxMemories),
          autoCapture: settings.autoCapture === true,
        })
        setInvalid(false)
      }, [open, forgetAfterDays, maxMemories, autoCapture])
      if (!open) return null
      const save = async () => {
        if (draft === null) return
        const forgetAfterDaysValue = Number(draft.forgetAfterDays)
        const maxMemoriesValue = Number(draft.maxMemories)
        if (!Number.isFinite(forgetAfterDaysValue) || forgetAfterDaysValue < 1 || forgetAfterDaysValue > 60
          || !Number.isFinite(maxMemoriesValue) || maxMemoriesValue < 100 || maxMemoriesValue > 2000) {
          setInvalid(true)
          return
        }
        setInvalid(false)
        await actions.saveSettings({
          forgetAfterDays: forgetAfterDaysValue,
          maxMemories: Math.round(maxMemoriesValue),
          autoCapture: draft.autoCapture === true,
        })
      }
      return h('section', { className: 'dsh-memory-brain-section' },
        h('h2', { className: 'dsh-memory-brain-sectionTitle' },
          h('span', null, t('settings.title')),
          h('button', {
            type: 'button',
            className: 'dsh-memory-brain-linkBtn',
            onClick: actions.hideSettings,
          }, t('settings.close'))),
        settings === null || draft === null
          ? h('p', { className: 'dsh-memory-brain-hint' }, t('canvas.loading'))
          : h('div', { className: 'dsh-memory-brain-settingsForm' },
            h('label', { className: 'dsh-memory-brain-field' },
              h('span', { className: 'dsh-memory-brain-label' }, t('settings.halfLife')),
              h('input', {
                className: 'dsh-memory-brain-input',
                type: 'number',
                min: 1,
                max: 60,
                step: 1,
                value: draft.forgetAfterDays,
                'aria-label': t('settings.halfLife'),
                onChange: (event) => setDraft({ ...draft, forgetAfterDays: event.target.value }),
              })),
            h('p', { className: 'dsh-memory-brain-hint' }, t('settings.halfLifeHint')),
            h('div', { className: 'dsh-memory-brain-presetRow', role: 'group', 'aria-label': t('settings.presets') },
              [7, 14, 30].map((days) => h('button', {
                key: days,
                type: 'button',
                className: 'dsh-memory-brain-presetBtn',
                'aria-pressed': Number(draft.forgetAfterDays) === days,
                onClick: () => setDraft({ ...draft, forgetAfterDays: String(days) }),
              }, t('settings.daysShort', { days })))),
            h('label', { className: 'dsh-memory-brain-field' },
              h('span', { className: 'dsh-memory-brain-label' }, t('settings.maxMemories')),
              h('input', {
                className: 'dsh-memory-brain-input',
                type: 'number',
                min: 100,
                max: 2000,
                step: 50,
                value: draft.maxMemories,
                'aria-label': t('settings.maxMemories'),
                onChange: (event) => setDraft({ ...draft, maxMemories: event.target.value }),
              })),
            h(Toggle, {
              label: t('settings.autoCapture'),
              checked: draft.autoCapture === true,
              hint: t('settings.autoCaptureHint'),
              onChange: (next) => setDraft({ ...draft, autoCapture: next }),
            }),
            invalid ? h('p', { className: 'dsh-memory-brain-errorText' }, t('settings.invalid')) : null,
            h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary',
              disabled: pending !== null,
              onClick: () => {
                void save()
              },
            }, pending === 'settings' ? t('settings.saving') : t('settings.save'))))
    }

    // ---------------------------------------------------------------------
    // Canvas surface — force layout, zoom/pan/drag/hover/select, DPR + resize
    // ---------------------------------------------------------------------

    function MemoryCanvas({ data, projected, topologyKey, selectedId, onSelect, filters, travelDays, t, overlay }) {
      const wrapRef = React.useRef(null)
      const canvasRef = React.useRef(null)
      const posRef = React.useRef(new Map())
      const simRef = React.useRef(null)
      const viewRef = React.useRef({ scale: 1, center: { x: 0, y: 0 }, fitted: false })
      const sizeRef = React.useRef({ width: 0, height: 0 })
      const tokensRef = React.useRef(null)
      const propsRef = React.useRef(null)
      const interactionRef = React.useRef(null)
      const hoverRef = React.useRef(null)
      const drawErrorRef = React.useRef(false)

      const [size, setSize] = React.useState({ width: 0, height: 0 })
      const [hoverNode, setHoverNode] = React.useState(null)
      const [dragging, setDragging] = React.useState(false)

      propsRef.current = { data, projected, selectedId, filters }
      sizeRef.current = size

      const stopSim = React.useCallback(() => {
        const sim = simRef.current
        if (sim === null) return
        if (sim.raf !== 0) {
          window.cancelAnimationFrame(sim.raf)
          sim.raf = 0
        }
        sim.running = false
      }, [])

      const draw = React.useCallback(() => {
        const canvas = canvasRef.current
        const wrap = wrapRef.current
        if (canvas === null || wrap === null) return
        const current = sizeRef.current
        if (current.width <= 0 || current.height <= 0) return
        const context = canvas.getContext('2d')
        if (context === null) return
        try {
          drawScene(context, {
            canvas,
            wrap,
            width: current.width,
            height: current.height,
            props: propsRef.current,
            positions: posRef.current,
            view: viewRef.current,
            tokensRef,
            hoverId: hoverRef.current === null ? null : hoverRef.current.id,
          })
        } catch (error) {
          if (!drawErrorRef.current) {
            drawErrorRef.current = true
            console.warn('dsh-memory-brain: canvas draw failed', error)
          }
        }
      }, [])

      const tick = React.useCallback(() => {
        const sim = simRef.current
        if (sim === null) return
        simulateStep(sim)
        draw()
        if (simRef.current !== sim) return
        if (sim.dragId !== null || sim.temperature > SIM_STOP_TEMPERATURE) {
          sim.running = true
          sim.raf = window.requestAnimationFrame(tick)
          return
        }
        sim.running = false
        sim.raf = 0
      }, [draw])

      const startSim = React.useCallback(() => {
        const sim = simRef.current
        if (sim === null || sim.items.length === 0) return
        if (sim.running) return
        sim.running = true
        sim.raf = window.requestAnimationFrame(tick)
      }, [tick])

      const reheat = React.useCallback((energy) => {
        const sim = simRef.current
        if (sim === null) return
        sim.temperature = Math.max(sim.temperature, typeof energy === 'number' ? energy : SIM_START_TEMPERATURE)
        if (sim.running) return
        sim.running = true
        sim.raf = window.requestAnimationFrame(tick)
      }, [tick])

      const fitView = React.useCallback(() => {
        const current = sizeRef.current
        if (current.width <= 0 || current.height <= 0) return
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const position of posRef.current.values()) {
          if (position.x < minX) minX = position.x
          if (position.x > maxX) maxX = position.x
          if (position.y < minY) minY = position.y
          if (position.y > maxY) maxY = position.y
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
          viewRef.current = { scale: 1, center: { x: 0, y: 0 }, fitted: true }
          return
        }
        const boundsWidth = Math.max(1, maxX - minX)
        const boundsHeight = Math.max(1, maxY - minY)
        const scale = clamp(Math.min((current.width - 90) / boundsWidth, (current.height - 90) / boundsHeight), 0.05, 2.4)
        viewRef.current = {
          scale,
          center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
          fitted: true,
        }
      }, [])

      const hitTest = React.useCallback((pointerX, pointerY) => {
        const props = propsRef.current
        const currentData = props.data
        if (currentData === null) return null
        const view = viewRef.current
        const current = sizeRef.current
        for (let index = currentData.nodes.length - 1; index >= 0; index -= 1) {
          const node = currentData.nodes[index]
          if (!nodeMatchesFilters(node, props.filters)) continue
          const position = posRef.current.get(node.id)
          if (position === undefined) continue
          const point = projectPoint(position, view, current.width, current.height)
          const retention = props.projected.has(node.id) ? props.projected.get(node.id) : node.retention
          const radius = nodeScreenRadius(node, retention, view.scale) + 4
          const dx = pointerX - point.x
          const dy = pointerY - point.y
          if (dx * dx + dy * dy <= radius * radius) return node.id
        }
        return null
      }, [])

      const buildSimulation = React.useCallback(() => {
        const currentData = propsRef.current.data
        const positions = posRef.current
        const alive = new Set()
        const items = []
        const itemById = new Map()
        if (currentData !== null) {
          for (const node of currentData.nodes) {
            alive.add(node.id)
            let position = positions.get(node.id)
            if (position === undefined) {
              const jitterX = ((hash32(`${node.id}|jx`) % 1000) / 1000 - 0.5) * 26
              const jitterY = ((hash32(`${node.id}|jy`) % 1000) / 1000 - 0.5) * 26
              position = { x: node.x0 * SEED_RADIUS + jitterX, y: node.y0 * SEED_RADIUS + jitterY }
              positions.set(node.id, position)
            }
            const item = { id: node.id, pos: position, radius: nodeBaseRadius(node, node.retention), dx: 0, dy: 0 }
            items.push(item)
            itemById.set(node.id, item)
          }
        }
        for (const id of [...positions.keys()]) {
          if (!alive.has(id)) positions.delete(id)
        }
        const edges = []
        if (currentData !== null) {
          for (const edge of currentData.edges) {
            const itemA = itemById.get(edge.source)
            const itemB = itemById.get(edge.target)
            if (itemA === undefined || itemB === undefined || itemA === itemB) continue
            edges.push({ a: itemA, b: itemB, stiffness: edgeStiffness(edge) })
          }
        }
        stopSim()
        simRef.current = {
          items,
          edges,
          temperature: SIM_START_TEMPERATURE,
          running: false,
          raf: 0,
          dragId: null,
        }
      }, [stopSim])

      // Rebuild the simulation only when the topology changes; positions are
      // reused per id so a poll or a mutation never resets the layout.
      React.useEffect(() => {
        const previous = simRef.current
        const wasEmpty = previous === null || previous.items.length === 0
        buildSimulation()
        const next = simRef.current
        if (next !== null && next.items.length > 0) {
          if (wasEmpty) viewRef.current = { ...viewRef.current, fitted: false }
          if (!viewRef.current.fitted) fitView()
          startSim()
        }
        draw()
        return () => {
          stopSim()
        }
      }, [topologyKey, buildSimulation, fitView, startSim, draw, stopSim])

      // Container measurement + backing-store sizing.
      React.useEffect(() => {
        const wrap = wrapRef.current
        if (wrap === null) return undefined
        const measure = () => {
          const rect = wrap.getBoundingClientRect()
          const width = Math.max(0, Math.round(rect.width))
          const height = Math.max(0, Math.round(rect.height))
          setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }))
        }
        measure()
        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          observer.observe(wrap)
        } else {
          window.addEventListener('resize', measure)
        }
        return () => {
          if (observer !== null) observer.disconnect()
          else window.removeEventListener('resize', measure)
        }
      }, [])

      React.useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null) return
        const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
        const nextWidth = Math.max(1, Math.round(size.width * ratio))
        const nextHeight = Math.max(1, Math.round(size.height * ratio))
        if (canvas.width !== nextWidth) canvas.width = nextWidth
        if (canvas.height !== nextHeight) canvas.height = nextHeight
        if (!viewRef.current.fitted && size.width > 0 && size.height > 0) fitView()
        draw()
      }, [size, fitView, draw])

      // Draw after every render so view/filter/time-travel props stay live even
      // while the simulation is asleep.
      React.useEffect(() => {
        draw()
      })

      // Native wheel listener so preventDefault works (React wheel is passive).
      React.useEffect(() => {
        const wrap = wrapRef.current
        if (wrap === null) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const rect = wrap.getBoundingClientRect()
          const pointerX = event.clientX - rect.left
          const pointerY = event.clientY - rect.top
          const current = sizeRef.current
          const view = viewRef.current
          if (current.width <= 0 || current.height <= 0) return
          const step = event.deltaMode === 1 ? 0.05 : 0.0016
          const nextScale = clamp(view.scale * Math.exp(-event.deltaY * step), 0.08, 3.2)
          const world = unprojectPoint(pointerX, pointerY, view, current.width, current.height)
          view.scale = nextScale
          view.center.x = world.x - (pointerX - current.width / 2) / nextScale
          view.center.y = world.y - (pointerY - current.height / 2) / nextScale
          draw()
        }
        wrap.addEventListener('wheel', onWheel, { passive: false })
        return () => {
          wrap.removeEventListener('wheel', onWheel)
        }
      }, [draw])

      const pointerPosition = (event) => {
        const wrap = wrapRef.current
        if (wrap === null) return null
        const rect = wrap.getBoundingClientRect()
        return { x: event.clientX - rect.left, y: event.clientY - rect.top }
      }

      const onPointerDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        // Overlay controls (empty-state CTA, no-match reset) sit on top of the
        // canvas; never start a pan or grab pointer capture from them or their
        // click would be retargeted to the capture element.
        const target = event.target
        if (target !== null && typeof target.closest === 'function'
          && target.closest('button, input, select, textarea, a') !== null) return
        const position = pointerPosition(event)
        const wrap = wrapRef.current
        if (position === null || wrap === null) return
        const hitId = hitTest(position.x, position.y)
        const view = viewRef.current
        interactionRef.current = {
          kind: hitId === null ? 'pan' : 'node',
          id: hitId,
          startX: position.x,
          startY: position.y,
          centerX: view.center.x,
          centerY: view.center.y,
          moved: false,
        }
        if (hitId !== null) {
          const sim = simRef.current
          if (sim !== null) sim.dragId = hitId
          reheat(14)
          onSelect(hitId)
          setDragging(true)
        }
        if (typeof wrap.setPointerCapture === 'function') {
          try {
            wrap.setPointerCapture(event.pointerId)
          } catch {
            // Pointer capture is best-effort.
          }
        }
      }

      const onPointerMove = (event) => {
        const position = pointerPosition(event)
        if (position === null) return
        const interaction = interactionRef.current
        const current = sizeRef.current
        if (interaction !== null) {
          const deltaX = position.x - interaction.startX
          const deltaY = position.y - interaction.startY
          if (Math.abs(deltaX) + Math.abs(deltaY) > 3) interaction.moved = true
          const view = viewRef.current
          if (interaction.kind === 'pan') {
            view.center.x = interaction.centerX - deltaX / view.scale
            view.center.y = interaction.centerY - deltaY / view.scale
            draw()
            return
          }
          if (interaction.kind === 'node' && interaction.id !== null) {
            const world = unprojectPoint(position.x, position.y, view, current.width, current.height)
            const nodePosition = posRef.current.get(interaction.id)
            if (nodePosition !== undefined) {
              nodePosition.x = world.x
              nodePosition.y = world.y
              reheat(12)
              draw()
            }
            return
          }
        }
        const hitId = hitTest(position.x, position.y)
        if (hitId === null) {
          if (hoverRef.current !== null) {
            hoverRef.current = null
            setHoverNode(null)
            draw()
          }
          return
        }
        hoverRef.current = { id: hitId }
        setHoverNode({ id: hitId, x: position.x, y: position.y })
      }

      const endInteraction = (event) => {
        const interaction = interactionRef.current
        interactionRef.current = null
        const sim = simRef.current
        if (sim !== null) {
          sim.dragId = null
          reheat(6)
        }
        setDragging(false)
        const wrap = wrapRef.current
        if (wrap !== null && typeof wrap.releasePointerCapture === 'function') {
          try {
            wrap.releasePointerCapture(event.pointerId)
          } catch {
            // Pointer capture is best-effort.
          }
        }
        if (interaction !== null && interaction.kind === 'pan' && !interaction.moved) onSelect(null)
      }

      const onPointerLeave = () => {
        if (interactionRef.current !== null) return
        if (hoverRef.current === null) return
        hoverRef.current = null
        setHoverNode(null)
        draw()
      }

      const onDoubleClick = () => {
        fitView()
        draw()
      }

      const hoveredNode = hoverNode === null || data === null ? null : data.byId.get(hoverNode.id) ?? null
      const hoverPosition = hoverNode === null || hoveredNode === null ? null : {
        x: clamp(hoverNode.x, 90, Math.max(90, size.width - 90)),
        y: clamp(hoverNode.y, 64, Math.max(64, size.height - 8)),
      }

      return h('div', {
        ref: wrapRef,
        className: 'dsh-memory-brain-canvasWrap',
        'data-dragging': dragging,
        onPointerDown,
        onPointerMove,
        onPointerUp: endInteraction,
        onPointerCancel: endInteraction,
        onPointerLeave,
        onDoubleClick,
      },
        h('canvas', {
          ref: canvasRef,
          className: 'dsh-memory-brain-canvas',
          role: 'img',
          'aria-label': t('canvas.aria'),
        }),
        overlay,
        hoverPosition === null || hoveredNode === null
          ? null
          : h('div', {
            className: 'dsh-memory-brain-tooltip',
            role: 'tooltip',
            style: { left: `${Math.round(hoverPosition.x)}px`, top: `${Math.round(hoverPosition.y)}px` },
          },
          h('div', { className: 'dsh-memory-brain-tooltipTitle' }, isTombstoneNode(hoveredNode) ? t('tombstone.label') : (hoveredNode.label || '·')),
          h('div', { className: 'dsh-memory-brain-tooltipMeta' },
            t('canvas.tooltip.retention', {
              value: Math.round((projected.has(hoveredNode.id) ? projected.get(hoveredNode.id) : hoveredNode.retention) * 100),
            })),
          isTombstoneNode(hoveredNode)
            ? h('div', { className: 'dsh-memory-brain-tooltipMeta' }, t('detail.tombstone'))
            : (hoveredNode.sessionTitle === ''
              ? null
              : h('div', { className: 'dsh-memory-brain-tooltipMeta' }, t('canvas.tooltip.session', { title: hoveredNode.sessionTitle }))),
          hoveredNode.kind === 'episode'
            ? h('div', { className: 'dsh-memory-brain-tooltipMeta' }, t('canvas.tooltip.turn', { turn: Math.round(num(hoveredNode.turn, 0)) }))
            : null))
    }

    /**
     * 3D memory network (CONTRACT 7): perspective orbit camera, 3D force
     * layout, painter's-algorithm depth sorting and one name label per visible
     * node. Props mirror MemoryCanvas; `autoRotate` and `resetSeq` are the two
     * extra inputs the canvas header needs for CONTRACT 7.4.
     */
    function MemoryCanvas3D({ data, projected, topologyKey, selectedId, onSelect, filters, travelDays, t, overlay, autoRotate, resetSeq }) {
      const wrapRef = React.useRef(null)
      const canvasRef = React.useRef(null)
      const positionsRef = React.useRef(new Map())
      const simRef = React.useRef(null)
      const cameraRef = React.useRef({
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        distance: 1200,
        fitted: false,
        pauseUntil: 0,
      })
      const autoRotateRef = React.useRef(autoRotate !== false)
      autoRotateRef.current = autoRotate !== false
      const sizeRef = React.useRef({ width: 0, height: 0 })
      const tokensRef = React.useRef(null)
      const propsRef = React.useRef(null)
      const interactionRef = React.useRef(null)
      const hoverRef = React.useRef(null)
      const rafRef = React.useRef(0)
      const runningRef = React.useRef(false)
      const drawErrorRef = React.useRef(false)
      const lastResetRef = React.useRef(resetSeq)

      const [size, setSize] = React.useState({ width: 0, height: 0 })
      const [hoverNode, setHoverNode] = React.useState(null)
      const [dragging, setDragging] = React.useState(false)

      propsRef.current = { data, projected, selectedId, filters, t }
      sizeRef.current = size

      const stopLoop = React.useCallback(() => {
        if (rafRef.current !== 0) {
          window.cancelAnimationFrame(rafRef.current)
          rafRef.current = 0
        }
        runningRef.current = false
      }, [])

      const draw = React.useCallback(() => {
        const canvas = canvasRef.current
        const wrap = wrapRef.current
        if (canvas === null || wrap === null) return
        const current = sizeRef.current
        if (current.width <= 0 || current.height <= 0) return
        const context = canvas.getContext('2d')
        if (context === null) return
        try {
          drawScene3D(context, {
            canvas,
            wrap,
            width: current.width,
            height: current.height,
            props: propsRef.current,
            positions: positionsRef.current,
            camera: cameraRef.current,
            tokensRef,
            hoverId: hoverRef.current === null ? null : hoverRef.current.id,
          })
        } catch (error) {
          if (!drawErrorRef.current) {
            drawErrorRef.current = true
            console.warn('dsh-memory-brain: 3D canvas draw failed', error)
          }
        }
      }, [])

      const tick = React.useCallback(() => {
        rafRef.current = 0
        const camera = cameraRef.current
        const now = Date.now()
        // Auto-rotate pauses for 2s after any interaction; keeping the pointer
        // over a node holds it still so the tooltip stays anchored.
        const autoRotating = autoRotateRef.current && now >= camera.pauseUntil && hoverRef.current === null
        if (autoRotating) camera.yaw += AUTO_ROTATE_STEP
        const sim = simRef.current
        if (sim !== null && sim.temperature > SIM_STOP_TEMPERATURE) simulateStep3D(sim)
        draw()
        const interaction = interactionRef.current
        const continueLoop = autoRotateRef.current
          || (interaction !== null && interaction.kind === 'node')
          || (sim !== null && (sim.temperature > SIM_STOP_TEMPERATURE || sim.dragId !== null))
        if (continueLoop) {
          runningRef.current = true
          rafRef.current = window.requestAnimationFrame(tick)
          return
        }
        runningRef.current = false
      }, [draw])

      const ensureLoop = React.useCallback(() => {
        if (runningRef.current) return
        runningRef.current = true
        rafRef.current = window.requestAnimationFrame(tick)
      }, [tick])

      const reheat = React.useCallback((energy) => {
        const sim = simRef.current
        if (sim === null) return
        sim.temperature = Math.max(sim.temperature, typeof energy === 'number' ? energy : SIM_START_TEMPERATURE)
        ensureLoop()
      }, [ensureLoop])

      const hitTest = React.useCallback((pointerX, pointerY) => {
        const props = propsRef.current
        const currentData = props.data
        if (currentData === null) return null
        const current = sizeRef.current
        if (current.width <= 0 || current.height <= 0) return null
        const camera = cameraRef.current
        for (let index = currentData.nodes.length - 1; index >= 0; index -= 1) {
          const node = currentData.nodes[index]
          if (!nodeMatchesFilters(node, props.filters)) continue
          const position = positionsRef.current.get(node.id)
          if (position === undefined) continue
          const point = projectCamera(position, camera, current.width, current.height)
          if (point === null) continue
          const retention = props.projected.has(node.id) ? props.projected.get(node.id) : node.retention
          const radius = clamp(nodeBaseRadius(node, retention) * point.scale, 2.5, 46) + 4
          const dx = pointerX - point.x
          const dy = pointerY - point.y
          if (dx * dx + dy * dy <= radius * radius) return node.id
        }
        return null
      }, [])

      const buildSimulation = React.useCallback(() => {
        const currentData = propsRef.current.data
        const positions = positionsRef.current
        const alive = new Set()
        const items = []
        const itemById = new Map()
        if (currentData !== null) {
          for (const node of currentData.nodes) {
            alive.add(node.id)
            let position = positions.get(node.id)
            if (position === undefined) {
              position = seedPosition3d(node.id)
              positions.set(node.id, position)
            }
            const item = {
              id: node.id,
              pos: position,
              radius: nodeBaseRadius(node, node.retention),
              dx: 0,
              dy: 0,
              dz: 0,
            }
            items.push(item)
            itemById.set(node.id, item)
          }
        }
        for (const id of [...positions.keys()]) {
          if (!alive.has(id)) positions.delete(id)
        }
        const edges = []
        if (currentData !== null) {
          for (const edge of currentData.edges) {
            const itemA = itemById.get(edge.source)
            const itemB = itemById.get(edge.target)
            if (itemA === undefined || itemB === undefined || itemA === itemB) continue
            edges.push({ a: itemA, b: itemB, stiffness: edgeStiffness(edge) })
          }
        }
        stopLoop()
        simRef.current = {
          items,
          edges,
          temperature: SIM_START_TEMPERATURE,
          dragId: null,
        }
      }, [stopLoop])

      // Rebuild the 3D simulation only when the topology changes; value-only
      // updates just redraw and keep the camera untouched (CONTRACT 7.3).
      React.useEffect(() => {
        const previous = simRef.current
        const wasEmpty = previous === null || previous.items.length === 0
        buildSimulation()
        const next = simRef.current
        const camera = cameraRef.current
        if (next !== null && next.items.length > 0) {
          if (wasEmpty || !camera.fitted) {
            camera.distance = autoCameraDistance(positionsRef.current)
            camera.fitted = true
          }
          ensureLoop()
        }
        draw()
        return () => {
          stopLoop()
        }
      }, [topologyKey, buildSimulation, ensureLoop, draw, stopLoop])

      // Container measurement + backing-store sizing (same pattern as 2D).
      React.useEffect(() => {
        const wrap = wrapRef.current
        if (wrap === null) return undefined
        const measure = () => {
          const rect = wrap.getBoundingClientRect()
          const width = Math.max(0, Math.round(rect.width))
          const height = Math.max(0, Math.round(rect.height))
          setSize((previousSize) => (previousSize.width === width && previousSize.height === height ? previousSize : { width, height }))
        }
        measure()
        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          observer.observe(wrap)
        } else {
          window.addEventListener('resize', measure)
        }
        return () => {
          if (observer !== null) observer.disconnect()
          else window.removeEventListener('resize', measure)
        }
      }, [])

      React.useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null) return
        const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
        const nextWidth = Math.max(1, Math.round(size.width * ratio))
        const nextHeight = Math.max(1, Math.round(size.height * ratio))
        if (canvas.width !== nextWidth) canvas.width = nextWidth
        if (canvas.height !== nextHeight) canvas.height = nextHeight
        draw()
        if (autoRotateRef.current) ensureLoop()
      }, [size, draw, ensureLoop])

      // Redraw after every render (filters / travel / selection changes).
      React.useEffect(() => {
        draw()
      })

      // Reset-view signal from the canvas header (CONTRACT 7.4).
      React.useEffect(() => {
        if (resetSeq === lastResetRef.current) return
        lastResetRef.current = resetSeq
        const camera = cameraRef.current
        camera.yaw = DEFAULT_YAW
        camera.pitch = DEFAULT_PITCH
        camera.distance = autoCameraDistance(positionsRef.current)
        camera.fitted = true
        camera.pauseUntil = 0
        draw()
      }, [resetSeq, draw])

      // Auto-rotate switch from the canvas header (default on).
      React.useEffect(() => {
        autoRotateRef.current = autoRotate !== false
        if (autoRotateRef.current) ensureLoop()
        else draw()
      }, [autoRotate, ensureLoop, draw])

      // Native wheel listener so preventDefault works.
      React.useEffect(() => {
        const wrap = wrapRef.current
        if (wrap === null) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const camera = cameraRef.current
          camera.pauseUntil = Math.max(camera.pauseUntil, Date.now() + INTERACTION_PAUSE_MS)
          camera.distance = clamp(camera.distance * Math.exp(event.deltaY * 0.001), DISTANCE_MIN, DISTANCE_MAX)
          draw()
        }
        wrap.addEventListener('wheel', onWheel, { passive: false })
        return () => {
          wrap.removeEventListener('wheel', onWheel)
        }
      }, [draw])

      // Recover from a hidden tab: keep drawing once visible again.
      React.useEffect(() => {
        const onVisibility = () => {
          if (!document.hidden && autoRotateRef.current) ensureLoop()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [ensureLoop])

      const pointerPosition = (event) => {
        const wrap = wrapRef.current
        if (wrap === null) return null
        const rect = wrap.getBoundingClientRect()
        return { x: event.clientX - rect.left, y: event.clientY - rect.top }
      }

      const pauseAutoRotate = () => {
        const camera = cameraRef.current
        camera.pauseUntil = Math.max(camera.pauseUntil, Date.now() + INTERACTION_PAUSE_MS)
      }

      const onPointerDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        // Let overlay controls (empty-state CTA, no-match reset) keep their clicks.
        const target = event.target
        if (target !== null && typeof target.closest === 'function'
          && target.closest('button, input, select, textarea, a') !== null) return
        const position = pointerPosition(event)
        const wrap = wrapRef.current
        if (position === null || wrap === null) return
        pauseAutoRotate()
        const hitId = hitTest(position.x, position.y)
        interactionRef.current = {
          kind: hitId === null ? 'rotate' : 'node',
          id: hitId,
          startX: position.x,
          startY: position.y,
          lastX: position.x,
          lastY: position.y,
          moved: false,
        }
        if (hitId !== null) {
          const sim = simRef.current
          if (sim !== null) sim.dragId = hitId
          reheat(14)
          onSelect(hitId)
          setDragging(true)
        }
        if (typeof wrap.setPointerCapture === 'function') {
          try {
            wrap.setPointerCapture(event.pointerId)
          } catch {
            // Pointer capture is best-effort.
          }
        }
        ensureLoop()
      }

      const onPointerMove = (event) => {
        const position = pointerPosition(event)
        if (position === null) return
        const interaction = interactionRef.current
        const current = sizeRef.current
        const camera = cameraRef.current
        if (interaction !== null) {
          const deltaX = position.x - interaction.lastX
          const deltaY = position.y - interaction.lastY
          interaction.lastX = position.x
          interaction.lastY = position.y
          if (Math.abs(position.x - interaction.startX) + Math.abs(position.y - interaction.startY) > 3) interaction.moved = true
          if (interaction.kind === 'rotate') {
            // CONTRACT 7.4: yaw += dx*0.006, pitch -= dy*0.006, clamped.
            camera.yaw += deltaX * 0.006
            camera.pitch = clamp(camera.pitch - deltaY * 0.006, -PITCH_LIMIT, PITCH_LIMIT)
            pauseAutoRotate()
            draw()
            return
          }
          if (interaction.kind === 'node' && interaction.id !== null) {
            const nodePosition = positionsRef.current.get(interaction.id)
            if (nodePosition !== undefined && current.width > 0 && current.height > 0) {
              const focal = 0.9 * Math.min(current.width, current.height)
              const projection = projectCamera(nodePosition, camera, current.width, current.height)
              if (projection !== null && focal > 0) {
                // Move in the plane that faces the camera (keep depth).
                const worldPerPixel = projection.zCamera / focal
                const basis = cameraBasis(camera.yaw, camera.pitch)
                nodePosition.x += (basis.right.x * deltaX - basis.up.x * deltaY) * worldPerPixel
                nodePosition.y += (basis.right.y * deltaX - basis.up.y * deltaY) * worldPerPixel
                nodePosition.z += (basis.right.z * deltaX - basis.up.z * deltaY) * worldPerPixel
                reheat(12)
              }
            }
            pauseAutoRotate()
            draw()
            return
          }
        }
        const hitId = hitTest(position.x, position.y)
        if (hitId === null) {
          if (hoverRef.current !== null) {
            hoverRef.current = null
            setHoverNode(null)
            draw()
          }
          return
        }
        pauseAutoRotate()
        hoverRef.current = { id: hitId }
        const hoveredPosition = positionsRef.current.get(hitId)
        const hoveredPoint = hoveredPosition === undefined
          ? null
          : projectCamera(hoveredPosition, camera, current.width, current.height)
        setHoverNode({
          id: hitId,
          x: hoveredPoint === null ? position.x : hoveredPoint.x,
          y: hoveredPoint === null ? position.y : hoveredPoint.y,
        })
      }

      const endInteraction = (event) => {
        const interaction = interactionRef.current
        interactionRef.current = null
        const sim = simRef.current
        if (sim !== null) {
          sim.dragId = null
          reheat(6)
        }
        setDragging(false)
        const wrap = wrapRef.current
        if (wrap !== null && typeof wrap.releasePointerCapture === 'function') {
          try {
            wrap.releasePointerCapture(event.pointerId)
          } catch {
            // Pointer capture is best-effort.
          }
        }
        if (interaction !== null && interaction.kind === 'rotate' && !interaction.moved) onSelect(null)
      }

      const onPointerLeave = () => {
        if (interactionRef.current !== null) return
        if (hoverRef.current === null) return
        hoverRef.current = null
        setHoverNode(null)
        draw()
      }

      const hoveredNode = hoverNode === null || data === null ? null : data.byId.get(hoverNode.id) ?? null
      const hoverPosition = hoverNode === null || hoveredNode === null ? null : {
        x: clamp(hoverNode.x, 90, Math.max(90, size.width - 90)),
        y: clamp(hoverNode.y, 64, Math.max(64, size.height - 8)),
      }

      return h('div', {
        ref: wrapRef,
        className: 'dsh-memory-brain-canvas3dWrap',
        'data-dragging': dragging,
        onPointerDown,
        onPointerMove,
        onPointerUp: endInteraction,
        onPointerCancel: endInteraction,
        onPointerLeave,
      },
        h('canvas', {
          ref: canvasRef,
          className: 'dsh-memory-brain-canvas3d',
          role: 'img',
          'aria-label': t('canvas.aria3d'),
        }),
        overlay,
        hoverPosition === null || hoveredNode === null
          ? null
          : h('div', {
            className: 'dsh-memory-brain-tooltip',
            role: 'tooltip',
            style: { left: `${Math.round(hoverPosition.x)}px`, top: `${Math.round(hoverPosition.y)}px` },
          },
          h('div', { className: 'dsh-memory-brain-tooltipTitle' }, isTombstoneNode(hoveredNode) ? t('tombstone.label') : (hoveredNode.label || '·')),
          h('div', { className: 'dsh-memory-brain-tooltipMeta' },
            t('canvas.tooltip.retention', {
              value: Math.round((projected.has(hoveredNode.id) ? projected.get(hoveredNode.id) : hoveredNode.retention) * 100),
            })),
          isTombstoneNode(hoveredNode)
            ? h('div', { className: 'dsh-memory-brain-tooltipMeta' }, t('detail.tombstone'))
            : (hoveredNode.sessionTitle === ''
              ? null
              : h('div', { className: 'dsh-memory-brain-tooltipMeta' }, t('canvas.tooltip.session', { title: hoveredNode.sessionTitle }))),
          hoveredNode.kind === 'episode'
            ? h('div', { className: 'dsh-memory-brain-tooltipMeta' }, t('canvas.tooltip.turn', { turn: Math.round(num(hoveredNode.turn, 0)) }))
            : null))
    }

    // ---------------------------------------------------------------------
    // Task-embedded view (CONTRACT 9) — one task's own memory network
    // ---------------------------------------------------------------------

    /**
     * Conversation View for one task (CONTRACT 9.2): a scoped mini 3D network,
     * the task's memory list, and the shared DetailCard for selection/actions.
     * @param {{ store: any, actions: any, sessionId?: string, t: any }} props
     */
    function MemoryTaskView({ store, actions, sessionId, t }) {
      const snapshot = useStore(store)
      const fullData = snapshot.data
      const pending = snapshot.pending
      const [selectedId, setSelectedId] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)

      const scopedData = React.useMemo(() => buildTaskScopedData(fullData, sessionId), [fullData, sessionId])
      const projected = React.useMemo(() => computeProjected(scopedData, 0), [scopedData])
      const topologyKey = React.useMemo(() => topologySignature(scopedData), [scopedData])
      const selected = selectedId === null ? null : scopedData.byId.get(selectedId) ?? null
      const sessionTitle = React.useMemo(() => {
        if (!isObject(fullData) || !Array.isArray(fullData.sessions)) return ''
        const match = fullData.sessions.find((row) => isObject(row) && row.sessionId === sessionId)
        return match !== undefined && typeof match.title === 'string' ? match.title : ''
      }, [fullData, sessionId])
      const sessionIsQq = React.useMemo(() => {
        if (!isObject(fullData) || !Array.isArray(fullData.sessions)) return false
        const match = fullData.sessions.find((row) => isObject(row) && row.sessionId === sessionId)
        return match !== undefined && match.source === 'qq'
      }, [fullData, sessionId])
      const listNodes = React.useMemo(() => {
        const episodes = []
        for (const node of scopedData.nodes) {
          if (node.kind === 'episode') episodes.push(node)
        }
        episodes.sort((left, right) => (num(left.turn, 0) - num(right.turn, 0)) || (num(left.createdAt, 0) - num(right.createdAt, 0)))
        return episodes
      }, [scopedData])

      // Poll while this view is mounted, pausing while the tab is hidden.
      React.useEffect(() => {
        let disposed = false
        const sync = () => {
          if (!disposed) void actions.load({ quiet: true })
        }
        sync()
        const timer = window.setInterval(() => {
          if (document.hidden) return
          sync()
        }, POLL_INTERVAL_MS)
        const onVisibility = () => {
          if (!document.hidden) sync()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          disposed = true
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [actions])

      // A node that disappeared (hard-forgotten elsewhere) drops the selection.
      React.useEffect(() => {
        if (selectedId !== null && !scopedData.byId.has(selectedId)) setSelectedId(null)
      }, [selectedId, scopedData])

      // Switching the task resets the selection.
      React.useEffect(() => {
        setSelectedId(null)
      }, [sessionId])

      const refresh = async () => {
        if (refreshing) return
        setRefreshing(true)
        try {
          await actions.load()
        } finally {
          setRefreshing(false)
        }
      }

      const openGlobal = () => {
        if (typeof actions.openGlobalMemory === 'function') actions.openGlobalMemory(sessionId)
      }

      const stats = scopedData.stats
      const statsText = t('task.stats', {
        total: Math.round(num(stats.total, 0)),
        active: Math.round(num(stats.active, 0)),
        retention: Math.round(clamp(num(stats.avgRetention, 0), 0, 1) * 100),
      })

      let body = null
      if (fullData === null) {
        body = h('div', { className: 'dsh-memory-brain-taskLoading', role: 'status' },
          h('div', { className: 'dsh-memory-brain-spinner', 'aria-hidden': 'true' }),
          h('span', null, t('task.loading')))
      } else if (scopedData.nodes.length === 0) {
        body = h('div', { className: 'dsh-memory-brain-taskEmpty' },
          h(BrainGlyph, { size: 40, active: false }),
          h('p', { className: 'dsh-memory-brain-taskEmptyTitle' }, t('task.empty.title')),
          h('p', { className: 'dsh-memory-brain-taskEmptyBody' }, t('task.empty.body')),
          h('div', { className: 'dsh-memory-brain-taskEmptyActions' },
            h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-primary dsh-memory-brain-btn-small',
              disabled: pending !== null,
              onClick: () => {
                void actions.capture()
              },
            }, pending === 'capture' ? t('action.capturing') : t('task.capture')),
            h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary dsh-memory-brain-btn-small',
              onClick: openGlobal,
            }, t('task.openGlobal'))))
      } else {
        body = h('div', { className: 'dsh-memory-brain-taskMain' },
          h('div', { className: 'dsh-memory-brain-taskCanvasCard' },
            h(MemoryCanvas3D, {
              data: scopedData,
              projected,
              topologyKey,
              selectedId,
              onSelect: setSelectedId,
              filters: TASK_DEFAULT_FILTERS,
              travelDays: 0,
              t,
              overlay: null,
              autoRotate: true,
              resetSeq: 0,
            }),
            selected === null
              ? null
              : h('aside', { className: 'dsh-memory-brain-taskDetail', 'aria-label': t('detail.title') },
                h('div', { className: 'dsh-memory-brain-taskDetailHead' },
                  h('span', { className: 'dsh-memory-brain-taskDetailTitle' }, t('detail.title')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-memory-brain-taskDetailClose',
                    title: t('detail.close'),
                    'aria-label': t('detail.close'),
                    onClick: () => setSelectedId(null),
                  }, '×')),
                h('div', { className: 'dsh-memory-brain-taskDetailScroll' },
                  h(DetailCard, {
                    key: selected.id,
                    node: selected,
                    data: scopedData,
                    projected,
                    travelDays: 0,
                    actions,
                    pending,
                    t,
                  })))),
          h('div', { className: 'dsh-memory-brain-taskListCard' },
            h('div', { className: 'dsh-memory-brain-taskListHead' },
              h('span', null, t('task.list')),
              h('span', null, String(listNodes.length))),
            h('ul', { className: 'dsh-memory-brain-taskList' }, listNodes.map((node) => {
              const retention = projected.has(node.id) ? projected.get(node.id) : node.retention
              const tombstone = isTombstoneNode(node)
              const tagLabel = tombstone
                ? t('tombstone.label')
                : (Array.isArray(node.tags) && node.tags.length > 0 ? node.tags[0] : (node.label || '·'))
              return h('li', { key: node.id },
                h('button', {
                  type: 'button',
                  className: 'dsh-memory-brain-taskListItem',
                  'aria-pressed': selectedId === node.id,
                  title: node.excerpt || (tombstone ? t('detail.tombstone') : undefined),
                  onClick: () => setSelectedId((current) => (current === node.id ? null : node.id)),
                },
                  h('span', { className: 'dsh-memory-brain-taskListTurn' }, t('task.turn', { turn: Math.round(num(node.turn, 0)) })),
                  h('span', { className: 'dsh-memory-brain-taskListLabel' }, tombstone ? tagLabel : `#${tagLabel}`),
                  h('span', { className: 'dsh-memory-brain-taskListRetention' }, t('task.retention', { value: Math.round(clamp(num(retention, 0), 0, 1) * 100) })),
                  h('span', { className: 'dsh-memory-brain-taskListExcerpt' }, tombstone ? '—' : (firstChars(node.excerpt, 40) || '—'))))
            }))))
      }

      return h('section', { className: 'dsh-memory-brain-task', 'aria-label': t('task.title') },
        h('header', { className: 'dsh-memory-brain-taskHeader' },
          h('div', { className: 'dsh-memory-brain-taskHeading' },
            h('h2', { className: 'dsh-memory-brain-taskTitle' }, t('task.title')),
            sessionIsQq
              ? h('span', {
                className: 'dsh-memory-brain-qqBadge',
                title: t('task.qq'),
                'aria-label': t('task.qq'),
              }, t('task.qq'))
              : null,
            sessionTitle === '' ? null : h('span', { className: 'dsh-memory-brain-taskStats' }, sessionTitle),
            h('span', { className: 'dsh-memory-brain-taskStats' }, statsText)),
          h('div', { className: 'dsh-memory-brain-taskActions' },
            h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-ghost dsh-memory-brain-btn-small',
              disabled: refreshing || pending !== null,
              onClick: () => {
                void refresh()
              },
            }, refreshing ? t('task.refreshing') : t('task.refresh')),
            h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary dsh-memory-brain-btn-small',
              disabled: fullData === null,
              onClick: openGlobal,
            }, t('task.openGlobal')))),
        snapshot.error === null
          ? null
          : h('div', { className: 'dsh-memory-brain-taskBanner', role: 'alert' },
            h('span', { className: 'dsh-memory-brain-taskBannerText' }, t('task.error', { message: snapshot.error })),
            h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-small dsh-memory-brain-btn-secondary',
              onClick: actions.dismissError,
            }, t('error.dismiss'))),
        h('div', { className: 'dsh-memory-brain-taskBody' }, body))
    }

    // ---------------------------------------------------------------------
    // Full-page panel
    // ---------------------------------------------------------------------

    /**
     * The whole Memory Network page. Owns selection, filters, time travel, and
     * polling; all business data comes from the injected store.
     * @param {{ store: any, actions: any, t: any }} props
     */
    function MemoryBrainPage({ store, actions, t }) {
      const snapshot = useStore(store)
      const data = snapshot.data
      const error = snapshot.error
      const pending = snapshot.pending
      const busy = pending !== null

      const [selectedId, setSelectedId] = React.useState(null)
      const [sessionFilter, setSessionFilter] = React.useState(null)
      const [tagFilter, setTagFilter] = React.useState([])
      const [search, setSearch] = React.useState('')
      const [showForgotten, setShowForgotten] = React.useState(false)
      const [travelDays, setTravelDays] = React.useState(0)
      const [leftOpen, setLeftOpen] = React.useState(true)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [refreshing, setRefreshing] = React.useState(false)
      const [viewMode, setViewMode] = React.useState('3d')
      const [autoRotate, setAutoRotate] = React.useState(true)
      const [resetViewSeq, setResetViewSeq] = React.useState(0)
      const [fullscreen, setFullscreen] = React.useState(false)
      const [immersive, setImmersive] = React.useState(false)
      const pageRef = React.useRef(null)
      const fullscreenActive = fullscreen || immersive

      const filters = React.useMemo(
        () => ({ session: sessionFilter, tags: tagFilter, search, showForgotten }),
        [sessionFilter, tagFilter, search, showForgotten],
      )
      const offsetMs = travelDays * DAY_MS
      const projected = React.useMemo(() => computeProjected(data, offsetMs), [data, offsetMs])
      const topologyKey = React.useMemo(() => topologySignature(data), [data])
      const selected = data === null || selectedId === null ? null : data.byId.get(selectedId) ?? null

      const visibleCount = React.useMemo(() => {
        if (data === null) return 0
        let count = 0
        for (const node of data.nodes) {
          if (nodeMatchesFilters(node, filters)) count += 1
        }
        return count
      }, [data, filters])

      // Drop a selection whose memory disappeared (forgotten hard elsewhere).
      React.useEffect(() => {
        if (selectedId !== null && (data === null || !data.byId.has(selectedId))) setSelectedId(null)
      }, [selectedId, data])

      // Poll while mounted; pause while the tab is hidden, resync on return.
      React.useEffect(() => {
        let disposed = false
        const sync = () => {
          if (!disposed) void actions.load({ quiet: true })
        }
        sync()
        const timer = window.setInterval(() => {
          if (document.hidden) return
          sync()
        }, POLL_INTERVAL_MS)
        const onVisibility = () => {
          if (!document.hidden) sync()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          disposed = true
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [actions])

      // A task view may ask the global panel to open filtered to that task
      // (CONTRACT 9.2). Apply it once, then consume the shared flag.
      const pendingSession = snapshot.pendingSession === undefined ? null : snapshot.pendingSession
      React.useEffect(() => {
        if (pendingSession === null) return
        setSessionFilter(pendingSession)
        setLeftOpen(true)
        actions.consumePendingSession()
      }, [pendingSession, actions])

      // Esc exits the immersive fallback, then clears selection and filters.
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (immersive) setImmersive(false)
          setSelectedId(null)
          setSessionFilter(null)
          setTagFilter([])
          setSearch('')
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [immersive])

      // Keep the native fullscreen state in sync and leave fullscreen when the
      // panel unmounts. Native fullscreen is the primary path; `immersive` is
      // the in-panel fallback when the browser refuses or lacks the API.
      React.useEffect(() => {
        const page = pageRef.current
        const onFullscreenChange = () => {
          setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === page)
        }
        document.addEventListener('fullscreenchange', onFullscreenChange)
        onFullscreenChange()
        return () => {
          document.removeEventListener('fullscreenchange', onFullscreenChange)
          if (page !== null && document.fullscreenElement === page && typeof document.exitFullscreen === 'function') {
            try {
              const exitResult = document.exitFullscreen()
              if (exitResult !== undefined && typeof exitResult.then === 'function') exitResult.catch(() => {})
            } catch {
              // Best-effort cleanup; never break unmounting.
            }
          }
        }
      }, [])

      /**
       * Enter/exit fullscreen: browser Fullscreen API first, in-panel immersive
       * layout as the fallback. Never throws (CONTRACT 8.1).
       */
      const toggleFullscreen = React.useCallback(async () => {
        const page = pageRef.current
        if (fullscreenActive) {
          if (document.fullscreenElement !== null && typeof document.exitFullscreen === 'function') {
            try {
              const exitResult = document.exitFullscreen()
              if (exitResult !== undefined && typeof exitResult.then === 'function') await exitResult
            } catch (error) {
              console.warn('dsh-memory-brain: exitFullscreen failed', error)
            }
          }
          setImmersive(false)
          setFullscreen(false)
          return
        }
        if (page === null || typeof page.requestFullscreen !== 'function') {
          setImmersive(true)
          return
        }
        try {
          const requestResult = page.requestFullscreen({ navigationUI: 'hide' })
          if (requestResult !== undefined && typeof requestResult.then === 'function') await requestResult
          // Some browsers resolve without a synchronous event; adopt the state.
          if (document.fullscreenElement === page) setFullscreen(true)
        } catch (error) {
          console.warn('dsh-memory-brain: requestFullscreen rejected, falling back to immersive layout', error)
          setImmersive(true)
        }
      }, [fullscreenActive])

      const clearFilters = React.useCallback(() => {
        setSessionFilter(null)
        setTagFilter([])
        setSearch('')
      }, [])

      const refresh = async () => {
        if (refreshing) return
        setRefreshing(true)
        try {
          await actions.load()
        } finally {
          setRefreshing(false)
        }
      }

      const toggleSession = (sessionId) => {
        setSessionFilter((current) => (current === sessionId ? null : sessionId))
      }
      const toggleTag = (tag) => {
        setTagFilter((current) => (current.indexOf(tag) === -1 ? [...current, tag] : current.filter((item) => item !== tag)))
      }

      const stats = data === null ? null : data.stats
      const statsChips = stats === null ? null : [
        h(StatChip, { key: 'total', label: t('stats.total'), value: String(Math.round(stats.total)), tone: 'total' }),
        h(StatChip, { key: 'active', label: t('stats.active'), value: String(Math.round(stats.active)), tone: 'active' }),
        h(StatChip, { key: 'fading', label: t('stats.fading'), value: String(Math.round(stats.fading)), tone: 'fading' }),
        h(StatChip, { key: 'forgotten', label: t('stats.forgotten'), value: String(Math.round(stats.forgotten)), tone: 'forgotten' }),
        h(StatChip, { key: 'pinned', label: t('stats.pinned'), value: String(Math.round(stats.pinned)), tone: 'pinned' }),
        h(StatChip, { key: 'avgRetention', label: t('stats.avgRetention'), value: formatPercent(stats.avgRetention), tone: 'retention' }),
      ]

      let overlay = null
      if (data === null) {
        overlay = h('div', { className: 'dsh-memory-brain-canvasEmpty', role: 'status' },
          h('div', { className: 'dsh-memory-brain-spinner', 'aria-hidden': 'true' }),
          h('p', { className: 'dsh-memory-brain-emptyBody' }, t('canvas.loading')))
      } else if (data.nodes.length === 0) {
        overlay = h(CanvasEmpty, {
          pending,
          onCapture: () => {
            void actions.capture()
          },
          t,
        })
      } else if (visibleCount === 0) {
        overlay = h(CanvasNoMatch, { onClear: clearFilters, t })
      }

      return h('section', {
        ref: pageRef,
        className: 'dsh-memory-brain-page',
        'data-left': leftOpen ? 'on' : 'off',
        'data-travel': travelDays > 0 ? 'on' : 'off',
        'data-fullscreen': fullscreenActive ? 'on' : 'off',
        'aria-label': t('page.title'),
      },
        h('header', { className: 'dsh-memory-brain-header' },
          h('div', { className: 'dsh-memory-brain-heading' },
            h('h1', { className: 'dsh-memory-brain-title' }, t('page.title')),
            h('p', { className: 'dsh-memory-brain-subtitle' }, t('page.subtitle'))),
          h('div', { className: 'dsh-memory-brain-chips', role: 'group', 'aria-label': t('page.title') }, statsChips),
          h('div', { className: 'dsh-memory-brain-headerActions' },
            h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-ghost dsh-memory-brain-btn-small',
              'aria-pressed': leftOpen,
              onClick: () => setLeftOpen((current) => !current),
            }, leftOpen ? t('action.filterHide') : t('action.filter')),
            h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary dsh-memory-brain-btn-small',
              disabled: refreshing || busy,
              onClick: () => {
                void refresh()
              },
            }, refreshing ? t('action.refreshing') : t('action.refresh')),
            h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary dsh-memory-brain-btn-small',
              disabled: busy || data === null,
              onClick: () => {
                void actions.sleep()
              },
            }, pending === 'sleep' ? t('action.sleeping') : t('action.sleep')),
            h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary dsh-memory-brain-btn-small',
              disabled: busy,
              onClick: () => {
                void actions.capture()
              },
            }, pending === 'capture' ? t('action.capturing') : t('action.capture')),
            h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary dsh-memory-brain-btn-small',
              'aria-pressed': settingsOpen,
              disabled: data === null,
              onClick: () => setSettingsOpen((current) => !current),
            }, t('action.settings')),
            h(DangerButton, {
              idleLabel: t('action.purge'),
              confirmLabel: t('action.purgeConfirm'),
              pendingLabel: t('action.purging'),
              pending: pending === 'purge',
              disabled: busy || data === null,
              className: 'dsh-memory-brain-btn-dangerGhost dsh-memory-brain-btn-small',
              onConfirm: () => {
                void actions.purge()
              },
            }),
            h(DangerButton, {
              idleLabel: t('action.reset'),
              confirmLabel: t('action.resetConfirm'),
              pendingLabel: t('action.resetting'),
              pending: pending === 'reset',
              disabled: busy || data === null,
              className: 'dsh-memory-brain-btn-danger dsh-memory-brain-btn-small',
              onConfirm: () => {
                void actions.reset()
              },
            }))),
        error === null ? null : h(ErrorBanner, { message: error, onDismiss: actions.dismissError, t }),
        h('div', { className: 'dsh-memory-brain-body' },
          leftOpen
            ? h('aside', { className: 'dsh-memory-brain-left' },
              h(LeftPanel, {
                data,
                sessionFilter,
                tagFilter,
                search,
                showForgotten,
                onToggleSession: toggleSession,
                onToggleTag: toggleTag,
                onSearchChange: setSearch,
                onToggleForgotten: setShowForgotten,
                onClearFilters: clearFilters,
                t,
              }))
            : null,
          h('div', { className: 'dsh-memory-brain-canvasCard' },
            h('div', { className: 'dsh-memory-brain-canvasHead' },
              h('span', { className: 'dsh-memory-brain-canvasMeta' },
                data === null
                  ? t('canvas.loading')
                  : t('canvas.meta', { nodes: data.nodes.length, edges: data.edges.length })),
              h('div', { className: 'dsh-memory-brain-canvasControls' },
                h('div', { className: 'dsh-memory-brain-viewSwitch', role: 'group', 'aria-label': t('view.switchLabel') },
                  h('button', {
                    type: 'button',
                    className: 'dsh-memory-brain-viewSwitchBtn',
                    'aria-pressed': viewMode === '3d',
                    onClick: () => setViewMode('3d'),
                  }, t('view.3d')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-memory-brain-viewSwitchBtn',
                    'aria-pressed': viewMode === '2d',
                    onClick: () => setViewMode('2d'),
                  }, t('view.2d'))),
                viewMode === '3d'
                  ? h('button', {
                    type: 'button',
                    className: 'dsh-memory-brain-btn dsh-memory-brain-btn-ghost dsh-memory-brain-btn-small',
                    onClick: () => setResetViewSeq((current) => current + 1),
                  }, t('view.reset'))
                  : null,
                viewMode === '3d'
                  ? h('button', {
                    type: 'button',
                    className: 'dsh-memory-brain-btn dsh-memory-brain-btn-ghost dsh-memory-brain-btn-small',
                    'aria-pressed': autoRotate,
                    onClick: () => setAutoRotate((current) => !current),
                  }, t('view.autoRotate'))
                  : null,
                h('button', {
                  type: 'button',
                  className: 'dsh-memory-brain-btn dsh-memory-brain-btn-ghost dsh-memory-brain-btn-small',
                  'aria-pressed': fullscreenActive,
                  title: t('view.fullscreenHint'),
                  onClick: () => {
                    void toggleFullscreen()
                  },
                }, fullscreenActive ? t('view.exitFullscreen') : t('view.fullscreen'))),
              h('span', { className: 'dsh-memory-brain-canvasHint' },
                viewMode === '3d' ? t('canvas.hint3d') : t('canvas.hint'))),
            travelDays > 0
              ? h('div', { className: 'dsh-memory-brain-simBanner', role: 'status' },
                h('span', null, t('travel.banner', { days: travelDays })),
                h('button', {
                  type: 'button',
                  className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary dsh-memory-brain-btn-small',
                  onClick: () => setTravelDays(0),
                }, t('travel.back')))
              : null,
            viewMode === '3d'
              ? h(MemoryCanvas3D, {
                data,
                projected,
                topologyKey,
                selectedId,
                onSelect: setSelectedId,
                filters,
                travelDays,
                t,
                overlay,
                autoRotate,
                resetSeq: resetViewSeq,
              })
              : h(MemoryCanvas, {
                data,
                projected,
                topologyKey,
                selectedId,
                onSelect: setSelectedId,
                filters,
                travelDays,
                t,
                overlay,
              }),
            h(TravelBar, { days: travelDays, onChange: setTravelDays, t })),
          h('aside', { className: 'dsh-memory-brain-right' },
            h('div', { className: 'dsh-memory-brain-scroll' },
              selected === null
                ? h(DetailEmpty, { t })
                : h(DetailCard, {
                  key: selected.id,
                  node: selected,
                  data,
                  projected,
                  travelDays,
                  actions,
                  pending,
                  t,
                }),
              h(SettingsPanel, {
                open: settingsOpen,
                settings: data === null ? null : data.settings,
                actions: { ...actions, hideSettings: () => setSettingsOpen(false) },
                pending,
                t,
              }),
              h('p', { className: 'dsh-memory-brain-footNote' }, t('poll.hint'))))),
        fullscreenActive
          ? h('div', { className: 'dsh-memory-brain-fullscreenBar', role: 'toolbar', 'aria-label': t('view.fullscreenBar') },
            h('div', { className: 'dsh-memory-brain-viewSwitch', role: 'group', 'aria-label': t('view.switchLabel') },
              h('button', {
                type: 'button',
                className: 'dsh-memory-brain-viewSwitchBtn',
                'aria-pressed': viewMode === '3d',
                onClick: () => setViewMode('3d'),
              }, t('view.3d')),
              h('button', {
                type: 'button',
                className: 'dsh-memory-brain-viewSwitchBtn',
                'aria-pressed': viewMode === '2d',
                onClick: () => setViewMode('2d'),
              }, t('view.2d'))),
            viewMode === '3d'
              ? h('button', {
                type: 'button',
                className: 'dsh-memory-brain-btn dsh-memory-brain-btn-ghost dsh-memory-brain-btn-small',
                onClick: () => setResetViewSeq((current) => current + 1),
              }, t('view.reset'))
              : null,
            viewMode === '3d'
              ? h('button', {
                type: 'button',
                className: 'dsh-memory-brain-btn dsh-memory-brain-btn-ghost dsh-memory-brain-btn-small',
                'aria-pressed': autoRotate,
                onClick: () => setAutoRotate((current) => !current),
              }, t('view.autoRotate'))
              : null,
            h('button', {
              type: 'button',
              className: 'dsh-memory-brain-btn dsh-memory-brain-btn-secondary dsh-memory-brain-btn-small',
              'aria-pressed': true,
              onClick: () => {
                void toggleFullscreen()
              },
            }, t('view.exitFullscreen')))
          : null,
        fullscreenActive
          ? h('div', { className: 'dsh-memory-brain-fullscreenHint' },
            h('span', null, t('view.fullscreenHint')),
            immersive ? h('span', { className: 'dsh-memory-brain-fullscreenHintNote' }, t('view.immersiveHint')) : null)
          : null,
        fullscreenActive && selected !== null
          ? h('aside', { className: 'dsh-memory-brain-fullscreenDetail', 'aria-label': t('detail.title') },
            h('div', { className: 'dsh-memory-brain-fullscreenDetailHead' },
              h('span', { className: 'dsh-memory-brain-fullscreenDetailTitle' }, t('detail.title')),
              h('button', {
                type: 'button',
                className: 'dsh-memory-brain-fullscreenDetailClose',
                title: t('detail.close'),
                'aria-label': t('detail.close'),
                onClick: () => setSelectedId(null),
              }, '×')),
            h('div', { className: 'dsh-memory-brain-fullscreenDetailScroll' },
              h(DetailCard, {
                key: selected.id,
                node: selected,
                data,
                projected,
                travelDays,
                actions,
                pending,
                t,
              })))
          : null)
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------

    /**
     * Create the shared store and the Host-facing actions, inject the styles,
     * and register the sidebar glyph and the main panel.
     * @param {object} ctx Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-memory-brain: dictionaries')
      const t = ctx.locale.bind(NS)

      const store = createSnapshotStore({ data: null, error: null, pending: null, lastLoadedAt: 0, pendingSession: null })
      const patch = (next) => {
        store.set({ ...store.getSnapshot(), ...next })
      }

      /** Read the authoritative snapshot; quiet polls never hide errors. */
      const load = async () => {
        if (store.getSnapshot().pending !== null) return { ok: false, message: '' }
        const result = await requestJson(ROUTES.state)
        if (!result.ok) {
          patch({ error: result.message })
          return result
        }
        const next = normalizeSnapshot(result.payload.state)
        if (next === null) {
          const message = t('error.badState')
          patch({ error: message })
          return { ok: false, message }
        }
        const current = store.getSnapshot()
        const nextState = { lastLoadedAt: Date.now() }
        if (current.data === null || next.revision >= current.data.revision) nextState.data = next
        if (current.error !== null) nextState.error = null
        patch(nextState)
        return { ok: true, data: next }
      }

      /** POST one mutation and adopt the state it answers with. */
      const run = async (op, path, body) => {
        if (store.getSnapshot().pending !== null) return { ok: false, message: '' }
        patch({ pending: op, error: null })
        const result = await requestJson(path, { method: 'POST', body: body === undefined ? {} : body })
        if (!result.ok) {
          patch({ pending: null, error: result.message })
          return result
        }
        const next = normalizeSnapshot(result.payload.state)
        if (next === null) {
          patch({ pending: null, error: t('error.badState') })
          return { ok: false, message: t('error.badState') }
        }
        const current = store.getSnapshot()
        const nextState = { pending: null, error: null, lastLoadedAt: Date.now() }
        if (current.data === null || next.revision >= current.data.revision) nextState.data = next
        patch(nextState)
        return { ok: true, data: next }
      }

      /**
       * Ask the full page to open filtered to one task (CONTRACT 9.2). The
       * pending session travels through the shared store so the panel applies
       * it even if the layout service appears later; a missing layout service
       * degrades to just remembering the filter.
       */
      const openGlobalMemory = (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        patch({ pendingSession: sessionId })
        let layout = null
        try {
          layout = typeof ctx.get === 'function' ? ctx.get('layout') : null
        } catch (error) {
          layout = null
        }
        if (layout !== null && layout !== undefined && typeof layout.selectPanel === 'function') {
          try {
            layout.selectPanel(PANEL_ID)
          } catch (error) {
            console.warn('dsh-memory-brain: could not open the memory panel', error)
          }
        }
      }

      const consumePendingSession = () => patch({ pendingSession: null })

      const actions = {
        load,
        openGlobalMemory,
        consumePendingSession,
        dismissError: () => patch({ error: null }),
        tagAdd: (id, tag) => run('tagAdd', ROUTES.tagAdd, { id, tag }),
        tagRemove: (id, tag) => run('tagRemove', ROUTES.tagRemove, { id, tag }),
        rehearse: (id) => run('rehearse', ROUTES.rehearse, { id }),
        forget: (id) => run('forget', ROUTES.forget, { id, hard: false }),
        forgetHard: (id) => run('forgetHard', ROUTES.forget, { id, hard: true }),
        restore: (id) => run('restore', ROUTES.restore, { id }),
        pin: (id, pinned) => run('pin', ROUTES.pin, { id, pinned: pinned === true }),
        sleep: () => run('sleep', ROUTES.sleep, {}),
        capture: () => run('capture', ROUTES.capture, {}),
        saveSettings: (partial) => run('settings', ROUTES.settings, {
          forgetAfterDays: partial.forgetAfterDays,
          autoCapture: partial.autoCapture,
          maxMemories: partial.maxMemories,
        }),
        purge: () => run('purge', ROUTES.purge, {}),
        reset: () => run('reset', ROUTES.reset, {}),
      }

      ctx.effect(() => {
        document.getElementById(STYLE_TAG_ID)?.remove()
        const tag = document.createElement('style')
        tag.id = STYLE_TAG_ID
        tag.dataset.plugin = 'dsh-memory-brain'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'dsh-memory-brain: styles')

      // The sidebar row owns the button shell; this component only draws glyph.
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 26,
        locale: NS,
        label: () => t('panel.label'),
        inject: () => ({ store, actions }),
      }, BrainGlyph))

      // Keyed slot: the key is the panel id the sidebar selects into `layout`.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ store, actions }),
      }, MemoryBrainPage))

      // One "记忆" view tab inside every conversation (CONTRACT 9.1).
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: PANEL_ID,
        order: 30,
        locale: NS,
        label: () => t('task.tab'),
        inject: () => ({ store, actions }),
      }, MemoryTaskView))
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
