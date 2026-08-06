package web

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/bigxixi/ainovel-webui/internal/bootstrap"
	"github.com/bigxixi/ainovel-webui/internal/diag"
	"github.com/bigxixi/ainovel-webui/internal/domain"
	"github.com/bigxixi/ainovel-webui/internal/host"
	"github.com/bigxixi/ainovel-webui/internal/host/exp"
	"github.com/bigxixi/ainovel-webui/internal/host/imp"
	"github.com/bigxixi/ainovel-webui/internal/host/sim"
	"github.com/bigxixi/ainovel-webui/internal/store"
)

// registerBookRoutes 注册书籍与会话相关路由（书架清单、新建、快照、SSE 事件流）。
func (s *Server) registerBookRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/books", s.guard(s.handleListBooks))
	mux.HandleFunc("POST /api/books", s.guard(s.handleCreateBook))
	mux.HandleFunc("GET /api/books/{id}", s.guard(s.handleGetBook))
	mux.HandleFunc("GET /api/books/{id}/stream", s.guard(s.handleBookStream))
	mux.HandleFunc("DELETE /api/books/{id}", s.guard(s.handleDeleteBook))
}

// handleListBooks 返回书架清单（含会话是否已打开）。
func (s *Server) handleListBooks(w http.ResponseWriter, r *http.Request) {
	uid := UserIDFromContext(r.Context())
	metas, err := s.books.List(uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "读取书架失败: %v", err)
		return
	}
	items := make([]map[string]any, 0, len(metas))
	for _, m := range metas {
		items = append(items, map[string]any{
			"id":         m.ID,
			"title":      m.Title,
			"dir":        m.Dir,
			"created_at": m.CreatedAt,
			"open":       s.books.IsOpen(uid, m.ID),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"books": items})
}

// createBookRequest 是新建书的请求体。
type createBookRequest struct {
	Mode   string `json:"mode"` // quick（默认，立即启动）| cocreate（先建会话，共创后启动）
	Title  string `json:"title"`
	Prompt string `json:"prompt"`
}

// handleCreateBook 新建书：quick 模式立即返回（引擎异步启动，进度经 SSE 推送）；
// cocreate 模式仅建会话等待共创。
func (s *Server) handleCreateBook(w http.ResponseWriter, r *http.Request) {
	var req createBookRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	uid := UserIDFromContext(r.Context())
	var (
		book *Book
		err  error
	)
	switch req.Mode {
	case "", "quick":
		book, err = s.books.CreateAsync(uid, CreateRequest{Title: req.Title, Prompt: req.Prompt})
	case "cocreate":
		book, err = s.books.CreateEmpty(uid, req.Title)
	default:
		writeErr(w, http.StatusBadRequest, "mode 必须是 quick 或 cocreate")
		return
	}
	if err != nil {
		// 未完成引导/无有效配置 → 503（不伪造 AI 输出）；其余 → 400。
		if strings.Contains(err.Error(), "引导") || strings.Contains(err.Error(), "配置") || strings.Contains(err.Error(), "Provider") {
			writeErr(w, http.StatusServiceUnavailable, "%v", err)
			return
		}
		writeErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"book": book.Meta, "starting": true})
}

// handleDeleteBook 删除一本书；?keep_completed=1 时若书已完结则仅从书架移除（保留目录）。
func (s *Server) handleDeleteBook(w http.ResponseWriter, r *http.Request) {
	uid := UserIDFromContext(r.Context())
	keep := r.URL.Query().Get("keep_completed")
	keepCompleted := keep == "1" || keep == "true"
	if err := s.books.Remove(uid, r.PathValue("id"), keepCompleted); err != nil {
		writeErr(w, http.StatusNotFound, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "kept": keepCompleted})
}

// handleGetBook 返回书的 UISnapshot 全量状态。
func (s *Server) handleGetBook(w http.ResponseWriter, r *http.Request) {
	uid := UserIDFromContext(r.Context())
	book, err := s.books.Get(uid, r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, book.host.Snapshot())
}

