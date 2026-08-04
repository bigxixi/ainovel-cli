# WebUI 使用说明

ainovel-cli 提供网页版工作台（WebUI），与 TUI / headless 共享同一套引擎逻辑与数据格式，**功能完全等价**，并额外支持多书书架与移动端访问。

## 启动

### Docker（推荐）

```bash
docker compose up -d
# 浏览器打开 http://localhost:5269
```

- 配置目录挂载：`./config:/root/.ainovel`（首次引导生成的 `config.json`、全局写作偏好）
- 书架目录挂载：`./workspace:/workspace`（每本书一个子目录，位于 `/workspace/books`）

### 本地运行

```bash
go build -o ainovel-cli ./cmd/ainovel-cli
./ainovel-cli web                # 默认端口 5269
./ainovel-cli web --port 8080 --books-dir ./books
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AINOVEL_WEB_PORT` | `5269` | WebUI 监听端口 |
| `AINOVEL_BOOKS_DIR` | `books`（相对工作目录） | 书架根目录，每本书一个子目录 |

对应的 CLI flag：`--port`、`--books-dir`（flag 优先于环境变量）。

## 首次引导

与 TUI 的交互式引导不同，Web 形态下首次打开 `http://localhost:5269` 会进入网页引导页：

1. 选择 Provider（OpenRouter / Anthropic / Gemini / OpenAI / DeepSeek / Qwen / GLM / Grok / Ollama / Bedrock / 自定义代理）
2. 输入 API Key（部分 Provider 可留空）
3. Base URL（留空使用官方地址；代理用户填代理地址）
4. 模型名称

保存后自动进入书架。配置保存在 `~/.ainovel/config.json`（容器内 `/root/.ainovel/config.json`），与 TUI 完全兼容；之后也可在书内用 `/config` 随时编辑。

## 多书书架

书架根目录下的每个子目录是一本书，清单持久化在 `books.json`（书架根目录）。支持：

- **新建书**：快速开始（直接以需求启动创作）或共创规划（先与 AI 多轮讨论再启动）
- **打开书**：进入创作工作台（引擎按需恢复）
- 同一本书同时只允许一个引擎实例（沿用 flock 独占语义）；多个浏览器标签可同时观看不同书

## TUI 命令 ↔ Web 操作映射

| TUI 命令 | Web 操作 |
|---|---|
| 输入框回车（续写/干预） | 工作台底部输入框（运行中自动走干预，停机后自动走继续） |
| `Ctrl+C` 暂停 | 输入栏 ⏸ 按钮 |
| `/review on\|off` | `/review on\|off` 或命令面板 |
| `/next` | `/next` 验收放行 |
| `/reopen [方向]` | `/reopen`（工作台命令） |
| `/model` | 顶栏「模型」按钮 / `/model` |
| `/config` | 顶栏「配置」按钮 / `/config` |
| `/diag` | 顶栏「诊断」按钮 / `/diag` |
| `/import` | `/import`（含切分确认、取消） |
| `/simulate`、`/importsim` | `/simulate`、`/importsim` |
| `/export` | `/export`（TXT/EPUB，可直接下载文件） |
| `/cocreate` | `/cocreate` 阶段共创；新建书对话框的「共创规划」为冷启动共创 |
| `/help` | 顶栏「帮助」按钮 / `/help` |

输入 `/` 即弹出命令面板（Tab 补全、点击执行）。

## 事件与实时性

- 引擎事件、流式输出经 SSE 实时推送（断线自动重连，重连后服务端回放历史补齐缺口）
- 状态快照每 3 秒轮询刷新
- 导入/仿写/共创的进度与流式回复也经 SSE 推送

## 移动端

WebUI 适配手机/平板（视口 < 768px 时自动切换为单列布局）：

- 状态/详情面板折叠为可滚动区块，事件流与输出以 tab 切换
- 暂停/继续等快捷键操作均有可见按钮（触屏无 Ctrl 快捷键）
- 输入框字号 ≥16px 防 iOS 自动缩放，点击目标 ≥44px
- iOS 切后台/锁屏后回到前台会自动重连事件流并刷新状态

## 数据与备份

- 每本书的数据都在书架目录的对应子目录中（`outline.json`、`progress.json`、章节文本、`web.log` 等），与 TUI 生成的书完全互通——备份书架目录即可
- 引擎日志：每本书 `web.log`；启动错误记录在 `~/.ainovel/last-error.log`

## 与 TUI / headless 的关系

- `ainovel-cli web` 是新增入口，TUI、`--headless`、`eval` 原样保留
- 同一本书目录不要同时被 TUI 和 WebUI 打开（flock 独占，后打开者报"目录已被占用"）
