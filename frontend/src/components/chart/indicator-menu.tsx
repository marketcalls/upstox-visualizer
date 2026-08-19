/*
  The indicator picker: every descriptor the library has registered, searchable
  and grouped by category. The list is read out of the registry rather than
  hand-kept, so a package update that adds an oscillator shows up here without
  anyone editing this file.
*/

import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { ChartSpline, Search, SearchX } from "lucide-react"

// Side-effect import: the registry is empty until this tier is evaluated.
import "openalgo-charts/indicators"
import { registeredIndicators } from "openalgo-charts"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export interface IndicatorMenuProps {
  onAdd: (indicatorId: string) => void
  activeCount: number
}

const ALL_TAB = "all"
const UNCATEGORISED = "Other"

/*
  An ordering hint only, never a filter. A category the library invents later
  still gets its own tab, appended after these in alphabetical order.
*/
const CATEGORY_ORDER = ["Trend", "Momentum", "Volatility", "Volume"]

interface CatalogEntry {
  id: string
  name: string
  category: string
  overlay: boolean
  /** Lowercased "name id", so a keystroke costs one substring test per row. */
  haystack: string
}

/*
  Built once at module scope. The registry is fixed for the life of the page and
  86 descriptors is a real amount of string work to redo on every render.
  Alphabetical by display name: with a search box on top, findability beats the
  registration order the library happens to use.
*/
const CATALOG: readonly CatalogEntry[] = registeredIndicators()
  .map((descriptor) => ({
    id: descriptor.id,
    name: descriptor.name,
    category: descriptor.category ?? UNCATEGORISED,
    overlay: descriptor.placement === "onchart",
    haystack: `${descriptor.name} ${descriptor.id}`.toLowerCase(),
  }))
  .sort((left, right) => left.name.localeCompare(right.name))

const CATEGORIES: readonly string[] = [
  ...new Set(CATALOG.map((entry) => entry.category)),
].sort((left, right) => {
  const leftRank = CATEGORY_ORDER.indexOf(left)
  const rightRank = CATEGORY_ORDER.indexOf(right)
  if (leftRank !== rightRank) {
    return (
      (leftRank < 0 ? CATEGORY_ORDER.length : leftRank) -
      (rightRank < 0 ? CATEGORY_ORDER.length : rightRank)
    )
  }
  return left.localeCompare(right)
})

function TabLabel({ label, count }: { label: string; count: number }) {
  return (
    <>
      {label}
      <span className="font-mono text-[10px] text-muted-foreground tabular">{count}</span>
    </>
  )
}

export function IndicatorMenu({ onAdd, activeCount }: IndicatorMenuProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [tab, setTab] = useState<string>(ALL_TAB)

  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const query = search.trim().toLowerCase()

  const matched = useMemo(
    () =>
      query === "" ? CATALOG : CATALOG.filter((entry) => entry.haystack.includes(query)),
    [query]
  )

  // Counts track the search rather than the catalogue, so a tab reading 0
  // explains why it is empty instead of looking like a dead end.
  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const entry of matched) map.set(entry.category, (map.get(entry.category) ?? 0) + 1)
    return map
  }, [matched])

  const visible = useMemo(
    () => (tab === ALL_TAB ? matched : matched.filter((entry) => entry.category === tab)),
    [matched, tab]
  )

  const elsewhere = matched.length - visible.length

  const handleOpenChange = useCallback((next: boolean) => {
    // Reset on the way in, not on the way out: clearing during the close
    // animation flashes the whole unfiltered list behind the fade.
    if (next) {
      setSearch("")
      setTab(ALL_TAB)
    }
    setOpen(next)
  }, [])

  const add = useCallback(
    (indicatorId: string) => {
      onAdd(indicatorId)
      setOpen(false)
    },
    [onAdd]
  )

  /*
    Roving focus over whatever rows are currently rendered. Reading them from
    the DOM rather than an index into `visible` keeps this correct while the
    filter is changing under it, and stepping back off the top row hands focus
    to the search box so the whole panel is one keyboard loop.
  */
  const moveFocus = useCallback((from: HTMLButtonElement | null, step: number) => {
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("[data-indicator-row]") ?? []
    )
    if (rows.length === 0) return

    const next = (from ? rows.indexOf(from) : -1) + step
    if (next < 0) {
      searchRef.current?.focus()
      return
    }
    rows[Math.min(next, rows.length - 1)]?.focus()
  }, [])

  function handleSearchKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault()
      const first = visible[0]
      if (first) add(first.id)
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      moveFocus(null, 1)
    }
  }

  function handleRowKeys(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    moveFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" title="Technical indicators">
          <ChartSpline />
          Indicators
          {activeCount > 0 ? (
            <Badge className="h-4 min-w-4 rounded-full px-1 font-mono text-[10px] tabular">
              {activeCount}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>

      {/*
        Fixed height with the scrolling pushed into the list. 86 rows is far more
        than a popover should ever be allowed to grow the page by.
      */}
      <PopoverContent
        align="start"
        sideOffset={8}
        className="flex h-[26.5rem] w-[30rem] flex-col gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          // Radix parks focus on the container; the search box is the point.
          event.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <div className="relative shrink-0 p-2">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={handleSearchKeys}
            placeholder={`Search ${CATALOG.length} indicators`}
            aria-label="Search indicators"
            autoComplete="off"
            spellCheck={false}
            className="h-8 pl-8 text-sm"
          />
        </div>

        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
          <div className="shrink-0 border-b border-hairline px-2 pb-2">
            <TabsList className="flex w-full">
              <TabsTrigger value={ALL_TAB} className="gap-1 px-1 text-xs">
                <TabLabel label="All" count={matched.length} />
              </TabsTrigger>
              {CATEGORIES.map((category) => (
                <TabsTrigger key={category} value={category} className="gap-1 px-1 text-xs">
                  <TabLabel label={category} count={counts.get(category) ?? 0} />
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* Only the active value is ever rendered, so one content node covers
              every tab; the key resets the scroll when the tab changes. */}
          <TabsContent key={tab} value={tab} className="min-h-0">
            {visible.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 px-8 text-center">
                <SearchX className="size-5 text-muted-foreground" />
                <p className="text-sm text-foreground">No indicator matches that search</p>
                <p className="text-xs text-muted-foreground">
                  {elsewhere > 0
                    ? `${elsewhere} ${elsewhere === 1 ? "match sits" : "matches sit"} in another category. Try the All tab.`
                    : "Try a shorter term, such as rsi, band or moving."}
                </p>
              </div>
            ) : (
              <ScrollArea className="h-full">
                <div ref={listRef} className="flex flex-col gap-px p-1.5">
                  {visible.map((entry, index) => (
                    <button
                      key={entry.id}
                      type="button"
                      data-indicator-row=""
                      data-first={query !== "" && index === 0 ? "" : undefined}
                      title={`${entry.name} (${entry.id})`}
                      onClick={() => add(entry.id)}
                      onKeyDown={handleRowKeys}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent data-[first]:bg-accent/50 data-[first]:ring-1 data-[first]:ring-hairline data-[first]:ring-inset"
                    >
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate text-sm text-foreground">{entry.name}</span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {entry.id}
                        </span>
                      </span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "shrink-0 rounded-sm px-1.5 py-0 font-mono text-[10px] tracking-wide",
                          entry.overlay
                            ? "border-primary/35 bg-primary/10 text-primary"
                            : "border-hairline bg-secondary text-muted-foreground"
                        )}
                      >
                        {entry.overlay ? "overlay" : "pane"}
                      </Badge>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  )
}
