/*
  The drawing toolbar. The library ships no UI at all, so every button here is
  ours; the only thing it gives us is the registry, which is where the tool list
  comes from. Nothing below hardcodes a tool id except the small "most used"
  shortlist and the family map, so a library update that adds a tool shows up in
  the catalogue on its own instead of silently disappearing.
*/

import { useMemo, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  Brush,
  Circle,
  Clock,
  Crosshair,
  Highlighter,
  Magnet,
  MessageSquare,
  Minus,
  MoreHorizontal,
  MousePointer2,
  MoveUpRight,
  PenLine,
  Percent,
  Redo2,
  Ruler,
  Slash,
  Spline,
  Square,
  Target,
  Trash2,
  TrendingUp,
  Triangle,
  Type,
  Undo2,
  Waves,
  Grid3x3,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { drawingShortcuts, registeredDrawingTools } from "openalgo-charts/draw"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Toggle } from "@/components/ui/toggle"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { DrawingStateSummary } from "@/lib/chart-terminal"
import { cn } from "@/lib/utils"

export interface DrawingRailProps {
  tool: string | null
  onToolChange: (toolId: string | null) => void
  magnet: boolean
  onMagnetChange: (on: boolean) => void
  summary: DrawingStateSummary
  onUndo: () => void
  onRedo: () => void
  onClear: () => void
}

type Family =
  | "Lines"
  | "Shapes"
  | "Paths"
  | "Channels"
  | "Fibonacci"
  | "Gann"
  | "Cycles"
  | "Forecasting"
  | "Measure"
  | "Arrows"
  | "Text"
  | "Brushes"
  | "Other"

/* Display order of the catalogue. "Other" is last and usually empty. */
const FAMILY_ORDER: readonly Family[] = [
  "Lines",
  "Shapes",
  "Paths",
  "Channels",
  "Fibonacci",
  "Gann",
  "Cycles",
  "Forecasting",
  "Measure",
  "Arrows",
  "Text",
  "Brushes",
  "Other",
]

/*
  Grouping is ours, not the library's: the registry is a flat list. Anything the
  map does not know about falls into "Other" so a new built-in tool still
  reaches the user.
*/
const TOOL_FAMILY: Record<string, Family> = {
  "trend-line": "Lines",
  ray: "Lines",
  "extended-line": "Lines",
  arrow: "Lines",
  "horizontal-line": "Lines",
  "horizontal-ray": "Lines",
  "vertical-line": "Lines",
  "cross-line": "Lines",

  rectangle: "Shapes",
  ellipse: "Shapes",
  circle: "Shapes",
  triangle: "Shapes",
  "rotated-rectangle": "Shapes",

  path: "Paths",
  polyline: "Paths",
  arc: "Paths",
  curve: "Paths",
  "double-curve": "Paths",

  "parallel-channel": "Channels",
  "fib-channel": "Channels",

  "fib-retracement": "Fibonacci",
  "fib-extension": "Fibonacci",
  "fib-time-zone": "Fibonacci",
  "fib-fan": "Fibonacci",

  "gann-fan": "Gann",
  "gann-box": "Gann",

  "cyclic-lines": "Cycles",
  "time-cycles": "Cycles",
  "sine-line": "Cycles",

  "long-position": "Forecasting",
  "short-position": "Forecasting",
  forecast: "Forecasting",

  measure: "Measure",
  "price-range": "Measure",
  "date-range": "Measure",

  "arrow-up": "Arrows",
  "arrow-down": "Arrows",

  text: "Text",
  "price-label": "Text",
  "flag-mark": "Text",
  callout: "Text",

  brush: "Brushes",
  highlighter: "Brushes",
}

/*
  lucide has no glyph for a Gann box or a fib fan, so icons are per family and
  every one of them is paired with the tool's real name in the catalogue. The
  rail's icons are only ever a shorthand for the eight tools a desk uses daily.
*/
const FAMILY_ICON: Record<Family, LucideIcon> = {
  Lines: Minus,
  Shapes: Square,
  Paths: Spline,
  Channels: Slash,
  Fibonacci: Percent,
  Gann: Grid3x3,
  Cycles: Waves,
  Forecasting: Target,
  Measure: Ruler,
  Arrows: ArrowUp,
  Text: Type,
  Brushes: PenLine,
  Other: Crosshair,
}

const TOOL_ICON: Record<string, LucideIcon> = {
  "trend-line": TrendingUp,
  ray: MoveUpRight,
  arrow: MoveUpRight,
  circle: Circle,
  ellipse: Circle,
  triangle: Triangle,
  "arrow-up": ArrowUp,
  "arrow-down": ArrowDown,
  callout: MessageSquare,
  "fib-time-zone": Clock,
  "time-cycles": Clock,
  brush: Brush,
  highlighter: Highlighter,
}

/* The shortlist that earns a slot on the rail itself. */
const QUICK_IDS: readonly string[] = [
  "trend-line",
  "horizontal-line",
  "ray",
  "rectangle",
  "ellipse",
  "fib-retracement",
  "text",
  "measure",
]

interface RailTool {
  id: string
  name: string
  shortcut: string | null
  family: Family
  Icon: LucideIcon
}

interface ToolGroup {
  family: Family
  tools: RailTool[]
}

