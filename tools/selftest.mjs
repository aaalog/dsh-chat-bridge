// 纯逻辑自测：不碰网络、不碰 Harness、不建会话。
// 覆盖 guard 的接话判断和 config 的合并/继承规则 —— 这两块是「改错了不会报错、
// 只会行为变怪」的地方，所以必须能单独验。
//
// 跑法：node tools/selftest.mjs
import assert from 'node:assert/strict'
import { DEFAULTS, resolveSettings, stateDirOf } from '../lib/config.js'
import { createGuard } from '../lib/guard.js'

let pass = 0
let fail = 0
const test = (name, fn) => {
  try {
    fn()
    pass += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

const me = { id: 'a_me', displayName: '小助手' }
const silentLog = { info() {}, warn() {}, error() {} }
const DM = { id: 'dm:1', type: 'dm', name: '' }
const GRP = { id: 'grp:1', type: 'group', name: '一家子' }

const mkGuard = (over = {}) => createGuard({
  settings: { name: '小助手', groupReplyMode: 'question', loopGuard: {}, ...over },
  log: silentLog,
})

const human = (convId, text, extra = {}) =>
  ({ seq: 1, convId, sender: 'u_1', senderType: 'human', type: 'text', text, ...extra })
const aiSay = (convId, text, extra = {}) =>
  ({ seq: 2, convId, sender: 'a_2', senderType: 'ai', type: 'text', text, ...extra })

console.log('config：')
test('默认值齐全', () => {
  assert.equal(DEFAULTS.groupReplyMode, 'question')
  assert.equal(DEFAULTS.loopGuard.chainMax, 3)
})
test('顶层覆盖生效、嵌套字段逐层合并', () => {
  const s = resolveSettings({ loopGuard: { chainMax: 5 }, legacyConfigPath: '/nonexistent.json' })
  assert.equal(s.loopGuard.chainMax, 5)
  assert.equal(s.loopGuard.aiMinGapMs, DEFAULTS.loopGuard.aiMinGapMs)
})
test('空串不覆盖默认值（配置留空不能把默认打掉）', () => {
  const s = resolveSettings({ host: '', legacyConfigPath: '/nonexistent.json' })
  assert.equal(s.host, DEFAULTS.host)
})
test('stateDir 落在 plugin-data 下', () => {
  assert.match(stateDirOf({ stateDir: '' }), /plugin-data[\\/]chat-bridge$/)
})
test('自定义 stateDir 优先', () => {
  assert.equal(stateDirOf({ stateDir: 'D:/tmp/cb' }), 'D:/tmp/cb')
})

console.log('guard · 人类：')
test('私聊必回', () => {
  const g = mkGuard()
  assert.equal(g.check(human(DM.id, '在吗'), DM, me).reply, true)
})
test('群里提问才回', () => {
  const g = mkGuard()
  assert.equal(g.check(human(GRP.id, '今天吃啥？'), GRP, me).reply, true)
  assert.equal(g.check(human(GRP.id, '我出门了'), GRP, me).reply, false)
})
test('被点名必回，哪怕陈述句', () => {
  const g = mkGuard()
  assert.equal(g.check(human(GRP.id, '小助手你过来'), GRP, me).reply, true)
  assert.equal(g.check(human(GRP.id, '@小助手 看这个'), GRP, me).reply, true)
})
test('mention 策略下没点名的问句也不回', () => {
  const g = mkGuard({ groupReplyMode: 'mention' })
  assert.equal(g.check(human(GRP.id, '有人在吗？'), GRP, me).reply, false)
})
test('自己发的、系统消息不回', () => {
  const g = mkGuard()
  assert.equal(g.check(human(DM.id, 'hi', { sender: 'a_me' }), DM, me).reply, false)
  assert.equal(g.check(human(DM.id, 'hi', { type: 'system' }), DM, me).reply, false)
})

console.log('guard · AI 对刷刹车：')
test('额度内可以接，用完就闭嘴', () => {
  const g = mkGuard({ loopGuard: { chainMax: 2, aiMinGapMs: 0 } })
  g.check(human(DM.id, '在吗'), DM, me)                    // 人类开口 → 额度 = 2
  assert.equal(g.check(aiSay(DM.id, '我在'), DM, me).reply, true)
  g.noteSent(DM.id, { toAi: true })                        // 额度 2 → 1
  assert.equal(g.check(aiSay(DM.id, '你说呢'), DM, me).reply, true)
  g.noteSent(DM.id, { toAi: true })                        // 额度 1 → 0
  assert.equal(g.check(aiSay(DM.id, '嗯'), DM, me).reply, false)
})
test('人类一开口额度立刻恢复', () => {
  const g = mkGuard({ loopGuard: { chainMax: 1, aiMinGapMs: 0 } })
  g.check(human(DM.id, '在吗'), DM, me)
  g.noteSent(DM.id, { toAi: true })
  assert.equal(g.check(aiSay(DM.id, '嗯'), DM, me).reply, false)
  g.check(human(DM.id, '继续'), DM, me)
  assert.equal(g.check(aiSay(DM.id, '好'), DM, me).reply, true)
})
test('最小间隔生效：6 秒内不接第二句', () => {
  const g = mkGuard({ loopGuard: { chainMax: 9, aiMinGapMs: 6000 } })
  g.check(human(DM.id, '在吗'), DM, me)
  assert.equal(g.check(aiSay(DM.id, '第一句'), DM, me).reply, true)
  g.noteSent(DM.id, { toAi: true })
  assert.equal(g.check(aiSay(DM.id, '第二句'), DM, me).reply, false)
})
test('收尾语不接', () => {
  const g = mkGuard({ loopGuard: { aiMinGapMs: 0 } })
  g.check(human(DM.id, '在吗'), DM, me)
  assert.equal(g.check(aiSay(DM.id, '回头见👋'), DM, me).reply, false)
})
test('固定话术不接（对方桥接报错不引爆对话）', () => {
  const g = mkGuard({ loopGuard: { aiMinGapMs: 0 } })
  g.check(human(DM.id, '在吗'), DM, me)
  assert.equal(g.check(aiSay(DM.id, '（我这边处理出错了：timeout）'), DM, me).reply, false)
  assert.equal(g.check(aiSay(DM.id, '（正在想…）'), DM, me).reply, false)
})
test('防刷熔断：窗口内超量就静默', () => {
  const g = mkGuard({ loopGuard: { chainMax: 99, aiMinGapMs: 0, burstMax: 2, burstWindowMs: 60000 } })
  g.check(human(DM.id, '在吗'), DM, me)
  assert.equal(g.check(aiSay(DM.id, '1'), DM, me).reply, true); g.noteSent(DM.id, { toAi: true })
  assert.equal(g.check(aiSay(DM.id, '2'), DM, me).reply, true); g.noteSent(DM.id, { toAi: true })
  assert.equal(g.check(aiSay(DM.id, '3'), DM, me).reply, false)
})
test('连刷三轮后人类插话能立刻恢复', () => {
  const g = mkGuard({ loopGuard: { chainMax: 3, aiMinGapMs: 0 } })
  g.check(human(DM.id, '在吗'), DM, me)
  g.check(aiSay(DM.id, 'a'), DM, me); g.noteSent(DM.id, { toAi: true })
  g.check(aiSay(DM.id, 'b'), DM, me); g.noteSent(DM.id, { toAi: true })
  g.check(aiSay(DM.id, 'c'), DM, me); g.noteSent(DM.id, { toAi: true })
  assert.equal(g.check(aiSay(DM.id, 'd'), DM, me).reply, false)
  assert.equal(g.check(human(DM.id, '我回来了，问你个事'), DM, me).reply, true)
})
test('没登录（me 为空）一律不回', () => {
  const g = mkGuard()
  assert.equal(g.check(human(DM.id, '在吗'), DM, undefined).reply, false)
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
