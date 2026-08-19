import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { api, type InstrumentSearchResult } from "@/lib/api"
import { cn } from "@/lib/utils"

/*
  The instrument master holds about 125,000 rows across 12 segments, so the
  picker searches the backend rather than filtering a list held in the browser.
  Ranking is done in SQL; this component only renders what comes back.
*/

const SEGMENT_FILTERS = [
  { id: "", label: "All" },
  { id: "NSE_EQ", label: "NSE" },
  { id: "BSE_EQ", label: "BSE" },
  { id: "NSE_INDEX", label: "Index" },
  { id: "NSE_FO", label: "F&O" },
  { id: "MCX_FO", label: "MCX" },
] as const

const DEBOUNCE_MS = 180

export interface SymbolSearchProps {
  symbol: string
  onSelect: (result: InstrumentSearchResult) => void
}

function segmentTone(segment: string | null | undefined): string {
  if (segment === "NSE_INDEX" || segment === "BSE_INDEX") return "text-violet"
  if (segment === "NSE_EQ" || segment === "BSE_EQ") return "text-up"
  return "text-muted-foreground"
}

export function SymbolSearch({ symbol, onSelect }: SymbolSearchProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [segment, setSegment] = useState<string>("")
  const [rows, setRows] = useState<InstrumentSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // A query shorter than this matches too much to be useful as a typeahead.
  const term = query.trim()
  const enabled = term.length >= 1

  useEffect(() => {
    if (!open || !enabled) {
      setRows([])
      setLoading(false)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError(null)

    const timer = window.setTimeout(() => {
      api
        .searchInstruments(term, { segment: segment || undefined, limit: 30 }, controller.signal)
        .then((results) => {
          setRows(results)
          setActive(0)
        })
        .catch((exception: unknown) => {
          if (controller.signal.aborted) return
          setRows([])
          setError(exception instanceof Error ? exception.message : "Search failed")
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [open, term, enabled, segment])

  const choose = useCallback(
    (row: InstrumentSearchResult) => {
      onSelect(row)
      setOpen(false)
      setQuery("")
      setRows([])
    },
    [onSelect]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        setActive((current) => {
          if (rows.length === 0) return 0
          const step = event.key === "ArrowDown" ? 1 : -1
          return (current + step + rows.length) % rows.length
        })
        return
      }
      if (event.key === "Enter" && rows[active]) {
        event.preventDefault()
        choose(rows[active])
      }
      if (event.key === "Escape") setOpen(false)
    },
    [rows, active, choose]
  )

  // Keep the highlighted row in view while arrowing through a long result list.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    node?.scrollIntoView({ block: "nearest" })
  }, [active])

  const hint = useMemo(() => {
    if (!enabled) return "Type a symbol or company name"
    if (loading) return "Searching"
    if (error) return error
    if (rows.length === 0) return `Nothing matches "${term}"`
    return null
  }, [enabled, loading, error, rows.length, term])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Search instruments"
          className="h-8 w-[150px] justify-between border-hairline bg-panel-raised px-2 font-display text-sm font-semibold tracking-tight"
        >
          <span className="truncate">{symbol}</span>
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-[30rem] border-hairline bg-panel-raised p-0"
        /*
          Radix focuses the content wrapper on open. Take that moment to put
          the caret in the search box instead: the content is mounted by now,
          which a queued frame callback cannot guarantee.
        */
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <div className="border-b border-hairline p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search 124,000 instruments"
              aria-label="Instrument search"
              className="h-8 border-hairline bg-panel pl-7 font-mono text-sm"
            />
            {loading ? (
              <Loader2 className="absolute right-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : null}
          </div>

          <div className="mt-2 flex flex-wrap gap-1">
            {SEGMENT_FILTERS.map((filter) => (
              <button
                key={filter.id || "all"}
                type="button"
                onClick={() => setSegment(filter.id)}
                className={cn(
                  "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors",
                  segment === filter.id
                    ? "bg-primary/15 text-violet"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        <ScrollArea className="h-[19rem]">
          <div ref={listRef} className="p-1" role="listbox" aria-label="Search results">
            {hint ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">{hint}</p>
            ) : (
              rows.map((row, index) => (
                <button
                  key={row.instrument_key}
                  type="button"
                  data-index={index}
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(row)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded px-2 py-1.5 text-left transition-colors",
                    index === active ? "bg-accent" : "hover:bg-accent/60"
                  )}
                >
                  <span className="w-[11rem] shrink-0 truncate font-mono text-xs text-foreground">
                    {row.trading_symbol}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                    {row.name ?? ""}
                  </span>
                  {row.expiry ? (
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {row.expiry}
                    </span>
                  ) : null}
                  <Badge
                    variant="secondary"
                    className={cn(
                      "shrink-0 font-mono text-[9px]",
                      segmentTone(row.segment)
                    )}
                  >
                    {row.segment ?? "?"}
                  </Badge>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
