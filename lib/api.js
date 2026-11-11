// WNA HUB chat 后台的 HTTP 客户端（照搬 ai-bridge.js 里跑通的那套协议）。
//
// 协议要点（实测确认）：
//   POST /api/v1/chat/auth/ai-login  { aiKey }        → { token, me }
//   GET  /api/v1/chat/conversations                    → 会话列表
//   GET  /api/v1/chat/messages?convId=&limit=          → 历史
//   GET  /api/v1/chat/conversations/:id/members        → 成员（含 type: human|ai）
//   POST /api/v1/chat/messages/send  { convId, type:'text', text }
//   GET  /api/v1/chat/messages/poll?convId=&since=&wait= → 长轮询（WS 不可用时的退路）
//   POST /api/v1/chat/auth/heartbeat                    → 保活
// 所有请求都带 X-Nonce / X-Timestamp，登录后带 authorization: Bearer <token>。
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'

const PREFIX = '/api/v1/chat'

export function createApi({ host, aiKey, log }) {
  const base = String(host || 'https://api.wna.me').replace(/\/$/, '')
  let token = ''
  let me = null

  /**
   * 一次请求。用 node:https 而不是 fetch：这条链路原来就是 https.request 跑通的，
   * 换 fetch 只会多一层不确定性（自定义头、长轮询超时语义）。
   */
  function request(method, path, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      let url
      try {
        url = new URL(base + path)
      } catch (error) {
        reject(new Error(`后台地址不合法：${base}${path}`))
        return
      }
      const lib = url.protocol === 'https:' ? https : http
      const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null
      const headers = {
        'user-agent': 'dsh-chat-bridge/1.0',
        accept: 'application/json',
        'X-Nonce': crypto.randomBytes(8).toString('hex'),
        'X-Timestamp': String(Math.floor(Date.now() / 1000)),
      }
      if (token) headers.authorization = `Bearer ${token}`
      if (data) {
        headers['content-type'] = 'application/json; charset=utf-8'
        headers['content-length'] = data.length
      }
      const req = lib.request({
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers,
        timeout: timeoutMs || 40000,
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let parsed
          try { parsed = JSON.parse(raw) } catch { parsed = { code: res.statusCode, message: raw.slice(0, 200) } }
          resolve({ status: res.statusCode, body: parsed })
        })
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  }

  const ok = (r) => Boolean(r?.body) && r.body.code === 0

  return {
    get base() { return base },
    get token() { return token },
    get me() { return me },
    request,

    async login() {
      if (!aiKey) throw new Error('没有 aiKey：插件配置 aiKey 或环境变量 DSH_CHAT_BRIDGE_AI_KEY')
      const r = await request('POST', `${PREFIX}/auth/ai-login`, { aiKey })
      if (!ok(r)) throw new Error(`AI 登录失败：${r?.body?.message ?? `HTTP ${r.status}`}`)
      token = r.body.data.token
      me = r.body.data.me
      log.info(`已登录为 AI：${me.displayName} (${me.id})`)
      return me
    },

    async conversations() {
      const r = await request('GET', `${PREFIX}/conversations`)
      if (!ok(r)) return []
      return r.body.data?.conversations || []
    },

    async history(convId, limit = 20) {
      const r = await request('GET',
        `${PREFIX}/messages?convId=${encodeURIComponent(convId)}&limit=${limit}`)
      if (!ok(r)) return []
      return r.body.data?.messages || []
    },

    async members(convId) {
      const r = await request('GET', `${PREFIX}/conversations/${encodeURIComponent(convId)}/members`)
      if (!ok(r)) return []
      const d = r.body.data || {}
      return d.members || (Array.isArray(d) ? d : [])
    },

    async sendText(convId, text, mentions) {
      const body = { convId, type: 'text', text }
      if (Array.isArray(mentions) && mentions.length) body.mentions = mentions
      const r = await request('POST', `${PREFIX}/messages/send`, body)
      if (!ok(r)) throw new Error(r?.body?.message ?? `HTTP ${r.status}`)
      return r.body.data
    },

    async heartbeat() {
      try { await request('POST', `${PREFIX}/auth/heartbeat`, {}, 10000) } catch { /* 保活失败下一轮再说 */ }
    },

    /** 长轮询：拿 since 之后的新消息 */
    async poll(convId, since, wait) {
      const r = await request('GET',
        `${PREFIX}/messages/poll?convId=${encodeURIComponent(convId)}&since=${since}&wait=${wait}`,
        null, (wait + 20) * 1000)
      if (!ok(r)) return { messages: [], cursor: since }
      return {
        messages: r.body.data?.messages || [],
        cursor: typeof r.body.data?.cursor === 'number' ? r.body.data.cursor : since,
      }
    },

    /** 掉线后重新登录（token 过期时用） */
    async relogin() {
      token = ''
      return await this.login()
    },
  }
}
