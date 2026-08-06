import { create } from 'zustand'

export type View = 'shelf' | 'workspace' | 'admin'

interface AppState {
  view: View
  currentBookId: string | null
  toaster: { message: string; type: 'info' | 'error' | 'success' } | null
  configDialogOpen: boolean

  navigate: (view: View, bookId?: string) => void
  toast: (message: string, type?: 'info' | 'error' | 'success') => void
  openConfigDialog: () => void
  closeConfigDialog: () => void
}

export const useAppStore = create<AppState>((set) => ({
  view: 'shelf',
  currentBookId: null,
  toaster: null,
  configDialogOpen: false,

  navigate(view: View, bookId?: string) {
    set({ view, currentBookId: bookId || null })
  },

  toast(message: string, type: 'info' | 'error' | 'success' = 'info') {
    set({ toaster: { message, type } })
    setTimeout(() => set({ toaster: null }), 4000)
  },

  openConfigDialog() {
    set({ configDialogOpen: true })
  },

  closeConfigDialog() {
    set({ configDialogOpen: false })
  },
}))