// handleBookStream 是书的 SSE 事件流：先回放历史（ReplayQueue），再订阅实时增量。
func (s *Server) handleBookStream(w http.ResponseWriter, r *http.Request) {
	uid := UserIDFromContext(r.Context())
	book, err := s.books.Get(uid, r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "%v", err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "SSE 不可用")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	// 先订阅再回放：回放期间产生的实时事件积在订阅缓冲中，回放完成后统一消费，
	// 避免"回放完成前的事件丢失"（前端仅靠快照轮询兜底）。
	ch := book.hub.Subscribe()
	defer book.hub.Unsubscribe(ch)

	// 1) 历史回放：让新连接/重连补齐运行时队列中的事件与流式文本。
	s.replayRuntimeQueue(w, flusher, book)

	ctx := r.Context()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case m, ok := <-ch:
			if !ok {
				return // hub 已关闭或本订阅被断开
			}
			if err := writeSSE(w, m); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// replayRuntimeQueue 把运行时队列历史按序回放为 SSE 消息。
// 失败仅记录警告，不阻断实时流。
func (s *Server) replayRuntimeQueue(w io.Writer, flusher http.Flusher, book *Book) {
	items, err := book.host.ReplayQueue(0)
	if err != nil {
		slog.Warn("web: 回放运行时队列失败", "book", book.Meta.ID, "err", err)
		return
	}
	for _, item := range items {
		switch item.Kind {
		case domain.RuntimeQueueUIEvent:
			if err := writeSSE(w, hubMessage{kind: "event", event: host.Event{
				Time:     item.Time,
				Category: item.Category,
				Agent:    item.Agent,
				Summary:  item.Summary,
			}}); err != nil {
				return
			}
		case domain.RuntimeQueueStreamClear:
			if err := writeSSE(w, hubMessage{kind: "clear"}); err != nil {
				return
			}
		case domain.RuntimeQueueStreamDelta:
			if text := host.ReplayDeltaText(item); text != "" {
				if err := writeSSE(w, hubMessage{kind: "delta", delta: text}); err != nil {
					return
				}
			}
		}
		flusher.Flush()
	}
}

// writeSSE 把一条 hub 消息写成 SSE 帧。delta 用 JSON 字符串编码保证多行安全。
func writeSSE(w io.Writer, m hubMessage) error {
	var sb strings.Builder
	switch m.kind {
	case "event":
		data, err := json.Marshal(m.event)
		if err != nil {
			return err
		}
		sb.WriteString("event: event\n")
		sb.WriteString("data: ")
		sb.Write(data)
		sb.WriteString("\n\n")
	case "delta":
		data, err := json.Marshal(m.delta)
		if err != nil {
			return err
		}
		sb.WriteString("event: delta\n")
		sb.WriteString("data: ")
		sb.Write(data)
		sb.WriteString("\n\n")
	case "import", "sim", "cocreate":
		data, err := json.Marshal(m.payload)
		if err != nil {
			return err
		}
		sb.WriteString("event: ")
		sb.WriteString(m.kind)
		sb.WriteString("\ndata: ")
		sb.Write(data)
		sb.WriteString("\n\n")
	case "clear":
		sb.WriteString("event: clear\ndata: {}\n\n")
	case "done":
		sb.WriteString("event: done\ndata: {}\n\n")
	default:
		return nil
	}
	_, err := io.WriteString(w, sb.String())
	return err
}

// registerControlRoutes 注册运行控制路由（继续/干预/暂停/推进/重开/恢复）。
func (s *Server) registerControlRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/books/{id}/continue", s.guard(s.handleContinue))
	mux.HandleFunc("POST /api/books/{id}/steer", s.guard(s.handleSteer))
	mux.HandleFunc("POST /api/books/{id}/abort", s.guard(s.handleAbort))
	mux.HandleFunc("POST /api/books/{id}/resume", s.guard(s.handleResume))
	mux.HandleFunc("POST /api/books/{id}/advance", s.guard(s.handleAdvance))
	mux.HandleFunc("POST /api/books/{id}/advance-mode", s.guard(s.handleAdvanceMode))
	mux.HandleFunc("POST /api/books/{id}/reopen", s.guard(s.handleReopen))
	mux.HandleFunc("POST /api/books/{id}/cocreate", s.guard(s.handleCoCreate))
	mux.HandleFunc("POST /api/books/{id}/cocreate/apply", s.guard(s.handleCoCreateApply))
	mux.HandleFunc("POST /api/books/{id}/cocreate/cancel", s.guard(s.handleCoCreateCancel))
}

