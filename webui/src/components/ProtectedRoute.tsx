import { useEffect } from 'react'
import { Outlet, Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'

export function ProtectedRoute() {
  const { status, checkStatus, loading } = useAuthStore()
  const location = useLocation()

  useEffect(() => { checkStatus() }, [checkStatus])

  if (loading || !status) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    )
  }

  if (!status.configured) {
    return <Navigate to="/setup" state={{ from: location }} replace />
  }

  if (!status.logged_in) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <Outlet />
}
