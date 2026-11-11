# dsh-chat-bridge

把 DeepSeek Harness 里的智能体接进 **DSH Chat** 风格的聊天后台：收消息 → 交给一个
真正的 DSH 会话去回 → 把回复发回去。

它是「独立桥接进程」的插件化版本。原来的做法是每条消息 `spawn` 一次
`dsh headless --json --session-id …`；改成 Host 内插件之后，三个结构性毛病一起消失：

| 独立进程的做法 | 本插件 |
|---|---|
| 子进程继承 DSH 的沙箱受限令牌，写别的 profile 目录直接 **EPERM** | 不 spawn 任何子进程，没有令牌继承 |
| 每条消息起一个 headless，慢；同会话并发会撞 `session is already owned by an active write handle` | `agents.create` / `resume` 在本进程建会话，`followup` + `whenIdle` |
| 会话映射存在 JSON 文件里，文件一丢上下文全断 | 会话 id 由 `convId` **确定性派生**，重启照样 `resume` 回来 |
| 日志在控制台，桌面版看不到 stdout | 落盘 `~/.dsh/plugin-data/chat-bridge/{bridge.log,diagnostic.json,bridge.pid}` |

## 装

```bash
# 1) 把它放进某个目录，装进当前 profile
plugin_manager install_bundle  /绝对路径/dsh-chat-bridge

# 2) 确认加载了
cordis_inspect_query  Config.listConfigs  { "name": "dsh-chat-bridge" }
#    status: schema   → 模块起来了
#    status: inactive → 模块没加载（看下面的「坑」）
```

如果这个目录是从工作区**链接**进 profile 的（`file:` 依赖），还要补一个依赖链接：

```bash
node tools/link-deps.mjs          # DSH_PROFILE=xxx 可指定 profile
```

**改完代码要重载**，HMR 不盯工作区目录：

```
plugin_manager set_plugin  <entryId>  enabled=false
plugin_manager set_plugin  <entryId>  enabled=true
```

## 配

密钥走环境变量，别写进版本库：

```bash
export DSH_CHAT_BRIDGE_AI_KEY=ak_xxxxxxxx     # 或 DSH_CHAT_BRIDGE_HOST
```

其余字段在 `cordis.patch.yml` 那一行里，或在你自己 profile 的 `cordis.patch.yml`
里补一行同 id 覆盖：

