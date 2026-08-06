package web

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/bigxixi/ainovel-webui/internal/bootstrap"
	"github.com/bigxixi/ainovel-webui/internal/rules"
	buildversion "github.com/bigxixi/ainovel-webui/internal/version"
)

// Options 是 `web` 子命令的启动选项。
type Options struct {
	Port     string
	Host     string // 监听地址（默认 127.0.0.1；远程部署显式放开 0.0.0.0 并配 TLS/反代）
	BooksDir string
	DataDir  string // Web 数据目录（users.json 等）
	Build    buildversion.Info
}

// DefaultPort 是 WebUI 默认监听端口。
const DefaultPort = "5269"

// Command 是 `ainovel-cli web` 子命令入口：启动 WebUI 服务器。
//
// 与 TUI/headless 的关系：web 是新增入口，不改变原有模式；
// 首次引导（bootstrap.NeedsSetup）在 web 形态下通过网页 /setup 完成，
// 服务器本身在无配置时也可启动（书 API 会返回"需要引导"错误）。
func Command(argv []string, build buildversion.Info) error {
	opts, err := parseOptions(argv)
	if err != nil {
		return err
	}
	opts.Build = build

	// 全局写作偏好目录（与 TUI 启动一致）。
	rules.EnsureHomeRulesDir()

	// 数据库多用户鉴权（SQLite）。
	db, err := OpenDB(opts.DataDir)
	if err != nil {
		return fmt.Errorf("打开数据库: %w", err)
	}
	defer db.Close()
	auth := NewAuth(db)

	// 配置每次创建书时按「当前用户」重新加载：
	// 系统 config.json 为基底，叠加该用户在 user_config 表的 Provider/API Key/模型，
	// 实现多用户配置完全隔离且改配置后无需重启服务器。
	cfgLoader := func(userID string) (bootstrap.Config, error) {
		// 先读该用户自己的配置（DB user_config）。
		uc, err := db.GetUserConfig(userID)
		if err != nil {
			return bootstrap.Config{}, fmt.Errorf("读取用户配置: %w", err)
		}
		userConfigured := uc != nil && (uc.Provider != "" || uc.APIKey != "")
		if bootstrap.NeedsSetup() {
			if !userConfigured {
				return bootstrap.Config{}, errors.New("尚未配置模型：请先到「全局设置」配置 Provider 与 API Key")
			}
			// 用户已在 Web 端保存过配置：以用户配置构建（无需系统 config.json）。
			cfg := bootstrap.Config{}
			cfg.FillDefaults()
			applyUserConfig(&cfg, uc)
			return cfg, nil
		}
		cfg, err := bootstrap.LoadConfig()
		if err != nil {
			return bootstrap.Config{}, err
		}
		cfg.FillDefaults()
		if uc != nil {
			applyUserConfig(&cfg, uc)
		}
		return cfg, nil
	}

	bm, err := NewBookManager(cfgLoader, opts.BooksDir)
	if err != nil {
		return err
	}
	defer bm.Close()

	server := NewServer(bm, auth)
	srv := &http.Server{
		Addr:              net.JoinHostPort(opts.Host, opts.Port),
		Handler:           server.Handler(),
		ReadHeaderTimeout: 30 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("ainovel WebUI 已启动",
			"addr", srv.Addr,
			"books_dir", opts.BooksDir,
			"data_dir", opts.DataDir,
			"setup_needed", bootstrap.NeedsSetup(),
			"auth_configured", auth.IsConfigured(),
			"version", build.Version,
			"commit", build.Commit,
		)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	// 优雅关闭：等待 SIGINT/SIGTERM。先非阻塞优先读取启动错误（避免被信号抢占），
	// 再用双通道 select 同时等待两者，避免启动错误晚于首次检查而永远读不到。
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errCh:
		return fmt.Errorf("web 服务启动失败: %w", err)
	default:
	}
	select {
	case err := <-errCh:
		return fmt.Errorf("web 服务启动失败: %w", err)
	case sig := <-stop:
		slog.Info("收到退出信号，正在关闭", "signal", sig.String())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Warn("HTTP 服务关闭超时", "err", err)
	}
	return nil
}

// parseOptions 解析 web 子命令参数，支持环境变量兜底。
func parseOptions(argv []string) (Options, error) {
	defaultDataDir := filepath.Join(bootstrap.DefaultConfigDir(), "web")
	if defaultDataDir == filepath.Join("", "web") {
		defaultDataDir = "./web-data"
	}
	opts := Options{
		Port:     envOr("AINOVEL_WEB_PORT", DefaultPort),
		Host:     envOr("AINOVEL_WEB_HOST", "127.0.0.1"),
		BooksDir: envOr("AINOVEL_BOOKS_DIR", "books"),
		DataDir:  envOr("AINOVEL_WEB_DATA_DIR", defaultDataDir),
	}
	fs := flag.NewFlagSet("web", flag.ContinueOnError)
	fs.StringVar(&opts.Port, "port", opts.Port, "WebUI 监听端口（默认 5269，可用环境变量 AINOVEL_WEB_PORT）")
	fs.StringVar(&opts.Host, "host", opts.Host, "监听地址（默认 127.0.0.1，可用环境变量 AINOVEL_WEB_HOST）")
	fs.StringVar(&opts.BooksDir, "books-dir", opts.BooksDir, "书架根目录，每本书一个子目录（默认 ./books，可用环境变量 AINOVEL_BOOKS_DIR）")
	fs.StringVar(&opts.DataDir, "data-dir", opts.DataDir, "Web 数据目录（users.json 等，默认 ~/.ainovel/web，可用环境变量 AINOVEL_WEB_DATA_DIR）")
	if err := fs.Parse(argv); err != nil {
		return Options{}, err
	}
	if fs.NArg() > 0 {
		return Options{}, fmt.Errorf("web 不接受位置参数: %v", fs.Args())
	}
	return opts, nil
}

// envOr 返回环境变量值，未设置时回退默认值。
func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
