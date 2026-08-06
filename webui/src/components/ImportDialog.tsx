import { useRef, useState, useCallback } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { tools } from '@/lib/api'
import { useAppStore } from '@/stores/app'
import { UploadCloud, FileUp, FolderOpen, Loader2, X } from 'lucide-react'

interface Props {
  bookId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

// 导入外部小说：拖拽上传 / 点击选择 / 直接输入服务器路径 三种方式
export function ImportDialog({ bookId, open, onOpenChange }: Props) {
  const { toast } = useAppStore()
  const [file, setFile] = useState<File | null>(null)
  const [path, setPath] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [loading, setLoading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const reset = () => { setFile(null); setPath(''); setDragOver(false); setLoading(false) }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) setFile(f)
  }, [])

  const doImport = async () => {
    setLoading(true)
    try {
      if (file) {
        const fd = new FormData()
        fd.append('file', file)
        await tools.importBook(bookId, fd)
        toast(`文件 ${file.name} 已提交导入`, 'success')
      } else if (path.trim()) {
        await tools.importBook(bookId, { source_path: path.trim() })
        toast('已提交路径导入', 'success')
      } else {
        toast('请选择文件或输入路径', 'error')
        setLoading(false)
        return
      }
      onOpenChange(false)
      setTimeout(reset, 300)
    } catch (e: any) {
      toast(`导入失败: ${e.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>导入外部小说</DialogTitle>
          <DialogDescription>支持文件上传（点击或拖拽）与服务器路径两种方式，导入到本书空项目。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* 拖拽/点击上传区 */}
          <div
            className={`rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <input ref={fileInput} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f) }} />
            {file ? (
              <div className="flex items-center justify-center gap-2 text-sm">
                <FileUp className="h-4 w-4 text-primary" />
                <span className="font-medium">{file.name}</span>
                <span className="text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</span>
                <button onClick={(e) => { e.stopPropagation(); setFile(null) }} className="ml-2">
                  <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <UploadCloud className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">点击选择或拖拽文件到此处</p>
              </div>
            )}
          </div>

          {/* 或分隔 */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground">或</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          {/* 路径导入 */}
          <div className="space-y-2">
            <Label htmlFor="path">服务器文件路径</Label>
            <Input
              id="path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="例如 /workspace/novel.txt"
              className="h-10"
            />
          </div>

          <Button onClick={doImport} disabled={loading || (!file && !path.trim())} className="w-full h-10">
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <FolderOpen className="h-4 w-4 mr-2" />}
            {loading ? '导入中…' : '开始导入'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
