---
name: ditto
description: 操作开发机上的 Ditto 专用 Chromium 浏览器，自动复用主力电脑 Chrome 插件全量同步的登录态（Cookie / localStorage / sessionStorage），进行网页浏览、元素交互、控制台/网络排障、文件上传、JS 执行与截图。支持多 Agent 会话并发隔离。
---

# Ditto Browser Skill

`ditto` 控制运行在当前开发机上的专用无头 Chromium（默认服务端口 `3217`，Agent 控制接口默认仅本机 `127.0.0.1` 可访问），不会抢占用户主力电脑的本地浏览器焦点，同时原生支持**多个 Agent 会话并发操作各自的独立标签页**。

用户在主力电脑 Chrome 安装并连接 Ditto 插件后，插件会**后台每 5 分钟全量同步浏览器所有 Cookie + 已打开页的 Storage，并在新开标签页时主动同步**——即使主力电脑合盖关机离线，开发机 Chromium Profile 中依然保留着完整持久化的 Cookie，你可以直接继续浏览和操作。主力电脑在线时，调用 `ditto open <url>` 或 `ditto sync` 还会即时拉取最新登录态。

## 核心工作流（多会话并发安全规范）

为保证多个 Codex / Claude 会话同时运行互不串台、互不抢焦点，**请始终遵循「一人一 Tab，全程带 `--tab`」**：

```bash
# 1. 打开目标页面，获取属于当前任务的专属 tabId / shortId（例如返回 "shortId": "e28c2282"）
ditto open "https://example.com"

# 2. 后续所有操作均显式传入 --tab <shortId>（后台直接操作该标签页，不抢其他会话或人工观测页焦点）
ditto snapshot --tab e28c2282
ditto click @e1 --tab e28c2282
ditto fill @e2 "搜索关键词" --tab e28c2282
ditto press Enter --tab e28c2282
ditto scroll down --tab e28c2282

# 3. 排查页面错误 / 接口报错或截图确认
ditto console --tab e28c2282
ditto network --tab e28c2282
ditto screenshot /tmp/page.png --tab e28c2282
```

> **提示**：
> - **默认保留标签页**：任务完成后**不要主动关闭**自己打开的标签页，直接保留在 Ditto 中方便用户在观测页查看结果或继续接手操作；仅当用户明确要求关闭，或需要清理多余的临时空白/中转页时，才调用 `ditto close --tab <id>`（且绝不关闭其他会话或用户已打开的标签页）。
> - `ditto` CLI 具备自动会话绑定保护——同一会话漏传 `--tab` 时会自动路由到你刚 `open` 的标签页，绝不会误点其他并发会话的标签页；但显式携带 `--tab <shortId>` 仍是最清晰稳妥的做法。

## 常用命令参考

```bash
ditto status                                             # 查看浏览器就绪状态、扩展是否在线、当前会话关联标签页
ditto tabs                                               # 列出全部标签页（mine: true 表示属于当前会话）
ditto open <url>                                         # 新建专属标签页访问 URL（扩展在线时自动同步登录态）
ditto goto <url> --tab <id>                              # 在指定标签页跳转到新 URL
ditto snapshot --tab <id> [--limit 150]                  # 提取页面文本与交互元素引用（支持 Shadow DOM 与同源 iframe，含 checked/disabled/value 等状态）
ditto click <@ref|selector> --tab <id>                   # 点击元素（如 @e3 或 'button:has-text("提交")'）
ditto hover <@ref|selector> --tab <id>                   # 悬停元素
ditto fill <@ref|selector> <text> --tab <id>             # 填写输入框或 textarea
ditto select <@ref|selector> <value> --tab <id>          # 选择下拉框选项
ditto press <key> [--target <@ref|sel>] --tab <id>       # 按键（Enter / Tab / Escape / ArrowDown 等）
ditto scroll [up|down|left|right|top|bottom|px] [--target <@ref|sel>] --tab <id> # 滚动页面或指定容器
ditto upload <@ref|selector> <filePath> --tab <id>       # 向 input[type=file] 上传开发机本地文件
ditto wait [selector|ms] [--text T] [--url U] [--networkidle] --tab <id> # 等待元素、文本、URL 或网络空闲
ditto dialog <accept|dismiss> [promptText] --tab <id>    # 处理原生 alert / confirm / prompt 弹窗
ditto console [--limit 50] [--clear] --tab <id>          # 查看控制台日志与未捕获 pageerror
ditto network [--all] [--limit 50] [--clear] --tab <id>  # 查看失败请求（加 --all 查看全部请求）
ditto eval '<js>' --tab <id>                             # 在页面中执行 JavaScript（如 'document.title'）
ditto sync [url] --tab <id>                              # 强制向主力机扩展重新请求该站点最新登录态并刷新页面
ditto reload | back | forward | close --tab <id>         # 刷新 / 后退 / 前进 / 关闭指定标签页
ditto screenshot [path] [--full-page] --tab <id>         # 保存 PNG 截图（默认 /tmp/ditto-screenshot.png）
```

## 登录态与人工协同规则

1. **发现页面仍处于未登录状态时**：
   - 先运行 `ditto status` 检查 `extensionConnected`：
     - 若 `extensionConnected: false`：主力电脑可能已关机或未连插件（远端已有全量同步的 Cookie 会自动生效）；若该站点 Cookie 过期或未同步过，提示用户在主力电脑打开 Chrome 连接 Ditto 插件（`http://<开发机IP>:3217`），或直接在观测页手动登录。
     - 若 `extensionConnected: true`：执行 `ditto sync --tab <id>` 强制拉取并刷新。注意 `localStorage` / `sessionStorage` 仅在主力电脑打开了对应同源标签页时才能采集；如果返回中的 `missingStorageOrigins` 包含目标站点，可提示用户在主力电脑打开一次该网站后再执行 `ditto sync --tab <id>`。
2. **遇到图形验证码 / 滑块 / 扫码登录 / 二次验证（2FA）时**：
   - **严禁自行破解或绕过验证码**。
   - 直接告知用户打开观测控制台 `http://<开发机IP>:3217`（或点浏览器插件右上角「观测页 ↗」），切换到你的标签页即可**直接点击与输入**（观测页默认始终可交互；如遇到跨域登录 iframe、Canvas 验证码或滑块拖拽，可点击标签栏最右侧的设置齿轮打开抽屉，开启全局「画面直连」开关直接操作）。用户完成后会话持久保存在 Chromium Profile 中，你直接继续后续操作即可。
