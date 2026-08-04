package web

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/voocel/ainovel-cli/internal/bootstrap"
	"github.com/voocel/ainovel-cli/internal/rules"
	buildversion "github.com/voocel/ainovel-cli/internal/version"
)

// Options 是 `web` 子命令的启动选项。
type Options struct {
	Port     string
	BooksDir string
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

	// 配置每次创建书时重新加载：/api/setup 或用户改配置后无需重启服务器。
	cfgLoader := func() (bootstrap.Config, error) {
		if bootstrap.NeedsSetup() {
			return bootstrap.Config{}, errors.New("尚未完成首次引导：请先访问 /setup 配置 Provider 与模型")
		}
		cfg, err := bootstrap.LoadConfig()
		if err != nil {
			return bootstrap.Config{}, err
		}
		cfg.FillDefaults()
		return cfg, nil
	}

	bm, err := NewBookManager(cfgLoader, opts.BooksDir)
	if err != nil {
		return err
	}
	defer bm.Close()

	server := NewServer(bm)
	srv := &http.Server{
		Addr:              ":" + opts.Port,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 30 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("ainovel WebUI 已启动",
			"addr", srv.Addr,
			"books_dir", opts.BooksDir,
			"setup_needed", bootstrap.NeedsSetup(),
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
	opts := Options{
		Port:     envOr("AINOVEL_WEB_PORT", DefaultPort),
		BooksDir: envOr("AINOVEL_BOOKS_DIR", "books"),
	}
	fs := flag.NewFlagSet("web", flag.ContinueOnError)
	fs.StringVar(&opts.Port, "port", opts.Port, "WebUI 监听端口（默认 5269，可用环境变量 AINOVEL_WEB_PORT）")
	fs.StringVar(&opts.BooksDir, "books-dir", opts.BooksDir, "书架根目录，每本书一个子目录（默认 ./books，可用环境变量 AINOVEL_BOOKS_DIR）")
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
