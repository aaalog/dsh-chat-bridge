// 「这条消息该不该接」 + AI 对刷的刹车。
//
// 原来的 ai-bridge 在这里踩过一个大的：`shouldReply()` 里「对方是 AI 就不接话」
// 只判在群聊分支，单聊直接 return true。于是这个账号的每条回复（包括错误提示）
// 都被另一个桥接账号回一句，两个 AI 无限对刷，几秒内刷出上百条。
//
// 现在这套规则是那次事故后定下来的：
//
//   规则            行为                                   目的
//   ─────────────────────────────────────────────────────────────────────────────
//   接力额度        每条**人类**消息重置为 chainMax；       硬闸门：一条人类消息
//   (chainMax)      AI 之间每接一句扣 1，归零就闭嘴等人      最多引出 N 轮 AI 互聊
//   最小间隔        我方两次「接 AI 的话」至少隔 aiMinGapMs   不抢话、不复读
//   (aiMinGapMs)    人类插话不受限
//   收尾语          对方说「拜拜/回头见/不用回了…」就不再接    让对话自然结束
//   固定话术过滤    「（正在想…」「（我这边处理出错了」不接   对方报错不引爆对话
//   点名门槛        没点我名也没问我时，额度 ≥2 才插一句       会接话但不自说自话
//   防刷熔断        60 秒内接 AI 的话超过 burstMax 条          最后一道保险
//                   → 静默 muteMs
//
// 所有阈值都在配置里（loopGuard.*），日志会写清「为什么没接」，随时能核对。

const CLOSING = /(回头见|回头聊|拜拜|再见|晚安|先这样|不聊了|不用回|别回了|下次聊|👋)/u
const CANNED = /^\s*（?(正在想|我这边处理出错了|没有想说的|处理出错)/u
const QUESTION = /[?？]|吗|呢|怎么|如何|什么|多少|哪里|哪个|谁|能不能|是不是|对不对|有没有|行不行|要不要/u

