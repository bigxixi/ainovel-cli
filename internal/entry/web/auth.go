package web

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	"context"
)

// loginFailWindow / loginFailThreshold 是登录失败滑动窗口限速参数。
const (
	loginFailWindow    = 5 * time.Minute
	loginFailThreshold = 10
	sessionTTL         = 30 * 24 * time.Hour // 30 天
	cookieName         = "ainovel_session"
)

// Auth 管理多用户鉴权：bcrypt 密码校验 + 数据库 session + HTTP cookie。
type Auth struct {
	mu  sync.Mutex
	db  *DB

	failMu    sync.Mutex
	failTimes map[string][]time.Time // 登录失败记录（按请求 IP）
}

// NewAuth 从数据库构建鉴权服务。
func NewAuth(db *DB) *Auth {
	a := &Auth{
		db:        db,
		failTimes: make(map[string][]time.Time),
	}
	// 定期清理过期 session
	go func() {
		for range time.Tick(1 * time.Hour) {
			db.CleanupExpiredSessions()
		}
	}()
	return a
}

// IsConfigured 是否有至少一个用户（即管理员已创建）。
func (a *Auth) IsConfigured() bool {
	users, err := a.db.ListUsers()
	if err != nil || len(users) == 0 {
		return false
	}
	return true
}

// IsAdmin 检查用户是否为管理员。
func (a *Auth) IsAdmin(userID string) bool {
	u, err := a.db.GetUserByID(userID)
	if err != nil || u == nil {
		return false
	}
	return u.Role == "admin"
}

// ---------- 密码与用户 ----------

// SetupAdmin 首次设置管理员账号。已存在管理员时返回错误。
func (a *Auth) SetupAdmin(displayName, password string) (*UserRow, error) {
	if len(password) < 6 {
		return nil, errors.New("访问密码至少 6 位")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("生成密码哈希: %w", err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	id := newUserID()
	if err := a.db.CreateUser(id, displayName, hash, "admin"); err != nil {
		return nil, err
	}
	u, _ := a.db.GetUserByID(id)
	slog.Info("web: 创建管理员账号", "id", id, "display_name", displayName)
	return u, nil
}

// CreateUser 管理员创建普通用户。
func (a *Auth) CreateUser(displayName, password string) (*UserRow, error) {
	if len(password) < 6 {
		return nil, errors.New("访问密码至少 6 位")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("生成密码哈希: %w", err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	id := newUserID()
	if err := a.db.CreateUser(id, displayName, hash, "user"); err != nil {
		return nil, err
	}
	u, _ := a.db.GetUserByID(id)
	slog.Info("web: 创建用户", "id", id, "display_name", displayName)
	return u, nil
}

// ListUsers 列出所有用户（管理员用）。
func (a *Auth) ListUsers() ([]UserRow, error) {
	return a.db.ListUsers()
}

// UpdateUser 修改用户信息（管理员用）。
func (a *Auth) UpdateUser(id, displayName, password string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	u, err := a.db.GetUserByID(id)
	if err != nil || u == nil {
		return fmt.Errorf("用户不存在")
	}
	var hash []byte
	if password != "" {
		hash, err = bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return fmt.Errorf("生成密码哈希: %w", err)
		}
	}
	return a.db.UpdateUser(id, displayName, hash)
}

// DeleteUser 删除用户（管理员用，不能删管理员自己）。
func (a *Auth) DeleteUser(id string) error {
	return a.db.DeleteUser(id)
}

// ---------- 登录 / 登出 ----------

// Login 校验密码并创建 session，返回 session token。
func (a *Auth) Login(password string) (token string, user *UserRow, err error) {
	// 查找所有用户，逐一比对密码（不支持用户名登录，仅密码）
	users, err := a.db.ListUsers()
	if err != nil {
		return "", nil, fmt.Errorf("查询用户: %w", err)
	}
	var found *UserRow
	for i := range users {
		if bcrypt.CompareHashAndPassword(users[i].PasswordHash, []byte(password)) == nil {
			found = &users[i]
			break
		}
	}
	// 固定比对延迟（无论是否找到用户）
	time.Sleep(600 * time.Millisecond)
	if found == nil {
		return "", nil, errors.New("密码错误")
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	token = newSessionToken()
	expires := time.Now().Add(sessionTTL)
	if err := a.db.CreateSession(token, found.ID, expires); err != nil {
		return "", nil, fmt.Errorf("创建会话: %w", err)
	}
	return token, found, nil
}

// Validate 从 cookie 校验 session，返回用户 ID。
func (a *Auth) Validate(r *http.Request) (userID string) {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return ""
	}
	uid, expires, err := a.db.GetSession(cookie.Value)
	if err != nil || uid == "" {
		return ""
	}
	if time.Now().After(expires) {
		a.db.DeleteSession(cookie.Value)
		return ""
	}
	return uid
}

// Logout 清除 session。
func (a *Auth) Logout(r *http.Request) {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return
	}
	a.db.DeleteSession(cookie.Value)
}

// SetSessionCookie 设置 cookie。
func SetSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
}

// ClearSessionCookie 清除 cookie。
func ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
	})
}

// ---------- 中间件 ----------

// Middleware 鉴权中间件：未登录返回 401 JSON。
func (a *Auth) Middleware(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid := a.Validate(r)
		if uid == "" {
			writeErr(w, 401, "未登录")
			return
		}
		ctx := withUserID(r.Context(), uid)
		h(w, r.WithContext(ctx))
	}
}

// AdminMiddleware 管理员鉴权中间件。
func (a *Auth) AdminMiddleware(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid := a.Validate(r)
		if uid == "" {
			writeErr(w, 401, "未登录")
			return
		}
		if !a.IsAdmin(uid) {
			writeErr(w, 403, "需要管理员权限")
			return
		}
		ctx := withUserID(r.Context(), uid)
		h(w, r.WithContext(ctx))
	}
}

// ---------- 限速 ----------

// RecordFailure 记录登录失败；返回 true 表示已达限速阈值。
func (a *Auth) RecordFailure(ip string) bool {
	now := time.Now()
	a.failMu.Lock()
	defer a.failMu.Unlock()
	cutoff := now.Add(-loginFailWindow)
	kept := a.failTimes[ip][:0]
	for _, t := range a.failTimes[ip] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	a.failTimes[ip] = append(kept, now)
	if len(a.failTimes) > 1000 {
		for k := range a.failTimes {
			if len(a.failTimes[k]) == 0 {
				delete(a.failTimes, k)
			}
		}
	}
	return len(a.failTimes[ip]) >= loginFailThreshold
}

// ClearFailures 登录成功后清空该 IP 的失败记录。
func (a *Auth) ClearFailures(ip string) {
	a.failMu.Lock()
	defer a.failMu.Unlock()
	delete(a.failTimes, ip)
}

// ---------- 工具 ----------

func newUserID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func newSessionToken() string {
	var b [32]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// ---------- Context ----------

type ctxKey string

const ctxUserID ctxKey = "user_id"

func withUserID(ctx context.Context, uid string) context.Context {
	return context.WithValue(ctx, ctxUserID, uid)
}

// UserIDFromContext 从 context 获取当前用户 ID。
func UserIDFromContext(ctx context.Context) string {
	v, _ := ctx.Value(ctxUserID).(string)
	return v
}

// ipFromRequest 从请求中获取客户端 IP。
func ipFromRequest(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		return strings.Split(fwd, ",")[0]
	}
	host := r.RemoteAddr
	if idx := strings.LastIndex(host, ":"); idx != -1 {
		return host[:idx]
	}
	return host
}
