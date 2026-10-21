# dsh-peer-messenger

跨**独立会话**的 Agent 互发消息。复用 DSH 0.2.1 原生的 relay 消息来源与原生 `RelayBody` 渲染，插件只负责寻址、准入、投递与「传输回执」，不重建第二套收件箱、不改渲染、不自动回复、不广播、不加白名单。

**平台**：DeepSeek Harness `0.2.1-rc.2`（host-only，无 client 半）。

## 三个工具

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `list_peer_agents` | 列出可通信的对端会话（非归档、非 subagent、非自己），带 `idle/running/offline` 与标题 | 只读；列出绝不发送或唤醒 |
| `send_agent_message` | 向另一个独立会话发一条消息，以你的 `SessionId` 为来源 | 需 `target_session_id` + `message`（+ 可选 `mode`） |
| `check_delivery` | 查单条已发消息的传输状态 | 只能查自己发的 `message_id` |

### 投递模式
- `followup`（默认）：挂到目标下一轮；对 `idle`/`offline` 都可用。
- `steer`：纠正正在进行的回合；**目标必须 `running`**，否则报错。
- `inject`：注入后台上下文；**目标必须 `running`**。

`offline` 目标以默认参数冷恢复（resume）后按 `followup` 投递；恢复句柄被进程内缓存并经 `ctx.effect` 统一释放。

### 回执状态（仅传输层）
`pending`（仍在待处理收件箱里折叠到）→ `claimed`（已提交进会话日志，目标尚未开始产出）→ `processed`（目标在你的消息之后开始产出）。
**`processed` 只代表「对方开始处理」，绝不等于「你的诉求完成」**——插件不解析任何助手输出内容。

## 不变量（对应 `lib/index.js` 头部注释）

1. 会话日志是唯一真相源；进程内 `ledger` 只是派生缓存，重启即丢、无需持久。
2. 复用原生 relay `source{kind:'agent-message',form:'relay',senderSessionId}` 与原生渲染，不自建 UI。
3. 任意互相发送：**无白名单 / 无 allowedPairs / 无同项目约束**（明确拒绝上游 PR#10 的方向）。
4. 自发消息拒绝 → `self_message`。
5. `origin==='subagent'` 的对端拒绝 → `subagent_not_peer`；普通 fork（仅 `parentSession`）允许。
6. 归档对端拒绝 → `target_archived`：准入时查一次，**resume 之后再复查一次**。
7. 读不到的目标拒绝 → `target_not_found`。
8. 滚动预算熔断（唯一保留的限流）：同一对 10/60s（方向无关）、单发送方 20/60s。
9. 三种模式见上；`steer/inject` 要求 `running`。
10. `offline` 冷恢复后投递；句柄缓存 + `ctx.effect` 释放。
11. resume 窗口内的归档复查（对端可能在恢复期间被归档）。
12. 单条消息序列化上限 64KB。
13. 回执仅传输层：`claimed ≠ 完成`，绝不把助手输出内容当作业务完成。
14. `ledger` 作用域：发送方只能查自己发的消息 → 否则 `message_not_owned_by_sender`。
15. fork 边界：继承前缀（`inheritedEventCount` 之前）的事件永不匹配为「刚发的这条」（上游 issue#2）。
16. 任何投递失败都在 `reserve` 之后释放预算槽，绝不泄漏额度。
17. v1 host-only：无 client 包，**不读取其它插件的 DOM**（从设计上规避上游 issue#4 的文本正则抓取 bug；来源身份取结构化 relay source）。

## 上游经验吸收（`GengDaPeng/dsh-agent-message`）
实现其架构 v2 文档与 7 个 issue 的教训：归档拒绝、subagent 来源排除（放行 fork）、自发拒绝、滚动预算、回执「claimed≠done」、离线恢复 + 句柄释放、恢复窗口复查。仅采纳 PR#10 的 API 纠正（`workspaceRegistry` 访问器、投影 `cwd`、`uiWorkspace.openSession`、`configForms`），**不采纳**其白名单/同项目限制。

## 安装
host 插件，需经 profile 安装（会写入 profile 的 `package.json` 与 `cordis.patch.yml`，属 profile 状态变更，须走 `plugin_manager` / `install_bundle`，不要手工改这两份文件）：

```
plugin_manager  action: install_bundle  target: <本目录绝对路径>
```

安装后该 profile 的**每个会话**重启即加载这三个工具。卸载 / 禁用由 profile patch 行控制。

## 开发校验（无需运行 Harness）
```
npm run check   # 逐模块语法检查
npm test        # 29 项：admission / delivery / receipt / 模块契约 + 三工具注册与执行（经 node_modules 解析真实 dsh 包）
```

## 假设
- 「任意互相发送」覆盖同 profile 下所有非归档、非 subagent 的独立会话，不要求同项目。
- 回执为尽力而为的传输观察，进程重启后旧 `message_id` 视为 `unknown`（无持久 spool）。
