import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import {
  BookOpen, Settings, Shield, LogOut, Menu, X, LayoutDashboard,
} from 'lucide-react'
import { useState } from 'react'

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

  const handleLogout = async () => {
    await logout()
    navigate('/login')
    toast('已退出登录')
  }

  const isActive = (path: string) => location.pathname.startsWith(path)

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* 品牌 */}
      <div className="px-4 py-5 flex items-center gap-2" onClick={() => navigate('/shelf')} style={{ cursor: 'pointer' }}>
        <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
          <BookOpen className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="font-semibold text-sm">AInovel-WebUI</span>
      </div>

      <Separator />

      {/* 导航 */}
      <nav className="flex-1 px-3 py-3 space-y-1">
        {NAV_ITEMS.filter(item => !item.admin || status?.display_name === 'admin').map(item => (
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

      {/* 用户区域 */}
      <div className="p-3">
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Button variant="ghost" className="w-full justify-start gap-3 h-10">
              <Avatar className="h-7 w-7">
                <AvatarFallback className="text-xs">
                  {(status?.display_name || '?')[0].toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 text-left truncate">
                <p className="text-sm font-medium leading-none">{status?.display_name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">在线</p>
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => navigate('/shelf')}>
              <LayoutDashboard className="h-4 w-4 mr-2" />
              我的书架
            </DropdownMenuItem>
            {status?.display_name === 'admin' && (
              <DropdownMenuItem onClick={() => navigate('/admin')}>
                <Settings className="h-4 w-4 mr-2" />
                账号管理
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout}>
              <LogOut className="h-4 w-4 mr-2" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen bg-background">
      {/* 桌面侧边栏 */}
      <aside className="hidden md:flex w-56 border-r bg-card flex-col">
        <SidebarContent />
      </aside>

      {/* 移动端 hamburger */}
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
            <DropdownMenuItem onClick={handleLogout}>
              <LogOut className="h-4 w-4 mr-2" />退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 移动端侧边栏 overlay */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/40" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute top-0 left-0 bottom-0 w-56 bg-card border-r">
            <SidebarContent />
          </aside>
        </div>
      )}

      {/* 内容区 */}
      <main className="flex-1 overflow-auto md:pt-0 pt-12">
        <Outlet />
      </main>
    </div>
  )
}
