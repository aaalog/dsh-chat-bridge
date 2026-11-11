// 实时收消息（WebSocket）。
//
// 协议（实测）：wss://host/ws?token=xxx&since=N
//   服务端补发 sync（带 since 时）→ ready → 主动推 message / presence / read / closing
//   客户端发 {type:'ping'}，服务端回 pong
//
// 实现选择：优先用 `ws` 包（profile 的 node_modules 里有，作为别的插件的传递依赖），
// 拿不到就退回 Node 22 自带的全局 WebSocket，两样都没有就只留长轮询。
// 这样插件本身没有硬依赖 —— 装它不需要联网拉包。
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

function resolveWebSocketImpl() {
  try {
    const mod = require_('ws')
    return mod?.WebSocket || mod?.default || mod
  } catch { /* 没有 ws 包 */ }
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket
  return null
}

const OPEN = 1

/**
 * @returns {{start: () => void, close: () => void, isOpen: () => boolean}}
 */
export function createReceiver({ api, since = 0, onMessage, onReady, log, onFatal }) {
  const Impl = resolveWebSocketImpl()
  let ws = null
  let closing = false
  let lastSeq = Number(since) || 0
  let delay = 2000
  let pingTimer = null
  let lastPongAt = 0
  let ready = false

  const url = () => {
    const base = String(api.base).replace(/^https/, 'wss').replace(/^http/, 'ws').replace(/\/$/, '')
    let u = `${base}/ws?token=${encodeURIComponent(api.token)}`
    if (lastSeq > 0) u += `&since=${lastSeq}`
    return u
  }

  const stopPing = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
  }

  const startPing = () => {
    stopPing()
    lastPongAt = Date.now()
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== OPEN) return
      try { ws.send(JSON.stringify({ type: 'ping' })) } catch { /* 下一轮重连兜 */ }
      // 60 秒没 pong 就当这条连接死了
      if (Date.now() - lastPongAt > 60000) {
        log.warn('WS 心跳超时，强制重连')
        try { ws.close() } catch { /* 已断 */ }
      }
    }, 30000)
  }

  const scheduleReconnect = () => {
    if (closing) return
    const wait = delay
    delay = Math.min(delay * 1.5, 30000)
    log.warn(`${Math.round(wait / 1000)} 秒后重连 WS…`)
    setTimeout(() => {
      if (closing) return
      try { connect() } catch (error) { log.error(`重连抛错：${error?.message ?? error}`) }
    }, wait)
  }

  const handleFrame = (raw) => {
    let obj
    try { obj = JSON.parse(String(raw)) } catch { return }
    if (!obj || !obj.type) return
    switch (obj.type) {
      case 'ready':
        ready = true
        delay = 2000
        startPing()
        log.info(`WS ready，me=${obj.data?.me?.displayName ?? '?'}，会话 ${(obj.data?.convIds || []).length} 个`)
        try { onReady?.(obj.data || {}) } catch (error) { log.error(`onReady 抛错：${error?.message ?? error}`) }
        break
      case 'message': {
        const m = obj.data || {}
        if (typeof m.seq === 'number' && m.seq > lastSeq) lastSeq = m.seq
        try { onMessage?.(m) } catch (error) { log.error(`onMessage 抛错：${error?.message ?? error}`) }
        break
      }
      case 'sync': {
        const arr = obj.data?.messages || []
        if (arr.length) log.info(`WS 补收 ${arr.length} 条`)
        for (const m of arr) {
          if (typeof m.seq === 'number' && m.seq > lastSeq) lastSeq = m.seq
          try { onMessage?.(m) } catch (error) { log.error(`onMessage 抛错：${error?.message ?? error}`) }
        }
        break
      }
      case 'pong':
        lastPongAt = Date.now()
        break
      case 'closing':
        log.warn(`服务端主动关闭：${JSON.stringify(obj.data ?? {})}`)
        break
      case 'error':
        log.warn(`服务端错误帧：${JSON.stringify(obj.data ?? {})}`)
        break
      default:
        break
    }
  }

  function connect() {
    if (!Impl) {
      log.warn('没有可用的 WebSocket 实现（ws 包和全局 WebSocket 都没有）')
      onFatal?.(new Error('no websocket implementation'))
      return
    }
    log.info(`WS 连接中… ${api.base.replace(/^http/, 'ws')}/ws`)
    ws = new Impl(url())

    // ws 包是 EventEmitter（on/onmessage 都有），全局 WebSocket 走 onxxx 属性。
    // 两套都认，少一个分支就少一种「某个环境里收不到消息」的坑。
    const useEmitter = typeof ws.on === 'function' && typeof ws.addEventListener !== 'function'
    const bind = (name, handler) => {
      if (useEmitter) ws.on(name, handler)
      else ws[`on${name}`] = handler
    }

    bind('open', () => { log.info('WS 已连接') })

    bind('message', (event) => {
      // ws 包给的是 (data) ；浏览器/全局 WebSocket 给的是 event 对象
      const data = event && typeof event === 'object' && 'data' in event ? event.data : event
      handleFrame(data)
    })

    bind('close', (event) => {
      ready = false
      stopPing()
      const code = typeof event === 'number' ? event : event?.code
      log.warn(`WS 断开 code=${code ?? '?'}`)
      scheduleReconnect()
    })

    bind('error', (event) => {
      log.warn(`WS 错误：${event?.message ?? String(event)}`)
    })
  }

  return {
    start() {
      closing = false
      connect()
    },
    close() {
      closing = true
      stopPing()
      if (ws) {
        try { ws.close() } catch { /* 已断 */ }
        ws = null
      }
    },
    isOpen() {
      return Boolean(ws && ws.readyState === OPEN && ready)
    },
    get available() { return Boolean(Impl) },
  }
}
