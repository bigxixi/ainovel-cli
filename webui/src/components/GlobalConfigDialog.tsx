import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { config } from '@/lib/api'
import { useAppStore } from '@/stores/app'
import { Loader2, Settings2 } from 'lucide-react'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// 全局配置：Provider / API Key / Base URL / 模型（保存到用户自己的 user_config，多用户隔离）
export function GlobalConfigDialog({ open, onOpenChange }: Props) {
  const { toast } = useAppStore()
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [thinking, setThinking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const { data: presets } = useQuery({ queryKey: ['presets'], queryFn: config.globalSetupPresets, enabled: open })

  // 打开时加载当前用户配置
  useEffect(() => {
    if (!open) return
    setLoaded(false)
    config.globalConfig()
      .then((c: any) => {
        setProvider(c.provider || '')
        setModel(c.model || '')
        setApiKey(c.api_key || '')
        setBaseUrl(c.base_url || '')
        setThinking(!!c.thinking)
      })
      .catch(() => { /* 首次无配置 */ })
      .finally(() => setLoaded(true))
  }, [open])

  const models = provider ? presets?.[provider]?.models || [] : []

  const save = async () => {
    setSaving(true)
    try {
      await config.updateGlobalConfig({ provider, model, api_key: apiKey, base_url: baseUrl, thinking })
      toast('全局配置已保存', 'success')
      onOpenChange(false)
    } catch (e: any) {
      toast(`保存失败: ${e.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-primary" />全局设置
          </DialogTitle>
          <DialogDescription>
            配置模型 Provider 与 API Key（每个账号独立保存）。未配置时新建小说会提示 503。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={(v) => { setProvider(v || ''); setModel('') }}>
              <SelectTrigger className="w-full"><SelectValue placeholder="选择 Provider（如 OpenRouter）" /></SelectTrigger>
              <SelectContent>
                {Object.values(presets || {}).map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>模型</Label>
            <Select value={model} onValueChange={(v) => setModel(v || '')} disabled={!provider}>
              <SelectTrigger className="w-full"><SelectValue placeholder={provider ? '选择模型' : '请先选择 Provider'} /></SelectTrigger>
              <SelectContent>
                {models.map((m: any) => (
                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="apikey">API Key</Label>
            <Input id="apikey" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." autoComplete="off" className="h-10" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="baseurl">Base URL（可选，默认 Provider 官方地址）</Label>
            <Input id="baseurl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://..." className="h-10" />
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="thinking">思考模式（模型支持时启用）</Label>
            <Switch id="thinking" checked={thinking} onCheckedChange={setThinking} />
          </div>

          <Button onClick={save} disabled={saving || !loaded || !provider || !model} className="w-full">
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}保存配置
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
