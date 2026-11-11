// 「一个聊天会话 ↔ 一个 DSH 会话」的映射与投递。
//
// 这是插件版和原桥接最本质的区别：
//   原版：每条消息 spawn 一次 `dsh headless --json --session-id …`
//         → 起进程慢、会话写句柄会撞、沙箱受限令牌还会 EPERM
//   插件：agents.create/resume 在本进程里直接建会话，followup + whenIdle
//         → 没有子进程、没有令牌继承、没有文件写句柄冲突
//
// 会话 id 是**确定性派生**的：sha256(prefix:conv:convId) 折成 uuid 形状。
// 插件重启、Harness 重启、换机器，只要 convId 不变就还是同一个会话 ——
// 上下文能 resume 回来，不会因为重启就失忆（原版靠 .ai-sessions.json 记映射，
// 文件一丢就全断）。
import { createHash, randomUUID } from 'node:crypto'
import { agentOptionsFor } from './model.js'

/**
 * 造一条用户消息。
 *
 * 为什么不用 `@deepseek-ai/dsh-llm` 的 createUserMessage：那个包只随 dsh 装
 * 在 app.asar 里，profile 的 node_modules 里**没有**。插件如果是从工作区目录
 * 链接进 profile 的（本插件就是这样），它的裸包名解析从自己的真实路径开始
 * 往上走，走不到 app.asar —— 一 import 就 ERR_MODULE_NOT_FOUND。
 * 而这个工厂的产物就是个普通对象（实测）：
 *   { content, source: { kind: 'user' }, role: 'user', id: <uuid> }
 * 自己拼一份，零依赖，也不受安装位置影响。
 */
function createUserMessage({ content, source = { kind: 'user' } }) {
  return { content, source, role: 'user', id: randomUUID() }
}

