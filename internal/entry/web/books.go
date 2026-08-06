package web

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/bigxixi/ainovel-webui/assets"
	"github.com/bigxixi/ainovel-webui/internal/bootstrap"
	"github.com/bigxixi/ainovel-webui/internal/domain"
	"github.com/bigxixi/ainovel-webui/internal/entry/startup"
	"github.com/bigxixi/ainovel-webui/internal/host"
	"github.com/bigxixi/ainovel-webui/internal/logger"
)

// booksFileName 是书架清单文件名（位于书架根目录）。
const booksFileName = "books.json"

// maxBooks 是书架可同时存在的书籍上限（防磁盘/条目无限增长）。
const maxBooks = 64

// BookMeta 是 books.json 中持久化的书清单条目。
type BookMeta struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Dir       string    `json:"dir"` // 相对书架根目录的子目录名
	CreatedAt time.Time `json:"created_at"`
}

// Book 是运行中的书会话：一个 host.Host 实例 + 事件广播 hub。
type Book struct {
	Meta       BookMeta
	UserID     string   // 所属用户（隔离维度）
	host       *host.Host
	hub        *StreamHub
	logCleanup func() // 书日志文件关闭函数（Close 时调用）

	cancelMu  sync.Mutex
	auxCancel context.CancelFunc // 当前附加操作（导入/仿写/共创）的取消函数（可空）
}

// setAuxCancel 登记当前附加操作的取消函数（导入/仿写/共创）。
func (b *Book) setAuxCancel(cancel context.CancelFunc) {
	b.cancelMu.Lock()
	defer b.cancelMu.Unlock()
	b.auxCancel = cancel
}

// CancelAux 取消当前附加操作（无则忽略）。
func (b *Book) CancelAux() {
	b.cancelMu.Lock()
	defer b.cancelMu.Unlock()
	if b.auxCancel != nil {
		b.auxCancel()
		b.auxCancel = nil
	}
}

// BookManager 管理多本书。每本书对应书架根目录下的一个子目录，
// 且同一时刻只存在一个 host.Host 实例（flock book lease 语义保证跨进程独占）。
//
// 多用户隔离：每个用户一个书架子目录 booksDir/{userID}/，其下有独立的
// books.json 清单与书籍目录；books 映射 key 为 userID + "/" + bookID。
//
// 并发模型：bm.mu 保护 books 映射与生命周期；host.Host 自身并发安全；
// StreamHub 每书一个消费 goroutine，把 Events()/Stream()/Done() 广播给订阅者。
type BookManager struct {
	mu        sync.Mutex
	cfgLoader func() (bootstrap.Config, error) // 每次创建书时加载最新配置（/api/setup 后可生效）
	booksDir  string
	books     map[string]*Book
	closed    bool
}

// NewBookManager 构造多书管理器。booksDir 是书架根目录，不存在则创建。
// cfgLoader 在每次创建书会话时调用，保证 /api/setup 或改配置后无需重启。
func NewBookManager(cfgLoader func() (bootstrap.Config, error), booksDir string) (*BookManager, error) {
	if cfgLoader == nil {
		return nil, fmt.Errorf("配置加载器为空")
	}
	if booksDir == "" {
		return nil, fmt.Errorf("书架目录为空")
	}
	if err := os.MkdirAll(booksDir, 0o755); err != nil {
		return nil, fmt.Errorf("创建书架目录 %q: %w", booksDir, err)
	}
	return &BookManager{
		cfgLoader: cfgLoader,
		booksDir:  booksDir,
		books:     make(map[string]*Book),
	}, nil
}

// BooksDir 返回书架根目录。
func (bm *BookManager) BooksDir() string { return bm.booksDir }

// userBooksDir 返回指定用户的书架子目录，并确保存在。
func (bm *BookManager) userBooksDir(userID string) string {
	dir := filepath.Join(bm.booksDir, userID)
	os.MkdirAll(dir, 0o755)
	return dir
}

// bookKey 生成 books 映射 key（userID + "/" + bookID）。
func bookKey(userID, bookID string) string { return userID + "/" + bookID }

// LoadConfig 返回当前有效配置（供全局 profile 配置读写使用）。
func (bm *BookManager) LoadConfig() (bootstrap.Config, error) {
	return bm.cfgLoader()
}

// CreateRequest 是新建书的请求（快速模式）。
type CreateRequest struct {
	Title  string
	Prompt string // 用户原始创作需求
}

