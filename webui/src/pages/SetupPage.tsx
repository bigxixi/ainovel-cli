import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { BookOpen, Loader2 } from 'lucide-react'

export function SetupPage() {
  const { status, setupAuth, checkStatus, loading, error, clearError } = useAuthStore()
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [localErr, setLocalErr] = useState('')
  const navigate = useNavigate()

  useEffect(() => { checkStatus() }, [checkStatus])

  useEffect(() => {
    if (status?.logged_in) {
      navigate('/shelf', { replace: true })
    } else if (status && status.configured) {
      navigate('/login', { replace: true })
    }
  }, [status, navigate])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalErr('')
    clearError()

    if (!displayName.trim()) { setLocalErr('请输入显示名称'); return }
    if (password.length < 6) { setLocalErr('密码至少 6 位'); return }
    if (password !== confirm) { setLocalErr('两次密码不一致'); return }

    try {
      await setupAuth(displayName.trim(), password)
      navigate('/shelf', { replace: true })
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
          <CardTitle className="text-xl">欢迎使用 AInovel-WebUI</CardTitle>
          <CardDescription>
            首次使用，请设置管理员账号。此账号拥有所有管理权限。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">显示名称</Label>
              <Input
                id="name"
                placeholder="管理员"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoFocus
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pw">访问密码</Label>
              <Input
                id="pw"
                type="password"
                placeholder="至少 6 位"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cpw">确认密码</Label>
              <Input
                id="cpw"
                type="password"
                placeholder="再次输入密码"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="h-10"
              />
            </div>
            {(error || localErr) && (
              <p className="text-sm text-destructive">{localErr || error}</p>
            )}
            <Button
              type="submit"
              className="w-full h-10"
              disabled={loading || !displayName.trim() || password.length < 6}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              创建管理员账号
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
