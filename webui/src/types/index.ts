// Book 元数据（对应后端 books.json 条目）
export interface BookMeta {
  id: string
  title: string
  dir: string
  created_at: string
  updated_at?: string
}

// 快照（对应 host.Snapshot）
export interface Snapshot {
  runtime_state: string
  phase: string
  chapter: number
  total_chapters: number
  completed_count: number
  word_count: number
  advance_mode: string
  thinking: boolean
  is_importing: boolean
  is_simulating: boolean
  is_cocreating: boolean
  provider: string
  model: string
  last_error?: string
  chapter_title?: string
  featured_pending?: boolean
}

// SSE 事件
export interface StreamEvent {
  time: string
  category: string
  summary: string
  agent?: string
}

// 认证状态
export interface AuthStatus {
  configured: boolean
  logged_in: boolean
  display_name?: string
}

// 登录请求
export interface LoginRequest {
  password: string
}

// 设置密码请求
export interface SetupAuthRequest {
  display_name: string
  password: string
}

// Profile 配置
export interface ProfileConfig {
  provider: string
  model: string
  base_url?: string
  api_key?: string
  temperature?: number
  max_tokens?: number
  thinking?: boolean
}

// Provider 预设
export interface ProviderPreset {
  id: string
  name: string
  models: ModelPreset[]
}

export interface ModelPreset {
  id: string
  name: string
}

// 诊断信息
export interface DiagInfo {
  version: string
  go_version: string
  providers: Record<string, { configured: boolean; model_count: number }>
}

// 创建书请求
export interface CreateBookRequest {
  title?: string
  prompt: string
  mode?: 'quick' | 'cocreate'
}

// 文本命令请求
export interface TextRequest {
  text: string
}

// 模式请求
export interface ModeRequest {
  mode: string
}

// 导入请求
export interface ImportRequest {
  source_path?: string
  mode?: string
}

// 导出请求
export interface ExportRequest {
  format?: string
  out_path?: string
}

// 共创消息
export interface CoCreateMessage {
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  suggestions?: string[]
}

// 共创请求
export interface CoCreateRequest {
  message: string
}

// 管理：用户列表
export interface UserInfo {
  id: string
  display_name: string
  role: 'admin' | 'user'
  created_at: string
  book_count: number
}

// 管理：创建/修改用户
export interface AdminUserRequest {
  display_name: string
  password?: string
}
