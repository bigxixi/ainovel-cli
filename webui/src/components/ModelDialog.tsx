import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { config } from '@/lib/api'
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

  const { data: modelData } = useQuery({ queryKey: ['models'], queryFn: config.models, enabled: open })

  useEffect(() => {
    if (open) {
      setProvider(currentProvider || '')
      setModel(currentModel || '')
    }
  }, [open, currentProvider, currentModel])

  const providers = Object.keys(modelData?.models || {})
  const models = provider ? modelData?.models?.[provider] || [] : []
  const datalistId = `mdl-models-${provider || 'none'}`

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
            <Label htmlFor="model">模型</Label>
            <Input
              id="model"
              list={datalistId}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={provider ? '选择或直接输入模型名' : '请先选择 Provider'}
              className="h-10"
            />
            {models.length > 0 && (
              <datalist id={datalistId}>
                {models.map(m => <option key={m} value={m} />)}
              </datalist>
            )}
            <p className="text-[11px] text-muted-foreground">可从常用模型中选择，也可直接输入模型名称</p>
          </div>
          <Button onClick={save} disabled={saving || !provider || !model} className="w-full">
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}应用
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
