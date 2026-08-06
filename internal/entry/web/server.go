// Package web 实现 ainovel-cli 的 WebUI 入口：一个嵌入静态单页的 HTTP 服务器，
// 通过 REST + SSE 暴露多书会话（host.Host）的全部能力。
//
// 设计要点：
//   - 前端为纯静态单页（无构建工具），经 //go:embed 打包进二进制；
//   - 每本书一个 host.Host 实例（跨进程 flock 独占输出目录），由 BookManager 管理；
//   - 事件/流式输出经 SSE 推送，状态快照由前端轮询，用户操作走 REST。
package web

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/bigxixi/ainovel-webui/internal/bootstrap"
)

//go:embed static
var staticFS embed.FS

// Server 是 WebUI 的 HTTP 服务器。它持有 BookManager（多书会话管理器）与 Auth（单用户鉴权），
// 通过 REST + SSE 把 ainovel 引擎能力暴露给浏览器。
type Server struct {
	books  *BookManager
	auth   *Auth
	static http.Handler
	log    *slog.Logger
}

// NewServer 构造 Web 服务器。bm 是已初始化（含配置加载）的多书管理器，auth 是已加载的鉴权器。
func NewServer(bm *BookManager, auth *Auth) *Server {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		// embed 静态目录必须存在，构建期即可发现。
		panic(fmt.Sprintf("web: embed static 目录不可用: %v", err))
	}
	return &Server{
		books:  bm,
		auth:   auth,
		static: spaHandler(http.FileServer(http.FS(sub))),
		log:    slog.Default(),
	}
}

// Handler 返回完整路由表。
// 公开端点：health / auth-status / setup-auth / login / logout（静态页面无需鉴权，页面本身
// 由前端鉴权引导）；其余 /api/* 一律经 s.guard 校验登录 cookie。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// 健康检查（Docker HEALTHCHECK 使用）。
	mux.HandleFunc("GET /api/health", s.handleHealth)
	// 鉴权公开端点。
	mux.HandleFunc("GET /api/auth-status", s.handleAuthStatus)
	mux.HandleFunc("POST /api/setup-auth", s.handleSetupAuth)
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/logout", s.handleLogout)
	// 用户信息与全局配置。
	mux.HandleFunc("GET /api/profile", s.guard(s.handleProfile))
	mux.HandleFunc("GET /api/profile/config", s.guard(s.handleProfileConfig))
	mux.HandleFunc("POST /api/profile/config", s.guard(s.handleProfileConfigSave))
	// 管理员端点。
	mux.HandleFunc("GET /api/admin/users", s.adminGuard(s.handleAdminUsers))
	mux.HandleFunc("POST /api/admin/users", s.adminGuard(s.handleAdminCreateUser))
	mux.HandleFunc("PUT /api/admin/users/{id}", s.adminGuard(s.handleAdminUpdateUser))
	mux.HandleFunc("DELETE /api/admin/users/{id}", s.adminGuard(s.handleAdminDeleteUser))

	// 书籍与会话（书架、快照、SSE 事件流）。
	s.registerBookRoutes(mux)
	// 运行控制（继续/干预/暂停/推进/重开）。
	s.registerControlRoutes(mux)
	// 导入/仿写/导出。
	s.registerImportExportRoutes(mux)
	// 模型/配置/诊断。
	s.registerConfigRoutes(mux)
	// 首次引导（API key 配置）。
	s.registerSetupRoutes(mux)

	// 静态单页（SPA 兜底：未匹配的路径回退 index.html）。
	mux.Handle("/", s.static)
	return mux
}

// guard 返回需要登录的 handler 包装。
func (s *Server) guard(h http.HandlerFunc) http.HandlerFunc {
	return s.auth.Middleware(h)
}

// adminGuard 需要管理员权限的 handler 包装。
func (s *Server) adminGuard(h http.HandlerFunc) http.HandlerFunc {
	return s.auth.AdminMiddleware(h)
}

// handleHealth 返回服务健康状态与是否处于"需要首次引导"状态。
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"time":   time.Now().Format(time.RFC3339),
		"setup":  bootstrap.NeedsSetup(),
	})
}

// spaHandler 服务静态文件；路径不存在时回退到 index.html，供前端路由使用。
func spaHandler(fs http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if clean == "" || clean == "." {
			clean = "index.html"
		}
		if _, err := staticFS.Open(path.Join("static", clean)); err != nil {
			// 资源不存在：回退单页入口（前端根据 URL/状态自行决定视图）。
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			fs.ServeHTTP(w, r2)
			return
		}
		fs.ServeHTTP(w, r)
	})
}

