import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { tools } from '@/lib/api'
import { useAppStore } from '@/stores/app'
import { Loader2, BookDown, Download } from 'lucide-react'
import type { ExportResult } from '@/types'

interface Props {
  bookId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ExportDialog({ bookId, open, onOpenChange }: Props) {
  const { toast } = useAppStore()
  const [format, setFormat] = useState('txt')
  const [overwrite, setOverwrite] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<ExportResult | null>(null)

  const run = async () => {
    setExporting(true)
    setResult(null)
    try {
      const res = await tools.export_(bookId, { format, overwrite })
      setResult(res)
      const a = document.createElement('a')
      a.href = res.download
      a.download = ''
      document.body.appendChild(a)
      a.click()
      a.remove()
      toast(`已导出 ${res.chapters} 章（${(res.bytes / 1024).toFixed(1)} KB）`, 'success')
    } catch (e: any) {
      toast(`导出失败: ${e.message}`, 'error')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <BookDown className="h-4 w-4 text-primary" />导出小说
          </DialogTitle>
          <DialogDescription>导出已完成章节，可选格式并下载到本地。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>格式</Label>
            <Select value={format} onValueChange={(v) => setFormat(v || 'txt')}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="txt">TXT（纯文本）</SelectItem>
                <SelectItem value="epub">EPUB（电子书）</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="overwrite">覆盖同名文件</Label>
            <Switch id="overwrite" checked={overwrite} onCheckedChange={setOverwrite} />
          </div>

          {result && (
            <a
              href={result.download}
              className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm text-primary hover:bg-primary/10"
            >
              <Download className="h-4 w-4" />
              重新下载：{result.path.split('/').pop()}
            </a>
          )}

          <Button onClick={run} disabled={exporting} className="w-full">
            {exporting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <BookDown className="h-4 w-4 mr-2" />}
            {exporting ? '导出中…' : '导出并下载'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
