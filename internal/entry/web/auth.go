package web

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/voocel/ainovel-cli/internal/bootstrap"
	"golang.org/x/crypto/bcrypt"
)

// userFileName 是单用户鉴权记录文件名（位于 Web 数据目录）。
const userFileName = "users.json"

// initializedFileName 标记已完成过首次初始化（防 users.json 被误删后静默重开）。
const initializedFileName = ".initialized"

// loginFailWindow / loginFailThreshold 是登录失败滑动窗口限速参数。
const (
	loginFailWindow    = 5 * time.Minute
	loginFailThreshold = 10
)

// sessionCookie 是登录态 cookie 名。
const sessionCookie = "ainovel_session"

// sessionTTL 是服务端 session 的兜底过期时长（cookie 本身为浏览器会话级，
// 关闭浏览器即失效，满足"每次打开 WebUI 重新鉴权"）。
const sessionTTL = 30 * 24 * time.Hour

// loginFailDelay 是登录失败时的固定延迟，减缓暴力猜测。
const loginFailDelay = 600 * time.Millisecond

// UserRecord 是持久化的单用户记录（bcrypt 密码哈希，不存明文）。
type UserRecord struct {
	DisplayName  string    `json:"display_name"`
	PasswordHash []byte    `json:"password_hash"`
	CreatedAt    time.Time `json:"created_at"`
}

// ErrInvalidPassword 表示密码错误。
var ErrInvalidPassword = errors.New("访问密码错误")

// ErrAuthNotConfigured 表示尚未设置访问密码。
var ErrAuthNotConfigured = errors.New("尚未设置访问密码")

// Auth 管理单用户鉴权：bcrypt 密码校验 + 内存 session + HTTP cookie。
// 数据仅持久化 users.json（显示名 + 密码哈希）。
type Auth struct {
	mu     sync.Mutex
	path   string               // users.json 绝对路径
	user   *UserRecord          // nil = 未设置
	tokens map[string]time.Time // session token → 过期时间

	failMu    sync.Mutex
	failTimes []time.Time // 登录失败时间（滑动窗口限速）
}

// NewAuth 加载或准备用户数据文件。文件不存在时返回未配置状态（首次设置密码）。
// 若 users.json 缺失但已存在初始化标记（数据被误删），拒绝以未配置模式启动。
func NewAuth(dataDir string) (*Auth, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("创建 Web 数据目录 %q: %w", dataDir, err)
	}
	a := &Auth{
		path:   filepath.Join(dataDir, userFileName),
		tokens: make(map[string]time.Time),
	}
	if err := a.load(); err != nil {
		return nil, err
	}
	if a.user == nil {
		initPath := filepath.Join(dataDir, initializedFileName)
		if _, err := os.Stat(initPath); err == nil {
			return nil, fmt.Errorf("用户数据异常：%s 缺失但已完成过初始化，请恢复该文件，或确认后删除 %s 重置", userFileName, initPath)
		}
	}
	return a, nil
}

// load 读取 users.json；不存在视为未配置。
func (a *Auth) load() error {
	data, err := os.ReadFile(a.path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var u UserRecord
	if err := json.Unmarshal(data, &u); err != nil {
		return fmt.Errorf("解析 %s: %w", a.path, err)
	}
	a.user = &u
	return nil
}

// save 写回 users.json（目录权限 0700，文件 0600）。
func (a *Auth) save() error {
	data, err := json.MarshalIndent(a.user, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(a.path, data, 0o600)
}

// Configured 返回是否已设置访问密码。
func (a *Auth) Configured() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.user != nil
}

// DisplayName 返回当前用户显示名（未设置时为空）。
func (a *Auth) DisplayName() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.user == nil {
		return ""
	}
	return a.user.DisplayName
}