```yaml
- id: chat-bridge
  config:
    name: "小助手"
    groupReplyMode: question
    loopGuard: { chainMax: 2, aiMinGapMs: 8000 }
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | 内置默认后台 | 聊天后台地址 |
| `aiKey` | 空 → `DSH_CHAT_BRIDGE_AI_KEY` | AI 身份密钥；**空了就不连后台** |
| `name` | `AI` | 名字，用来判断是不是在叫我 |
| `groupReplyMode` | `question` | `mention` 只认 @ / `question` 只回问句 / `always` 全回 |
| `cwd` | 进程当前目录 | 桥接会话的工作目录 |
| `sessionPrefix` | `dsnchat` | 会话 key 前缀（改了等于换一批新会话） |
| `provider` / `model` | 空 → 宿主 `agentDefaultModel` | 桥接会话的模型路由 |
| `maxConcurrent` | 2 | 同时跑几个会话（同一会话永远串行） |
| `turnTimeoutMs` | 300000 | 一轮回复超时 |
| `loopGuard.*` | 3 / 6000 / 10 / 60000 / 60000 | 防对刷刹车，见下 |
| `typingNotice` / `typingAfterMs` / `typingCooldownMs` | true / 15000 / 60000 | 慢的时候先发一句「正在想…」 |
| `allowMultiInstance` | false | 允许同 aiKey 本机多开（默认禁止） |
| `legacyConfigPath` | 空 | 从老桥接迁移时指过去，继承 host/aiKey/name/cwd |
| `promptEnabled` / `promptText` | true / 空 | 给桥接会话注入的聊天场景提示 |
| `tools.enabled` | true | 注册 `chat_bridge_*` 工具 |

值优先级：**插件 config → 环境变量 → `legacyConfigPath` 指向的文件 → 内置默认**。
默认**不读**用户目录里的任何文件。

## 防 AI 对刷

两个 AI 账号互相接话，几秒就能刷出上百条 —— 这不是假想，是实际踩过的：某段时间
连续几十条消息都是同一个账号发的，而本机日志一条没有，说明别处还有一份同 `aiKey`
的实例在跑，回路一闭就停不下来。

所以有两层：

**1. 单实例闸门**：同一个 `stateDir` 只允许一个活进程（`bridge.pid`）。第二份
**不会连后台**，只在 `diagnostic.json` 里记一笔。

**2. 接话节奏**（`loopGuard`），每次都写一行「不接话（原因）」方便核对：

| 规则 | 行为 |
|---|---|
| `chainMax` 接力额度 | 每条**人类**消息重置额度；AI 之间每接一句扣 1，归零就闭嘴等人 |
| `aiMinGapMs` 最小间隔 | 我方两次「接 AI 的话」至少隔这么久；人类插话不受限 |
| 收尾语 | 对方说「拜拜 / 回头见 / 不用回了…」就不再接 |
| 固定话术过滤 | 「（正在想…」「（我这边处理出错了」一律不接 |
| 点名门槛 | 没点我名也没问我时，额度见底就不再主动搭话 |
| `burstMax` 熔断 | 窗口内接 AI 的话超过这个数 → 静默 `muteMs` |

## 工具

- **`chat_bridge_status`** —— 登录没有、走 WS 还是轮询、收发/跳过几条、映射了哪些
  会话、接话节奏。`selftest: true` 会**真的建一个会话跑一轮小回合**（不往聊天里发
  任何东西），验证「建会话 → 投消息 → 取回复」这条链路。这是本插件唯一「改错了不
  报错、只在真人发消息时才炸」的地方，所以留了个能随时按的按钮。
- **`chat_bridge_send`** —— 主动往某个会话发一条（`convId` 或会话名 `to`）。

## 会话与上下文

`convId` → `sha256("dsnchat:conv:<convId>")` → uuid 形状的 `SessionId`。同一个会话
永远落在同一个 DSH session 上，插件/Harness 重启后 `resume` 回来，上下文不断。
想强制断上下文就改 `sessionPrefix`。

## 实现上的三个坑

写的时候都踩过，记下来省得下次再踩：

1. **`@deepseek-ai/dsh-llm` 解析不到。** 它只随 dsh 装在 `app.asar` 里，profile 的
   `node_modules` 没有。插件如果是从工作区链接进 profile 的，裸包名解析从自己的真实
   路径往上走，走不到 asar。所以 `UserMessage` 自己拼 —— 那个工厂的产物就是个普通
   对象（实测）：

   ```js
   { content, source: { kind: 'user' }, role: 'user', id: randomUUID() }
   ```

2. **`@deepseek-ai/schemastery` 同理。** 这个必须真解析到（`Config` 要在模块加载时
   就存在，Loader 要读它投影出设置表单），所以用 `tools/link-deps.mjs` 建 junction。
   不要改成运行时 `await import()` —— 那只是把「装不上」变成一个更晚、更难查的失败。

3. **不给 `agentOptions` 会「每轮都失败」。** DSH 提示词里有一段 persona-prefix，里面
   的 `{{model}}` 取自 `agent.options.model`；渠道自己 `agents.create()` 建的会话如果
   没带这个选项，变量为空，拼提示词时直接抛
   `prompt variable "{{model}}" has no value for this assembly`。
   表现是「本轮运行失败」，看起来像模型挂了。所以建会话前必须解析出模型路由；
   `resume` 回来没有 model 的会话宁可丢掉重建。

## 排查

1. `~/.dsh/plugin-data/chat-bridge/diagnostic.json` —— 起没起、登没登、收几条；
2. `~/.dsh/plugin-data/chat-bridge/bridge.log` —— 完整时间线（>2MB 自动轮转一份）;
3. 直接在 Harness 里问「桥接还活着吗」→ 模型会调 `chat_bridge_status`。

| 现象 | 原因 |
|---|---|
| 跑着但收不到消息 | WS 不通 → 自动降级长轮询，日志里有「降级长轮询」；`pollFallback=false` 时会直接报错 |
| 每条消息都「本轮运行失败」 | 模型路由没给（`{{model}}` 为空）→ 配 `provider` / `model` |
| 没连后台，日志说已有实例在跑 | 单实例闸门命中了，先确认老进程还活着 |
| 状态是 `inactive` | 模块没加载起来：多半是依赖没链接（见坑 2） |

## 自测

```bash
node tools/selftest.mjs
```

纯逻辑自测（接话判断 + 配置合并），不联网、不建会话。

## License

MIT
