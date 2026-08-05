import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { config } from '@/lib/api'
import { useAppStore } from '@/stores/app'
import { Plus, Trash2, Edit, Loader2, Shield, User } from 'lucide-react'
import type { UserInfo } from '@/types'

export function AdminPage() {
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState<UserInfo | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const { toast } = useAppStore()
  const qc = useQueryClient()

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: config.adminUsers,
  })

  const createMut = useMutation({
    mutationFn: () => config.adminCreateUser({ display_name: name, password }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] })
      setShowCreate(false)
      setName('')
      setPassword('')
      toast('用户创建成功', 'success')
    },
    onError: (e: any) => toast(e.message, 'error'),
  })

  const updateMut = useMutation({
    mutationFn: () => config.adminUpdateUser(editing!.id, { display_name: name, password: password || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] })
      setEditing(null)
      setName('')
      setPassword('')
      toast('用户更新成功', 'success')
    },
    onError: (e: any) => toast(e.message, 'error'),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => config.adminDeleteUser(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] })
      toast('用户已删除', 'success')
    },
    onError: (e: any) => toast(e.message, 'error'),
  })

  const openEdit = (u: UserInfo) => {
    setEditing(u)
    setName(u.display_name)
    setPassword('')
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">账号管理</h1>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger>
            <Button><Plus className="h-4 w-4 mr-2" />新建账号</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>新建普通账号</DialogTitle></DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label>显示名称</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </div>
              <div className="space-y-2">
                <Label>访问密码</Label>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" />
              </div>
              <Button onClick={() => createMut.mutate()} disabled={createMut.isPending || !name.trim() || password.length < 6} className="w-full">
                {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                创建
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : (
        <div className="space-y-3">
          {users?.map(u => (
            <Card key={u.id}>
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-3">
                  {u.role === 'admin' ? (
                    <Shield className="h-5 w-5 text-primary" />
                  ) : (
                    <User className="h-5 w-5 text-muted-foreground" />
                  )}
                  <div>
                    <p className="font-medium text-sm">{u.display_name}</p>
                    <p className="text-xs text-muted-foreground">{new Date(u.created_at).toLocaleDateString()}</p>
                  </div>
                  <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>
                    {u.role === 'admin' ? '管理员' : '普通用户'}
                  </Badge>
                </div>
                {u.role !== 'admin' && (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(u)}>
                      <Edit className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => { if (confirm('确认删除此账号？')) deleteMut.mutate(u.id) }}
                      disabled={deleteMut.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 编辑弹窗 */}
      <Dialog open={!!editing} onOpenChange={() => setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>编辑「{editing?.display_name}」</DialogTitle></DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label>显示名称</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>新密码（留空则不改）</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="留空保持原密码" />
            </div>
            <Button onClick={() => updateMut.mutate()} disabled={updateMut.isPending || !name.trim()} className="w-full">
              {updateMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