// SetPassword 首次设置访问密码并创建用户记录。
// 已在锁内判定：已配置时拒绝覆盖（防并发 TOCTOU 抢写）。
func (a *Auth) SetPassword(displayName, password string) error {
	if len(password) < 6 {
		return errors.New("访问密码至少 6 位")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("生成密码哈希: %w", err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.user != nil {
		return errors.New("访问密码已设置，不能重复初始化")
	}
	a.user = &UserRecord{
		DisplayName:  displayName,
		PasswordHash: hash,
		CreatedAt:    time.Now(),
	}
	if err := a.save(); err != nil {
		a.user = nil
		return fmt.Errorf("保存用户数据: %w", err)
	}
	// 初始化标记：users.json 被误删后不再静默重开初始化。
	initPath := filepath.Join(filepath.Dir(a.path), initializedFileName)
	if err := os.WriteFile(initPath, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o600); err != nil {
		slog.Warn("web: 写入初始化标记失败", "err", err)
	}
	slog.Info("web: 已设置访问密码", "display_name", displayName)
	return nil
}

// RecordFailure 记录一次登录失败；滑动窗口内失败达到阈值返回 true（应拒绝请求）。
func (a *Auth) RecordFailure() bool {
	now := time.Now()
	a.failMu.Lock()
	defer a.failMu.Unlock()
	cutoff := now.Add(-loginFailWindow)
	kept := a.failTimes[:0]
	for _, t := range a.failTimes {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	a.failTimes = append(kept, now)
	return len(a.failTimes) >= loginFailThreshold
}

// ClearFailures 登录成功后清空失败记录。
func (a *Auth) ClearFailures() {
	a.failMu.Lock()
	defer a.failMu.Unlock()
	a.failTimes = nil
}

// Verify 校验访问密码；失败返回 ErrInvalidPassword。
func (a *Auth) Verify(password string) error {
	a.mu.Lock()
	u := a.user
	a.mu.Unlock()
	if u == nil {
		return ErrAuthNotConfigured
	}
	if err := bcrypt.CompareHashAndPassword(u.PasswordHash, []byte(password)); err != nil {
		return ErrInvalidPassword
	}
	return nil
}

// CreateSession 创建登录 session 并返回 token（crypto/rand 32 字节）。
func (a *Auth) CreateSession() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成会话 token: %w", err)
	}
	token := hex.EncodeToString(buf)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.tokens[token] = time.Now().Add(sessionTTL)
	return token, nil
}

// Validate 校验 token 是否有效（存在且未过期）；过期 token 顺手清理。
func (a *Auth) Validate(token string) bool {
	if token == "" {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	exp, ok := a.tokens[token]
	if !ok {
		return false
	}
	if time.Now().After(exp) {
		delete(a.tokens, token)
		return false
	}
	return true
}

// Destroy 注销 session（登出）。
func (a *Auth) Destroy(token string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.tokens, token)
}

// Middleware 保护需要登录的 API：cookie 无效返回 401。
func (a *Auth) Middleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil || !a.Validate(c.Value) {
			writeErr(w, http.StatusUnauthorized, "未登录或会话已过期")
			return
		}
		next(w, r)
	}
}

// setSessionCookie 写入登录 cookie（浏览器会话级，无 Max-Age）。
func setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

// clearSessionCookie 清除登录 cookie（登出）。
func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})
}

// ================= 鉴权与 profile 端点 =================

// handleAuthStatus 返回鉴权与配置状态（前端初始化用）。
func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	configured := s.auth.Configured()
	authenticated := false
	if c, err := r.Cookie(sessionCookie); err == nil {
		authenticated = s.auth.Validate(c.Value)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured":    configured,
		"authenticated": authenticated,
		"display_name":  s.auth.DisplayName(),
		"setup_needed":  bootstrap.NeedsSetup(),
	})
}

// setupAuthRequest 是首次设置访问密码的请求体。
type setupAuthRequest struct {
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
}

// handleSetupAuth 首次设置访问密码并自动登录（已配置时拒绝）。
func (s *Server) handleSetupAuth(w http.ResponseWriter, r *http.Request) {
	if s.auth.Configured() {
		writeErr(w, http.StatusConflict, "访问密码已设置")
		return
	}
	var req setupAuthRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	name := strings.TrimSpace(req.DisplayName)
	if name == "" {
		name = "用户"
	}
	if err := s.auth.SetPassword(name, req.Password); err != nil {
		writeErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	token, err := s.auth.CreateSession()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	setSessionCookie(w, token)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "display_name": name})
}