// ---------- 认证处理 ----------

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	uid := s.auth.Validate(r)
	out := map[string]any{
		"configured": s.auth.IsConfigured(),
		"logged_in":  uid != "",
	}
	if uid != "" {
		u, _ := s.auth.db.GetUserByID(uid)
		if u != nil {
			out["display_name"] = u.DisplayName
			out["role"] = u.Role
			out["user_id"] = u.ID
		}
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleSetupAuth(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DisplayName string `json:"display_name"`
		Password    string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if s.auth.IsConfigured() {
		writeErr(w, 409, "已配置，不能重复初始化")
		return
	}
	user, token, err := s.auth.SetupAdmin(req.DisplayName, req.Password)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	// Cookie 必须在 writeJSON 前设置（WriteHeader 后 header 变更无效）。
	SetSessionCookie(w, token)
	writeJSON(w, 200, map[string]any{
		"configured":   true,
		"logged_in":    true,
		"display_name": user.DisplayName,
		"role":         user.Role,
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := ipFromRequest(r)
	if s.auth.RecordFailure(ip) {
		writeErr(w, 429, "登录过于频繁，请 5 分钟后再试")
		return
	}
	var req struct{ Password string `json:"password"` }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	token, user, err := s.auth.Login(req.Password)
	if err != nil {
		writeErr(w, 401, "%v", err)
		return
	}
	s.auth.ClearFailures(ip)
	SetSessionCookie(w, token)
	writeJSON(w, 200, map[string]any{
		"logged_in":    true,
		"display_name": user.DisplayName,
		"role":         user.Role,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.auth.Logout(r)
	ClearSessionCookie(w)
	writeJSON(w, 200, map[string]string{"ok": "true"})
}

func (s *Server) handleProfile(w http.ResponseWriter, r *http.Request) {
	uid := UserIDFromContext(r.Context())
	u, err := s.auth.db.GetUserByID(uid)
	if err != nil || u == nil {
		writeErr(w, 404, "用户不存在")
		return
	}
	cfg, _ := s.auth.db.GetUserConfig(uid)
	out := map[string]any{
		"user_id":      u.ID,
		"display_name": u.DisplayName,
		"role":         u.Role,
		"created_at":   u.CreatedAt.Format(time.RFC3339),
	}
	if cfg != nil {
		out["provider"] = cfg.Provider
		out["model"] = cfg.Model
	}
	// 统计书数量
	books, _ := s.books.List()
	out["book_count"] = len(books)
	writeJSON(w, 200, out)
}

func (s *Server) handleProfileConfig(w http.ResponseWriter, r *http.Request) {
	uid := UserIDFromContext(r.Context())
	cfg, _ := s.auth.db.GetUserConfig(uid)
	if cfg == nil {
		writeJSON(w, 200, map[string]any{})
		return
	}
	writeJSON(w, 200, map[string]any{
		"provider":    cfg.Provider,
		"model":       cfg.Model,
		"base_url":    cfg.BaseURL,
		"api_key":     cfg.APIKey,
		"temperature": cfg.Temperature,
		"max_tokens":  cfg.MaxTokens,
		"thinking":    cfg.Thinking,
	})
}

func (s *Server) handleProfileConfigSave(w http.ResponseWriter, r *http.Request) {
	uid := UserIDFromContext(r.Context())
	var req struct {
		Provider    string  `json:"provider"`
		Model       string  `json:"model"`
		BaseURL     string  `json:"base_url"`
		APIKey      string  `json:"api_key"`
		Temperature float64 `json:"temperature"`
		MaxTokens   int     `json:"max_tokens"`
		Thinking    bool    `json:"thinking"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if req.BaseURL != "" {
		if err := validateBaseURL(req.BaseURL); err != nil {
			writeErr(w, 400, "%v", err)
			return
		}
	}
	if err := s.auth.db.SetUserConfig(&UserConfigRow{
		UserID: uid, Provider: req.Provider, Model: req.Model,
		BaseURL: req.BaseURL, APIKey: req.APIKey,
		Temperature: req.Temperature, MaxTokens: req.MaxTokens, Thinking: req.Thinking,
	}); err != nil {
		writeErr(w, 500, "保存配置失败: %v", err)
		return
	}
	writeJSON(w, 200, map[string]string{"ok": "true"})
}

// ---------- 管理员 API ----------

func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.auth.ListUsers()
	if err != nil {
		writeErr(w, 500, "查询用户: %v", err)
		return
	}
	out := make([]map[string]any, len(users))
	for i, u := range users {
		out[i] = map[string]any{
			"id":           u.ID,
			"display_name": u.DisplayName,
			"role":         u.Role,
			"created_at":   u.CreatedAt.Format(time.RFC3339),
		}
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleAdminCreateUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DisplayName string `json:"display_name"`
		Password    string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	user, err := s.auth.CreateUser(req.DisplayName, req.Password)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	writeJSON(w, 201, map[string]any{
		"id":           user.ID,
		"display_name": user.DisplayName,
		"role":         user.Role,
		"created_at":   user.CreatedAt.Format(time.RFC3339),
	})
}

func (s *Server) handleAdminUpdateUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		DisplayName string `json:"display_name"`
		Password    string `json:"password,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if err := s.auth.UpdateUser(id, req.DisplayName, req.Password); err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	writeJSON(w, 200, map[string]string{"ok": "true"})
}

func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.auth.DeleteUser(id); err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	writeJSON(w, 200, map[string]string{"ok": "true"})
}

// ---------- 工具 ----------

func validateBaseURL(urlStr string) error {
	if !strings.HasPrefix(urlStr, "http://") && !strings.HasPrefix(urlStr, "https://") {
		return fmt.Errorf("base_url 必须以 http:// 或 https:// 开头")
	}
	return nil
}

// writeJSON 写 JSON 响应。
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("web: 写 JSON 响应失败", "err", err)
	}
}

// writeErr 写错误响应（统一 {"error": "..."} 结构）。
func writeErr(w http.ResponseWriter, status int, format string, args ...any) {
	writeJSON(w, status, map[string]string{"error": fmt.Sprintf(format, args...)})
}