// textRequest 是携带一段文本的请求体。
type textRequest struct {
	Text string `json:"text"`
}

// modeRequest 是携带推进模式的请求体。
type modeRequest struct {
	Mode string `json:"mode"`
}

// bookFor 按路径参数取书会话；失败时已写响应并返回 false。
func (s *Server) bookFor(w http.ResponseWriter, r *http.Request) (*Book, bool) {
	uid := UserIDFromContext(r.Context())
	book, err := s.books.Get(uid, r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "%v", err)
		return nil, false
	}
	return book, true
}

// handleContinue 停机后继续创作（文本为续写/干预方向）。
func (s *Server) handleContinue(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var req textRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	if err := book.host.Continue(req.Text); err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleSteer 运行中干预。
func (s *Server) handleSteer(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var req textRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	if err := book.host.Steer(req.Text); err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleAbort 手动暂停引擎。
func (s *Server) handleAbort(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	stopped := book.host.Abort()
	writeJSON(w, http.StatusOK, map[string]any{"stopped": stopped})
}

// handleResume 恢复已有书会话的创作（引擎启动继续）。
func (s *Server) handleResume(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	label, err := book.host.Resume()
	if err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "label": label})
}

// handleAdvance 逐章验收模式下放行一个新章节。
func (s *Server) handleAdvance(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	if err := book.host.AdvanceOneChapter(); err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleAdvanceMode 切换推进模式（auto / review）。
func (s *Server) handleAdvanceMode(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var req modeRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	var mode domain.ChapterAdvanceMode
	switch req.Mode {
	case "", "auto":
		mode = domain.ChapterAdvanceAuto
	case "review":
		mode = domain.ChapterAdvanceReview
	default:
		writeErr(w, http.StatusBadRequest, "mode 必须是 auto 或 review")
		return
	}
	if err := book.host.SetAdvanceMode(mode); err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleReopen 重开已完结的书继续创作（direction 为续写方向，可空）。
func (s *Server) handleReopen(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var req textRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	if err := book.host.Reopen(req.Text); err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	// TUI 的 /reopen 成功后立即补跑一次恢复门禁启动引擎。
	label, err := book.host.Resume()
	if err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "label": label})
}

// cocreateRequest 是共创对话请求体。
type cocreateRequest struct {
	Messages []host.CoCreateMessage `json:"messages"`
	Stage    bool                   `json:"stage"` // true=阶段共创（先暂停引擎）
}

// cocreateApplyRequest 是共创应用请求体。
type cocreateApplyRequest struct {
	Draft string `json:"draft"`
	Stage bool   `json:"stage"` // true=阶段共创 ResumeFromCoCreate；false=冷启动 StartWithPrompt
}

// cocreateProgress 是经 SSE 的 cocreate 类型推送的共创进度。
type cocreateProgress struct {
	ReqID string              `json:"req_id"`
	Kind  string              `json:"kind"` // thinking|reply|done|error
	Text  string              `json:"text,omitempty"`
	Reply *host.CoCreateReply `json:"reply,omitempty"`
	Error string              `json:"error,omitempty"`
}

// handleCoCreate 发起一轮共创对话（thinking/reply 流式经 SSE 推送，完成后推 done+reply）。
func (s *Server) handleCoCreate(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var req cocreateRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	stream := book.host.CoCreateStream
	if req.Stage {
		if !book.host.PauseForCoCreate() {
			writeErr(w, http.StatusConflict, "无法进入阶段共创：全书已完成或已在共创中")
			return
		}
		stream = book.host.StageCoCreateStream
	}
	reqID := newReqID()
	ctx, cancel := context.WithCancel(context.Background())
	book.setAuxCancel(cancel)
	go func() {
		defer cancel()
		reply, err := stream(ctx, req.Messages, func(kind, text string) {
			book.hub.Publish(hubMessage{kind: "cocreate", payload: cocreateProgress{
				ReqID: reqID, Kind: kind, Text: text,
			}})
		})
		if err != nil {
			book.hub.Publish(hubMessage{kind: "cocreate", payload: cocreateProgress{
				ReqID: reqID, Kind: "error", Error: err.Error(),
			}})
			return
		}
		book.hub.Publish(hubMessage{kind: "cocreate", payload: cocreateProgress{
			ReqID: reqID, Kind: "done", Reply: &reply,
		}})
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{"req_id": reqID})
}

