import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { books } from '@/lib/api'
import { useAppStore } from '@/stores/app'
import { Plus, BookOpen, Trash2, Loader2 } from 'lucide-react'
import type { BookMeta } from '@/types'

export function ShelfPage() {
  const [showCreate, setShowCreate] = useState(false)
  const [showDelete, setShowDelete] = useState<BookMeta | null>(null)
  const [keepCompleted, setKeepCompleted] = useState(true)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { toast } = useAppStore()

  const { data: list, isLoading } = useQuery({
    queryKey: ['books'],
    queryFn: books.list,
    refetchInterval: 15_000,
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => books.delete(id, keepCompleted),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['books'] })
      setShowDelete(null)
      toast(data.kept ? '已从书架移除（目录已保留）' : '小说已删除', 'success')
    },
    onError: () => toast('删除失败', 'error'),
  })

  const handleCreate = async () => {
    if (!prompt.trim()) return
    setCreating(true)
    try {
      const book = await books.create({ title: title.trim() || undefined, prompt: prompt.trim(), mode: 'quick' })
      qc.invalidateQueries({ queryKey: ['books'] })
      setShowCreate(false)
      setTitle('')
      setPrompt('')
      toast('小说创建成功', 'success')
      navigate(`/book/${book.id}`)
    } catch {
      toast('创建失败', 'error')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">我的书架</h1>
          <p className="text-sm text-muted-foreground mt-1">{list?.length ?? 0} 本小说</p>
        </div>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger>
            <Button><Plus className="h-4 w-4 mr-2" />新建小说</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新建小说</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label>书名（可选）</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="留空自动生成" />
              </div>
              <div className="space-y-2">
                <Label>一句话需求</Label>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="写一本东方玄幻长篇，主角从边陲小城起步..."
                  rows={3}
                  autoFocus
                />
              </div>
              <Button onClick={handleCreate} disabled={creating || !prompt.trim()} className="w-full">
                {creating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                开始创作
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      ) : !list?.length ? (
        <div className="text-center py-20 text-muted-foreground">
          <BookOpen className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg">书架空空</p>
          <p className="text-sm mt-1">点击「新建小说」开始你的创作之旅</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {list.map(book => (
            <Card
              key={book.id}
              className="cursor-pointer hover:shadow-md transition-shadow group"
              onClick={() => navigate(`/book/${book.id}`)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <CardTitle className="text-base truncate">{book.title || '未命名'}</CardTitle>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 opacity-0 group-hover:opacity-100 -mr-1 -mt-1"
                    onClick={(e) => { e.stopPropagation(); setShowDelete(book) }}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary">{book.id.slice(0, 8)}</Badge>
                  <span>{new Date(book.created_at).toLocaleDateString()}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 删除确认 */}
      <Dialog open={!!showDelete} onOpenChange={() => setShowDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除「{showDelete?.title}」</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">此操作不可撤销。</p>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="keep"
              checked={keepCompleted}
              onCheckedChange={(v) => setKeepCompleted(!!v)}
            />
            <Label htmlFor="keep" className="text-sm">保留已完成目录</Label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setShowDelete(null)}>取消</Button>
            <Button
              variant="destructive"
              onClick={() => showDelete && deleteMut.mutate(showDelete.id)}
              disabled={deleteMut.isPending}
            >
              {deleteMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              确认删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
