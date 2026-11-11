// 把 @deepseek-ai/schemastery 链接进插件目录。
//
// 为什么需要：这个插件是从工作区目录**链接**进 profile 的（`file:` 依赖），
// 它的裸包名解析从自己的真实路径开始往上走 —— 走不到 profile 的 node_modules，
// 而 schemastery 只随 dsh / profile 装着。链接一份进来，import 才能成功。
//
// 不做成运行时动态 import 的理由：Config 必须在模块加载时就存在（Loader 要读它
// 投影出设置表单），顶层 await 只会把「装不上」变成一个更晚、更难查的失败。
//
// 跑法：
//   node tools/link-deps.mjs                # 默认用 desktop profile
//   DSH_PROFILE=xxx node tools/link-deps.mjs
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = dirname(here)

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = process.env.DSH_PROFILE || 'desktop'
const profileModules = join(home, 'profiles', profile, 'node_modules')

const link = join(pluginDir, 'node_modules', '@deepseek-ai', 'schemastery')
const target = join(profileModules, '@deepseek-ai', 'schemastery')

if (existsSync(link)) {
  console.log(`已存在：${link}`)
} else if (!existsSync(target)) {
  console.error(`找不到源：${target}\n`
    + '先把 dsh 的 profile 装好（schemastery 是它的依赖），或用 DSH_PROFILE 指定 profile 名。')
  process.exitCode = 1
} else {
  mkdirSync(dirname(link), { recursive: true })
  // Windows 上目录符号链接要管理员，junction 不要；symlinkSync 的 'junction' 类型是安全的
  symlinkSync(target, link, 'junction')
  console.log(`已链接：${link}\n      → ${target}`)
}
