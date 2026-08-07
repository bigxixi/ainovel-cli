import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { cocreate } from '@/lib/api'
import { useAppStore } from '@/stores/app'
import { Send, Loader2, Check, X, Sparkles } from 'lucide-react'
import type { CoCreateMessage } from '@/types'

interface Props {
  bookId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

// 共创规划：左栏对话流 + 右栏思考/草稿/建议，确认后 apply 启动引擎
export function CoCreateDialog({ bookId, open, onOpenChange }: Props) {
  const { toast } = useAppStore()
  const navigate = useNavigate()
  const [messages, setMessages] = useState<CoCreateMessage[]>([
    { role: 'assistant', content: '你好！我是共创规划助手。告诉我你想写什么样的故事，我会和你一起把创作指令整理成型。' },
  ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [thinking, setThinking] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [applying, setApplying] = useState(false)
  const chatEnd = useRef<HTMLDivElement>(null)

  const scrollBottom = () => setTimeout(() => chatEnd.current?.scrollIntoView({ behavior: 'smooth' }), 50)

  // 发送一轮对话（流式接收）
  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    setThinking('思考中…')
    setSuggestions([])
    const history = [...messages, { role: 'user' as const, content: text }]
    setMessages(history)
    setDraft('')
    scrollBottom()

    let reply = ''
    let replyThinking = ''
    let replySuggestions: string[] = []
    let replyDraft = ''
    try {
      for await (const ev of cocreate.chat(bookId, history)) {
        if (ev.thinking !== undefined) { replyThinking = ev.thinking; setThinking(ev.thinking) }
        if (ev.draft !== undefined) { replyDraft = ev.draft; setDraft(ev.draft); scrollBottom() }
        if (ev.content) { reply += ev.content; scrollBottom() }
        if (ev.suggestions?.length) { replySuggestions = [...replySuggestions, ...ev.suggestions]; setSuggestions(replySuggestions) }
      }
      void replyThinking
      setMessages([...history, { role: 'assistant', content: reply || '（本轮未生成内容）' }])
      setThinking('')
    } catch (e: any) {
      toast(`对话失败: ${e.message}`, 'error')
      setMessages(history)
    } finally {
      setBusy(false)
      setThinking('')
    }
  }, [bookId, input, busy, messages, toast])

  const apply = async () => {
    const finalDraft = draft.trim()
    if (!finalDraft) {
      toast('还没有可用的创作指令草稿，请先与助手对话生成草稿', 'error')
      return
    }
    setApplying(true)
    try {
      await cocreate.apply(bookId, finalDraft)
      toast('共创完成，开始创作', 'success')
      onOpenChange(false)
      navigate(`/book/${bookId}`)
    } catch (e: any) {
      toast(`应用失败: ${e.message}`, 'error')
    } finally {
      setApplying(false)
    }
  }

  const cancel = async () => {
    try { await cocreate.cancel(bookId) } catch { /* ignore */ }
    onOpenChange(false)
  }

  useEffect(() => { scrollBottom() }, [messages, busy])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) cancel() }}>
      <DialogContent className="sm:max-w-[min(1600px,95vw)] w-[95vw]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm"><Sparkles className="h-4 w-4 text-primary" />共创规划</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 h-[min(70vh,560px)] min-h-0">
          {/* 左：对话流 */}
          <div className="flex flex-col border rounded-lg min-h-0 overflow-hidden">
            <div className="px-3 py-1.5 border-b text-[11px] font-medium text-muted-foreground shrink-0">对话</div>
            <ScrollArea className="flex-1 min-h-0 p-3">
              <div className="space-y-2.5">
                {messages.map((m, i) => (
                  <div key={i} className={`max-w-[85%] rounded-lg px-2.5 py-2 text-[13px] leading-relaxed text-left whitespace-pre-wrap break-words ${m.role === 'user' ? 'bg-primary text-primary-foreground ml-auto' : 'bg-muted text-foreground'}`}>
                    {m.content}
                  </div>
                ))}
                {busy && <div className="max-w-[85%] rounded-lg px-2.5 py-2 text-[13px] bg-muted text-left"><Loader2 className="h-3 w-3 animate-spin inline mr-1" />思考中…</div>}
                <div ref={chatEnd} />
              </div>
            </ScrollArea>
            <div className="p-2 border-t flex gap-2 shrink-0">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                placeholder="描述你的故事想法…"
                className="min-h-[48px] max-h-24 text-[13px] resize-none"
                disabled={busy}
              />
              <Button size="icon" onClick={send} disabled={busy || !input.trim()} className="shrink-0"><Send className="h-4 w-4" /></Button>
            </div>
          </div>

          {/* 右：思考 + 草稿 + 建议 */}
          <div className="flex flex-col border rounded-lg min-h-0 overflow-hidden">
            <div className="px-3 py-1.5 border-b text-[11px] font-medium text-muted-foreground shrink-0">创作指令草稿</div>
            <ScrollArea className="flex-1 min-h-0 p-3">
              {thinking && <p className="text-[11px] text-muted-foreground italic mb-2">💭 {thinking}</p>}
              <div className="text-[13px] leading-relaxed text-foreground whitespace-pre-wrap break-words text-left">
                {draft || <span className="text-muted-foreground italic">AI 正在整理你的创作指令…</span>}
              </div>
              {suggestions.length > 0 && (
                <div className="mt-3">
                  <p className="text-[11px] font-medium text-muted-foreground mb-1.5">建议补充：</p>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((s, i) => (
                      <Badge key={i} variant="secondary" className="cursor-pointer text-[11px]"
                        onClick={() => { setInput(prev => (prev ? prev + ' ' : '') + s) }}>
                        {s}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </ScrollArea>
            <div className="p-2 border-t flex gap-2 shrink-0">
              <Button variant="outline" size="sm" className="flex-1 min-w-0" onClick={cancel} disabled={busy}>
                <X className="h-3 w-3 mr-1 shrink-0" /><span className="truncate">取消</span>
              </Button>
              <Button size="sm" className="flex-1 min-w-0" onClick={apply} disabled={applying || busy}>
                {applying ? <Loader2 className="h-3 w-3 animate-spin mr-1 shrink-0" /> : <Check className="h-3 w-3 mr-1 shrink-0" />}
                <span className="truncate">{applying ? '启动中…' : '确认并开始创作'}</span>
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
