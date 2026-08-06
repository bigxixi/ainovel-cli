import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { BookOpen, Loader2 } from 'lucide-react'

export function LoginPage() {
  const { status, login, checkStatus, loading, error, clearError } = useAuthStore()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    checkStatus()
  }, [checkStatus])

  useEffect(() => {
    if (status?.logged_in) {
      const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/shelf'
      navigate(from, { replace: true })
    }
  }, [status?.logged_in, navigate, location.state])

  // 未配置 → 跳设置页
  useEffect(() => {
    if (status && !status.configured) {
      navigate('/setup', { replace: true })
    }
  }, [status, navigate])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) return
    clearError()
    try {
      await login(username.trim(), password)
    } catch { /* error set in store */ }
  }

  if (!status || status.logged_in) return null

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm shadow-sm border-border/60">
        <CardHeader className="text-center pb-4">
          <div className="mx-auto h-12 w-12 rounded-lg bg-primary flex items-center justify-center mb-3">
            <BookOpen className="h-6 w-6 text-primary-foreground" />
          </div>
          <CardTitle className="text-xl text-foreground">AInovel-WebUI</CardTitle>
          <CardDescription>输入用户名与密码进入你的创作空间</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                placeholder="请输入用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                className="h-10"
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">访问密码</Label>
              <Input
                id="password"
                type="password"
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-10"
                autoComplete="current-password"
              />
            </div>
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            <Button type="submit" className="w-full h-10" disabled={loading || !username.trim() || !password}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              登 录
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
