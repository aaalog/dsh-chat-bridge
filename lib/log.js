// 落盘日志。
//
// 为什么非得写文件：桌面版的插件跑在 Host 进程里，stdout 被 Electron 收走，
// 出了事在界面上只能看到「处理出错了」。原来 ai-bridge 的 ai-run.log 一直是
// 排查的主入口，插件版保留同样的能力。
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024

export function createLogger(stateDir, base) {
  const file = join(stateDir, 'bridge.log')
  let broken = false

  const ensure = () => {
    if (broken) return false
    try {
      mkdirSync(stateDir, { recursive: true })
      if (existsSync(file) && statSync(file).size > MAX_BYTES) {
        try { renameSync(file, `${file}.1`) } catch { /* 转不动就直接追加 */ }
      }
      return true
    } catch {
      broken = true
      return false
    }
  }

  const write = (level, message) => {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`
    if (ensure()) {
      try { appendFileSync(file, `${line}\n`) } catch { broken = true }
    }
    // 同时往宿主日志走一份：GUI 里能直接看到，省得每次都要翻文件
    try {
      if (level === 'error') base?.error?.(`[chat-bridge] ${message}`)
      else if (level === 'warn') base?.warn?.(`[chat-bridge] ${message}`)
      else base?.info?.(`[chat-bridge] ${message}`)
    } catch { /* 宿主 logger 形状不一定一样，不影响落盘 */ }
  }

  return {
    file,
    log: write,
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    debug: (m) => write('debug', m),
  }
}
