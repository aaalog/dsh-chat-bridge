// dsh-chat-bridge —— 把 DSH 智能体接进 WNA HUB 聊天后台（DSH Chat）。
//
// 这个插件是 app-agent/ai-bridge.js 的插件化改写。原版是一个独立 node 进程：
// 登录 → 收消息 → 每条 spawn 一次 `dsh headless --json` → 发回复。三个硬伤：
//   1. 子进程继承沙箱受限令牌，写 profiles/headless 直接 EPERM；
//   2. 每条消息起一个 headless，慢，而且同一会话并发会撞会话写句柄；
//   3. 会话映射存在 .ai-sessions.json 里，文件一丢上下文全断。
// 插件版把这三点都消掉：In-Process 的 agents.create/resume + followup/whenIdle，
// 会话 id 由 convId 确定性派生，重启还能 resume 回来。
//
// 三个接线点：
//   1. 入站：WS 推送（或长轮询）→ 该不该接的判断（含防 AI 对刷）→ 投给 DSH 会话；
//   2. 出站：本轮跑完后从会话事件里取助手说的话 → 发回聊天；
//   3. 工具：chat_bridge_status / chat_bridge_send。
import Schema from '@deepseek-ai/schemastery'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PROMPT, LIB_VERSION, resolveSettings, stateDirOf } from './lib/config.js'
import { createLogger } from './lib/log.js'
import { createApi } from './lib/api.js'
import { createReceiver } from './lib/ws.js'
import { BridgeSessions } from './lib/session.js'
import { createGuard } from './lib/guard.js'
import { resolveModel } from './lib/model.js'

