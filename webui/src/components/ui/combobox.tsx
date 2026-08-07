import { useState } from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command'

interface ComboboxProps {
  value: string
  onChange: (value: string) => void
  options: string[]
  placeholder?: string
  disabled?: boolean
  loading?: boolean
  emptyText?: string
  allowCustom?: boolean
}

export function Combobox({
  value, onChange, options, placeholder = '选择或输入…',
  disabled, loading, emptyText = '无匹配项', allowCustom = true,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const commit = (v: string) => {
    onChange(v)
    setOpen(false)
    setQuery('')
  }

  const showCustom = allowCustom && query.trim() !== '' && !options.includes(query.trim())

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between font-normal"
          >
            <span className={cn('truncate', !value && 'text-muted-foreground')}>
              {value || placeholder}
            </span>
            <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
          </Button>
        }
      />
      <PopoverContent className="w-(--anchor-width) min-w-52 p-0" align="start">
        <Command shouldFilter>
          <CommandInput
            placeholder={loading ? '加载模型中…' : placeholder}
            value={query}
            onValueChange={setQuery}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && showCustom) {
                e.preventDefault()
                commit(query.trim())
              }
            }}
          />
          <CommandList>
            {!showCustom && <CommandEmpty>{emptyText}</CommandEmpty>}
            {showCustom && (
              <CommandGroup heading="自定义">
                <CommandItem value={query} onSelect={() => commit(query.trim())}>
                  <Plus className="h-4 w-4 mr-2" />
                  使用「{query.trim()}」
                </CommandItem>
              </CommandGroup>
            )}
            {options.length > 0 && (
              <CommandGroup heading="可选模型">
                {options.map((opt) => (
                  <CommandItem key={opt} value={opt} onSelect={() => commit(opt)}>
                    <Check className={cn('h-4 w-4 mr-2', value === opt ? 'opacity-100' : 'opacity-0')} />
                    {opt}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
