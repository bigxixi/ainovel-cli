import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { books, controls, config, tools, connectBookStream } from '@/lib/api'
import { useAppStore } from '@/stores/app'
import {
  ArrowLeft, Send, Square, Play, SkipForward, AlertCircle,
  Loader2, Zap, ZapOff, PanelRightClose, PanelRightOpen,
} from 'lucide-react'
import type { Snapshot, StreamEvent } from '@/types'

export function WorkspacePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useAppStore()
  const [input, setInput] = useState('')
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [delta, setDelta] = useState('')
  const [detailOpen, setDetailOpen] = useState(true)
  const eventsEnd = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLDivElement>(null)

  const { data: snap, isLoading, refetch } = useQuery({
    queryKey: ['snapshot', id],
    queryFn: () => books.get(id!),
    enabled: !!id,
    refetchInterval: 5000,
  })

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
            setDelta(prev => prev + (ev as unknown as { summary: string }).summary)
            setTimeout(() => outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' }), 50)
          } else if (ev.type === 'clear') {
            setDelta('')
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
  }, [id, refetch])

  // 发送命令
  const send = useCallback(async (cmd: string) => {
    if (!id || !cmd.trim()) return
    if (cmd.startsWith('/')) {
      const parts = cmd.slice(1).split(/\s+/)
      const cmdName = parts[0]
      const arg = parts.slice(1).join(' ')
      try {
        if (cmdName === 'review') await controls.advanceMode(id, 'review')
        else if (cmdName === 'auto') await controls.advanceMode(id, 'auto')
        else if (cmdName === 'next') await controls.advance(id)
        else if (cmdName === 'abort') await controls.abort(id)
        else if (cmdName === 'resume') await controls.resume(id)
        else if (cmdName === 'reopen') await controls.reopen(id)
        else if (cmdName === 'think-on') await config.setThinking(id, true)
        else if (cmdName === 'think-off') await config.setThinking(id, false)
        else if (cmdName === 'model') {
          if (arg) { const [p, m] = arg.split('@'); await config.switchModel(id, p, m || p) }
        } else if (cmdName === 'export') {
          const res = await tools.export_(id)
          window.open(tools.exportURL(id, res.file), '_blank')
        } else {
          toast(`未知命令: ${cmdName}`, 'error')
        }
        toast(`已执行: ${cmdName}`, 'success')
      } catch (e: any) {
        toast(`命令失败: ${e.message}`, 'error')
      }
    } else {
      try {
        if (snap?.runtime_state === 'running' || snap?.phase === 'writing') {
          await controls.steer(id, cmd)
        } else {
          await controls.continue(id, cmd)
        }
        toast('已发送')
      } catch (e: any) {
        toast(`发送失败: ${e.message}`, 'error')
      }
    }
    setInput('')
  }, [id, snap, toast])

  const phaseLabel = (p?: string) => {
    const map: Record<string, string> = { init: '初始化', waiting: '等待', plan: '规划中', writing: '写作中', review: '验收中', edit: '编辑中', complete: '已完成', '': '空闲' }
    return map[p || ''] || p || '未知'
  }

  if (isLoading) return <div className="p-6"><Skeleton className="h-96 w-full" /></div>
  if (!snap) return <div className="p-6">小说不存在</div>

  return (
    <div className="flex flex-col h-[calc(100vh-0px)]">
      {/* 顶部状态栏 */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b bg-card shrink-0">
        <Button variant="ghost" size="icon" onClick={() => navigate('/shelf')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 flex-1">
          <Badge variant={snap.runtime_state === 'running' ? 'default' : 'secondary'}>
            {snap.runtime_state === 'running' ? '运行中' : snap.runtime_state === 'paused' ? '已暂停' : '空闲'}
          </Badge>
          <Badge variant="outline">{phaseLabel(snap.phase)}</Badge>
          <Badge variant="outline">{snap.provider || '-'} / {snap.model || '-'}</Badge>
          <span className="text-xs text-muted-foreground">
            第 {snap.chapter}/{snap.total_chapters || '?'} 章 · {snap.word_count?.toLocaleString()} 字
          </span>
          {snap.thinking && <Zap className="h-3.5 w-3.5 text-amber-500" />}
        </div>
        <Button variant="ghost" size="icon" onClick={() => setDetailOpen(!detailOpen)}>
          {detailOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 中部：输出 + 事件流 */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* 输出区 */}
          <ScrollArea className="flex-1 p-4" ref={outputRef}>
            <div className="prose prose-sm dark:prose-invert max-w-none font-mono text-sm whitespace-pre-wrap">
              {delta || <span className="text-muted-foreground italic">等待输出…</span>}
            </div>
          </ScrollArea>

          {/* 事件流（可折叠） */}
          <div className="border-t shrink-0" style={{ height: 160 }}>
            <ScrollArea className="h-full p-2">
              <div className="text-xs text-muted-foreground space-y-1">
                {events.slice(-50).map((ev, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-zinc-500 shrink-0">{ev.time?.slice(11, 19)}</span>
                    <Badge variant="outline" className="text-[10px] h-4 px-1">{ev.category}</Badge>
                    <span className="truncate">{ev.summary}</span>
                  </div>
                ))}
                <div ref={eventsEnd} />
              </div>
            </ScrollArea>
          </div>
        </div>

        {/* 右侧详情面板 */}
        {detailOpen && (
          <div className="w-64 border-l bg-card p-4 shrink-0 overflow-auto">
            <h3 className="font-semibold text-sm mb-3">详情</h3>
            <dl className="space-y-2 text-xs">
              <DetailItem label="阶段" value={phaseLabel(snap.phase)} />
              <DetailItem label="推进模式" value={snap.advance_mode} />
              <DetailItem label="已完成" value={`${snap.completed_count} 章`} />
              <DetailItem label="导入中" value={snap.is_importing ? '是' : '否'} />
              <DetailItem label="仿写中" value={snap.is_simulating ? '是' : '否'} />
            </dl>
            {snap.last_error && (
              <div className="mt-3 p-2 rounded bg-destructive/10 text-destructive text-xs">
                <AlertCircle className="h-3 w-3 inline mr-1" />{snap.last_error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部输入栏 */}
      <div className="border-t bg-card p-3 shrink-0">
        <div className="flex gap-2 max-w-3xl mx-auto">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
            placeholder="/ 命令面板 · 输入文本发送干预 · Enter 发送"
            className="flex-1"
          />
          <Button size="icon" onClick={() => send(input)}><Send className="h-4 w-4" /></Button>
          {snap.runtime_state === 'running' && (
            <Button size="icon" variant="outline" onClick={() => { controls.abort(id!); toast('已暂停') }}>
              <Square className="h-4 w-4" />
            </Button>
          )}
          {snap.runtime_state !== 'running' && (
            <Button size="icon" variant="outline" onClick={() => { controls.resume(id!); toast('已恢复') }}>
              <Play className="h-4 w-4" />
            </Button>
          )}
          <Button size="icon" variant="ghost" onClick={() => { controls.advance(id!); toast('放行下一章') }}>
            <SkipForward className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function DetailItem({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value || '-'}</dd>
    </div>
  )
}