export const name = 'chat-bridge'
export const inject = ['agents']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用桥接'),
  host: Schema.string().default('https://api.wna.me').description('聊天后台地址'),
  aiKey: Schema.string().default('').description('AI 身份的 aiKey（留空则读环境变量 DSH_CHAT_BRIDGE_AI_KEY 或老 config.json）'),
  name: Schema.string().default('AI').description('AI 名字（用于识别是不是在叫我）'),
  groupReplyMode: Schema.string().default('question')
    .description('群聊策略：mention（只认 @）| question（只回问句）| always'),
  useWebSocket: Schema.boolean().default(true).description('优先用 WebSocket 实时收消息'),
  pollFallback: Schema.boolean().default(true).description('WS 不可用时降级长轮询'),
  pollWait: Schema.number().default(4).description('长轮询等待秒数'),
  cwd: Schema.string().default('').description('桥接会话的工作目录（留空 = 进程当前目录）'),
  sessionPrefix: Schema.string().default('dsnchat').description('会话 key 前缀（改了等于换一批新会话）'),
  provider: Schema.string().default('').description('桥接会话用的 provider（留空则问宿主 agentDefaultModel）'),
  model: Schema.string().default('').description('桥接会话用的 model id（留空则同上）'),
  maxConcurrent: Schema.number().default(2).description('同时跑几个会话的回复（同一会话永远串行）'),
  turnTimeoutMs: Schema.number().default(300000).description('一轮回复的超时（ms）'),
  loopGuard: Schema.object({
    chainMax: Schema.number().default(3).description('一条人类消息最多引出几轮 AI 互聊'),
    aiMinGapMs: Schema.number().default(6000).description('我方两次接 AI 的话之间的最小间隔（ms）'),
    burstMax: Schema.number().default(10).description('窗口内接 AI 的话超过这个数就静默'),
    burstWindowMs: Schema.number().default(60000).description('防刷统计窗口（ms）'),
    muteMs: Schema.number().default(60000).description('熔断静默时长（ms）'),
  }).default({}),
  proactive: Schema.object({
    enabled: Schema.boolean().default(true).description('AI 主动发言（不等被回，自己找话说）'),
    intervalMs: Schema.number().default(90000).description('主动发言检查间隔（ms）'),
    cooldownMs: Schema.number().default(600000).description('同一会话两次主动发言的最小间隔（ms）'),
    maxPerHour: Schema.number().default(8).description('全桥接每小时最多主动发言条数'),
    onlyGroup: Schema.boolean().default(true).description('只对群聊主动发言（单聊等对方说）'),
  }).default({}),
  receipt: Schema.object({
    enabled: Schema.boolean().default(false)
      .description('投递前先回一句「收到，我看一下…」（默认关闭：没人喜欢开场白）'),
    text: Schema.string().default('收到，我看一下…')
      .description('回执话术（只在 enabled 打开时用；这句子会被 CANNED 识别，防另一个 AI 接话）'),
  }).default({}),
  typingNotice: Schema.boolean().default(true).description('超过 typingAfterMs 还没好，先发一句「正在想…」'),
  typingAfterMs: Schema.number().default(15000).description('多久之后发提示（ms）'),
  typingCooldownMs: Schema.number().default(60000).description('提示语冷却（ms/会话）'),
  allowMultiInstance: Schema.boolean().default(false)
    .description('允许同一个 aiKey 在本机多份实例同时跑（默认不允许，防两个实例把对话点着）'),
  stateDir: Schema.string().default('').description('状态目录（默认 ~/.dsh/plugin-data/chat-bridge）'),
  legacyConfigPath: Schema.string().default('').description('老 ai-bridge config.json 的位置（用来继承 aiKey/host/name）'),
  tools: Schema.object({
    enabled: Schema.boolean().default(true).description('是否注册 chat_bridge_* 工具'),
  }).default({}),
  promptEnabled: Schema.boolean().default(true).description('是否给桥接会话注入聊天场景提示'),
  promptText: Schema.string().default('').description('自定义场景提示（留空用默认）'),
})

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const stateDir = stateDirOf(settings)
  let base = console
  try { base = ctx.logger ?? console } catch { base = console }
  const log = createLogger(stateDir, base)

  log.info(`=== dsh-chat-bridge ${LIB_VERSION} 启动 ===`)
  log.info(`后台：${settings.host} · 身份：${settings.name}`)

  if (settings.enabled === false) {
    log.info('插件已停用（enabled: false）')
    return
  }

  const agents = ctx.agents
  if (!agents?.create || !agents?.resume) {
    log.error('agents 服务不可用（DSH 版本不匹配？），桥接没起来')
    return
  }

  const api = createApi({ host: settings.host, aiKey: settings.aiKey, log })
  const sessions = new BridgeSessions({ ctx, agents, settings, log })
  const guard = createGuard({ settings, log })

  // ── 体检文件：桌面版看不到 stdout 时，看这个就知道插件起没起、登没登、收几条 ──
  const diagnostics = {
    version: LIB_VERSION,
    startedAt: new Date().toISOString(),
    stateDir,
    host: settings.host,
    name: settings.name,
    loggedIn: false,
    transport: settings.useWebSocket ? 'websocket' : 'poll',
    running: false,
    selfId: '',
    selfName: '',
    conversations: 0,
    knownSessions: 0,
    received: 0,
    sent: 0,
    skipped: 0,
    lastError: '',
    lastMessageAt: '',
    modelRoute: '',
    lockHeld: false,
    lockPid: 0,
  }
  const diagFile = join(stateDir, 'diagnostic.json')
  const writeDiagnostics = () => {
    try {
      mkdirSync(stateDir, { recursive: true })
      diagnostics.knownSessions = sessions.list().length
      writeFileSync(diagFile,
        `${JSON.stringify({ ...diagnostics, updatedAt: new Date().toISOString() }, null, 2)}\n`)
    } catch { /* 写不动就算了 */ }
  }
  writeDiagnostics()

  /**
   * 单实例闸门。
   *
   * 为什么要有：2026-11-12 那次对刷风暴里，#832–#891 全是小肥鱼账号发的，
   * 但本机日志那段时间一条都没有 —— 说明**别处还有一个同 aiKey 的实例**在跑。
   * 两个实例各听一份 WS，你回我我回你，回路一闭就停不下来。
   * 所以：同一个状态目录只允许一个活进程，第二个直接不连后台，并在状态里写清楚。
   */
  const lockFile = join(stateDir, 'bridge.pid')
  const pidAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }
  let lockOwned = false
  if (!settings.allowMultiInstance) {
    try {
      if (existsSync(lockFile)) {
        const pid = Number(String(readFileSync(lockFile, 'utf8')).trim())
        if (pid !== process.pid && pidAlive(pid)) {
          diagnostics.lockHeld = true
          diagnostics.lockPid = pid
          diagnostics.lastError = `本机已有桥接实例在跑（pid ${pid}），本次不连后台`
          writeDiagnostics()
          log.error(`本机已有桥接实例在跑（pid ${pid}），本次不连后台 —— `
            + '要强制多开请把 allowMultiInstance 设成 true')
          return
        }
      }
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(lockFile, String(process.pid))
      lockOwned = true
    } catch (error) {
      log.warn(`单实例闸门没装上（${error?.message ?? error}）—— 继续跑，但注意别开第二个`)
    }
  }

  // ── 会话/成员缓存 ──
  let convsCache = {}
  let nameMap = {}
  /** 会话名 → convId（给 chat_bridge_send 的 to 用） */
  const convByName = new Map()
  /** 成员名 → convId 集合（会话名对不上时按人找） */
  const memberIndex = new Map()

  const refreshNames = async () => {
    try {
      const convs = await api.conversations()
      diagnostics.conversations = convs.length
      convsCache = {}
      convByName.clear()
      memberIndex.clear()
      for (const conv of convs) {
        convsCache[conv.id] = conv
        if (conv.name) convByName.set(String(conv.name), conv.id)
        try {
          const members = await api.members(conv.id)
          for (const member of members) {
            if (!member?.id) continue
            nameMap[member.id] = member.displayName || member.id
            if (member.type) nameMap[`__type_${member.id}`] = member.type
            const display = String(member.displayName || member.id)
            if (!memberIndex.has(display)) memberIndex.set(display, new Set())
            memberIndex.get(display).add(conv.id)
          }
        } catch { /* 单个会话成员拉不到不影响别的 */ }
      }
      writeDiagnostics()
    } catch (error) {
      log.warn(`刷新会话/成员失败：${error?.message ?? error}`)
    }
  }

  const convType = (convId) => (String(convId).startsWith('grp:') ? 'group' : 'dm')

  const describeConv = (convId) => {
    const conv = convsCache[convId]
    if (conv) return conv
    return { id: convId, type: convType(convId), name: conv?.name ?? '' }
  }

  /** 组提示词（和原版一致的意图，措辞按「先说人话」重写） */
  const buildPrompt = (msg, conv, recent, aiJudge = false) => {
    const senderName = nameMap[msg.sender] || msg.senderName || msg.sender
    const isGroup = (conv?.type === 'group') || convType(msg.convId) === 'group'
    const ctxLines = recent?.length
      ? `\n【会话最近消息】\n${recent.map((x) => `  ${x.name}：${x.text}`).join('\n')}\n`
      : ''
    if (isGroup) {
      return `【DSH Chat 群聊「${conv?.name || '群聊'}」】\n`
        + `你是群成员「${api.me?.displayName || settings.name}」。\n`
        + ctxLines
        + `\n最新消息来自 ${senderName}：\n${msg.text || ''}\n\n`
        + '有想说的就直接说，没什么可说的就别硬凑。要求：简短自然，像真人聊天；'
        + '不要用「收到」「好的」「我看一下」这类空话开场；'
        + '不要解释你在调用什么工具；不要加「回复：」前缀。'
        + (aiJudge
          ? '\n\n【想不想回，你自己判断】不需要你回应的时候就只回复 SKIP（全大写，别的一个字都不写）——'
            + 'SKIP 不会被发出去，等于你选择不说话。该回应就正常说。'
          : '')
    }
    return `【DSH Chat 私聊】${senderName} 给你发来消息：\n\n${msg.text || ''}\n\n`
      + '有想说的就说，简洁自然；确实没什么可说就不用硬凑（只回 SKIP，我不会把它发出去）。'
  }

  /** 每个会话最近 10 条，给提示词当上下文 */
  const recentByConv = new Map()
  /** 每个会话最后一次收到消息的时间（主动发言只对最近活跃的会话） */
  const lastActivityAt = new Map()
  const rememberSeen = (convId, msg) => {
    let arr = recentByConv.get(convId)
    if (!arr) { arr = []; recentByConv.set(convId, arr) }
    if (arr.some((x) => x.seq === msg.seq)) return
    lastActivityAt.set(convId, Date.now())
    arr.push({
      seq: msg.seq,
      name: nameMap[msg.sender] || msg.senderName || msg.sender,
      text: String(msg.text || '').slice(0, 400),
    })
    if (arr.length > 20) arr.splice(0, arr.length - 20)
  }

  // ── 并发闸门 ──
  // 同一会话永远串行（消息乱序进来会互相抢同一轮），不同会话之间限并发。
  const convChains = new Map()
  const withConvLock = (convId, task) => {
    const prev = convChains.get(convId) ?? Promise.resolve()
    const next = prev.then(task, task)
    convChains.set(convId, next.catch(() => {}))
    return next
  }

  let active = 0
  const waiting = []
  const pump = () => {
    while (active < Math.max(1, Number(settings.maxConcurrent) || 2) && waiting.length) {
      const { task, resolve, reject } = waiting.shift()
      active += 1
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => { active -= 1; pump() })
    }
  }
  const limited = (task) => new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject })
    pump()
  })

  // ── 「正在想…」提示语（按会话冷却，别刷屏） ──
  const lastNoticeAt = new Map()

  /**
   * 投一条消息并取回复；整轮被门禁拒绝（blocked）时自动换新会话 id 重投一次。
   *
   * 为什么必须有：会话被归档后，resume 回来的每一轮都会在 pre-step 被
   * ArchivedSessionGate 拒掉 —— reply 是空的、turn/end 是 blocked，从外面看
   * 就像「模型没话说」，实际是这个群从此哑了。2026-11-12 三个桥接会话
   * （群聊 + 私聊 + 自检）全在归档列表里，就是这么集体失声的。
   */
  const deliverWithRecovery = async (convId, prompt) => {
    let result = await sessions.deliver(convId, prompt)
    if (result.endReason !== 'blocked') return result
    log.warn(`会话 ${result.sessionId} 整轮被拒（blocked，多半是被归档了），换新会话 id 重投一次`)
    await sessions.reset(convId)
    result = await sessions.deliver(convId, prompt)
    if (result.endReason === 'blocked') {
      log.error('换了新会话仍然 blocked —— 不是归档问题，去查 agent/pre-step 上的门禁插件')
    }
    return result
  }

  /**
   * 「这一轮模型其实不想说话」的判定。
   *
   * 提示词要求「不想说就只回 SKIP」，但模型经常回「SKIP。」「（SKIP）」
   * 「我觉得不用回，SKIP」—— 只认纯 SKIP 的正则会把这些当正文发到群里。
   * 这里放宽成：整句很短、并且带 SKIP 字样，就当它不想说。
   */
  const isSkipReply = (text) => {
    const t = String(text ?? '').trim()
    if (!t) return true
    if (/^\s*[\[【（(]?\s*SKIP\s*[\]】）)]?\s*[。.!！]*\s*$/i.test(t)) return true
    return /skip/i.test(t) && t.length <= 24
  }

  /** 处理一条该接的消息 */
  const handleMessage = async (msg, conv, verdict = {}) => {
    const convId = msg.convId
    const senderName = nameMap[msg.sender] || msg.senderName || msg.sender
    diagnostics.received += 1
    diagnostics.lastMessageAt = new Date().toISOString()
    log.info(`收到 #${msg.seq} 来自 ${senderName}：${String(msg.text || '').slice(0, 60)}`)

    const recent = (recentByConv.get(convId) || [])
      .filter((x) => x.seq !== msg.seq)
      .slice(-10)
    // 图片/文件消息用 guard 给的 promptOverride；普通消息走 buildPrompt
    const prompt = verdict.promptOverride || buildPrompt(msg, conv, recent, verdict.aiJudge)

    // 投递前回执：默认**关闭**。想看「收到了，在处理」就自己把 receipt.enabled 打开。
    if (msg.senderType !== 'ai' && settings.receipt?.enabled === true) {
      const rtext = String(settings.receipt?.text || '').trim()
      if (rtext) {
        try { await api.sendText(convId, rtext); diagnostics.sent += 1 } catch { /* 回执发不出就算了 */ }
      }
    }

    let noticeTimer = null
    if (settings.typingNotice !== false) {
      const now = Date.now()
      if (now - (lastNoticeAt.get(convId) ?? 0) > Number(settings.typingCooldownMs || 60000)) {
        noticeTimer = setTimeout(() => {
          lastNoticeAt.set(convId, Date.now())
          void api.sendText(convId, '（正在想…）').catch(() => {})
        }, Number(settings.typingAfterMs) || 15000)
        noticeTimer.unref?.()
      }
    }

    let reply = ''
    let failed = ''
    try {
      const result = await deliverWithRecovery(convId, prompt)
      reply = result.text
      if (result.timedOut && !reply) failed = '本轮超时'
    } catch (error) {
      failed = String(error?.message ?? error).slice(0, 150)
      log.error(`runtime 失败：${failed}`)
    } finally {
      if (noticeTimer) clearTimeout(noticeTimer)
    }

    // 没话说就是没话说：不再往聊天里塞「（没有想说的）」，也不把内部错误原文发出去。
    // 群里安静比冒一句废话强；原因都写进日志和 diagnostic.json。
    if (!reply) {
      diagnostics.skipped += 1
      if (failed) {
        diagnostics.lastError = failed
        log.warn(`#${msg.seq} 本轮没有产出（${failed}），不回话`)
      } else {
        log.info(`#${msg.seq} 模型没有回复内容，不回话`)
      }
      if (noticeTimer) clearTimeout(noticeTimer)
      writeDiagnostics()
      return
    }

    // 模型自己判断「不用回」：SKIP /（SKIP）/ SKIP。 一律不发
    if (isSkipReply(reply)) {
      diagnostics.skipped += 1
      log.info(`AI 判断不接 #${msg.seq}（SKIP）`)
      if (noticeTimer) clearTimeout(noticeTimer)
      writeDiagnostics()
      return
    }

    try {
      await api.sendText(convId, reply)
      diagnostics.sent += 1
      lastNoticeAt.delete(convId)
      log.info(`已回复 #${msg.seq} → ${reply.slice(0, 60).replace(/\n/g, ' ')}`)
      // 接的是 AI 的话才扣额度/记间隔；人类的消息不算
      guard.noteSent(convId, { toAi: msg.senderType === 'ai' })
    } catch (error) {
      log.error(`发送失败：${error?.message ?? error}`)
      diagnostics.lastError = String(error?.message ?? error)
    }
    writeDiagnostics()
  }

  /** 一条入站消息（WS 和长轮询共用） */
  const onInbound = async (msg) => {
    if (!msg?.convId) return
    const convId = msg.convId
    if (nameMap[`__type_${msg.sender}`]) msg.senderType = nameMap[`__type_${msg.sender}`]
    rememberSeen(convId, msg)

    const conv = describeConv(convId)
    const verdict = guard.check(msg, conv, api.me)
    if (!verdict.reply) {
      diagnostics.skipped += 1
      return
    }
    // 先排会话串行锁，再抢全局并发槽 —— 顺序反过来会让「同一会话的第二条消息」
    // 白占一个并发槽等前面那条跑完，别的会话就被饿着。
    await withConvLock(convId, () => limited(() => handleMessage(msg, conv, verdict)))
  }

  const submitInbound = (msg) => {
    // WS 回调和轮询循环都是「来一条算一条」，绝不能因为一条出错把收消息停掉；
    // 而且 fire-and-forget 的链必须以一个不会再抛的 catch 收尾（Node 24 会把
    // unhandled rejection 直接变成进程退出 —— 真崩过一次 DSH）。
    void onInbound(msg)
      .catch((error) => { log.error(`入站处理失败：${error?.stack ?? error}`) })
      .catch(() => { /* 绝不能再抛 */ })
  }

  // ── AI 主动发言：像人一样自己找话说，不等被回 ──
  const proactive = {
    lastAt: new Map(),  // convId → 上次主动发言时间
    thisHour: [],       // 主动发言时间戳（防每小时上限）
  }
  const proactiveTimer = { t: null }

  const buildProactivePrompt = (convId, conv) => {
    const recent = (recentByConv.get(convId) || []).slice(-8)
    const ctxLines = recent.length
      ? recent.map((x) => `  ${x.name}：${x.text}`).join('\n')
      : '（还没有最近消息）'
    const gname = conv?.name || '群聊'
    return `【DSH Chat 群聊「${gname}」· 主动发言】\n`
      + `你是群成员「${api.me?.displayName || settings.name}」。最近会话消息：\n${ctxLines}\n\n`
      + '你不用等别人回，自己判断：现在有没有一句值得你主动说的？'
      + '（比如接着刚才的话题补充一句、提醒一句、汇报进度、接上话茬）\n'
      + '- 如果有一句值得说：直接说那一句（简短自然，像真人，不要前缀，不要「回复：」）。\n'
      + '- 如果没有值得主动说的：只回复 SKIP（全大写，一个字都别多说）。'
  }

  const proactiveSpeak = async (convId) => {
    if (settings.proactive?.onlyGroup !== false) {
      const conv = describeConv(convId)
      if (conv?.type !== 'group' && !String(convId).startsWith('grp:')) return
    }
    const now = Date.now()
    // 只对最近活跃的会话主动（比如 30 分钟内有人说过话）
    const lastAct = lastActivityAt.get(convId) ?? 0
    if (now - lastAct > 30 * 60 * 1000) return
    const last = proactive.lastAt.get(convId) ?? 0
    if (now - last < Number(settings.proactive?.cooldownMs ?? 600000)) return
    proactive.thisHour = proactive.thisHour.filter((t) => now - t < 3600000)
    if (proactive.thisHour.length >= Number(settings.proactive?.maxPerHour ?? 8)) return

    const conv = describeConv(convId)
    const prompt = buildProactivePrompt(convId, conv)
    try {
      const result = await deliverWithRecovery(convId, prompt)
      const reply = String(result?.text ?? '')
      if (isSkipReply(reply)) return  // 没说，等下次
      proactive.lastAt.set(convId, now)
      proactive.thisHour.push(now)
      await api.sendText(convId, reply)
      diagnostics.sent += 1
      log.info(`主动发言 → ${reply.slice(0, 60).replace(/\n/g, ' ')}`)
      writeDiagnostics()
    } catch (error) {
      log.error(`主动发言失败：${error?.message ?? error}`)
    }
  }

  const startProactive = () => {
    if (settings.proactive?.enabled === false) {
      log.info('主动发言已关闭（proactive.enabled=false）')
      return
    }
    const interval = Number(settings.proactive?.intervalMs ?? 90000)
    proactiveTimer.t = setInterval(() => {
      if (closing) return
      for (const convId of recentByConv.keys()) {
        void withConvLock(convId, () => limited(() => proactiveSpeak(convId)))
          .catch(() => {})
      }
    }, interval)
    proactiveTimer.t.unref?.()
    log.info(`主动发言已启动（间隔 ${interval / 1000}s，冷却 ${Number(settings.proactive?.cooldownMs ?? 600000) / 60000}min/会话）`)
  }

  // ── 长轮询（WS 的退路） ──
  let closing = false
  const cursors = {}
  const pollLoop = async () => {
    let convs = []
    let index = 0
    let lastRefresh = 0
    while (!closing) {
      try {
        const now = Date.now()
        if (convs.length === 0 || now - lastRefresh > 60000) {
          await refreshNames()
          convs = await api.conversations()
          diagnostics.transport = 'poll'
          lastRefresh = now
          for (const conv of convs) {
            if (!(conv.id in cursors)) {
              cursors[conv.id] = 0
              try {
                const history = await api.history(conv.id, 20)
                for (const m of history) rememberSeen(conv.id, m)
              } catch { /* 预热失败无所谓 */ }
            }
          }
          log.info(`会话列表：${convs.length} 个（长轮询）`)
          writeDiagnostics()
        }
        if (convs.length === 0) {
          await new Promise((r) => setTimeout(r, 5000))
          continue
        }
        if (index >= convs.length) index = 0
        const conv = convs[index]
        index += 1
        const since = cursors[conv.id] || 0
        const { messages, cursor } = await api.poll(conv.id, since, settings.pollWait)
        for (const m of messages) submitInbound(m)
        if (typeof cursor === 'number' && cursor > since) cursors[conv.id] = cursor
      } catch (error) {
        log.warn(`轮询异常：${error?.message ?? error}`)
        await new Promise((r) => setTimeout(r, 5000))
        try { await api.relogin() } catch (e) { log.error(`重登录失败：${e?.message ?? e}`) }
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  // ── 传输层启动 ──
  let receiver = null
  let heartbeatTimer = null

  const startTransport = async () => {
    let ok = false
    while (!ok && !closing) {
      try {
        await api.login()
        ok = true
      } catch (error) {
        diagnostics.lastError = String(error?.message ?? error)
        writeDiagnostics()
        log.error(`登录失败：${error?.message ?? error}，5 秒后重试`)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
    if (closing || !ok) return

    diagnostics.loggedIn = true
    diagnostics.selfId = api.me?.id ?? ''
    diagnostics.selfName = api.me?.displayName ?? ''
    const route = resolveModel({ ctx, settings, log })
    diagnostics.modelRoute = `${route.provider}/${route.model}`
    writeDiagnostics()

    heartbeatTimer = setInterval(() => { void api.heartbeat().catch(() => {}) }, 45000)
    heartbeatTimer.unref?.()

    await refreshNames()

    startProactive()

    if (settings.useWebSocket !== false) {
      receiver = createReceiver({
        api,
        onMessage: (m) => submitInbound(m),
        onReady: () => {
          diagnostics.transport = 'websocket'
          diagnostics.running = true
          writeDiagnostics()
        },
        log,
        onFatal: () => {
          if (settings.pollFallback !== false) {
            log.warn('WS 不可用，降级长轮询')
            void pollLoop().catch((error) => log.error(`轮询循环挂了：${error?.message ?? error}`))
          }
        },
      })
      if (receiver.available) {
        log.info('使用 WebSocket 模式（实时推送）')
        receiver.start()
        diagnostics.running = true
        writeDiagnostics()
        return
      }
      log.warn('没有可用的 WebSocket 实现，改用长轮询')
    }

    if (settings.pollFallback !== false || settings.useWebSocket === false) {
      log.info('使用长轮询模式')
      diagnostics.transport = 'poll'
      diagnostics.running = true
      writeDiagnostics()
      void pollLoop().catch((error) => log.error(`轮询循环挂了：${error?.message ?? error}`))
    } else {
      diagnostics.running = false
      diagnostics.lastError = '没有可用的 WebSocket 实现，且 pollFallback=false —— 收不到任何消息'
      writeDiagnostics()
      log.error(diagnostics.lastError)
    }
  }

  // 启动不阻塞插件装配（登录要联网）
  //
  // 没有 aiKey 就不去连后台 —— 否则每 5 秒重试一次、日志刷满，看着像「挂了」，
  // 其实只是没配。工具仍然注册，问一句状态就能看到「缺 aiKey」。
  if (!String(settings.aiKey ?? '').trim()) {
    diagnostics.running = false
    diagnostics.lastError = '没有 aiKey：配 插件 config.aiKey 或环境变量 DSH_CHAT_BRIDGE_AI_KEY'
    writeDiagnostics()
    log.error(diagnostics.lastError)
  } else {
    void startTransport().catch((error) => {
      diagnostics.lastError = String(error?.message ?? error)
      writeDiagnostics()
      log.error(`启动流程异常：${error?.stack ?? error}`)
    }).catch(() => { /* 绝不能再抛 */ })
  }

  // ── 工具 ──
  if (settings.tools?.enabled !== false) {
    ctx.inject(['tools'], (scope) => {
      const tools = scope.tools
      if (!tools?.register) {
        log.warn('tools 服务不可用，chat_bridge_* 工具没注册')
        return
      }

      tools.register({
        name: 'chat_bridge_status',
        description: '看 DSH Chat 桥接的状态：登录没有、走 WS 还是轮询、收了/发了多少条、'
          + '映射了哪些会话、接话节奏（防对刷）当前状态。用户问「桥接还活着吗」时用。'
          + 'selftest=true 会真的建一个会话跑一轮小回合，验证「建会话 → 投消息 → 取回复」'
          + '这条链路通不通（不会往聊天里发任何东西），平时不用开。',
        parameters: {
          type: 'object',
          properties: {
            selftest: {
              type: 'boolean',
              description: '真的跑一轮会话，验证取回复的链路（默认 false）',
            },
            key: {
              type: 'string',
              description: '自检用哪个会话键（默认每次新建；传同一个键可复现「重启后 resume 旧会话」）',
            },
          },
          additionalProperties: false,
        },
        output: TEXT_OUTPUT,
        async execute(args) {
          // 自检：不调 api.sendText，所以对方什么都不会收到 —— 只是让
          // agents.create → followup → whenIdle → snapshotEvents 真的跑一遍。
          // 为什么需要它：这条链路是本插件唯一「改错了也不报错、只在真人发消息时
          // 才炸」的地方，得有个随时能按的按钮。
          let selftestLine = ''
          if (args?.selftest) {
            const started = Date.now()
            try {
              // 默认每次换一个新 convId：固定 key 的会话一旦被历史事件污染（比如某次
              // pre-step 被门禁 block 之后留下脏状态），下次自检会误报「取回复链路坏了」，
              // 分不清是链路坏还是那个会话坏了。新 key 每次都是干净的 create。
              // 传了 key 就复用 —— 那是复现「插件重启后 resume 同一个会话」用的，
              // 真人消息最常踩的正是这条路径。
              const fixedKey = String(args?.key ?? '').trim()
              const probeKey = fixedKey || `__selftest_${started.toString(36)}`
              const probe = await deliverWithRecovery(probeKey, '自检：请只回复两个字「正常」，不要用任何工具。')
              const cost = ((Date.now() - started) / 1000).toFixed(1)
              selftestLine = `自检：${probeKey} → 会话 ${probe.sessionId} · ${cost}s · `
                + `${probe.timedOut ? '超时' : '完成'}`
                + `${probe.endReason ? ` · 收尾=${probe.endReason}` : ''}`
                + ` · 取回 ${probe.text ? `${probe.text.length} 字：「${probe.text.slice(0, 40)}」` : '**0 字（取回复的链路有问题）**'}`
            } catch (error) {
              selftestLine = `自检：失败 ${error?.message ?? error}`
            }
          }

          const lines = [
            `桥接：${diagnostics.running ? '运行中' : '未运行'} · 传输：${diagnostics.transport}`,
            `登录：${diagnostics.loggedIn ? `是（${diagnostics.selfName} / ${diagnostics.selfId}）` : '否'}`,
            `后台：${diagnostics.host} · 身份：${diagnostics.name}`,
            `收到 ${diagnostics.received} 条 · 发出 ${diagnostics.sent} 条 · 跳过 ${diagnostics.skipped} 条`,
            `会话：后台 ${diagnostics.conversations} 个 · 已映射 DSH 会话 ${sessions.list().length} 个`,
            `模型路由：${diagnostics.modelRoute || '(还没建过会话)'}`,
            `单实例闸门：${diagnostics.lockHeld ? `被 pid ${diagnostics.lockPid} 占着（本次没连后台）` : '持有'}（${lockFile}）`,
            `状态目录：${stateDir}`,
            diagnostics.lastError ? `最近错误：${diagnostics.lastError}` : '',
            diagnostics.lastMessageAt ? `最近消息：${diagnostics.lastMessageAt}` : '',
            selftestLine,
          ]
          const mapped = sessions.list()
          if (mapped.length) {
            lines.push('已映射会话：')
            for (const item of mapped.slice(0, 20)) {
              lines.push(`  ${item.convId} → ${item.sessionId}${item.model ? ` (${item.model})` : ''}`)
            }
          }
          const snap = guard.snapshot()
          lines.push(`接话节奏：群聊策略=${snap.mode} · 额度=${snap.cfg.chainMax} · 最小间隔=${snap.cfg.aiMinGapMs}ms`)
          const convIds = Object.keys(snap.conversations)
          if (convIds.length) {
            lines.push('当前会话节奏：')
            for (const id of convIds.slice(0, 10)) {
              const st = snap.conversations[id]
              lines.push(`  ${id}: 额度 ${st.chain} · burst ${st.burst}`
                + `${st.muted ? ` · 静默 ${Math.ceil(st.muted / 1000)}s` : ''}`)
            }
          }
          return { text: lines.filter(Boolean).join('\n') }
        },
      })

      tools.register({
        name: 'chat_bridge_send',
        description: '往 DSH Chat 的某个会话主动发一条消息。convId 和 to 二选一：'
          + 'to 是会话名（群名或对方名字）。用户说「跟 xx 说一声」时用。',
        parameters: {
          type: 'object',
          properties: {
            convId: { type: 'string', description: '目标会话 id' },
            to: { type: 'string', description: '目标会话名（群名/对方名字）' },
            text: { type: 'string', description: '要发的内容' },
          },
          required: ['text'],
          additionalProperties: false,
        },
        output: TEXT_OUTPUT,
        async execute(args) {
          const text = String(args?.text ?? '').trim()
          if (!text) return { text: '内容不能为空。' }
          let convId = String(args?.convId ?? '').trim()
          if (!convId) {
            const to = String(args?.to ?? '').trim()
            if (!to) return { text: '要给 convId 或 to（会话名）。' }
            await refreshNames()
            convId = convByName.get(to) ?? ''
            if (!convId) {
              const byMember = memberIndex.get(to)
              if (byMember && byMember.size === 1) convId = [...byMember][0]
              else if (byMember && byMember.size > 1) {
                return { text: `「${to}」出现在多个会话里：${[...byMember].join(', ')}。请用 convId 指定。` }
              }
            }
            if (!convId) return { text: `找不到会话「${to}」。可用：${[...convByName.keys()].join(', ') || '(还没拉到会话列表)'}` }
          }
          try {
            await api.sendText(convId, text)
            diagnostics.sent += 1
            writeDiagnostics()
            log.info(`手动发出 → ${convId}：${text.slice(0, 60)}`)
            return { text: `已发到 ${convId}。` }
          } catch (error) {
            return { text: `发送失败：${error?.message ?? error}` }
          }
        },
      })

      // 手动重置：把一个会话的桥接上下文换成全新会话。会话被归档（每轮 blocked）
      // 或者上下文被聊脏了的时候用。不发消息，只换 id。
      tools.register({
        name: 'chat_bridge_reset',
        description: '把 DSH Chat 某个会话的桥接上下文重置成全新会话（会话被归档/每轮 '
          + 'blocked、或者上下文聊脏了时用）。convId 和 to 二选一，to 是会话名（群名/对方名字）。'
          + '只换 DSH 会话 id，不会往聊天里发任何消息。',
        parameters: {
          type: 'object',
          properties: {
            convId: { type: 'string', description: '目标会话 id' },
            to: { type: 'string', description: '目标会话名（群名/对方名字）' },
          },
          additionalProperties: false,
        },
        output: TEXT_OUTPUT,
        async execute(args) {
          let convId = String(args?.convId ?? '').trim()
          if (!convId) {
            const to = String(args?.to ?? '').trim()
            if (!to) return { text: '要给 convId 或 to（会话名）。' }
            await refreshNames()
            convId = convByName.get(to) ?? ''
            if (!convId) {
              const byMember = memberIndex.get(to)
              if (byMember && byMember.size === 1) convId = [...byMember][0]
              else if (byMember && byMember.size > 1) {
                return { text: `「${to}」出现在多个会话里：${[...byMember].join(', ')}。请用 convId 指定。` }
              }
            }
            if (!convId) return { text: `找不到会话「${to}」。` }
          }
          const before = sessions.findByConvId(convId)?.sessionId ?? ''
          try {
            const record = await sessions.reset(convId)
            writeDiagnostics()
            log.info(`手动重置会话 ${convId}：${before || '(无)'} → ${record.sessionId}`)
            return { text: `已重置 ${convId}\n  旧会话：${before || '(无)'}\n  新会话：${record.sessionId}` }
          } catch (error) {
            return { text: `重置失败：${error?.message ?? error}` }
          }
        },
      })
    })
  }

  // ── 场景提示注入（只对那些真是桥接会话的会话生效） ──
  if (settings.promptEnabled !== false) {
    const promptText = settings.promptText || DEFAULT_PROMPT
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next()
      const sessionId = context?.agent?.session?.id ?? context?.agent?.id
      if (!sessionId || !sessions.findBySessionId(sessionId)) return assembled
      return {
        ...assembled,
        sections: [...(assembled?.sections ?? []), { name: 'chat-bridge:prompt', order: 90, text: promptText }],
      }
    })
  }

  // ── 卸载 ──
  ctx.effect(() => () => {
    closing = true
    log.info('插件卸载：停收消息、断连接、卸会话')
    try { receiver?.close() } catch { /* 已断 */ }
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (proactiveTimer.t) clearInterval(proactiveTimer.t)
    try {
      void sessions.disposeAll()
        .catch((error) => { log.warn(`卸会话失败：${error?.message ?? error}`) })
        .catch(() => {})
    } catch { /* 忽略 */ }
    if (lockOwned) {
      try { rmSync(lockFile, { force: true }) } catch { /* 忽略 */ }
    }
    writeDiagnostics()
  })

  log.info('插件已装配：等登录完成开始收消息')
}
