import { create } from 'zustand'
import { api, ApiError } from '@/lib/api'
import type { AuthStatus } from '@/types'

interface AuthState {
  status: AuthStatus | null
  loading: boolean
  error: string | null

  checkStatus: () => Promise<void>
  login: (password: string) => Promise<void>
  setupAuth: (displayName: string, password: string) => Promise<void>
  logout: () => Promise<void>
  clearError: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  status: null,
  loading: false,
  error: null,

  async checkStatus() {
    set({ loading: true, error: null })
    try {
      const status = await api.authStatus()
      set({ status, loading: false })
    } catch {
      // 网络错误时保留旧 status，不重置 configured/logged_in（防止死循环跳转）
      set({ loading: false })
    }
  },

  async login(password: string) {
    set({ loading: true, error: null })
    try {
      const status = await api.login({ password })
      set({ status, loading: false })
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status === 429 ? '登录过于频繁，请稍候' : e.message}` : '登录失败'
      set({ error: msg, loading: false })
      throw e
    }
  },

  async setupAuth(displayName: string, password: string) {
    set({ loading: true, error: null })
    try {
      const status = await api.setupAuth({ display_name: displayName, password })
      set({ status, loading: false })
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '设置失败'
      set({ error: msg, loading: false })
      throw e
    }
  },

  async logout() {
    set({ loading: true })
    try {
      await api.logout()
    } catch { /* ignore */ }
    set({ status: { configured: true, logged_in: false }, loading: false, error: null })
  },

  clearError() {
    set({ error: null })
  },
}))
