import { create } from 'zustand'

export type View = 'shelf' | 'workspace' | 'admin'

interface AppState {
  view: View
  currentBookId: string | null
  toaster: { message: string; type: 'info' | 'error' | 'success' } | null

  navigate: (view: View, bookId?: string) => void
  toast: (message: string, type?: 'info' | 'error' | 'success') => void
}

export const useAppStore = create<AppState>((set) => ({
  view: 'shelf',
  currentBookId: null,
  toaster: null,

  navigate(view: View, bookId?: string) {
    set({ view, currentBookId: bookId || null })
  },

  toast(message: string, type: 'info' | 'error' | 'success' = 'info') {
    set({ toaster: { message, type } })
    setTimeout(() => set({ toaster: null }), 4000)
  },
}))
