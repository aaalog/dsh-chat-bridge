// 模型路由。
//
// 为什么非给不可：DSH 的提示词里有一段 persona-prefix，
//   You are a coding agent powered by the {{model}} model. ...
// `{{model}}` 取自 agent.options.model。插件的 agents.create() 如果不带
// agentOptions，这个变量就是 undefined，拼提示词时直接抛
//   prompt variable "{{model}}" has no value for this assembly
// 表现是「本轮运行失败」—— 看起来像模型挂了，其实是路由没给。踩过。
//
// 优先级：插件配置 → 宿主 agentDefaultModel → settings.yaml → 兜底。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FALLBACK = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

function fromSettingsFile() {
  const candidates = [
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'settings.yaml') : null,
    join(homedir(), '.dsh', 'settings.yaml'),
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      const idx = text.indexOf('agent-default-model:')
      if (idx < 0) continue
      const block = text.slice(idx, idx + 400)
      const provider = /provider:\s*['"]?([\w.-]+)['"]?/.exec(block)?.[1]
      const model = /model:\s*['"]?([\w.-]+)['"]?/.exec(block)?.[1]
      if (provider && model) return { provider, model, source: 'settings.yaml' }
    } catch { /* 读不动就当没有 */ }
  }
  return undefined
}

function fromHost(ctx) {
  try {
    const svc = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    if (!svc) return undefined
    const pick = typeof svc.currentSelection === 'function' ? svc.currentSelection() : undefined
    if (pick?.provider && pick?.model) {
      return { provider: pick.provider, model: pick.model, source: '宿主 agentDefaultModel' }
    }
  } catch { /* 服务不可用 */ }
  return undefined
}

export function resolveModel({ ctx, settings, log }) {
  const provider = String(settings?.provider ?? '').trim()
  const model = String(settings?.model ?? '').trim()
  if (provider && model) return { provider, model, source: '插件配置' }
  const host = fromHost(ctx)
  if (host) return host
  const file = fromSettingsFile()
  if (file) return file
  log?.warn?.(`没问出模型路由，回退到 ${FALLBACK.provider}/${FALLBACK.model}`)
  return { ...FALLBACK, source: '兜底' }
}

/** 给 agents.create / agents.resume 用的 agentOptions */
export function agentOptionsFor({ ctx, settings, log }) {
  try {
    const resolved = resolveModel({ ctx, settings, log })
    return { provider: resolved.provider, model: resolved.model }
  } catch {
    return undefined
  }
}
