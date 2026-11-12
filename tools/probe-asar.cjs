// 探针 2：在整个 app.asar（不只是 dsh-agent）里搜关键字，定位某个 hook / 服务 / 事件的
// 注册点。probe-agent.cjs 只盯着两个包，查「谁订阅了 agent/pre-step」这种事不够用。
//
// 必须用 Electron 的二进制跑（asar 是虚拟目录，普通 node 读不了）：
//   $env:ELECTRON_RUN_AS_NODE = '1'
//   & "<Harness>\DeepSeek Harness.exe" tools/probe-asar.cjs "agent/pre-step" 400
//
// 安装目录自动按 LOCALAPPDATA 推，也能用 DSH_RESOURCES 直接指 resources 目录。
const fs = require('node:fs')
const path = require('node:path')

const RESOURCES = process.env.DSH_RESOURCES
  || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources')
const ROOTS = [
  path.join(RESOURCES, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai'),
  path.join(RESOURCES, 'app.asar', 'dsh', 'node_modules'),
]

const needle = process.argv[2] || 'agent/pre-step'
const pad = Number(process.argv[3] || 300)
const MAX_FILES = Number(process.env.PROBE_MAX_FILES || 400)
const MAX_HITS = Number(process.env.PROBE_MAX_HITS || 40)

function walk(dir, out, depth = 0) {
  if (out.length >= MAX_FILES || depth > 6) return
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walk(full, out, depth + 1)
    } else if (/\.(js|cjs|mjs|json)$/.test(entry.name) && !/\.map$/.test(entry.name)) {
      out.push(full)
    }
  }
}

const files = []
for (const root of ROOTS) walk(root, files)

let hits = 0
const seen = new Set()
for (const file of files) {
  if (hits >= MAX_HITS) break
  if (seen.has(file)) continue
  seen.add(file)
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { continue }
  if (!text.includes(needle)) continue
  let from = 0
  let local = 0
  while (local < 2 && hits < MAX_HITS) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    from = at + needle.length
    local += 1
    hits += 1
    const rel = file.slice(RESOURCES.length + 1).replace(/\\/g, '/')
    console.log(`\n--- ${rel} @ ${at} ---`)
    console.log(text.slice(Math.max(0, at - pad), at + pad).replace(/\r/g, ''))
  }
}
console.log(`\n[scanned ${seen.size} files, ${hits} hits]`)