// handleCoCreateApply 应用共创草稿：阶段共创恢复引擎；冷启动以草稿启动新书引擎。
func (s *Server) handleCoCreateApply(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var req cocreateApplyRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	if strings.TrimSpace(req.Draft) == "" {
		writeErr(w, http.StatusBadRequest, "draft 不能为空")
		return
	}
	var err error
	if req.Stage {
		err = book.host.ResumeFromCoCreate(req.Draft)
	} else {
		err = s.books.StartWithPrompt(book, req.Draft)
	}
	if err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleCoCreateCancel 放弃共创：取消在途 LLM 流并清除共创占用标记。
func (s *Server) handleCoCreateCancel(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	book.CancelAux()
	book.host.CancelCoCreate()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// decodeBody 解析 JSON 请求体（限制 1MB）；失败时已写响应并返回错误。
func decodeBody(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "请求体无效: %v", err)
		return err
	}
	return nil
}

// registerImportExportRoutes 注册导入/仿写/导出路由。
func (s *Server) registerImportExportRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/books/{id}/import", s.guard(s.handleImport))
	mux.HandleFunc("POST /api/books/{id}/import/confirm", s.guard(s.handleImportConfirm))
	mux.HandleFunc("POST /api/books/{id}/import/cancel", s.guard(s.handleImportCancel))
	mux.HandleFunc("POST /api/books/{id}/simulate", s.guard(s.handleSimulate))
	mux.HandleFunc("POST /api/books/{id}/importsim", s.guard(s.handleImportSimulation))
	mux.HandleFunc("POST /api/books/{id}/export", s.guard(s.handleExport))
	mux.HandleFunc("GET /api/books/{id}/export-file", s.guard(s.handleExportFile))
}

// importRequest 是语义导入请求体。source_path 为空表示恢复未完成导入。
type importRequest struct {
	SourcePath  string `json:"source_path"`
	AutoConfirm bool   `json:"auto_confirm"` // 对应 --yes
	Story       string `json:"story"`        // open|closed
	Continue    bool   `json:"continue"`     // 对应 --continue
	Guidance    string `json:"guidance"`     // 对应 --guide
}

// importsimRequest 是导入仿写画像请求体。
type importsimRequest struct {
	ProfilePath string `json:"profile_path"`
}

// exportRequest 是导出请求体。
type exportRequest struct {
	Format    string `json:"format"` // txt|epub；空则由 out_path 扩展名决定
	OutPath   string `json:"out_path"`
	From      int    `json:"from"`
	To        int    `json:"to"`
	Overwrite bool   `json:"overwrite"`
}

// importEventPayload 是 import 事件桥接到 SSE 的载荷（error 字符串化、小写键）。
type importEventPayload struct {
	Time      time.Time `json:"time"`
	Stage     string    `json:"stage"`
	Current   int       `json:"current"`
	Total     int       `json:"total"`
	Message   string    `json:"message"`
	Level     string    `json:"level"`
	Key       string    `json:"key,omitempty"`
	RetryAt   time.Time `json:"retry_at,omitempty"`
	Err       string    `json:"err,omitempty"`
	Continued bool      `json:"continued,omitempty"`
}

// toImportPayload 把 imp.Event 转成 SSE 载荷。
func toImportPayload(ev imp.Event) importEventPayload {
	p := importEventPayload{
		Time: ev.Time, Stage: string(ev.Stage), Current: ev.Current,
		Total: ev.Total, Message: ev.Message, Level: ev.Level,
		Key: ev.Key, RetryAt: ev.RetryAt, Continued: ev.Continued,
	}
	if ev.Err != nil {
		p.Err = ev.Err.Error()
	}
	return p
}

// simEventPayload 是仿写事件桥接到 SSE 的载荷（error 字符串化、小写键）。
type simEventPayload struct {
	Time    time.Time `json:"time"`
	Stage   string    `json:"stage"`
	Current int       `json:"current"`
	Total   int       `json:"total"`
	Message string    `json:"message"`
	Err     string    `json:"err,omitempty"`
}

