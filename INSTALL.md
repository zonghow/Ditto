# Ditto AI 部署与配置指南（供开发机 Agent 执行）

本文档专供运行在 Linux 开发机上的 Coding Agent（Codex / Claude Code / OpenCode 等）阅读并自动执行。
完成以下全部步骤后，向用户汇报开发机的连接地址即可。

---

## 1. 获取项目代码

如果当前不在 Ditto 仓库目录内，先将仓库克隆到 `~/ditto`（已有目录则进入并更新）：

```bash
cd ~
if [ ! -d "$HOME/ditto/.git" ]; then
  git clone https://github.com/zonghow/ditto.git "$HOME/ditto"
fi
cd "$HOME/ditto"
```

*(如果你已经在仓库根目录内，保持在当前仓库目录执行后续步骤即可。)*

---

## 2. 使用 Docker 构建并启动服务

直接运行仓库自带的一键容器启动脚本（自动适配新版 `docker compose` 与旧版 Docker 18 环境，自动清理旧实例并挂载数据卷）：

```bash
sh scripts/docker-up.sh
```

> - 若默认端口 `3217` 已被无关服务占用，可改为 `DITTO_PORT=3218 sh scripts/docker-up.sh`（后续验证和汇报地址同步使用该端口）。
> - 若首次拉取海外 Debian / npm 官方源较慢，可传入镜像源加速：
>   ```bash
>   DITTO_APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn \
>   DITTO_NPM_REGISTRY=https://registry.npmmirror.com \
>   sh scripts/docker-up.sh
>   ```

---

## 3. 验证服务与 Chromium 就绪

轮询本地健康检查接口，确认 `ok: true` 且 `browserReady: true`：

```bash
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${DITTO_PORT:-3217}/health" | grep -q '"browserReady":true'; then
    curl -fsS "http://127.0.0.1:${DITTO_PORT:-3217}/health"
    echo ""
    break
  fi
  sleep 1
done
```

如果 30 秒后仍未就绪，运行 `docker logs --tail 50 ditto-browser` 排查原因。

---

## 4. 安装 `ditto` CLI 与 Agent Skill

在仓库根目录执行安装脚本，将零依赖 CLI 安装到 `~/.local/bin/ditto`，并将浏览器操作 Skill 安装到 `~/.agents/skills/ditto`（同时自动软链至 `~/.claude/skills/ditto` 与 `~/.codex/skills/ditto`）：

```bash
sh scripts/install-skill.sh
```

验证 CLI 可正常通信：

```bash
export PATH="$HOME/.local/bin:$PATH"
ditto status
```

*(若 `echo "$PATH"` 中尚未包含 `~/.local/bin`，请顺手确保用户的 `~/.bashrc` 或 `~/.zshrc` 中包含 `export PATH="$HOME/.local/bin:$PATH"`。)*

> **可选（如果需要宿主机 `127.0.0.1:9222` 直连原生 CDP）**：
> 默认配置通过 `ditto` CLI（走本地 `3217` 接口）即可完成全部浏览、交互、JS 执行和截图，无需额外暴露 `9222`。如果你的环境还需要其它工具直连 `127.0.0.1:9222` CDP，可在 Linux 下将 `docker-compose.yml` 中的 `ports` 替换为 `network_mode: host` 后执行 `docker compose up -d`（Chromium CDP 仅绑定宿主机 `127.0.0.1:9222`，不会对外网暴露）。

---

## 5. 探测开发机 IP 并回复用户

探测当前开发机可供用户主力电脑直连的网卡 IP（排除 `127.0.0.1` 与 `172.17.x.x` Docker 网桥地址）：

```bash
python3 - <<'PY'
import socket, subprocess
ip = ""
try:
    out = subprocess.check_output(["ip", "-4", "route", "get", "1.1.1.1"], text=True)
    parts = out.split()
    if "src" in parts:
        ip = parts[parts.index("src") + 1]
except Exception:
    pass
if not ip:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    finally:
        s.close()
print(ip)
PY
```

部署与验证全部通过后，请将以下信息清晰回复给用户：

1. **Ditto 服务与观测控制台地址**：`http://<开发机IP>:3217`
2. **下一步操作提示**：
   - 在主力电脑 Chrome 打开 `chrome://extensions/` → 开启「开发者模式」→「加载已解压的扩展程序」选择本项目的 `extension/` 目录（如尚未安装）；
   - 点击浏览器工具栏的 **Ditto** 插件图标，填入 `http://<开发机IP>:3217` 并点击「**连接**」（会自动开启全量后台定时同步与新开标签页主动同步）；
   - 随时可点击插件右上角「**观测页 ↗**」（或直接访问 `http://<开发机IP>:3217`）实时查看或直接操作开发机上的浏览器。
