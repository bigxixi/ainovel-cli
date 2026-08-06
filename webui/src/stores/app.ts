import { create } from 'zustand'
import { toast as sonnerToast } from 'sonner'

export type View = 'shelf' | 'workspace' | 'admin'

interface AppState {
  view: View
  currentBookId: string | null
  configDialogOpen: boolean

  navigate: (view: View, bookId?: string) => void
  toast: (message: string, type?: 'info' | 'error' | 'success') => void
  openConfigDialog: () => void
  closeConfigDialog: () => void
}

export const useAppStore = create<AppState>((set) => ({
  view: 'shelf',
  currentBookId: null,
  configDialogOpen: false,

  navigate(view: View, bookId?: string) {
    set({ view, currentBookId: bookId || null })
  },

  toast(message: string, type: 'info' | 'error' | 'success' = 'info') {
    sonnerToast[type](message)
  },

  openConfigDialog() {
    set({ configDialogOpen: true })
  },

  closeConfigDialog() {
    set({ configDialogOpen: false })
  },
}))