// Create 新建一本快速模式的书并立即启动引擎（同步执行 Arbiter 启动裁定）。
func (bm *BookManager) Create(userID string, req CreateRequest) (*Book, error) {
	plan, err := startup.PrepareQuick(startup.Request{
		Mode:        startup.ModeQuick,
		UserPrompt:  req.Prompt,
		Interactive: true,
	})
	if err != nil {
		return nil, fmt.Errorf("创作需求无效: %w", err)
	}

	bm.mu.Lock()
	book, err := bm.createSessionLocked(userID, req.Title)
	bm.mu.Unlock()
	if err != nil {
		return nil, err
	}

	// 用户规则快照须在 StartPrepared 之前（与 headless 流程一致）。
	if err := book.host.PrepareUserRules(plan.RawPrompt); err != nil {
		bm.removeBook(book)
		return nil, fmt.Errorf("准备用户规则: %w", err)
	}
	if err := book.host.StartPrepared(plan.RawPrompt); err != nil {
		bm.removeBook(book)
		return nil, fmt.Errorf("启动创作引擎: %w", err)
	}
	return book, nil
}

// CreateEmpty 创建一本空书会话（host.New 但引擎不启动），
// 供共创规划等"先建会话、后启动"的路径使用；随后用 StartWithPrompt 启动。
func (bm *BookManager) CreateEmpty(userID, title string) (*Book, error) {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	return bm.createSessionLocked(userID, title)
}

// CreateAsync 创建一本快速模式的书并异步启动引擎（不阻塞 HTTP 请求）。
// 启动裁定进度经该书 hub 广播（DECISION/TOOL 事件），失败以 ERROR 事件回显并回滚。
func (bm *BookManager) CreateAsync(userID string, req CreateRequest) (*Book, error) {
	plan, err := startup.PrepareQuick(startup.Request{
		Mode:        startup.ModeQuick,
		UserPrompt:  req.Prompt,
		Interactive: true,
	})
	if err != nil {
		return nil, fmt.Errorf("创作需求无效: %w", err)
	}
	book, err := bm.CreateEmpty(userID, req.Title)
	if err != nil {
		return nil, err
	}
	go func() {
		if err := book.host.PrepareUserRules(plan.RawPrompt); err != nil {
			book.hub.Publish(hubMessage{kind: "event", event: host.Event{
				Time: time.Now(), Category: "ERROR", Level: "error",
				Summary: "启动失败（准备用户规则）: " + err.Error(),
			}})
			bm.removeBook(book)
			return
		}
		if err := book.host.StartPrepared(plan.RawPrompt); err != nil {
			book.hub.Publish(hubMessage{kind: "event", event: host.Event{
				Time: time.Now(), Category: "ERROR", Level: "error",
				Summary: "启动裁定失败: " + err.Error(),
			}})
			bm.removeBook(book)
			return
		}
	}()
	return book, nil
}

// Remove 从书架移除一本书。
// keepCompleted=true 时，若书已完结则仅从清单移除（保留目录与小说文件），
// 否则连同目录一并删除。已完结判定用 Snapshot().Phase。
func (bm *BookManager) Remove(userID, id string, keepCompleted bool) error {
	bm.mu.Lock()
	meta, err := bm.findMetaLocked(userID, id)
	if err != nil {
		bm.mu.Unlock()
		return err
	}
	if meta == nil {
		bm.mu.Unlock()
		return fmt.Errorf("书架中不存在书 %q", id)
	}
	// 防御：目录名必须是单段相对路径（与 Get 一致），拒绝路径穿越。
	if meta.Dir == "" || filepath.Base(meta.Dir) != meta.Dir {
		bm.mu.Unlock()
		return fmt.Errorf("非法书目录名 %q", meta.Dir)
	}
	b := bm.books[bookKey(userID, id)]
	if b != nil {
		delete(bm.books, bookKey(userID, id))
	}
	bm.mu.Unlock()

	// 判断是否已完结（keepCompleted 时才需要）。
	completed := false
	if keepCompleted && b != nil && b.host != nil {
		completed = domain.Phase(b.host.Snapshot().Phase) == domain.PhaseComplete
	} else if keepCompleted && b == nil {
		if b2, err := bm.Get(userID, id); err == nil {
			completed = domain.Phase(b2.host.Snapshot().Phase) == domain.PhaseComplete
			// 临时打开的会话必须关闭，否则 flock 目录锁泄漏。
			b2.hub.Close()
			b2.host.Close()
			if b2.logCleanup != nil {
				b2.logCleanup()
			}
			bm.mu.Lock()
			delete(bm.books, bookKey(userID, id))
			bm.mu.Unlock()
		}
	}

	// 关闭会话（若打开）。
	if b != nil {
		b.hub.Close()
		b.host.Close()
		if b.logCleanup != nil {
			b.logCleanup()
		}
	}

	// 从清单移除。
	bm.mu.Lock()
	if metas, err := bm.loadBooks(userID); err == nil {
		filtered := metas[:0]
		for _, m := range metas {
			if m.ID != id {
				filtered = append(filtered, m)
			}
		}
		if len(filtered) != len(metas) {
			if err := bm.saveBooks(userID, filtered); err != nil {
				bm.mu.Unlock()
				return fmt.Errorf("更新书架清单: %w", err)
			}
		}
	}
	bm.mu.Unlock()

	// 删除目录（保留完结书时不删）。
	if !(keepCompleted && completed) {
		if err := os.RemoveAll(filepath.Join(bm.userBooksDir(userID), meta.Dir)); err != nil {
			return fmt.Errorf("删除书目录: %w", err)
		}
	}
	return nil
}

