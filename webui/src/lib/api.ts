import type {
  AuthStatus, BookMeta, Snapshot, StreamEvent,
  LoginRequest, SetupAuthRequest, ProfileConfig,
  CreateBookRequest, TextRequest, ModeRequest,
  ImportRequest, ExportRequest, CoCreateRequest,
  CoCreateMessage, UserInfo, AdminUserRequest,
  DiagInfo, ProviderPreset,
} from '@/types'

const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try { msg = JSON.parse(text).error || text } catch { /* raw */ }
    throw new ApiError(res.status, msg)
  }
  try { return JSON.parse(text) as T } catch { return text as unknown as T }
}

// 不上传 JSON Content-Type（multipart 时）
async function requestRaw<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include', ...init })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try { msg = JSON.parse(text).error || text } catch { }
    throw new ApiError(res.status, msg)
  }
  try { return JSON.parse(text) as T } catch { return text as unknown as T }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

// ---------- 认证 ----------
export const api = {
  health: () => request<{ ok: boolean; setup: boolean; auth: boolean }>('/health'),

  authStatus: () => request<AuthStatus>('/auth-status'),

  setupAuth: (req: SetupAuthRequest) =>
    request<AuthStatus>('/setup-auth', { method: 'POST', body: JSON.stringify(req) }),

  login: (req: LoginRequest) =>
    request<AuthStatus>('/login', { method: 'POST', body: JSON.stringify(req) }),

  logout: () => requestRaw<{ ok: boolean }>('/logout', { method: 'POST' }),

  deleteAccount: (password: string) =>
    requestRaw<{ ok: boolean }>('/account', { method: 'DELETE', body: JSON.stringify({ password }) }),
}

// ---------- 书架 ----------
export const books = {
  list: () => request<{ books: BookMeta[] }>('/books').then(r => r.books),

  get: (id: string) => request<Snapshot>(`/books/${id}`),

  create: (req: CreateBookRequest) =>
    request<{ book: BookMeta; starting: boolean }>('/books', { method: 'POST', body: JSON.stringify(req) })
      .then(r => ({ ...r.book, starting: r.starting })),

  delete: (id: string, keepCompleted?: boolean) =>
    request<{ ok: boolean; kept?: boolean }>(`/books/${id}?keep_completed=${keepCompleted ? 1 : 0}`, { method: 'DELETE' }),
}

// ---------- 运行控制 ----------
export const controls = {
  continue: (bookId: string, text: string) =>
    request<{ ok: boolean }>(`/books/${bookId}/continue`, { method: 'POST', body: JSON.stringify({ text }) }),

  steer: (bookId: string, text: string) =>
    request<{ ok: boolean }>(`/books/${bookId}/steer`, { method: 'POST', body: JSON.stringify({ text }) }),

  abort: (bookId: string) =>
    request<{ ok: boolean }>(`/books/${bookId}/abort`, { method: 'POST' }),

  resume: (bookId: string) =>
    request<{ ok: boolean }>(`/books/${bookId}/resume`, { method: 'POST' }),

  advance: (bookId: string) =>
    request<{ ok: boolean }>(`/books/${bookId}/advance`, { method: 'POST' }),

  advanceMode: (bookId: string, mode: string) =>
    request<{ ok: boolean }>(`/books/${bookId}/advance-mode`, { method: 'POST', body: JSON.stringify({ mode }) }),

  reopen: (bookId: string, direction?: string) =>
    request<{ ok: boolean }>(`/books/${bookId}/reopen`, { method: 'POST', body: JSON.stringify({ direction }) }),
}

// ---------- 导入/仿写/导出 ----------
export const tools = {
  importBook: (bookId: string, bodyOrForm: ImportRequest | FormData) =>
    bodyOrForm instanceof FormData
      ? requestRaw<{ ok: boolean; status: string }>(`/books/${bookId}/import`, { method: 'POST', body: bodyOrForm })
      : request<{ ok: boolean; status: string }>(`/books/${bookId}/import`, { method: 'POST', body: JSON.stringify(bodyOrForm) }),

  simulate: (bookId: string, text: string) =>
    request<{ ok: boolean; stream_url: string }>(`/books/${bookId}/simulate`, { method: 'POST', body: JSON.stringify({ text }) }),

  importsim: (bookId: string, text: string) =>
    request<{ ok: boolean; stream_url: string }>(`/books/${bookId}/importsim`, { method: 'POST', body: JSON.stringify({ text }) }),

  cancelAux: (bookId: string) =>
    request<{ ok: boolean }>(`/books/${bookId}/import/cancel`, { method: 'POST' }),

  export_: (bookId: string, req?: ExportRequest) =>
    request<{ ok: boolean; file: string; url: string }>(`/books/${bookId}/export`, { method: 'POST', body: JSON.stringify(req || {}) }),

  exportURL: (bookId: string, file: string) =>
    `${BASE}/books/${bookId}/export-file?name=${encodeURIComponent(file)}`,
}

