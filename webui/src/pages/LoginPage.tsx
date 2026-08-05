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
    if (!password.trim()) return
    clearError()
    try {
      await login(password.trim())
    } catch { /* error set in store */ }
  }

  if (!status || status.logged_in) return null

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center pb-4">
          <div className="mx-auto h-12 w-12 rounded-xl bg-primary flex items-center justify-center mb-3">
            <BookOpen className="h-6 w-6 text-primary-foreground" />
          </div>
          <CardTitle className="text-xl">AInovel-WebUI</CardTitle>
          <CardDescription>输入访问密码以继续</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">访问密码</Label>
              <Input
                id="password"
                type="password"
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                className="h-10"
              />
            </div>
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            <Button type="submit" className="w-full h-10" disabled={loading || !password.trim()}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              登 录
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