// StartWithPrompt 用给定 prompt 启动一本书的引擎（冷启动共创的 Apply 路径）。
func (bm *BookManager) StartWithPrompt(book *Book, prompt string) error {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return fmt.Errorf("创作需求不能为空")
	}
	if err := book.host.PrepareUserRules(prompt); err != nil {
		return fmt.Errorf("准备用户规则: %w", err)
	}
	if err := book.host.StartPrepared(prompt); err != nil {
		return fmt.Errorf("启动创作引擎: %w", err)
	}
	return nil
}

// createSessionLocked 创建书会话并注册到书架（host.New + hub + books.json），不启动引擎。
// 调用方须持 bm.mu。
func (bm *BookManager) createSessionLocked(userID, title string) (*Book, error) {
	if bm.closed {
		return nil, errors.New("book manager 已关闭")
	}
	if len(bm.books) >= maxBooks {
		return nil, fmt.Errorf("书架书籍数量已达上限（%d 本），请先删除部分书籍", maxBooks)
	}
	cfg, err := bm.cfgLoader()
	if err != nil {
		return nil, err
	}

	id := newBookID()
	dir := filepath.Join(bm.userBooksDir(userID), id)
	cfg.OutputDir = dir // 本书目录

	// 文风资源按本书配置加载（style 与书目录 style/ 覆盖层随之生效）。
	bundle := assets.Load(cfg.Style, assets.DefaultLoadOptions(dir))

	eng, err := host.New(cfg, bundle)
	if err != nil {
		return nil, err
	}
	logCleanup, err := logger.SetupFile(dir, "web.log", false)
	if err != nil {
		slog.Warn("web: 书日志不可用，继续运行", "book", id, "err", err)
		logCleanup = func() {}
	}

	book := &Book{
		Meta:       BookMeta{ID: id, Title: strings.TrimSpace(title), Dir: id, CreatedAt: time.Now()},
		host:       eng,
		hub:        newStreamHub(eng),
		logCleanup: logCleanup,
	}
	if book.Meta.Title == "" {
		book.Meta.Title = "未命名小说"
	}
	go book.hub.Run()
	bm.books[bookKey(userID, id)] = book

	// 持久化书架清单；失败则回滚（关闭引擎、清理目录），避免"在跑但不在书架"。
	metas, err := bm.loadBooks(userID)
	if err == nil {
		metas = append(metas, book.Meta)
		err = bm.saveBooks(userID, metas)
	}
	if err != nil {
		delete(bm.books, bookKey(userID, id))
		book.hub.Close()
		eng.Close()
		if logCleanup != nil {
			logCleanup()
		}
		os.RemoveAll(dir)
		return nil, fmt.Errorf("写入书架清单: %w", err)
	}
	return book, nil
}

// removeBook 从书架移除书会话、清理目录并同步清单（启动失败回滚用）。
func (bm *BookManager) removeBook(book *Book) {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	delete(bm.books, bookKey(book.UserID, book.Meta.ID))
	book.hub.Close()
	book.host.Close()
	if book.logCleanup != nil {
		book.logCleanup()
	}
	os.RemoveAll(filepath.Join(bm.userBooksDir(book.UserID), book.Meta.Dir))
	// 同步书架清单，避免"僵尸书"残留（书打不开也删不掉）。
	if metas, err := bm.loadBooks(book.UserID); err == nil {
		filtered := metas[:0]
		for _, m := range metas {
			if m.ID != book.Meta.ID {
				filtered = append(filtered, m)
			}
		}
		if len(filtered) != len(metas) {
			if err := bm.saveBooks(book.UserID, filtered); err != nil {
				slog.Warn("web: 移除书清单条目失败", "book", book.Meta.ID, "err", err)
			}
		}
	}
}

