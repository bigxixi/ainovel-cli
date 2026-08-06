import { useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import {
  BookOpen, Shield, LogOut, Menu, X, LayoutDashboard, Trash2, Loader2,
} from 'lucide-react'

const NAV_ITEMS = [
  { path: '/shelf', icon: BookOpen, label: '书架', admin: false },
  { path: '/admin', icon: Shield, label: '账号管理', admin: true },
] as const

export function AppShell() {
  const { status, logout } = useAuthStore()
  const { toast } = useAppStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [delPw, setDelPw] = useState('')
  const [delLoading, setDelLoading] = useState(false)
  const [delErr, setDelErr] = useState('')

  const isAdmin = status?.role === 'admin'

  const handleLogout = async () => {
    await logout()
    navigate('/login')
    toast('已退出登录')
  }

  const handleDeleteAccount = async () => {
    setDelErr('')
    setDelLoading(true)
    try {
      await api.deleteAccount(delPw)
      setShowDelete(false)
      await logout()
      toast('账号已删除', 'success')
      navigate('/login')
    } catch (e: any) {
      setDelErr(e.message || '删除失败')
    } finally {
      setDelLoading(false)
    }
  }

  const isActive = (path: string) => location.pathname.startsWith(path)

  const userMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger className="w-full justify-start gap-3 h-10 inline-flex items-center rounded-md px-3 text-sm hover:bg-muted">
        <Avatar className="h-7 w-7">
          <AvatarFallback className="text-xs">{(status?.display_name || '?')[0].toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="flex-1 text-left truncate">
          <p className="text-sm font-medium leading-none">{status?.display_name}</p>
          <p className="text-xs text-muted-foreground mt-0.5">@{status?.username || ''}</p>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={() => navigate('/shelf')}>
          <LayoutDashboard className="h-4 w-4 mr-2" />我的书架
        </DropdownMenuItem>
        {isAdmin && (
          <DropdownMenuItem onClick={() => navigate('/admin')}>
            <Shield className="h-4 w-4 mr-2" />账号管理
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleLogout}>
          <LogOut className="h-4 w-4 mr-2" />切换账号 / 退出登录
        </DropdownMenuItem>
        {!isAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setShowDelete(true)} className="text-destructive">
              <Trash2 className="h-4 w-4 mr-2" />删除我的账号
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div className="flex h-screen bg-background">
      {/* 桌面侧边栏 */}
      <aside className="hidden md:flex w-56 border-r bg-card flex-col">
        <div className="px-4 py-5 flex items-center gap-2" onClick={() => navigate('/shelf')} style={{ cursor: 'pointer' }}>
          <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
            <BookOpen className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="font-semibold text-sm text-foreground">AInovel-WebUI</span>
        </div>
        <Separator />
        <nav className="flex-1 px-3 py-3 space-y-1">
          {NAV_ITEMS.filter(item => !item.admin || isAdmin).map(item => (
            <Button
              key={item.path}
              variant={isActive(item.path) ? 'secondary' : 'ghost'}
              className="w-full justify-start gap-3 h-9"
              onClick={() => { navigate(item.path); setSidebarOpen(false) }}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Button>
          ))}
        </nav>
        <Separator />
        <div className="p-3">{userMenu}</div>
      </aside>

      {/* 移动端顶栏 */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 h-12 bg-card border-b flex items-center px-3">
        <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(!sidebarOpen)}>
          {sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>
        <span className="ml-2 font-semibold text-sm">AInovel-WebUI</span>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Avatar className="h-7 w-7 cursor-pointer">
              <AvatarFallback className="text-xs">{(status?.display_name || '?')[0].toUpperCase()}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleLogout}><LogOut className="h-4 w-4 mr-2" />退出登录</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/30" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute top-12 left-0 bottom-0 w-56 bg-card border-r">
            <nav className="px-3 py-3 space-y-1">
              {NAV_ITEMS.filter(item => !item.admin || isAdmin).map(item => (
                <Button key={item.path} variant={isActive(item.path) ? 'secondary' : 'ghost'} className="w-full justify-start gap-3 h-9"
                  onClick={() => { navigate(item.path); setSidebarOpen(false) }}>
                  <item.icon className="h-4 w-4" />{item.label}
                </Button>
              ))}
            </nav>
          </aside>
        </div>
      )}

      <main className="flex-1 overflow-auto md:pt-0 pt-12">
        <Outlet />
      </main>

      {/* 删除账号确认 */}
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除我的账号</DialogTitle>
            <DialogDescription>
              此操作将删除账号及其所有书籍数据，不可恢复。请输入访问密码确认。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="delpw">访问密码</Label>
              <Input
                id="delpw"
                type="password"
                value={delPw}
                onChange={(e) => setDelPw(e.target.value)}
                className="h-10"
                autoComplete="current-password"
              />
            </div>
            {delErr && <p className="text-sm text-destructive">{delErr}</p>}
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => { setShowDelete(false); setDelPw(''); setDelErr('') }}>取消</Button>
              <Button variant="destructive" onClick={handleDeleteAccount} disabled={delLoading || !delPw}>
                {delLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                确认删除
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