// toSimPayload 把 sim.Event 转成 SSE 载荷。
func toSimPayload(ev sim.Event) simEventPayload {
	p := simEventPayload{
		Time: ev.Time, Stage: string(ev.Stage), Current: ev.Current,
		Total: ev.Total, Message: ev.Message,
	}
	if ev.Err != nil {
		p.Err = ev.Err.Error()
	}
	return p
}

// saveUploadedImport 保存上传的导入源文件到书目录 web-imports/，返回路径。
// 文件名仅取 Base 并防覆盖（同名加时间戳前缀）。
func saveUploadedImport(book *Book, f multipart.File, header *multipart.FileHeader) (string, error) {
	name := filepath.Base(header.Filename)
	if name == "." || name == ".." || name == "" {
		return "", errors.New("无效的文件名")
	}
	dir := filepath.Join(book.host.Dir(), "web-imports")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	dst := filepath.Join(dir, name)
	if _, err := os.Stat(dst); err == nil {
		dst = filepath.Join(dir, fmt.Sprintf("%d-%s", time.Now().UnixNano(), name))
	}
	out, err := os.Create(dst)
	if err != nil {
		return "", err
	}
	defer out.Close()
	if _, err := io.Copy(out, f); err != nil {
		os.Remove(dst)
		return "", err
	}
	return dst, nil
}

