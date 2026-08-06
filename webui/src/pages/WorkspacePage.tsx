import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { books, controls, config, tools, connectBookStream } from '@/lib/api'
import { useAppStore } from '@/stores/app'
import { ImportDialog } from '@/components/ImportDialog'
import { ModelDialog } from '@/components/ModelDialog'
import {
  ArrowLeft, Send, Square, Play, SkipForward, Loader2, Zap, ZapOff,
  PanelRightClose, PanelRightOpen, ChevronDown, ChevronUp, ArrowDownToLine,
  CheckCircle2, RefreshCw, RotateCcw, ListChecks, Sparkles, BookDown, UploadCloud, Cpu,
} from 'lucide-react'
import type { Snapshot, StreamEvent } from '@/types'

// 输出块：段落级文本（虚拟滚动最小单元）
interface Block {
  id: number
  kind: 'text' | 'chapter' | 'error'
  text: string
}

// TUI 命令按钮定义
const COMMANDS = [
  { name: '/review', label: '逐章验收', icon: ListChecks, desc: '开启逐章验收，/next 放行新章节' },
  { name: '/auto', label: '全自动', icon: Sparkles, desc: '恢复全自动创作' },
  { name: '/next', label: '放行下一章', icon: SkipForward, desc: '验收模式下放行下一章' },
  { name: '/abort', label: '暂停', icon: Square, desc: '暂停当前创作' },
  { name: '/resume', label: '恢复', icon: Play, desc: '恢复暂停的创作' },
  { name: '/reopen', label: '重开', icon: RotateCcw, desc: '重开当前章节' },
  { name: '/think-on', label: '思考开', icon: Zap, desc: '开启思考模式' },
  { name: '/think-off', label: '思考关', icon: ZapOff, desc: '关闭思考模式' },
] as const

