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

  const { data: presets } = useQuery({ queryKey: ['presets'], queryFn: config.presets, enabled: open })
  const { data: modelData } = useQuery({ queryKey: ['models'], queryFn: config.models, enabled: open })

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

  const providerList = presets?.presets || []
  const models = provider ? modelData?.models?.[provider] || [] : []
  const datalistId = `gcfg-models-${provider || 'none'}`

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
            <Select value={provider} onValueChange={(v) => {
              setProvider(v || '')
              setModel('')
              // 自动填入预设 base_url（保持可编辑）
              const preset = providerList.find(p => p.name === v)
              if (preset?.base_url) setBaseUrl(preset.base_url)
            }}>
              <SelectTrigger className="w-full"><SelectValue placeholder="选择 Provider（如 OpenRouter）" /></SelectTrigger>
              <SelectContent>
                {providerList.map((p) => (
                  <SelectItem key={p.name} value={p.name}>{p.label || p.name}</SelectItem>
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
            <p className="text-[11px] text-muted-foreground">可从常用模型中选择，也可直接输入模型名称（如列表外的自定义模型）</p>
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
