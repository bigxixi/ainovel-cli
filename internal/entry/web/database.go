package web

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// DB 封装 SQLite 连接（Web 数据目录下的 web.db）。
// 所有用户与配置数据通过数据库管理，替代单文件 JSON。
type DB struct {
	*sql.DB
	mu sync.Mutex
}

// OpenDB 打开或创建数据库，并执行迁移。
func OpenDB(dataDir string) (*DB, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("创建数据目录: %w", err)
	}
	path := filepath.Join(dataDir, "web.db")
	// 使用 WAL 模式 + busy timeout 支持多读单写
	dsn := path + "?_journal_mode=WAL&_busy_timeout=5000"
	raw, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库 %q: %w", path, err)
	}
	raw.SetMaxOpenConns(1) // SQLite 单写入者，限制并发写
	db := &DB{DB: raw}
	if err := db.migrate(); err != nil {
		raw.Close()
		return nil, fmt.Errorf("数据库迁移: %w", err)
	}
	return db, nil
}

func (db *DB) migrate() error {
	db.mu.Lock()
	defer db.mu.Unlock()
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS users (
			id         TEXT PRIMARY KEY,
			display_name TEXT NOT NULL DEFAULT '',
			password_hash BLOB NOT NULL,
			role       TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS sessions (
			token      TEXT PRIMARY KEY,
			user_id    TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
		-- 每个用户的全局配置（合并到 users 表延展字段，或用独立表）
		CREATE TABLE IF NOT EXISTS user_config (
			user_id    TEXT PRIMARY KEY,
			provider   TEXT NOT NULL DEFAULT '',
			model      TEXT NOT NULL DEFAULT '',
			base_url   TEXT NOT NULL DEFAULT '',
			api_key    TEXT NOT NULL DEFAULT '',
			temperature REAL NOT NULL DEFAULT 0.7,
			max_tokens INTEGER NOT NULL DEFAULT 0,
			thinking   INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);
	`)
	return err
}

// ---------- User CRUD ----------

type UserRow struct {
	ID           string
	DisplayName  string
	PasswordHash []byte
	Role         string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

func (db *DB) CreateUser(id, displayName string, hash []byte, role string) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	// 管理员唯一约束
	if role == "admin" {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM users WHERE role='admin'").Scan(&count); err != nil {
			return err
		}
		if count > 0 {
			return fmt.Errorf("管理员账号已存在")
		}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := db.Exec(
		"INSERT INTO users (id, display_name, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?,?)",
		id, displayName, hash, role, now, now,
	)
	return err
}

func (db *DB) GetUserByID(id string) (*UserRow, error) {
	row := db.QueryRow("SELECT id, display_name, password_hash, role, created_at, updated_at FROM users WHERE id=?", id)
	u := &UserRow{}
	var ca, ua string
	if err := row.Scan(&u.ID, &u.DisplayName, &u.PasswordHash, &u.Role, &ca, &ua); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	u.CreatedAt, _ = time.Parse(time.RFC3339, ca)
	u.UpdatedAt, _ = time.Parse(time.RFC3339, ua)
	return u, nil
}

func (db *DB) ListUsers() ([]UserRow, error) {
	rows, err := db.Query("SELECT id, display_name, password_hash, role, created_at, updated_at FROM users ORDER BY created_at")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UserRow
	for rows.Next() {
		u := UserRow{}
		var ca, ua string
		if err := rows.Scan(&u.ID, &u.DisplayName, &u.PasswordHash, &u.Role, &ca, &ua); err != nil {
			return nil, err
		}
		u.CreatedAt, _ = time.Parse(time.RFC3339, ca)
		u.UpdatedAt, _ = time.Parse(time.RFC3339, ua)
		out = append(out, u)
	}
	return out, rows.Err()
}

func (db *DB) UpdateUser(id, displayName string, hash []byte) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	now := time.Now().UTC().Format(time.RFC3339)
	if len(hash) > 0 {
		_, err := db.Exec("UPDATE users SET display_name=?, password_hash=?, updated_at=? WHERE id=?",
			displayName, hash, now, id)
		return err
	}
	_, err := db.Exec("UPDATE users SET display_name=?, updated_at=? WHERE id=?",
		displayName, now, id)
	return err
}

func (db *DB) DeleteUser(id string) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	var role string
	if err := db.QueryRow("SELECT role FROM users WHERE id=?", id).Scan(&role); err != nil {
		return err
	}
	if role == "admin" {
		return fmt.Errorf("不能删除管理员账号")
	}
	_, err := db.Exec("DELETE FROM users WHERE id=?", id)
	return err
}

// ---------- Config ----------

type UserConfigRow struct {
	UserID      string
	Provider    string
	Model       string
	BaseURL     string
	APIKey      string
	Temperature float64
	MaxTokens   int
	Thinking    bool
}

func (db *DB) GetUserConfig(userID string) (*UserConfigRow, error) {
	row := db.QueryRow("SELECT user_id, provider, model, base_url, api_key, temperature, max_tokens, thinking FROM user_config WHERE user_id=?", userID)
	c := &UserConfigRow{}
	var thinking int
	if err := row.Scan(&c.UserID, &c.Provider, &c.Model, &c.BaseURL, &c.APIKey, &c.Temperature, &c.MaxTokens, &thinking); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	c.Thinking = thinking != 0
	return c, nil
}

func (db *DB) SetUserConfig(c *UserConfigRow) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	thinking := 0
	if c.Thinking {
		thinking = 1
	}
	_, err := db.Exec(
		`INSERT INTO user_config (user_id, provider, model, base_url, api_key, temperature, max_tokens, thinking)
		 VALUES (?,?,?,?,?,?,?,?)
		 ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider, model=excluded.model, base_url=excluded.base_url,
		 api_key=excluded.api_key, temperature=excluded.temperature, max_tokens=excluded.max_tokens, thinking=excluded.thinking`,
		c.UserID, c.Provider, c.Model, c.BaseURL, c.APIKey, c.Temperature, c.MaxTokens, thinking,
	)
	return err
}

// ---------- Session ----------

func (db *DB) CreateSession(token, userID string, expiresAt time.Time) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	_, err := db.Exec("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)",
		token, userID, expiresAt.UTC().Format(time.RFC3339))
	return err
}

func (db *DB) GetSession(token string) (userID string, expiresAt time.Time, err error) {
	var exp string
	err = db.QueryRow("SELECT user_id, expires_at FROM sessions WHERE token=?", token).Scan(&userID, &exp)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", time.Time{}, nil
		}
		return "", time.Time{}, err
	}
	expiresAt, _ = time.Parse(time.RFC3339, exp)
	return userID, expiresAt, nil
}

func (db *DB) DeleteSession(token string) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	_, err := db.Exec("DELETE FROM sessions WHERE token=?", token)
	return err
}

func (db *DB) CleanupExpiredSessions() {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.Exec("DELETE FROM sessions WHERE expires_at < datetime('now')")
}
