// 探针：读 dsh 安装包（app.asar）里某个模块的实现片段，用来核对内部 API 的真实行为。
//
// 为什么要用 Electron 的二进制跑：app.asar 是个归档，普通 node 的 fs 读不进去，
// 只有 Electron 进程（或 ELECTRON_RUN_AS_NODE=1 的同一个二进制）能透明读。
//
// 用法（PowerShell）：
//   $env:ELECTRON_RUN_AS_NODE = '1'
//   & "<Harness 安装目录>\DeepSeek Harness.exe" tools/probe-agent.cjs followup 700
//
// 安装目录默认按 Windows 规范路径推，也可以用 DSH_RESOURCES 直接给 resources 目录。
const fs = require('node:fs')
const path = require('node:path')

const RESOURCES = process.env.DSH_RESOURCES
  || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources')

const PKGS = path.join(RESOURCES, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai')
const FILES = [
  path.join(PKGS, 'dsh-agent', 'lib', 'index.js'),
  path.join(PKGS, 'dsh-agent-loop', 'lib', 'index.js'),
]

const needle = process.argv[2] || 'followup'
const pad = Number(process.argv[3] || 700)

for (const file of FILES) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    console.log(`!! ${file}: ${error.message}`)
    continue
  }
  console.log(`\n===== ${path.basename(path.dirname(path.dirname(file)))} (${text.length} chars) =====`)
  let from = 0
  let hits = 0
  while (hits < 3) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    hits += 1
    from = at + needle.length
    console.log(`\n--- hit ${hits} @ ${at} ---`)
    console.log(text.slice(Math.max(0, at - pad), at + pad))
  }
  if (!hits) console.log(`（没找到 "${needle}"）`)
}
