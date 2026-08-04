# 工具链安装指引（在您的真实终端执行）

> 背景：Reasonix 桌面应用的进程受 macOS 沙箱限制，只能写 `/tmp`、`~/Library/Caches` 与工作区，
> 无法写 `/opt/homebrew` 与 `~`，因此 `brew install` / `colima start` 需由您在**真实终端**执行。
> 沙箱内已装好一份 Go（仅本会话可用的验证版），见文末说明。

## 1. 安装 Go（正式版，用户终端全局可用）

```bash
brew install go
go version          # 期望输出 go1.26.x darwin/arm64
```

## 2. 安装 Docker 运行时（colima + docker CLI）

```bash
brew install colima docker
colima start        # 首次启动会下载虚拟机镜像，耗时数分钟
docker --version
docker info         # 确认 daemon 就绪
```

> 说明：macOS 没有原生 Docker daemon，colima 提供命令行 Docker 运行时（基于 Lima 虚拟机）。
> 如日后需要 GUI 管理，可再 `brew install --cask docker`（Docker Desktop）。

## 3. 构建并验证本项目

```bash
cd /Users/bigxixi/Desktop/西西的东西/ainovel_webui/ainovel-cli
go build ./...
go vet ./...
```

## 4. 启动 WebUI（两种方式）

本地运行：

```bash
go run ./cmd/ainovel-cli web --port 5269
# 浏览器打开 http://localhost:5269
```

Docker 运行（colima 启动后）：

```bash
cd /Users/bigxixi/Desktop/西西的东西/ainovel_webui/ainovel-cli
docker compose up -d --build
docker compose logs -f ainovel
# 浏览器打开 http://localhost:5269
```

---

## 附：沙箱内 Go（本会话验证用，可选）

已验证：`go build ./...` 与 `go vet` 全部通过，WebUI 服务器冒烟测试（health / presets /
静态页 / 建书 / 快照 / SSE 回放+流式）全部正常。该 Go 位于：

```bash
export PATH="$HOME/Library/Caches/ainovel-dev/go/bin:$PATH"
export GOPATH="$HOME/Library/Caches/ainovel-dev/gopath"
export GOPROXY="https://goproxy.cn,direct"
go version   # go1.26.5 darwin/arm64
```

> 注：此位置是缓存目录，系统清理可能移除；正式开发请在真实终端 `brew install go`。

## 镜像构建与导出（已验证）

前提：colima 已启动（`colima start`）、docker daemon 可用。

```bash
cd ainovel-cli
# 本机验证构建（arm64，载入本地 daemon）
docker-buildx build --platform linux/arm64 --load -t ainovel-cli:webui .
# 导出离线镜像（docker load 可还原）
mkdir -p dist
docker save ainovel-cli:webui -o dist/ainovel-cli-webui-arm64.tar
# 运行
docker run -d --name ainovel -p 5269:5269 \
  -v "$HOME/.ainovel:/root/.ainovel" \
  -v "$PWD/workspace:/workspace" \
  ainovel-cli:webui
```

多平台发布（amd64 + arm64）走 GitHub Actions：推送 `v*` tag 后
`.github/workflows/docker.yml` 自动构建并推送到 `ghcr.io/voocel/ainovel-cli`。

> 备注：
> - brew 的 docker 公式不带 buildx 插件时，直接调用 `docker-buildx` 二进制（需
>   `BUILDX_CONFIG` 指向可写目录避免写 `~/.docker/buildx`）。
> - 国内网络访问 Docker Hub 超时：在 colima VM 内配置 registry 镜像加速
>   （`/etc/docker/daemon.json` 写 `{"registry-mirrors":["https://dockerproxy.net"]}`
>   后 `systemctl restart docker`）；若 VM 内 `/etc/resolv.conf` 为断链，重写为
>   公共 DNS（如 `223.5.5.5`）。