/*
  Read the registry once. Importing "openalgo-charts/draw" registers the 43
  built-ins as a side effect, so by the time this runs the list is complete.
*/
function buildCatalogue(): {
  quick: RailTool[]
  groups: ToolGroup[]
  count: number
} {
  const chords = drawingShortcuts()

  const tools: RailTool[] = registeredDrawingTools().map((tool) => {
    const family = TOOL_FAMILY[tool.id] ?? "Other"
    return {
      id: tool.id,
      name: tool.name,
      // The descriptor is the source; the chord map is only a fallback.
      shortcut: tool.shortcut ?? chords[tool.id] ?? null,
      family,
      Icon: TOOL_ICON[tool.id] ?? FAMILY_ICON[family],
    }
  })

  const groups = FAMILY_ORDER.map((family) => ({
    family,
    tools: tools.filter((tool) => tool.family === family),
  })).filter((group) => group.tools.length > 0)

  // flatMap rather than find + filter, so the result narrows without a cast.
  const quick = QUICK_IDS.flatMap((id) => {
    const match = tools.find((tool) => tool.id === id)
    return match ? [match] : []
  })

  return { quick, groups, count: tools.length }
}

const ARMED_CLASS =
  "border border-violet bg-primary/15 text-violet hover:bg-primary/20 hover:text-violet"

function RailToolButton({
  tool,
  armed,
  onSelect,
}: {
  tool: RailTool
  armed: boolean
  onSelect: () => void
}) {
  const Icon = tool.Icon

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={tool.name}
          aria-pressed={armed}
          onClick={onSelect}
          className={cn(
            "border border-transparent text-muted-foreground hover:text-foreground",
            armed && ARMED_CLASS
          )}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {tool.name}
        {tool.shortcut ? (
          <span className="ml-2 font-mono text-muted-foreground">
            {tool.shortcut}
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}

function CatalogueEntry({
  tool,
  armed,
  onSelect,
}: {
  tool: RailTool
  armed: boolean
  onSelect: () => void
}) {
  const Icon = tool.Icon

  return (
    <button
      type="button"
      aria-pressed={armed}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-xs transition-colors",
        armed
          ? "border-violet bg-primary/15 text-violet"
          : "text-foreground hover:bg-accent"
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="flex-1 truncate">{tool.name}</span>
      {tool.shortcut ? (
        <kbd className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {tool.shortcut}
        </kbd>
      ) : null}
    </button>
  )
}

function RailAction({
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  label: string
  icon: LucideIcon
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="text-muted-foreground hover:text-foreground"
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function Divider() {
  return <div className="my-1 h-px w-6 shrink-0 bg-hairline" />
}

export function DrawingRail({
  tool,
  onToolChange,
  magnet,
  onMagnetChange,
  summary,
  onUndo,
  onRedo,
  onClear,
}: DrawingRailProps) {
  const [open, setOpen] = useState(false)
  const { quick, groups, count } = useMemo(buildCatalogue, [])

  /*
    The controller disarms itself the moment a shape completes, and that lands
    in `summary.tool` before the parent's own `tool` state hears about it. Read
    the summary first so the rail never stays lit on a tool that is no longer
    armed, and fall back to the prop for the tick between click and event.
  */
  const armed = summary.tool ?? tool
  const armedInRail = quick.some((entry) => entry.id === armed)

  // Clicking the armed tool a second time puts the cursor back.
  function pick(id: string) {
    onToolChange(armed === id ? null : id)
  }

  return (
    <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-hairline bg-panel py-2">
      <div className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto">
        {quick.map((entry) => (
          <RailToolButton
            key={entry.id}
            tool={entry}
            armed={armed === entry.id}
            onSelect={() => pick(entry.id)}
          />
        ))}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`All drawing tools (${count})`}
                className={cn(
                  "border border-transparent text-muted-foreground hover:text-foreground",
                  // Light it up when the armed tool has no slot on the rail,
                  // otherwise the armed state would be invisible.
                  armed !== null && !armedInRail && ARMED_CLASS
                )}
              >
                <MoreHorizontal />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">All tools ({count})</TooltipContent>
        </Tooltip>

        <PopoverContent side="right" align="start" className="w-[21rem] p-0">
          <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
            <span className="eyebrow">Drawing tools</span>
            <span className="tabular text-[11px] text-muted-foreground">
              {count} tools
            </span>
          </div>

          <ScrollArea className="h-[22rem]">
            <div className="space-y-3 p-2">
              {groups.map((group) => (
                <div key={group.family}>
                  <p className="eyebrow px-1 pb-1">{group.family}</p>
                  <div className="grid grid-cols-2 gap-1">
                    {group.tools.map((entry) => (
                      <CatalogueEntry
                        key={entry.id}
                        tool={entry}
                        armed={armed === entry.id}
                        onSelect={() => {
                          pick(entry.id)
                          setOpen(false)
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>

      <Divider />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Cursor"
            aria-pressed={armed === null}
            onClick={() => onToolChange(null)}
            className={cn(
              "border border-transparent text-muted-foreground hover:text-foreground",
              armed === null && ARMED_CLASS
            )}
          >
            <MousePointer2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Cursor and select</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={magnet}
            onPressedChange={onMagnetChange}
            aria-label="Magnet snap"
            className="text-muted-foreground data-[state=on]:bg-primary/15 data-[state=on]:text-violet"
          >
            <Magnet />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent side="right">
          Magnet snap to open, high, low and close
        </TooltipContent>
      </Tooltip>

      <Divider />

      <RailAction
        label="Undo"
        icon={Undo2}
        disabled={!summary.canUndo}
        onClick={onUndo}
      />
      <RailAction
        label="Redo"
        icon={Redo2}
        disabled={!summary.canRedo}
        onClick={onRedo}
      />
      <RailAction
        label={
          summary.count === 0
            ? "No drawings to clear"
            : `Clear ${summary.count} drawing${summary.count === 1 ? "" : "s"}`
        }
        icon={Trash2}
        disabled={summary.count === 0}
        onClick={onClear}
      />
    </div>
  )
}