// handleImport 启动语义导入（事件经 SSE 的 import 类型推送）。
// 支持两种请求体：JSON（source_path 直接指定路径）与 multipart/form-data（文件上传）。
func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var (
		req        importRequest
		sourcePath string
	)
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		// 文件上传模式：点击/拖拽上传的源文件 + 表单字段。
		r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			writeErr(w, http.StatusBadRequest, "上传表单解析失败: %v", err)
			return
		}
		req.SourcePath = r.FormValue("source_path")
		req.Story = r.FormValue("story")
		req.Guidance = r.FormValue("guidance")
		req.AutoConfirm = r.FormValue("auto_confirm") == "1" || r.FormValue("auto_confirm") == "true"
		req.Continue = r.FormValue("continue") == "1" || r.FormValue("continue") == "true"
		if f, header, err := r.FormFile("file"); err == nil {
			src, err := saveUploadedImport(book, f, header)
			if err != nil {
				writeErr(w, http.StatusBadRequest, "保存上传文件失败: %v", err)
				return
			}
			sourcePath = src
		}
	} else {
		if err := decodeBody(w, r, &req); err != nil {
			return
		}
	}
	if req.Story != "" && req.Story != "open" && req.Story != "closed" {
		writeErr(w, http.StatusBadRequest, "story 必须是 open 或 closed")
		return
	}
	if sourcePath == "" {
		// 未上传文件：路径必须位于书架目录或工作目录内（防越权读取任意路径）。
		var err error
		sourcePath, err = s.validateImportSource(req.SourcePath)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "%v", err)
			return
		}
	}
	// 预检：外部小说导入仅支持空书（imp/state.go 对非空书籍硬性拒绝，
	// 提前返回明确错误，避免用户看到"失败+重试"的无效循环）。
	if snap := book.host.Snapshot(); snap.CompletedCount > 0 {
		writeErr(w, http.StatusConflict,
			"该书已有 %d 个完成章节：外部小说导入仅支持空书，请新建一本书后再导入",
			snap.CompletedCount)
		return
	}
	opts := imp.Options{
		SourcePath:      sourcePath,
		AutoConfirm:     req.AutoConfirm,
		StoryResolution: req.Story,
		ContinueAfter:   req.Continue,
		Guidance:        req.Guidance,
	}
	ctx, cancel := context.WithCancel(context.Background())
	book.setAuxCancel(cancel)
	ch, err := book.host.ImportFrom(ctx, opts)
	if err != nil {
		cancel()
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	go func() {
		defer cancel()
		for ev := range ch {
			book.hub.Publish(hubMessage{kind: "import", payload: toImportPayload(ev)})
		}
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

// handleImportConfirm 切分预览后的人工确认（对应 TUI 的 y 键，AcceptSegmentation 重跑）。
func (s *Server) handleImportConfirm(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	book.setAuxCancel(cancel)
	ch, err := book.host.ImportFrom(ctx, imp.Options{AcceptSegmentation: true})
	if err != nil {
		cancel()
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	go func() {
		defer cancel()
		for ev := range ch {
			book.hub.Publish(hubMessage{kind: "import", payload: toImportPayload(ev)})
		}
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

// handleImportCancel 取消进行中的导入/仿写操作。
func (s *Server) handleImportCancel(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	book.CancelAux()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleSimulate 生成/增量更新仿写画像（读取书目录下 ./simulate）。
func (s *Server) handleSimulate(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	book.setAuxCancel(cancel)
	ch, err := book.host.Simulate(ctx)
	if err != nil {
		cancel()
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	go func() {
		defer cancel()
		for ev := range ch {
			book.hub.Publish(hubMessage{kind: "sim", payload: toSimPayload(ev)})
		}
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

// handleImportSimulation 导入已有仿写画像。
func (s *Server) handleImportSimulation(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var req importsimRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	if strings.TrimSpace(req.ProfilePath) == "" {
		writeErr(w, http.StatusBadRequest, "profile_path 必填")
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	book.setAuxCancel(cancel)
	ch, err := book.host.ImportSimulationProfile(ctx, req.ProfilePath)
	if err != nil {
		cancel()
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	go func() {
		defer cancel()
		for ev := range ch {
			book.hub.Publish(hubMessage{kind: "sim", payload: toSimPayload(ev)})
		}
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

// validateImportSource 校验并规范化导入源路径：
// 空路径（恢复模式）返回空串；非空路径必须解析后位于书架目录或工作目录内。
func (s *Server) validateImportSource(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil // 恢复未完成导入
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", fmt.Errorf("导入路径无效: %v", err)
	}
	cwd, _ := os.Getwd()
	allowed := []string{s.books.BooksDir(), cwd}
	for _, root := range allowed {
		if root == "" {
			continue
		}
		rel, err := filepath.Rel(root, abs)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return abs, nil
		}
	}
	return "", fmt.Errorf("导入路径必须在书架目录或工作目录内")
}

// handleExport 同步导出已完成章节为 TXT/EPUB，返回结果与下载地址。
func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var req exportRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	var format exp.Format
	switch req.Format {
	case "", "txt":
		format = exp.FormatTXT
	case "epub":
		format = exp.FormatEPUB
	default:
		writeErr(w, http.StatusBadRequest, "format 必须是 txt 或 epub")
		return
	}
	// 输出路径约束：只允许书目录内的单段文件名（防越权写入任意路径）。
	outPath := strings.TrimSpace(req.OutPath)
	if outPath != "" {
		name := filepath.Base(outPath)
		if name != outPath || name == "." || name == ".." {
			writeErr(w, http.StatusBadRequest, "out_path 必须是文件名（导出到书目录内）")
			return
		}
		outPath = filepath.Join(book.host.Dir(), name)
	}
	res, err := book.host.Export(context.Background(), exp.Options{
		Format:    format,
		OutPath:   outPath,
		From:      req.From,
		To:        req.To,
		Overwrite: req.Overwrite,
	})
	if err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	name := filepath.Base(res.Path)
	writeJSON(w, http.StatusOK, map[string]any{
		"chapters": res.Chapters,
		"bytes":    res.Bytes,
		"path":     res.Path,
		"skipped":  res.Skipped,
		"download": "/api/books/" + book.Meta.ID + "/export-file?name=" + url.QueryEscape(name),
	})
}

// handleExportFile 提供导出文件的下载（name 必须是书目录下的单段文件名）。
func (s *Server) handleExportFile(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" || filepath.Base(name) != name {
		writeErr(w, http.StatusBadRequest, "非法文件名")
		return
	}
	full := filepath.Join(book.host.Dir(), name)
	if fi, err := os.Stat(full); err != nil || fi.IsDir() {
		writeErr(w, http.StatusNotFound, "文件不存在")
		return
	}
	w.Header().Set("Content-Disposition", "attachment; filename="+strconv.Quote(name))
	http.ServeFile(w, r, full)
}

// registerConfigRoutes 注册模型/配置/诊断路由。
func (s *Server) registerConfigRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/books/{id}/models", s.guard(s.handleGetModels))
	mux.HandleFunc("POST /api/books/{id}/switch-model", s.guard(s.handleSwitchModel))
	mux.HandleFunc("POST /api/books/{id}/set-thinking", s.guard(s.handleSetThinking))
	mux.HandleFunc("GET /api/books/{id}/config", s.guard(s.handleGetConfig))
	mux.HandleFunc("POST /api/books/{id}/config", s.guard(s.handleSaveConfig))
	mux.HandleFunc("POST /api/books/{id}/config/test", s.guard(s.handleTestConfig))
	mux.HandleFunc("POST /api/books/{id}/diag", s.guard(s.handleDiag))
}

// modelRoles 是可供切换模型的角色（空串 = 默认角色）。
var modelRoles = []string{"", "architect", "writer", "editor"}

// handleGetModels 返回可用 provider/模型、当前选择与推理强度选项。
func (s *Server) handleGetModels(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	providers := book.host.ConfiguredProviders()
	models := make(map[string][]string, len(providers))
	for _, p := range providers {
		models[p] = book.host.ConfiguredModels(p)
	}
	current := make(map[string]map[string]string, len(modelRoles))
	thinking := make(map[string][]string, len(modelRoles))
	for _, role := range modelRoles {
		provider, model, found := book.host.CurrentModelSelection(role)
		entry := map[string]string{"role": role}
		if found {
			entry["provider"] = provider
			entry["model"] = model
		}
		current[role] = entry
		levels := book.host.AvailableThinking(role)
		thinking[role] = make([]string, 0, len(levels))
		for _, lv := range levels {
			thinking[role] = append(thinking[role], string(lv))
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"providers":       providers,
		"models":          models,
		"current":         current,
		"thinking_levels": thinking,
	})
}

// switchModelRequest 是切换模型请求体。
type switchModelRequest struct {
	Role     string `json:"role"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

// handleSwitchModel 切换指定角色的模型（同时持久化配置）。
func (s *Server) handleSwitchModel(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var req switchModelRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	if err := book.host.SwitchModel(req.Role, req.Provider, req.Model); err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// setThinkingRequest 是设置推理强度请求体。
type setThinkingRequest struct {
	Role  string `json:"role"`
	Level string `json:"level"`
}

// handleSetThinking 设置角色推理强度。
func (s *Server) handleSetThinking(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var req setThinkingRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	if err := book.host.SetRoleThinking(req.Role, req.Level); err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleGetConfig 返回 Provider/模型配置快照（/config 对话框数据）。
func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, book.host.ModelConfiguration())
}

// configDraft 是保存配置的请求体（与 host.ModelConfigurationDraft 对应的小写键 DTO）。
type configDraft struct {
	Provider     string                  `json:"provider"`
	Type         string                  `json:"type"`
	API          string                  `json:"api"`
	BaseURL      string                  `json:"base_url"`
	Models       []bootstrap.ModelConfig `json:"models"`
	Renames      []host.ModelRename      `json:"renames"`
	APIKeyAction string                  `json:"api_key_action"`
	APIKey       string                  `json:"api_key"`
}

// saveConfigRequest 是保存/测试配置的请求体。
type saveConfigRequest struct {
	Draft configDraft `json:"draft"`
	Model string      `json:"model"` // 仅测试连接使用
}

// toHostDraft 把 web DTO 转成 host.ModelConfigurationDraft。
func (d configDraft) toHostDraft() host.ModelConfigurationDraft {
	return host.ModelConfigurationDraft{
		Provider:     d.Provider,
		Type:         d.Type,
		API:          d.API,
		BaseURL:      d.BaseURL,
		Models:       d.Models,
		Renames:      d.Renames,
		APIKeyAction: host.APIKeyAction(d.APIKeyAction),
		APIKey:       d.APIKey,
	}
}

// handleSaveConfig 保存 Provider/模型配置。
func (s *Server) handleSaveConfig(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var req saveConfigRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	if err := book.host.ConfigureModels(req.Draft.toHostDraft()); err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleTestConfig 测试 Provider/模型连接。
func (s *Server) handleTestConfig(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	var req saveConfigRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	if req.Model == "" {
		writeErr(w, http.StatusBadRequest, "model 必填")
		return
	}
	if err := book.host.TestModelConnection(r.Context(), req.Draft.toHostDraft(), req.Model); err != nil {
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDiag 生成诊断报告（创作诊断 + 运行时检测 + 脱敏导出）。
func (s *Server) handleDiag(w http.ResponseWriter, r *http.Request) {
	book, ok := s.bookFor(w, r)
	if !ok {
		return
	}
	st := store.NewStore(book.host.Dir())
	rep, rc := diag.Diagnose(st)
	exportPath, exportErr := diag.WriteExport(st, rep, rc)
	var exportErrStr string
	if exportErr != nil {
		exportErrStr = exportErr.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"report":      rep,
		"export_path": exportPath,
		"export_err":  exportErrStr,
	})
}

// registerSetupRoutes 注册首次引导路由。
func (s *Server) registerSetupRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/setup/presets", s.guard(s.handleSetupPresets))
	mux.HandleFunc("POST /api/setup", s.guard(s.handleSetupSave))
}

// handleGlobalModels 返回全部可选 Provider 及其候选模型（无需书实例，配置对话框用）。
func (s *Server) handleGlobalModels(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.books.LoadConfig()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "%v", err)
		return
	}
	models := map[string][]string{}
	for name := range cfg.Providers {
		models[name] = cfg.CandidateModels(name)
	}
	// 附加预设 Provider（即使尚未写入配置，便于首次选择）。
	for _, p := range bootstrap.ProviderPresets() {
		if _, ok := models[p.Name]; !ok {
			models[p.Name] = cfg.CandidateModels(p.Name)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}

// setupPreset 是 Provider 预设的 SSE 载荷（小写键）。
type setupPreset struct {
	Name           string `json:"name"`
	Label          string `json:"label"`
	BaseURL        string `json:"base_url"`
	NeedType       bool   `json:"need_type"`
	APIKeyOptional bool   `json:"api_key_optional"`
}

// handleSetupPresets 返回可选 Provider 预设列表（首次引导页用）。
func (s *Server) handleSetupPresets(w http.ResponseWriter, r *http.Request) {
	src := bootstrap.ProviderPresets()
	out := make([]setupPreset, 0, len(src))
	for _, p := range src {
		out = append(out, setupPreset{
			Name: p.Name, Label: p.Label, BaseURL: p.BaseURL,
			NeedType: p.NeedType, APIKeyOptional: p.APIKeyOptional,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"presets": out})
}

// setupRequest 是首次引导保存配置的请求体。
type setupRequest struct {
	Provider     string `json:"provider"`      // 预设名或 custom
	ProviderName string `json:"provider_name"` // custom 时的名称
	Type         string `json:"type"`          // custom 时的 API 协议类型
	APIKey       string `json:"api_key"`
	BaseURL      string `json:"base_url"`
	Model        string `json:"model"`
}

// handleSetupSave 保存首次引导配置（复用 bootstrap.SaveConfig 落盘到默认配置路径）。
func (s *Server) handleSetupSave(w http.ResponseWriter, r *http.Request) {
	var req setupRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	if strings.TrimSpace(req.Provider) == "" {
		writeErr(w, http.StatusBadRequest, "请选择 Provider")
		return
	}
	if strings.TrimSpace(req.Model) == "" {
		writeErr(w, http.StatusBadRequest, "模型名称必填")
		return
	}
	name := strings.TrimSpace(req.Provider)
	if name == "custom" {
		name = strings.TrimSpace(req.ProviderName)
		if name == "" {
			writeErr(w, http.StatusBadRequest, "自定义代理需要 Provider 名称")
			return
		}
	}
	pc := bootstrap.ProviderConfig{
		Type:    req.Type,
		APIKey:  req.APIKey,
		BaseURL: strings.TrimSpace(req.BaseURL),
		Models:  []bootstrap.ModelConfig{{Name: strings.TrimSpace(req.Model)}},
	}
	if err := validateBaseURL(pc.BaseURL); err != nil {
		writeErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	cfg := bootstrap.Config{
		Provider:  name,
		ModelName: strings.TrimSpace(req.Model),
		Providers: map[string]bootstrap.ProviderConfig{name: pc},
		Roles:     map[string]bootstrap.RoleConfig{},
		Style:     "default",
	}
	if err := bootstrap.SaveConfig(bootstrap.DefaultConfigPath(), cfg); err != nil {
		writeErr(w, http.StatusInternalServerError, "保存配置失败: %v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
