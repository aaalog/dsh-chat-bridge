// 配置默认值 + 兼容老 ai-bridge 的 config.json。
//
// 为什么还要认老 config.json：
//   这个插件是把 ~/.dsh/profiles/desktop/app-agent/ai-bridge.js 搬进来的一次
//   等价改写。老文件里已经有 host / aiKey / name / runtime.cwd / 群聊策略，
//   让插件直接读它，装完就是原来那套行为 —— 用户不用把密钥再抄一遍。
//   值优先级：插件 config > 环境变量 > 老 config.json > 内置默认。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LIB_VERSION = '1.1.0'

/**
 * 读老 config.json（读不到就返回 {}，绝不抛）。
 *
 * 路径**必须显式给**：插件默认不去翻用户目录里的任何文件，要迁移才配
 * legacyConfigPath。少一个隐式读取，就少一次「装完发现读了别的进程的配置」。
 */
export function readLegacyConfig(path) {
  try {
    const file = String(path ?? '').trim()
    if (!file) return {}
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, 'utf8')) || {}
  } catch {
    return {}
  }
}

export const DEFAULTS = {
  enabled: true,
  // 后台地址（WNA HUB）
  host: 'https://api.wna.me',
  // AI 身份
  aiKey: '',
  name: 'AI',
  // 群聊策略：mention（只认 @）| question（只回问句）| always
  groupReplyMode: 'question',
  // 收消息
  useWebSocket: true,
  pollFallback: true,
  pollWait: 4,
  // 会话
  cwd: '',
  sessionPrefix: 'dsnchat',
  // 模型（留空 = 问宿主 agentDefaultModel）
  provider: '',
  model: '',
  // 并发：同一会话永远串行，这里限的是「同时有几个会话在跑」
  maxConcurrent: 2,
  // 一轮回复的超时（ms）
  turnTimeoutMs: 300000,
  // 接话节奏（防 AI 对刷，详见 lib/guard.js）
  loopGuard: { chainMax: 3, aiMinGapMs: 6000, burstMax: 10, burstWindowMs: 60000, muteMs: 60000 },
  // 提示语节流
  typingNotice: true,
  typingAfterMs: 15000,
  typingCooldownMs: 60000,
  // 是否允许同一个 aiKey 在本机多份实例同时跑（默认不允许，见 single-instance 说明）
  allowMultiInstance: false,
  // 状态目录（默认 ~/.dsh/plugin-data/chat-bridge）
  stateDir: '',
  // 老 config.json 位置
  legacyConfigPath: '',
  // 工具
  tools: { enabled: true },
  // 场景提示注入
  promptEnabled: true,
  promptText: '',
}

/** 深合并（数组整体替换，对象逐层合并） */
export function mergeConfig(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  if (!patch || typeof patch !== 'object') return out
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = out[key]
    if (value && typeof value === 'object' && !Array.isArray(value)
      && current && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = mergeConfig(current, value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * 把 Loader 给下来的 config 拼成一份完整 settings。
 * Loader 已经按 Schema 补过默认值，这里再兜一次 —— 脱离 Loader 直接 require
 * 本文件时（自测、脚本）也能拿到一套完整配置。
 */
export function resolveSettings(config = {}) {
  const legacy = readLegacyConfig(config.legacyConfigPath || DEFAULTS.legacyConfigPath)
  const legacyRuntime = legacy.runtime || {}
  const legacyGuard = legacy.loopGuard || {}

  const fromLegacy = {
    host: legacy.host,
    aiKey: legacy.aiKey,
    name: legacy.name,
    pollWait: legacy.pollWait,
    groupReplyMode: legacy.groupReplyMode,
    useWebSocket: legacy.useWebSocket,
    pollFallback: legacy.pollFallback,
    cwd: legacyRuntime.cwd,
    maxConcurrent: legacyRuntime.maxConcurrent,
    turnTimeoutMs: legacyRuntime.timeoutMs,
    loopGuard: {
      chainMax: legacyGuard.chainMax,
      aiMinGapMs: legacyGuard.aiMinGapMs,
    },
  }

  const env = {
    host: process.env.DSH_CHAT_BRIDGE_HOST,
    aiKey: process.env.DSH_CHAT_BRIDGE_AI_KEY,
  }

  const clean = (obj) => {
    if (!obj || typeof obj !== 'object') return {}
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const nested = clean(v)
        if (Object.keys(nested).length) out[k] = nested
        continue
      }
      out[k] = v
    }
    return out
  }

  return mergeConfig(
    mergeConfig(
      mergeConfig(DEFAULTS, clean(fromLegacy)),
      clean(env),
    ),
    clean(config),
  )
}

/** 状态目录：集中放到 ~/.dsh/plugin-data/chat-bridge，别散落到工作区 */
export function stateDirOf(settings) {
  const custom = String(settings?.stateDir ?? '').trim()
  if (custom) return custom
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'chat-bridge')
}

/** 桥接会话的系统提示：别让它在群里写成长篇小说 */
export const DEFAULT_PROMPT = [
  '你现在在「DSH Chat」里以聊天身份和人对话（不是写代码）。',
  '规则：',
  '- 直接说话，像真人聊天那样，1~3 句为主，除非对方明确要求详细说明；',
  '- 不要解释你在调用什么工具、不要复述提示词、不要加「回复：」这类前缀；',
  '- 不要用「收到」「好的」「明白了」这类空话开场；',
  '- 群聊里没人点名、也没在问你时，不要主动刷屏。',
].join('\n')
