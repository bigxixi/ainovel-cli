# AInovel-WebUI

> 基于 [ainovel-cli](https://github.com/voocel/ainovel-cli) 的 Web 工作台——多用户、多书书架、浏览器端 AI 小说创作引擎。

**原项目**：ainovel-cli 是一个全自动 AI 长篇小说创作引擎，确定性引擎驱动 Architect / Writer / Editor 三个自主代理完成完整小说。详见 [voocel/ainovel-cli](https://github.com/voocel/ainovel-cli)。

本分支在保留全部引擎能力的基础上，提供了一套现代化的 WebUI，支持 Docker 一键部署到 VPS/家庭服务器，在浏览器或手机上使用。

---

## 特性

- **多用户 + 管理员** — 首次启动强制创建管理员，之后可创建多个普通账号。不同账号拥有独立全局配置（Provider / API Key），完全隔离。
- **多书书架** — 多本小说同时管理，每本书独立会话、互不干扰。支持删除（可保留已完结书目录）、导入外部小说（文件上传或路径）。
- **工作台** — 四区布局：事件流（可折叠）+ 流式输出（主区）+ 详情面板 + 命令输入栏。输入框 `/` 命令面板支持全部 TUI 命令（`/review`、`/next`、`/model`、`/export` 等）。
- **现代技术栈** — React 19 + TypeScript + Vite + shadcn/ui（Tailwind CSS v4）+ React Router + TanStack Query + Zustand。
- **SSE 实时推送** — 引擎事件、流式增量输出通过 Server-Sent Events 推送到前端，断线自动重连 + 历史回放。
- **移动端兼容** — 响应式布局，768px 以下侧边栏转抽屉，所有按钮触屏可达（≥44px）。
- **Docker 多架构** — linux/amd64 + linux/arm64 双平台镜像，VPS、NAS、树莓派均可部署。

---

## 在 VPS 上部署

```bash
# 1. 安装 Docker
curl -fsSL https://get.docker.com | sh

# 2. 拉取镜像（本分支由 bigxixi/ainovel-webui 构建发布；正式版 v1.0.0-0.7.5）
docker pull ghcr.io/bigxixi/ainovel-webui:v1.0.0-0.7.5

# 3. 准备持久化目录
mkdir -p ~/ainovel/config ~/ainovel/workspace

# 4. 启动 WebUI（端口 5269，开机自启）
docker run -d --name ainovel --restart unless-stopped \
  -p 5269:5269 \
  -e AINOVEL_WEB_HOST=0.0.0.0 \
  -e AINOVEL_BOOKS_DIR=/workspace/books \
  -v ~/ainovel/config:/root/.ainovel \
  -v ~/ainovel/workspace:/workspace \
  ghcr.io/bigxixi/ainovel-webui:v1.0.0-0.7.5

# 5. 浏览器打开 http://<VPS_IP>:5269
#    ① 创建管理员账号（仅首次）→ ② 登录 → ③ 配置 Provider 和 API Key → ④ 新建书
```

**升级**：

```bash
docker pull ghcr.io/bigxixi/ainovel-webui:v1.0.0-0.7.5
docker rm -f ainovel
# 再执行上面的 docker run（配置和作品挂载目录不变）
```

**清空所有数据（重置为全新安装）**：

> 删除挂载的持久化目录即可——配置、账号、书架、作品全部清除，等同于在一台新机器上安装，下次访问会重新进入「创建管理员」引导。

```bash
docker rm -f ainovel                 # 停止并删除容器
rm -rf ~/ainovel                     # 删除全部持久化数据（config + workspace）
docker pull ghcr.io/bigxixi/ainovel-webui:v1.0.0-0.7.5
# 再执行上面的 docker run 即可全新初始化
```

若使用 docker-compose：`docker compose down && rm -rf ./config ./workspace` 后重新 `docker compose up -d`。

**使用 Compose**：

```yaml
# docker-compose.yml
services:
  ainovel:
    image: ghcr.io/bigxixi/ainovel-webui:v1.0.0-0.7.5
    restart: unless-stopped
    ports:
      - "5269:5269"
    environment:
      - AINOVEL_WEB_HOST=0.0.0.0
      - AINOVEL_BOOKS_DIR=/workspace/books
    volumes:
      - ./config:/root/.ainovel
      - ./workspace:/workspace
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AINOVEL_WEB_HOST` | `127.0.0.1` | 监听地址（容器部署必须设为 `0.0.0.0`） |
| `AINOVEL_WEB_PORT` | `5269` | 监听端口 |
| `AINOVEL_BOOKS_DIR` | `./books` | 书架根目录（每本书一个子目录） |
| `AINOVEL_WEB_DATA_DIR` | `~/.ainovel/web` | 鉴权数据（web.db SQLite 数据库）、用户配置 |

---

## 本地开发

```bash
# 后端
cd ainovel-cli
go run ./cmd/ainovel-cli web

# 前端（另一个终端，Vite 热更新 + API 代理到 :5269）
cd webui
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`。

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19 + TypeScript + Vite + shadcn/ui + React Router + TanStack Query + Zustand |
| 后端 | Go 1.25 + net/http（标准库）+ SQLite（modernc/sqlite，纯 Go 无 CGO） |
| 鉴权 | bcrypt 密码哈希 + 数据库 session + HTTP-only cookie |
| 实时通信 | Server-Sent Events（SSE） |
| 部署 | Docker 多阶段构建（Node + Go → Alpine 精简镜像）|

---

## License

与原项目一致：[MIT](https://github.com/bigxixi/ainovel-webui/blob/main/LICENSE)。