// loginRequest 是登录请求体。
type loginRequest struct {
	Password string `json:"password"`
}

// handleLogin 校验访问密码并建立会话。
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	if err := s.auth.Verify(req.Password); err != nil {
		// 滑动窗口限速：5 分钟内失败 ≥10 次直接拒绝，否则固定延迟减缓暴力尝试。
		if s.auth.RecordFailure() {
			writeErr(w, http.StatusTooManyRequests, "尝试过于频繁，请稍后再试")
			return
		}
		time.Sleep(loginFailDelay)
		writeErr(w, http.StatusUnauthorized, "%v", err)
		return
	}
	s.auth.ClearFailures()
	token, err := s.auth.CreateSession()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	setSessionCookie(w, token)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "display_name": s.auth.DisplayName()})
}

// handleLogout 注销会话。
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.auth.Destroy(c.Value)
	}
	clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleProfile 返回当前用户信息与配置摘要。
func (s *Server) handleProfile(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"display_name": s.auth.DisplayName(),
		"setup_needed": bootstrap.NeedsSetup(),
	})
}

// handleProfileConfig 返回全局配置快照（脱敏：仅 provider/模型，不含明文 key）。
func (s *Server) handleProfileConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.books.LoadConfig()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, configSnapshot(cfg))
}

// configSnapshot 从配置构造前端可展示的脱敏快照。
func configSnapshot(cfg bootstrap.Config) map[string]any {
	providers := make([]map[string]any, 0, len(cfg.Providers))
	for name, pc := range cfg.Providers {
		models := make([]map[string]any, 0, len(pc.Models))
		for _, m := range pc.Models {
			models = append(models, map[string]any{"name": m.Name, "context_window": m.ContextWindow})
		}
		providers = append(providers, map[string]any{
			"name":        name,
			"type":        pc.Type,
			"api":         pc.API,
			"base_url":    pc.BaseURL,
			"models":      models,
			"has_api_key": pc.APIKey != "",
		})
	}
	return map[string]any{
		"providers":        providers,
		"default_provider": cfg.Provider,
		"default_model":    cfg.ModelName,
	}
}

// validateBaseURL 校验 base_url 为 http(s) 地址（防注入/自我 SSRF）。
func validateBaseURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("base_url 必须是 http(s):// 地址")
	}
	return nil
}

// handleProfileConfigSave 保存全局配置（简化版：base_url/api/type/models/APIKey，不支持重命名）。
func (s *Server) handleProfileConfigSave(w http.ResponseWriter, r *http.Request) {
	var req saveConfigRequest
	if err := decodeBody(w, r, &req); err != nil {
		return
	}
	cfg, err := s.books.LoadConfig()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "%v", err)
		return
	}
	name := strings.TrimSpace(req.Draft.Provider)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "provider 名称不能为空")
		return
	}
	pc := cfg.Providers[name]
	if req.Draft.Type != "" {
		pc.Type = req.Draft.Type
	}
	if req.Draft.API != "" {
		pc.API = req.Draft.API
	}
	if err := validateBaseURL(req.Draft.BaseURL); err != nil {
		writeErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	if req.Draft.BaseURL != "" {
		pc.BaseURL = req.Draft.BaseURL
	}
	if len(req.Draft.Models) > 0 {
		pc.Models = req.Draft.Models
	}
	switch req.Draft.APIKeyAction {
	case "replace":
		pc.APIKey = req.Draft.APIKey
	case "clear":
		pc.APIKey = ""
	}
	if cfg.Providers == nil {
		cfg.Providers = make(map[string]bootstrap.ProviderConfig)
	}
	cfg.Providers[name] = pc
	cfg.FillDefaults()
	if err := cfg.ValidateBase(); err != nil {
		writeErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	if err := bootstrap.SaveConfig(bootstrap.DefaultConfigPath(), cfg); err != nil {
		writeErr(w, http.StatusInternalServerError, "保存配置失败: %v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