// Get 打开（或复用）一本书。已打开的会话直接返回；
// 未打开则创建 host.Host 会话并启动事件广播（引擎不自动恢复，由用户操作触发）。
func (bm *BookManager) Get(userID, id string) (*Book, error) {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	if bm.closed {
		return nil, errors.New("book manager 已关闭")
	}
	if b, ok := bm.books[bookKey(userID, id)]; ok {
		return b, nil
	}

	meta, err := bm.findMetaLocked(userID, id)
	if err != nil {
		return nil, err
	}
	if meta == nil {
		return nil, fmt.Errorf("书架中不存在书 %q", id)
	}
	// 防御：目录名必须是单段相对路径，拒绝路径穿越。
	if meta.Dir == "" || filepath.Base(meta.Dir) != meta.Dir {
		return nil, fmt.Errorf("非法书目录名 %q", meta.Dir)
	}

	dir := filepath.Join(bm.userBooksDir(userID), meta.Dir)
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("书目录不存在: %s", dir)
	}

	cfg, err := bm.cfgLoader()
	if err != nil {
		return nil, err
	}
	cfg.OutputDir = dir

	// 文风资源按本书配置加载（与 createSessionLocked 一致）。
	bundle := assets.Load(cfg.Style, assets.DefaultLoadOptions(dir))

	eng, err := host.New(cfg, bundle)
	if err != nil {
		return nil, err
	}
	logCleanup, err := logger.SetupFile(dir, "web.log", false)
	if err != nil {
		slog.Warn("web: 书日志不可用，继续运行", "book", id, "err", err)
		logCleanup = func() {}
	}

	book := &Book{UserID: userID, Meta: *meta, host: eng, hub: newStreamHub(eng), logCleanup: logCleanup}
	go book.hub.Run()
	bm.books[bookKey(userID, id)] = book
	return book, nil
}

// List 返回书架清单（books.json 内容，按创建时间排序）。
func (bm *BookManager) List(userID string) ([]BookMeta, error) {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	return bm.loadBooks(userID)
}

// IsOpen 返回书会话是否已打开（在内存中）。
func (bm *BookManager) IsOpen(userID, id string) bool {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	_, ok := bm.books[bookKey(userID, id)]
	return ok
}

// findMetaLocked 在清单中查找书元信息（调用方须持锁）。
func (bm *BookManager) findMetaLocked(userID, id string) (*BookMeta, error) {
	metas, err := bm.loadBooks(userID)
	if err != nil {
		return nil, err
	}
	for i := range metas {
		if metas[i].ID == id {
			return &metas[i], nil
		}
	}
	return nil, nil
}

// loadBooks 读取书架清单（books.json）。文件不存在时返回空列表。
func (bm *BookManager) loadBooks(userID string) ([]BookMeta, error) {
	data, err := os.ReadFile(filepath.Join(bm.userBooksDir(userID), booksFileName))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var f struct {
		Books []BookMeta `json:"books"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("解析书架清单: %w", err)
	}
	return f.Books, nil
}

// saveBooks 写回书架清单。
func (bm *BookManager) saveBooks(userID string, books []BookMeta) error {
	payload := struct {
		Books []BookMeta `json:"books"`
	}{Books: books}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(bm.userBooksDir(userID), booksFileName), data, 0o644)
}

// RemoveAllForUser 关闭并移除指定用户的所有书会话，并删除其书架目录（删除账号时调用）。
func (bm *BookManager) RemoveAllForUser(userID string) {
	bm.mu.Lock()
	prefix := userID + "/"
	for key, b := range bm.books {
		if strings.HasPrefix(key, prefix) {
			if b != nil && b.hub != nil {
				b.hub.Close()
			}
			if b != nil && b.host != nil {
				b.host.Close()
			}
			if b != nil && b.logCleanup != nil {
				b.logCleanup()
			}
			delete(bm.books, key)
		}
	}
	bm.mu.Unlock()
	os.RemoveAll(filepath.Join(bm.booksDir, userID))
}

// Close 关闭所有运行中的书并释放目录锁。幂等。
func (bm *BookManager) Close() {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	if bm.closed {
		return
	}
	for id, b := range bm.books {
		if b != nil && b.hub != nil {
			b.hub.Close()
		}
		if b != nil && b.host != nil {
			b.host.Close()
		}
		if b != nil && b.logCleanup != nil {
			b.logCleanup()
		}
		delete(bm.books, id)
	}
	bm.closed = true
}

// newBookID 生成书 ID：时间戳 + 随机后缀，避免并发创建冲突。
func newBookID() string {
	buf := make([]byte, 3)
	if _, err := rand.Read(buf); err != nil {
		return time.Now().Format("20060102-150405-000")
	}
	return time.Now().Format("20060102-150405") + "-" + hex.EncodeToString(buf)
}

// newReqID 生成附加操作（导入/仿写/共创）的请求 ID。
func newReqID() string {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		return time.Now().Format("150405.000")
	}
	return hex.EncodeToString(buf)
}