/** 从 assistant/message 的 content 块里抽纯文本 */
export function extractText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && block.text) parts.push(String(block.text))
  }
  // 用 \n 拼：一轮里可能有多段文本（中间夹着工具调用），直接粘会变成
  // 「我先看看看完了」。
  return parts.join('\n').trim()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class BridgeSessions {
  #ctx
  #agents
  #settings
  #log
  /** convId → record */
  #records = new Map()
  /** sessionId → record（事件只带 sessionId，得能反查） */
  #bySessionId = new Map()
  #modelLogged = false

  constructor({ ctx, agents, settings, log }) {
    this.#ctx = ctx
    this.#agents = agents
    this.#settings = settings
    this.#log = log
  }

  sessionKey(convId) {
    return `${this.#settings.sessionPrefix}:conv:${String(convId)}`
  }

  deriveSessionId(convId) {
    const hash = createHash('sha256').update(this.sessionKey(convId)).digest('hex')
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
  }

  findBySessionId(sessionId) {
    return this.#bySessionId.get(String(sessionId))
  }

  findByConvId(convId) {
    return this.#records.get(String(convId))
  }

  list() {
    return [...this.#records.values()].map((r) => ({
      convId: r.convId,
      sessionId: r.sessionId,
      model: r.agent?.options?.model ?? '',
      lastActivity: r.lastActivity,
    }))
  }

  /** 取（或建/恢复）会话 */
  async getOrCreate(convId) {
    const key = String(convId)
    const existing = this.#records.get(key)
    if (existing) {
      existing.lastActivity = Date.now()
      return existing
    }

    const sessionId = this.deriveSessionId(key)
    const cwd = String(this.#settings.cwd ?? '').trim() || process.cwd()
    const agentOptions = agentOptionsFor({ ctx: this.#ctx, settings: this.#settings, log: this.#log })
    if (!this.#modelLogged) {
      this.#modelLogged = true
      this.#log.info(`模型路由：${agentOptions?.provider ?? '?'}/${agentOptions?.model ?? '?'}`)
    }

    let agent
    let handle

    // 先看有没有活的：同一个 sessionId 已经跑着 agent 时再 create 会撞车。
    const live = this.#agents.get?.(sessionId)
    if (live) {
      agent = live
      handle = { agent, dispose: async () => {} }
    } else {
      try {
        const resumed = await this.#agents.resume({
          resumeSessionId: sessionId,
          ...(agentOptions ? { agentOptions } : {}),
        })
        // 恢复出来必须带 model 路由，否则提示词里的 {{model}} 拼不出来，
        // 每一条消息都会「本轮运行失败」。宁可丢历史重建。
        if (resumed?.agent?.options?.model) {
          agent = resumed.agent
          handle = resumed
          this.#log.info(`恢复会话：conv=${key} sessionId=${sessionId}`)
        } else {
          this.#log.warn(`恢复出来的会话没有 model 路由，丢掉重建：conv=${key}`)
          try { await resumed?.dispose?.() } catch { /* 卸不干净也得往下走 */ }
          throw new Error('resumed session has no model route')
        }
      } catch {
        const created = await this.#agents.create({
          sessionId,
          meta: { cwd },
          ...(agentOptions ? { agentOptions } : {}),
        })
        agent = created.agent
        handle = created
        if (!agent?.options?.model) {
          this.#log.error('新建会话没有 model 路由 —— 每条消息都会失败，检查插件 provider/model 配置')
        }
        this.#log.info(`新建会话：conv=${key} sessionId=${sessionId} cwd=${cwd}`)
      }
    }

    const record = {
      convId: key,
      sessionId,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      lastActivity: Date.now(),
    }
    this.#records.set(key, record)
    this.#bySessionId.set(String(sessionId), record)
    return record
  }

  /**
   * 投一条消息，等这一轮跑完，把这轮助手说的话取回来。
   *
   * 取回复的方式是「记账」而不是「听事件」：followup 之前记下 session.seq，
   * whenIdle 之后把这段区间里的 assistant/message 全捞出来。
   * 比挂 session/event 稳 —— 事件是 fire-and-forget 的广播，投递顺序和
   * 「这一轮到底结束没有」都得自己判断；snapshotEvents 是确定性读。
   */
  async deliver(convId, text) {
    const record = await this.getOrCreate(convId)
    const agent = record.agent
    const session = agent.session
    const fromSeq = typeof session?.seq === 'number' ? session.seq : 0

    const message = createUserMessage({
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'user' },
    })
    agent.followup(message)
    record.lastActivity = Date.now()

    const timeoutMs = Number(this.#settings.turnTimeoutMs) || 300000
    let timedOut = false
    let timerHandle = null
    const timer = new Promise((resolve) => {
      timerHandle = setTimeout(() => { timedOut = true; resolve('timeout') }, timeoutMs)
      timerHandle.unref?.()
    })
    try {
      await Promise.race([agent.whenIdle(), timer])
    } catch (error) {
      this.#log.warn(`whenIdle 拒绝：${error?.message ?? error}`)
    } finally {
      if (timerHandle) clearTimeout(timerHandle)
    }

    let reply = ''
    try {
      if (typeof session?.snapshotEvents === 'function') {
        const events = session.snapshotEvents(fromSeq)
        const parts = []
        for (const event of events) {
          if (event?.type !== 'assistant/message') continue
          const t = extractText(event.data?.message?.content)
          if (t) parts.push(t)
        }
        reply = parts.join('\n').trim()
      }
    } catch (error) {
      this.#log.warn(`读取本轮回复失败：${error?.message ?? error}`)
    }

    return { text: reply, sessionId: record.sessionId, timedOut, fromSeq }
  }

  /** 重置某个会话的上下文（下一个 convId 还是同一个 id，所以要落新随机 id） */
  async reset(convId) {
    const key = String(convId)
    const record = this.#records.get(key)
    if (record) {
      this.#records.delete(key)
      this.#bySessionId.delete(String(record.sessionId))
      try { await record.handle.dispose() } catch { /* 已经没了 */ }
    }
    return await this.getOrCreate(key)
  }

  /** 插件卸载时清干净，别把 agent 泄漏在后台跑 */
  async disposeAll() {
    for (const record of this.#records.values()) {
      try { await record.handle.dispose() } catch { /* 忽略 */ }
    }
    this.#records.clear()
    this.#bySessionId.clear()
    // 给还在排队的 turn 一点收尾时间
    await sleep(10)
  }
}