export function WorkspacePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useAppStore()
  const [input, setInput] = useState('')
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [blocks, setBlocks] = useState<Block[]>([])
  const [detailOpen, setDetailOpen] = useState(true)
  const [eventsOpen, setEventsOpen] = useState(true)
  const [followScroll, setFollowScroll] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const eventsEnd = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const blockId = useRef(0)
  const pendingDelta = useRef('')
  const rafPending = useRef(false)

  const { data: snap, isLoading, refetch } = useQuery({
    queryKey: ['snapshot', id],
    queryFn: () => books.get(id!),
    enabled: !!id,
    refetchInterval: 5000,
  })

  // 追加输出块（rAF 节流，按行切块）
  const pushDelta = useCallback((text: string) => {
    pendingDelta.current += text
    if (rafPending.current) return
    rafPending.current = true
    requestAnimationFrame(() => {
      rafPending.current = false
      const raw = pendingDelta.current
      pendingDelta.current = ''
      if (!raw) return
      setBlocks(prev => {
        const lines = raw.split(/(?<=\n)/)
        const next = [...prev]
        for (const line of lines) {
          const trimmed = line.trimEnd()
          if (!trimmed) continue
          if (/^第[0-9一二三四五六七八九十百千]+章/.test(trimmed)) {
            next.push({ id: ++blockId.current, kind: 'chapter', text: trimmed })
          } else {
            const last = next[next.length - 1]
            if (last && last.kind === 'text' && last.text.length < 2000) {
              next[next.length - 1] = { ...last, text: last.text + trimmed }
            } else {
              next.push({ id: ++blockId.current, kind: 'text', text: trimmed })
            }
          }
        }
        return next
      })
    })
  }, [])

  // SSE 连接
  useEffect(() => {
    if (!id) return
    let running = true
    const connect = async () => {
      try {
        const stream = connectBookStream(id)
        for await (const ev of stream) {
          if (!running) break
          if (ev.type === 'event') {
            setEvents(prev => [...prev, ev as StreamEvent])
            setTimeout(() => eventsEnd.current?.scrollIntoView({ behavior: 'smooth' }), 50)
          } else if (ev.type === 'delta') {
            pushDelta((ev as unknown as { summary: string }).summary)
          } else if (ev.type === 'clear') {
            setBlocks([])
          } else if (ev.type === 'done') {
            refetch()
          }
        }
      } catch {
        if (running) setTimeout(connect, 3000)
      }
    }
    connect()
    return () => { running = false }
  }, [id, refetch, pushDelta])

  // 自动滚动跟随（用户上滚时暂停）
  const onScroll = useCallback(() => {
    const el = outputRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    setFollowScroll(nearBottom)
  }, [])

  useEffect(() => {
    const el = outputRef.current
    if (el && followScroll) {
      el.scrollTop = el.scrollHeight
    }
  }, [blocks, followScroll])

  // 虚拟滚动
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => outputRef.current,
    estimateSize: (i) => {
      const b = blocks[i]
      if (!b) return 40
      return Math.ceil(b.text.length / 42) * 24 + 8
    },
    overscan: 8,
  })

  const totalChars = blocks.reduce((s, b) => s + b.text.length, 0)

  // 执行命令
  const runCommand = useCallback(async (cmd: string) => {
    if (!id) return
    const parts = cmd.slice(1).split(/\s+/)
    const cmdName = parts[0]
    try {
      if (cmdName === 'review') await controls.advanceMode(id, 'review')
      else if (cmdName === 'auto') await controls.advanceMode(id, 'auto')
      else if (cmdName === 'next') await controls.advance(id)
      else if (cmdName === 'abort') await controls.abort(id)
      else if (cmdName === 'resume') await controls.resume(id)
      else if (cmdName === 'reopen') await controls.reopen(id)
      else if (cmdName === 'think-on') await config.setThinking(id, true)
      else if (cmdName === 'think-off') await config.setThinking(id, false)
      else if (cmdName === 'export') {
        setExporting(true)
        const res = await tools.export_(id)
        window.open(tools.exportURL(id, res.file), '_blank')
        setExporting(false)
      } else {
        toast(`未知命令: ${cmdName}`, 'error')
        return
      }
      toast(`已执行 /${cmdName}`, 'success')
      setTimeout(() => refetch(), 800)
    } catch (e: any) {
      toast(`命令失败: ${e.message}`, 'error')
    }
  }, [id, refetch, toast])

  // 输入框提交：/ 开头走命令，否则文本干预/继续
  const send = useCallback(async (text: string) => {
    if (!id || !text.trim()) return
    if (text.startsWith('/')) {
      await runCommand(text.trim())
    } else {
      try {
        if (snap?.runtime_state === 'running') {
          await controls.steer(id, text.trim())
        } else {
          await controls.continue(id, text.trim())
        }
        toast('已发送')
      } catch (e: any) {
        toast(`发送失败: ${e.message}`, 'error')
      }
    }
    setInput('')
  }, [id, snap, controls, toast, runCommand])

  const phaseLabel = (p?: string) => {
    const map: Record<string, string> = { init: '初始化', waiting: '等待', plan: '规划中', writing: '写作中', review: '验收中', edit: '编辑中', complete: '已完成', '': '空闲' }
    return map[p || ''] || p || '未知'
  }

  const running = snap?.runtime_state === 'running'

  if (isLoading) return <div className="p-6"><Skeleton className="h-96 w-full" /></div>
  if (!snap) return <div className="p-6 text-muted-foreground">小说不存在或无权访问</div>

  return (
    <div className="flex flex-col h-[calc(100vh)]">
      {/* 顶部信息栏 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-card shrink-0">
        <Button variant="ghost" size="icon" onClick={() => navigate('/shelf')} title="返回书架">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Badge variant={running ? 'default' : 'secondary'}>{running ? '运行中' : snap.runtime_state === 'paused' ? '已暂停' : '空闲'}</Badge>
          <Badge variant="outline">{phaseLabel(snap.phase)}</Badge>
          <Badge variant="outline">{snap.provider || '-'}/{snap.model || '-'}</Badge>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            第 {snap.chapter}/{snap.total_chapters || '?'} 章 · {snap.completed_count} 完成 · {totalChars.toLocaleString()} 字
          </span>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setDetailOpen(!detailOpen)} title="详情面板">
          {detailOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 主区：输出 + 事件流 */}
        <div className="flex-1 flex flex-col min-w-0 bg-card/40">
          {/* 输出区（虚拟滚动） */}
          <div className="relative flex-1 flex flex-col min-h-0">
            <div className="flex items-center gap-2 px-4 py-1.5 border-b bg-background/60 shrink-0">
              <span className="text-xs font-medium text-muted-foreground">输出</span>
              <span className="text-xs text-muted-foreground">{blocks.length} 段 · {totalChars.toLocaleString()} 字</span>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => { setFollowScroll(true); outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }) }}>
                <ArrowDownToLine className="h-3 w-3 mr-1" />跳到底部
              </Button>
            </div>
            <div ref={outputRef} onScroll={onScroll} className="flex-1 overflow-auto px-4 py-2">
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                {virtualizer.getVirtualItems().map(vi => {
                  const b = blocks[vi.index]
                  return (
                    <div
                      key={vi.key}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                    >
                      {b.kind === 'chapter' ? (
                        <div className="py-2 mt-2 mb-1 border-b border-dashed text-left">
                          <span className="text-sm font-semibold text-primary">{b.text}</span>
                        </div>
                      ) : b.kind === 'error' ? (
                        <div className="py-1 text-sm text-destructive text-left">{b.text}</div>
                      ) : (
                        <div className="py-1 text-[15px] leading-7 text-foreground whitespace-pre-wrap text-left">{b.text}</div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* 事件流（可折叠） */}
          <div className="border-t bg-background/60 shrink-0">
            <div className="flex items-center gap-2 px-4 py-1 cursor-pointer select-none" onClick={() => setEventsOpen(!eventsOpen)}>
              <span className="text-xs font-medium text-muted-foreground">事件流</span>
              <span className="text-xs text-muted-foreground">{events.length}</span>
              <div className="flex-1" />
              {eventsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
            </div>
            {eventsOpen && (
              <div className="max-h-36 overflow-auto px-4 pb-2 space-y-0.5">
                {events.slice(-80).map((ev, i) => (
                  <div key={i} className="flex gap-2 text-xs text-left">
                    <span className="text-muted-foreground shrink-0 font-mono">{ev.time?.slice(11, 19)}</span>
                    <Badge variant="outline" className="text-[10px] h-4 px-1 shrink-0">{ev.category}</Badge>
                    <span className="truncate text-foreground/80">{ev.summary}</span>
                  </div>
                ))}
                <div ref={eventsEnd} />
              </div>
            )}
          </div>
        </div>

        {/* 右侧上下文栏 */}
        {detailOpen && (
          <div className="w-60 border-l bg-card p-4 shrink-0 overflow-auto hidden sm:block">
            <h3 className="font-semibold text-sm mb-3 text-foreground">详情</h3>
            <dl className="space-y-2 text-xs">
              <DetailItem label="阶段" value={phaseLabel(snap.phase)} />
              <DetailItem label="推进模式" value={snap.advance_mode === 'review' ? '逐章验收' : '全自动'} />
              <DetailItem label="已完成" value={`${snap.completed_count} 章`} />
              <DetailItem label="当前" value={`第 ${snap.chapter} 章`} />
              <DetailItem label="思考模式" value={snap.thinking ? '开' : '关'} />
              <DetailItem label="导入中" value={snap.is_importing ? '是' : '否'} />
              <DetailItem label="仿写中" value={snap.is_simulating ? '是' : '否'} />
            </dl>
            {snap.last_error && (
              <div className="mt-3 p-2 rounded bg-destructive/10 text-destructive text-xs">
                {snap.last_error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部：命令按钮栏 + 输入框 */}
      <div className="border-t bg-card shrink-0">
        {/* TUI 命令按钮栏 */}
        <div className="flex items-center gap-1.5 px-3 py-2 overflow-x-auto">
          {COMMANDS.map(c => (
            <Button
              key={c.name}
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1 shrink-0"
              title={c.desc}
              onClick={() => runCommand(c.name)}
              disabled={c.name === '/abort' ? !running : c.name === '/resume' ? running : false}
            >
              <c.icon className="h-3 w-3" />
              {c.label}
            </Button>
          ))}
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1 shrink-0" title="切换模型" onClick={() => setModelOpen(true)}>
            <Cpu className="h-3 w-3" />
            模型
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1 shrink-0" title="导入外部小说" onClick={() => setImportOpen(true)}>
            <UploadCloud className="h-3 w-3" />
            导入
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1 shrink-0" title="导出小说" onClick={() => runCommand('/export')} disabled={exporting}>
            {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <BookDown className="h-3 w-3" />}
            导出
          </Button>
        </div>
        {/* 输入框 */}
        <div className="px-3 pb-3">
          <div className="flex gap-2 max-w-4xl mx-auto">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
              placeholder="输入 / 命令或创作干预文本，Enter 发送"
              className="h-10 text-left"
            />
            <Button size="icon" onClick={() => send(input)} className="shrink-0"><Send className="h-4 w-4" /></Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5 text-center">
            运行中直接输入为干预建议 · 空闲时输入为继续创作指令 · 支持 /review /auto /next /abort /resume /reopen 等命令
          </p>
        </div>
      </div>

      <ImportDialog bookId={id!} open={importOpen} onOpenChange={setImportOpen} />
      <ModelDialog bookId={id!} open={modelOpen} onOpenChange={setModelOpen} currentProvider={snap?.provider} currentModel={snap?.model} />
    </div>
  )
}

function DetailItem({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="font-medium text-right">{value || '-'}</dd>
    </div>
  )
}