// ---------- 共创 ----------
export const cocreate = {
  chat: (bookId: string, messages: CoCreateMessage[]): AsyncGenerator<CoCreateMessage> => {
    const url = `${BASE}/books/${bookId}/cocreate`
    const iter = sseStream(url, { method: 'POST', body: JSON.stringify({ messages }) })
    return (async function* () {
      for await (const ev of iter) {
        if (ev.event === 'delta') {
          yield { role: 'assistant', content: ev.data }
        } else if (ev.event === 'thinking') {
          yield { role: 'assistant', content: '', thinking: ev.data }
        } else if (ev.event === 'suggestion') {
          yield { role: 'assistant', content: '', suggestions: [ev.data] }
        } else if (ev.event === 'done') {
          return
        } else if (ev.event === 'error') {
          throw new ApiError(500, ev.data)
        }
      }
    })()
  },

  apply: (bookId: string) =>
    request<{ ok: boolean }>(`/books/${bookId}/cocreate/apply`, { method: 'POST' }),

  cancel: (bookId: string) =>
    request<{ ok: boolean }>(`/books/${bookId}/cocreate/cancel`, { method: 'POST' }),
}

// ---------- 模型/配置 ----------
export const config = {
  switchModel: (bookId: string, provider: string, model: string) =>
    request<{ ok: boolean }>(`/books/${bookId}/switch-model`, { method: 'POST', body: JSON.stringify({ provider, model }) }),

  setThinking: (bookId: string, on: boolean) =>
    request<{ ok: boolean }>(`/books/${bookId}/set-thinking`, { method: 'POST', body: JSON.stringify({ thinking: on }) }),

  diag: () => request<DiagInfo>('/diag'),

  presets: () => request<Record<string, ProviderPreset>>('/setup/presets'),

  globalConfig: () => request<ProfileConfig>('/profile/config'),

  updateGlobalConfig: (cfg: ProfileConfig) =>
    request<ProfileConfig>('/profile/config', { method: 'POST', body: JSON.stringify(cfg) }),

  profile: () => request<{ display_name: string; role: string; created_at: string; provider: string; model: string }>('/profile'),

  updateProfile: (cfg: ProfileConfig) =>
    request<{ ok: boolean }>('/profile', { method: 'PUT', body: JSON.stringify(cfg) }),

  globalSetupPresets: () => request<Record<string, ProviderPreset>>('/setup/presets'),

  globalSetupSave: (cfg: Record<string, unknown>) =>
    request<{ ok: boolean }>('/setup', { method: 'POST', body: JSON.stringify(cfg) }),

  // 管理
  adminUsers: () => request<UserInfo[]>('/admin/users'),

  adminCreateUser: (req: AdminUserRequest) =>
    request<UserInfo>('/admin/users', { method: 'POST', body: JSON.stringify(req) }),

  adminUpdateUser: (id: string, req: AdminUserRequest) =>
    request<UserInfo>(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(req) }),

  adminDeleteUser: (id: string) =>
    request<{ ok: boolean }>(`/admin/users/${id}`, { method: 'DELETE' }),
}

// ---------- SSE 工具 ----------
interface SSERawEvent {
  event: string
  data: string
}

async function* sseStream(url: string, init?: RequestInit): AsyncGenerator<SSERawEvent> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    ...init,
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
  if (!res.body) throw new ApiError(500, 'No response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let currentEvent = 'message'

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    const lines = buf.split('\n')
    buf = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7)
      } else if (line.startsWith('data: ')) {
        yield { event: currentEvent, data: line.slice(6) }
      } else if (line === '') {
        currentEvent = 'message'
      }
    }
  }
}

// 导出 SSE 流用于事件流连接
export function connectBookStream(bookId: string): AsyncGenerator<StreamEvent & { type: 'event' | 'delta' | 'done' | 'clear' }> {
  const url = `${BASE}/books/${bookId}/stream`
  const iter = sseStream(url)
  return (async function* () {
    for await (const ev of iter) {
      if (ev.event === 'event') {
        try { yield { type: 'event', ...JSON.parse(ev.data) } } catch { /* skip */ }
      } else if (ev.event === 'delta') {
        yield { type: 'delta', time: '', category: '', summary: ev.data }
      } else if (ev.event === 'clear') {
        yield { type: 'clear', time: '', category: '', summary: '' }
      } else if (ev.event === 'done') {
        yield { type: 'done', time: '', category: '', summary: '' }
      }
    }
  })()
}