export function createGuard({ settings, log }) {
  const cfg = {
    chainMax: Number(settings?.loopGuard?.chainMax ?? 3),
    aiMinGapMs: Number(settings?.loopGuard?.aiMinGapMs ?? 6000),
    burstMax: Number(settings?.loopGuard?.burstMax ?? 10),
    burstWindowMs: Number(settings?.loopGuard?.burstWindowMs ?? 60000),
    muteMs: Number(settings?.loopGuard?.muteMs ?? 60000),
  }
  const mode = String(settings?.groupReplyMode ?? 'question')
  const botName = String(settings?.name ?? '')

  /** convId → 状态 */
  const states = new Map()
  /** 跳过日志 30 秒/会话 节流 */
  const lastSkipLog = new Map()

  const stateOf = (convId) => {
    let st = states.get(convId)
    if (!st) {
      st = { chain: cfg.chainMax, lastOurAt: 0, burst: [], mutedUntil: 0, humanAt: 0 }
      states.set(convId, st)
    }
    return st
  }

  const mentionsSelf = (msg, me, text) => {
    if (Array.isArray(msg?.mentions) && me?.id && msg.mentions.includes(me.id)) return true
    if (me?.displayName && text.includes(`@${me.displayName}`)) return true
    if (botName && text.includes(botName)) return true
    return false
  }

  const decide = (msg, conv, me) => {
    const convId = String(msg?.convId ?? conv?.id ?? '')
    const st = stateOf(convId)
    const text = String(msg?.text ?? '')

    if (!msg) return { reply: false, why: '空消息' }
    if (!me?.id) return { reply: false, why: '还没登录' }
    if (msg.sender === me.id) return { reply: false, why: '自己发的' }
    if (msg.type === 'system' || msg.sender === 'system') return { reply: false, why: '系统消息' }
    if (!text.trim()) return { reply: false, why: '非文本消息' }
    if (CANNED.test(text)) return { reply: false, why: '固定话术（对方桥接在报告错误）' }

    const isGroup = conv?.type === 'group' || String(convId).startsWith('grp:')
    const fromAi = msg.senderType === 'ai'
    const mentioned = mentionsSelf(msg, me, text)

    // ── 人类说话 ──
    if (!fromAi) {
      st.chain = cfg.chainMax          // 人类一开口，额度重置
      st.humanAt = Date.now()
      st.mutedUntil = 0                // 人类插话不解封熔断之外的任何东西
      if (mentioned) return { reply: true, why: '人类点名' }
      if (!isGroup) return { reply: true, why: '私聊' }
      if (mode === 'mention') return { reply: false, why: '群聊策略=mention，只认 @' }
      if (mode === 'question') {
        return QUESTION.test(text)
          ? { reply: true, why: '群里的问句' }
          : { reply: false, why: '群聊策略=question，陈述句不回' }
      }
      return { reply: true, why: '群聊策略=always' }
    }

    // ── AI 说话：这里的每一步都是刹车 ──
    if (CLOSING.test(text)) return { reply: false, why: '对方在收尾' }
    const now = Date.now()
    if (st.mutedUntil > now) {
      return { reply: false, why: `熔断中，还剩 ${Math.ceil((st.mutedUntil - now) / 1000)}s` }
    }
    if (st.chain <= 0) return { reply: false, why: '接力额度用尽，等着人接话' }

    const asksMe = mentioned || /你/u.test(text)
    // 最后一份额度只留给「被点名/被问到」的情况：额度见底就不再主动搭话。
    // chainMax=3 时这条线是 1（原来写死的 2），chainMax=1 时是 0 —— 也就是
    // 额度只有 1 的情况下仍然允许那唯一一次接话，不然 chainMax=1 等于「永远
    // 不许接话」，配置名和实际行为就对不上了。
    const reserve = Math.max(0, Math.min(1, cfg.chainMax - 1))
    if (!asksMe && st.chain <= reserve) {
      return { reply: false, why: `没点名也没问我，额度只剩 ${st.chain} —— 不主动搭话` }
    }
    if (st.lastOurAt && now - st.lastOurAt < cfg.aiMinGapMs) {
      return { reply: false, why: `距上次接话 ${now - st.lastOurAt}ms < ${cfg.aiMinGapMs}ms` }
    }
    st.burst = st.burst.filter((t) => now - t < cfg.burstWindowMs)
    if (st.burst.length >= cfg.burstMax) {
      st.mutedUntil = now + cfg.muteMs
      log?.warn?.(`会话 ${convId} 60s 内接了 ${st.burst.length} 条 AI 消息，静默 ${Math.round(cfg.muteMs / 1000)}s`)
      return { reply: false, why: '刷太快，开始熔断' }
    }

    return { reply: true, why: asksMe ? '对方在跟我说' : '自然接一句' }
  }

  return {
    /** 判定；跳过时会按会话节流写一行日志 */
    check(msg, conv, me) {
      const verdict = decide(msg, conv, me)
      if (!verdict.reply) {
        const convId = String(msg?.convId ?? conv?.id ?? '')
        const now = Date.now()
        if (now - (lastSkipLog.get(convId) ?? 0) > 30000) {
          lastSkipLog.set(convId, now)
          log?.info?.(`不接话（${verdict.why}）：#${msg?.seq ?? '?'} ${String(msg?.text ?? '').slice(0, 40)}`)
        }
      }
      return verdict
    },

    /** 我方发出了一条（接 AI 的话要扣额度、记间隔、记 burst） */
    noteSent(convId, { toAi = false } = {}) {
      const st = stateOf(String(convId))
      st.lastOurAt = Date.now()
      if (toAi) {
        st.chain = Math.max(0, st.chain - 1)
        st.burst.push(Date.now())
      }
    },

    snapshot() {
      const out = {}
      for (const [convId, st] of states) {
        out[convId] = {
          chain: st.chain,
          burst: st.burst.length,
          muted: Math.max(0, st.mutedUntil - Date.now()),
          lastOurAt: st.lastOurAt,
        }
      }
      return { cfg, mode, conversations: out }
    },

    reset(convId) {
      states.delete(String(convId))
    },
  }
}
