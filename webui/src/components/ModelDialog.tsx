import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { config, request } from '@/lib/api'
import { useAppStore } from '@/stores/app'
import { Loader2 } from 'lucide-react'

interface Props {
  bookId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  currentProvider?: string
  currentModel?: string
}

// 模型切换：从 Provider 预设加载模型列表，切换当前书的模型
export function ModelDialog({ bookId, open, onOpenChange, currentProvider, currentModel }: Props) {
  const { toast } = useAppStore()
  const [provider, setProvider] = useState(currentProvider || '')
  const [model, setModel] = useState(currentModel || '')
  const [saving, setSaving] = useState(false)

  const { data: bookModels } = useQuery({
    queryKey: ['bookModels', bookId],
    queryFn: () => request<{ providers: string[]; models: Record<string, string[]> }>(`/books/${bookId}/models`),
    enabled: open,
  })

  useEffect(() => {
    if (open) {
      setProvider(currentProvider || '')
      setModel(currentModel || '')
    }
  }, [open, currentProvider, currentModel])

  const providers = bookModels?.providers || []
  const models = provider ? bookModels?.models?.[provider] || [] : []

  const save = async () => {
    if (!provider || !model) return
    setSaving(true)
    try {
      await config.switchModel(bookId, provider, model)
      toast(`已切换模型: ${provider}/${model}`, 'success')
      onOpenChange(false)
    } catch (e: any) {
      toast(`切换失败: ${e.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>切换模型</DialogTitle></DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={(v) => { setProvider(v || ''); setModel('') }}>
              <SelectTrigger className="w-full"><SelectValue placeholder="选择 Provider" /></SelectTrigger>
              <SelectContent>
                {providers.map(p => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>模型</Label>
            <Select value={model} onValueChange={(v) => setModel(v || '')} disabled={!provider}>
              <SelectTrigger className="w-full"><SelectValue placeholder={provider ? '选择模型' : '请先选择 Provider'} /></SelectTrigger>
              <SelectContent>
                {models.map(m => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={save} disabled={saving || !provider || !model} className="w-full">
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}应用
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
