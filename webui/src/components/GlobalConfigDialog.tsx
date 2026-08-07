import { useState, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Combobox } from '@/components/ui/combobox'
import { config } from '@/lib/api'
import { useAppStore } from '@/stores/app'
import { Loader2, Settings2, PlugZap, CheckCircle2, RefreshCw } from 'lucide-react'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function GlobalConfigDialog({ open, onOpenChange }: Props) {
  const { toast } = useAppStore()
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [thinking, setThinking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelSource, setModelSource] = useState<'live' | 'preset' | ''>('')

  const { data: presets } = useQuery({ queryKey: ['presets'], queryFn: config.presets, enabled: open })

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

  const loadModels = useCallback(async (p: string, base: string, key: string) => {
    if (!p) { setModels([]); setModelSource(''); return }
    setModelsLoading(true)
    try {
      const r = await config.providerModels({ provider: p, base_url: base, api_key: key })
      setModels(r.models)
      setModelSource(r.source)
    } catch {
      setModels([])
      setModelSource('')
    } finally {
      setModelsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || !provider) return
    const t = setTimeout(() => loadModels(provider, baseUrl, apiKey), 400)
    return () => clearTimeout(t)
  }, [open, provider, baseUrl, apiKey, loadModels])

  const onProviderChange = (v: string | null) => {
    setProvider(v || '')
    setModel('')
    setTested(false)
    const preset = providerList.find(p => p.name === v)
    if (preset?.base_url) setBaseUrl(preset.base_url)
  }

  const test = async () => {
    if (!provider || !model) { toast('请先选择 Provider 与模型', 'error'); return }
    setTesting(true)
    setTested(false)
    try {
      const r = await config.providerTest({ provider, model, base_url: baseUrl, api_key: apiKey })
      toast(r.message || '连接成功', 'success')
      setTested(true)
    } catch (e: any) {
      toast(e.message || '连接测试失败', 'error')
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    if (!provider || !model) { toast('请先选择 Provider 与模型', 'error'); return }
    setSaving(true)
    try {
      await config.updateGlobalConfig({ provider, model, api_key: apiKey, base_url: baseUrl, thinking, validate: true })
      toast('全局配置已保存并验证通过', 'success')
      onOpenChange(false)
    } catch (e: any) {
      toast(`保存失败：${e.message}`, 'error')
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
            配置模型 Provider 与 API Key（每个账号独立保存）。保存时会自动测试连接以确保配置可用。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={onProviderChange}>
              <SelectTrigger className="w-full"><SelectValue placeholder="选择 Provider（如 OpenRouter）" /></SelectTrigger>
              <SelectContent>
                {providerList.map((p) => (
                  <SelectItem key={p.name} value={p.name}>{p.label || p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>模型</Label>
              <button
                type="button"
                onClick={() => loadModels(provider, baseUrl, apiKey)}
                disabled={!provider || modelsLoading}
                className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 disabled:opacity-50"
              >
                <RefreshCw className={`h-3 w-3 ${modelsLoading ? 'animate-spin' : ''}`} />刷新
              </button>
            </div>
            <Combobox
              value={model}
              onChange={(v) => { setModel(v); setTested(false) }}
              options={models}
              loading={modelsLoading}
              disabled={!provider}
              placeholder={provider ? '选择或输入模型名' : '请先选择 Provider'}
              emptyText="无候选，可直接输入模型名"
            />
            <p className="text-[11px] text-muted-foreground">
              {modelSource === 'live' ? '已从 Provider 实时拉取可用模型' : '列表为内置常用模型，可直接输入列表外的自定义模型名'}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="apikey">API Key</Label>
            <Input id="apikey" type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setTested(false) }} placeholder="sk-..." autoComplete="off" className="h-10" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="baseurl">Base URL（可选，默认 Provider 官方地址）</Label>
            <Input id="baseurl" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setTested(false) }} placeholder="https://..." className="h-10" />
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="thinking">思考模式（模型支持时启用）</Label>
            <Switch id="thinking" checked={thinking} onCheckedChange={setThinking} />
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={test} disabled={testing || !loaded || !provider || !model} className="flex-1">
              {testing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : tested ? <CheckCircle2 className="h-4 w-4 mr-2 text-primary" /> : <PlugZap className="h-4 w-4 mr-2" />}
              测试连接
            </Button>
            <Button onClick={save} disabled={saving || !loaded || !provider || !model} className="flex-1">
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}保存配置
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
