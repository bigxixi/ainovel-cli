package web

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/voocel/agentcore"

	"github.com/bigxixi/ainovel-webui/internal/bootstrap"
)

// 本文件提供「全局设置对话框」用的、无需书实例的两个能力：
//   POST /api/provider/models —— 依据当前草稿（provider/base_url/api_key）拉取可选模型，
//                                拉取失败时回退到内置预设，保证前端下拉始终有候选。
//   POST /api/provider/test   —— 用草稿构造真实模型客户端发一次最小请求，验证配置可用性。
// 两者都不落盘、不切换运行时模型，仅用于配置阶段的探测与校验。

// providerDraft 是配置对话框传来的草稿（与前端 GlobalConfigDialog 字段一致）。
type providerDraft struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	BaseURL  string `json:"base_url"`
	APIKey   string `json:"api_key"`
	Thinking bool   `json:"thinking"`
}

// presetFor 返回指定 provider 的内置预设（找不到返回零值 + false）。
func presetFor(name string) (bootstrap.ProviderPreset, bool) {
	for _, p := range bootstrap.ProviderPresets() {
		if p.Name == name {
			return p, true
		}
	}
	return bootstrap.ProviderPreset{}, false
}

// resolveBaseURL 归一 base_url：草稿优先，其次预设默认。
func (d providerDraft) resolveBaseURL() string {
	if b := strings.TrimSpace(d.BaseURL); b != "" {
		return b
	}
	if p, ok := presetFor(d.Provider); ok {
		return p.BaseURL
	}
	return ""
}

// buildProbeConfig 用草稿构造一个仅含单 provider/单模型的最小可用配置，供 NewModelSet 使用。
func (d providerDraft) buildProbeConfig(model string) bootstrap.Config {
	name := strings.TrimSpace(d.Provider)
	pc := bootstrap.ProviderConfig{
		APIKey:  strings.TrimSpace(d.APIKey),
		BaseURL: strings.TrimSpace(d.resolveBaseURL()),
		Models:  []bootstrap.ModelConfig{{Name: strings.TrimSpace(model)}},
	}
	cfg := bootstrap.Config{
		Provider:  name,
		ModelName: strings.TrimSpace(model),
		Providers: map[string]bootstrap.ProviderConfig{name: pc},
		Roles:     map[string]bootstrap.RoleConfig{},
		Style:     "default",
	}
	cfg.FillDefaults()
	return cfg
}

// handleProviderModels 拉取当前草稿 provider 的可选模型列表。
// 优先真实查询 OpenAI 兼容的 GET {base_url}/models；失败或不兼容时回退内置预设。
func (s *Server) handleProviderModels(w http.ResponseWriter, r *http.Request) {
	var d providerDraft
	if err := decodeBody(w, r, &d); err != nil {
		return
	}
	if strings.TrimSpace(d.Provider) == "" {
		writeErr(w, http.StatusBadRequest, "请先选择 Provider")
		return
	}

	preset, _ := presetFor(d.Provider)
	source := "preset"
	models := append([]string(nil), preset.Models...)

	if fetched, err := fetchOpenAICompatModels(r.Context(), d.resolveBaseURL(), d.APIKey); err == nil && len(fetched) > 0 {
		models = mergeModels(fetched, preset.Models)
		source = "live"
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"provider": d.Provider,
		"models":   models,
		"source":   source,
	})
}

// fetchOpenAICompatModels 调用 OpenAI 兼容的 GET {base}/models，解析 {data:[{id}]}。
func fetchOpenAICompatModels(ctx context.Context, baseURL, apiKey string) ([]string, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return nil, fmt.Errorf("base_url 为空")
	}
	url := strings.TrimRight(baseURL, "/") + "/models"

	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if k := strings.TrimSpace(apiKey); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("models 接口返回 %d", resp.StatusCode)
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(payload.Data))
	for _, m := range payload.Data {
		if id := strings.TrimSpace(m.ID); id != "" {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out, nil
}

// handleProviderTest 用草稿构造真实客户端并发送最小请求，验证配置可用性。
// 成功返回 200；失败按错误类型映射为清晰的中文提示。
func (s *Server) handleProviderTest(w http.ResponseWriter, r *http.Request) {
	var d providerDraft
	if err := decodeBody(w, r, &d); err != nil {
		return
	}
	provider := strings.TrimSpace(d.Provider)
	model := strings.TrimSpace(d.Model)
	if provider == "" {
		writeErr(w, http.StatusBadRequest, "请先选择 Provider")
		return
	}
	if model == "" {
		writeErr(w, http.StatusBadRequest, "请填写模型名称")
		return
	}
	// base_url 若填写则做基本格式校验。
	if b := strings.TrimSpace(d.BaseURL); b != "" {
		if err := validateBaseURL(b); err != nil {
			writeErr(w, http.StatusBadRequest, "%v", err)
			return
		}
	}

	cfg := d.buildProbeConfig(model)
	if err := cfg.ValidateBase(); err != nil {
		writeErr(w, http.StatusBadRequest, "配置无效：%v", err)
		return
	}
	models, err := bootstrap.NewModelSet(cfg)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "创建模型客户端失败：%v", err)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if _, err := models.Default.Generate(ctx, []agentcore.Message{agentcore.UserMsg("Reply OK.")}, nil); err != nil {
		writeErr(w, http.StatusBadGateway, "%s", mapProviderError(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "连接成功，配置可用"})
}

// mapProviderError 把底层错误映射为面向用户的清晰提示。
func mapProviderError(err error) string {
	msg := err.Error()
	low := strings.ToLower(msg)
	switch {
	case strings.Contains(low, "401") || strings.Contains(low, "unauthorized") || strings.Contains(low, "invalid api key") || strings.Contains(low, "authentication"):
		return "连接失败：API Key 无效或未授权（401），请检查 API Key。"
	case strings.Contains(low, "403") || strings.Contains(low, "forbidden") || strings.Contains(low, "permission"):
		return "连接失败：无访问权限（403），请检查账号套餐或 IP 白名单。"
	case strings.Contains(low, "404") || strings.Contains(low, "not found"):
		return "连接失败：地址或模型不存在（404），请检查 Base URL 与模型名称。"
	case strings.Contains(low, "429") || strings.Contains(low, "rate limit") || strings.Contains(low, "too many"):
		return "连接失败：请求过于频繁（429），请稍后重试。"
	case strings.Contains(low, "timeout") || strings.Contains(low, "deadline") || strings.Contains(low, "context canceled"):
		return "连接超时：服务器无响应，请检查网络或 Base URL 是否可达。"
	case strings.Contains(low, "no such host") || strings.Contains(low, "dial tcp") || strings.Contains(low, "connection refused") || strings.Contains(low, "eof"):
		return "无法连接到服务器：请检查 Base URL 与网络（本地 Ollama 需先启动）。"
	default:
		return "连接测试失败：" + msg
	}
}
