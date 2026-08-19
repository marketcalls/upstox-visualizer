/*
  The charting workstation. Every piece of chart behaviour lives in
  ChartTerminal and the components under components/chart, so this page is the
  controller: it owns the workspace state, feeds it down as props, and never
  touches the renderer except through the terminal handle the canvas hands back.
*/

import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import {
  Camera,
  ChartColumnBig,
  Expand,
  Grid3x3,
  Loader2,
  Maximize2,
  Minimize,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Ruler,
  TriangleAlert,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { toast } from "sonner"

import { ChartCanvas } from "@/components/chart/chart-canvas"
import { ChartTypeMenu } from "@/components/chart/chart-type-menu"
import { DrawingRail } from "@/components/chart/drawing-rail"
import { IndicatorLayers } from "@/components/chart/indicator-layers"
import { IndicatorMenu } from "@/components/chart/indicator-menu"
import { IndicatorSettingsDialog } from "@/components/chart/indicator-settings-dialog"
import { SymbolSearch } from "@/components/chart/symbol-search"
import { useSession } from "@/components/session-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  api,
  ApiError,
  type Candle,
  type CandleResponse,
  type Instrument,
  type InstrumentSearchResult,
} from "@/lib/api"
import {
  CHART_KINDS,
  DEFAULT_INTERVAL_ID,
  INTERVALS,
  intervalById,
  type ChartKind,
  type IntervalEntry,
} from "@/lib/chart-catalog"
import {
  DEFAULT_TRANSFORM_PARAMS,
  type ActiveIndicator,
  type ChartTerminal,
  type DrawingStateSummary,
  type TransformParams,
} from "@/lib/chart-terminal"
import {
  countdown,
  decimal,
  istStamp,
  quantity,
  rupees,
  sessionLabel,
  signed,
} from "@/lib/format"
import { cn } from "@/lib/utils"

const WORKSPACE_KEY = "upstox-chart-workspace"
const LAYOUT_PREFIX = "upstox-chart-layout:"
const SAVE_DELAY_MS = 500

/* One frozen identity, so an empty response never re-anchors the canvas. */
const NO_CANDLES: Candle[] = []

const EMPTY_SUMMARY: DrawingStateSummary = {
  tool: null,
  count: 0,
  canUndo: false,
  canRedo: false,
  selected: null,
}

interface Workspace {
  symbol: string
  /* Set once the symbol came from the instrument master, so an exact contract
     (an index, a specific expiry) reloads as itself instead of by name. */
  instrumentKey: string | null
  intervalId: string
  chartKind: ChartKind
  params: TransformParams
  volume: boolean
  grid: boolean
  logScale: boolean
  magnet: boolean
}

const DEFAULT_WORKSPACE: Workspace = {
  symbol: "RELIANCE",
  instrumentKey: null,
  intervalId: DEFAULT_INTERVAL_ID,
  chartKind: "candlestick",
  params: DEFAULT_TRANSFORM_PARAMS,
  volume: true,
  grid: true,
  logScale: false,
  magnet: false,
}

function isChartKind(value: unknown): value is ChartKind {
  return CHART_KINDS.some((entry) => entry.id === value)
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

/* Every transform size throws in its constructor when it is not positive. */
function sizeOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

/*
  A stored workspace is user data from an older build, so every field is
  re-validated on the way in and a bad one falls back rather than throwing.
*/
function readWorkspace(): Workspace {
  try {
    const stored = localStorage.getItem(WORKSPACE_KEY)
    if (!stored) return DEFAULT_WORKSPACE

    const saved = JSON.parse(stored) as Partial<Workspace> | null
    if (!saved || typeof saved !== "object") return DEFAULT_WORKSPACE

    const params = (saved.params ?? {}) as Partial<TransformParams>
    const fallback = DEFAULT_TRANSFORM_PARAMS

    return {
      symbol:
        typeof saved.symbol === "string" && saved.symbol.length > 0
          ? saved.symbol
          : DEFAULT_WORKSPACE.symbol,
      instrumentKey:
        typeof saved.instrumentKey === "string" && saved.instrumentKey.length > 0
          ? saved.instrumentKey
          : null,
      intervalId: intervalById(
        typeof saved.intervalId === "string" ? saved.intervalId : DEFAULT_INTERVAL_ID
      ).id,
      chartKind: isChartKind(saved.chartKind)
        ? saved.chartKind
        : DEFAULT_WORKSPACE.chartKind,
      params: {
        renkoBox: sizeOr(params.renkoBox, fallback.renkoBox),
        rangeSize: sizeOr(params.rangeSize, fallback.rangeSize),
        lineBreakLines: sizeOr(params.lineBreakLines, fallback.lineBreakLines),
        pfBox: sizeOr(params.pfBox, fallback.pfBox),
        kagiReversal: sizeOr(params.kagiReversal, fallback.kagiReversal),
      },
      volume: boolOr(saved.volume, DEFAULT_WORKSPACE.volume),
      grid: boolOr(saved.grid, DEFAULT_WORKSPACE.grid),
      logScale: boolOr(saved.logScale, DEFAULT_WORKSPACE.logScale),
      magnet: boolOr(saved.magnet, DEFAULT_WORKSPACE.magnet),
    }
  } catch {
    return DEFAULT_WORKSPACE
  }
}

function IntervalSwitcher({
  value,
  onChange,
}: {
  value: string
  onChange: (id: string) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Candle interval"
      className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-hairline bg-panel-raised p-0.5"
    >
      {INTERVALS.map((entry) => {
        const selected = entry.id === value
        return (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(entry.id)}
            className={cn(
              "shrink-0 rounded-sm px-2 py-1 font-mono text-xs tabular transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              selected
                ? "bg-primary/15 text-violet"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {entry.label}
          </button>
        )
      })}
    </div>
  )
}

function ChromeToggle({
  label,
  icon: Icon,
  pressed,
  onPressedChange,
}: {
  label: string
  icon: LucideIcon
  pressed: boolean
  onPressedChange: (on: boolean) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          size="sm"
          variant="outline"
          pressed={pressed}
          onPressedChange={onPressedChange}
          aria-label={label}
          className="text-muted-foreground data-[state=on]:bg-primary/15 data-[state=on]:text-violet"
        >
          <Icon />
        </Toggle>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function IconAction({
  label,
  icon: Icon,
  onClick,
  spin,
  className,
}: {
  label: string
  icon: LucideIcon
  onClick: () => void
  spin?: boolean
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
          className={cn("text-muted-foreground hover:text-foreground", className)}
        >
          <Icon className={cn(spin && "animate-spin")} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The house mark: one candle, body and wick. */
function CandleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 22 22" aria-hidden="true">
      <line x1="11" y1="1" x2="11" y2="21" stroke="var(--violet)" strokeWidth="1.8" />
      <rect
        x="5.5"
        y="6"
        width="11"
        height="10"
        rx="1.5"
        fill="var(--ink)"
        stroke="var(--violet)"
        strokeWidth="1.8"
      />
    </svg>
  )
}

/* The only separator in the chrome. One pixel, never a border on a control. */
function Divider() {
  return <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-hairline" />
}

/** A labelled number on the status line. */
function Reading({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "up" | "down"
}) {
  return (
    <span className="flex shrink-0 items-baseline gap-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className={cn(tone === "up" && "text-up", tone === "down" && "text-down")}>
        {value}
      </span>
    </span>
  )
}

export function ChartPage() {
  const { status, secondsLeft, lifetimeFraction } = useSession()
  const connected = Boolean(status?.connected) && secondsLeft > 0

  /* Read the stored workspace once per mount, not once per module load. */
  const bootRef = useRef<Workspace | null>(null)
  if (bootRef.current === null) bootRef.current = readWorkspace()
  const boot = bootRef.current

  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [symbol, setSymbol] = useState(boot.symbol)
  const [instrumentKey, setInstrumentKey] = useState<string | null>(boot.instrumentKey)
  const [intervalId, setIntervalId] = useState(boot.intervalId)
  const [data, setData] = useState<CandleResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [chartKind, setChartKind] = useState<ChartKind>(boot.chartKind)
  const [params, setParams] = useState<TransformParams>(boot.params)
  const [volume, setVolume] = useState(boot.volume)
  const [grid, setGrid] = useState(boot.grid)
  const [logScale, setLogScale] = useState(boot.logScale)
  const [magnet, setMagnet] = useState(boot.magnet)
  const [tool, setTool] = useState<string | null>(null)
  const [panel, setPanel] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)

  const [terminal, setTerminal] = useState<ChartTerminal | null>(null)
  const [indicators, setIndicators] = useState<ActiveIndicator[]>([])
  const [drawings, setDrawings] = useState<DrawingStateSummary>(EMPTY_SUMMARY)
  const [settingsId, setSettingsId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  /* The imperative handle, kept in a ref so no toolbar callback depends on it. */
  const terminalRef = useRef<ChartTerminal | null>(null)

  const interval = intervalById(intervalId)
  const layoutKey = `${LAYOUT_PREFIX}${symbol}`

  const layoutKeyRef = useRef(layoutKey)
  layoutKeyRef.current = layoutKey

  /* The chrome the terminal has to be told about again after a restore. */
  const chromeRef = useRef({ volume, grid, logScale, magnet })
  chromeRef.current = { volume, grid, logScale, magnet }

  /* --------------------------------------------------------------- data */

  useEffect(() => {
    api.getInstruments().then(setInstruments).catch(() => setInstruments([]))
  }, [])

  /* A ticket per request: switching symbol twice must not land out of order. */
  const requestRef = useRef(0)

  const load = useCallback(
    async (
      target: string,
      key: string | null,
      entry: IntervalEntry,
      announce: boolean
    ) => {
      const ticket = requestRef.current + 1
      requestRef.current = ticket

      setLoading(true)
      setError(null)
      try {
        const next = await api.getCandles(target, {
          unit: entry.unit,
          interval: entry.interval,
          sessions: entry.sessions,
          instrumentKey: key,
        })
        if (requestRef.current !== ticket) return

        setData(next)
        if (announce) {
          toast.success(
            `${next.candles.length} candles loaded for ${next.instrument.symbol}`
          )
        }
        if (next.notice) toast.warning(next.notice)
      } catch (exception) {
        if (requestRef.current !== ticket) return
        const message =
          exception instanceof ApiError ? exception.message : "Could not load candles"
        setError(message)
        setData(null)
      } finally {
        if (requestRef.current === ticket) setLoading(false)
      }
    },
    []
  )

  // intervalById hands back the entry out of INTERVALS, so the identity is
  // stable for an id and this only refires on a real interval change.
  useEffect(() => {
    void load(symbol, instrumentKey, interval, false)
  }, [symbol, instrumentKey, interval, load])

  const refresh = useCallback(() => {
    void load(symbol, instrumentKey, interval, true)
  }, [load, symbol, instrumentKey, interval])

  /* A search hit carries its own key, so the exact contract is what gets charted. */
  const pickInstrument = useCallback((row: InstrumentSearchResult) => {
    setSymbol(row.trading_symbol)
    setInstrumentKey(row.instrument_key)
  }, [])

  /* --------------------------------------------------- layout persistence */

  const pendingRef = useRef<{ key: string; timer: number } | null>(null)

  /* Which key the live chart currently holds, and on which terminal. */
  const restoredRef = useRef<{ key: string; terminal: ChartTerminal } | null>(null)

  /*
    Scheduled by hand rather than from an effect on the drawing summary: moving
    a shape changes its geometry without changing the summary, and that edit
    still has to reach the store.
  */
  const scheduleLayoutSave = useCallback(() => {
    const key = layoutKeyRef.current

    /*
      Nothing may be written for a key the chart has not loaded yet. A blank
      chart emits an indicator and a drawing event while it is being built, and
      saving that would erase the very layout the restore is about to read.
    */
    if (restoredRef.current?.key !== key) return

    const pending = pendingRef.current
    if (pending !== null) window.clearTimeout(pending.timer)

    const timer = window.setTimeout(() => {
      pendingRef.current = null
      terminalRef.current?.saveLayout(key)
    }, SAVE_DELAY_MS)
    pendingRef.current = { key, timer }
  }, [])

  /* Writes the pending save under the key it was scheduled for, then drops it. */
  const flushLayoutSave = useCallback(() => {
    const pending = pendingRef.current
    if (pending === null) return
    window.clearTimeout(pending.timer)
    pendingRef.current = null
    terminalRef.current?.saveLayout(pending.key)
  }, [])

  /*
    The key just changed, which means the symbol did. Bank the outgoing
    symbol's pending save now, while the chart still holds its indicators,
    drawings and viewport. Declared before the restore so it always runs first.
  */
  useEffect(() => {
    flushLayoutSave()
  }, [layoutKey, flushLayoutSave])

  /*
    Restore once this symbol's bars are on the chart. Order matters twice over:
    a logical viewport indexes bars, so it means nothing on an empty chart, and
    the tier imports have to have run for a saved indicator or drawing id to
    resolve - which they have, because chart-terminal imports them at module
    scope.
  */
  const loaded = data !== null && data.instrument.symbol === symbol

  useEffect(() => {
    if (terminal === null || !loaded) return

    const done = restoredRef.current
    if (done !== null && done.key === layoutKey && done.terminal === terminal) return

    if (!terminal.restoreLayout(layoutKey)) {
      // Nothing stored for this symbol: start clean rather than inheriting the
      // previous symbol's indicators and drawings.
      terminal.clearIndicators()
      terminal.clearDrawings()
    }
    restoredRef.current = { key: layoutKey, terminal }

    // restoreState can overwrite grid and scale options, and the canvas will
    // not re-push props that did not change, so re-assert the chrome here.
    const chrome = chromeRef.current
    terminal.setVolumeVisible(chrome.volume)
    terminal.setGrid(chrome.grid)
    terminal.setLogScale(chrome.logScale)
    terminal.setMagnet(chrome.magnet)

    /*
      The instrument just changed, so any price range that came back with the
      layout belongs to a different price band. Autoscale to the bars that are
      actually loaded, or the candles render off screen.
    */
    terminal.autoscalePrices()

    setIndicators(terminal.activeIndicators())
    setDrawings(terminal.drawingSummary())
  }, [terminal, layoutKey, loaded])

  useEffect(() => {
    if (terminal === null) return
    scheduleLayoutSave()
  }, [terminal, layoutKey, chartKind, params, volume, grid, logScale, scheduleLayoutSave])

  // Leaving the page must not drop the last 500ms of work.
  useEffect(() => flushLayoutSave, [flushLayoutSave])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(
          WORKSPACE_KEY,
          JSON.stringify({
            symbol,
            instrumentKey,
            intervalId,
            chartKind,
            params,
            volume,
            grid,
            logScale,
            magnet,
          } satisfies Workspace)
        )
      } catch {
        // A blocked or full store is not worth an error on a chart page.
      }
    }, SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [symbol, instrumentKey, intervalId, chartKind, params, volume, grid, logScale, magnet])

  /* ----------------------------------------------------------- callbacks */

  const handleReady = useCallback((instance: ChartTerminal) => {
    terminalRef.current = instance
    setTerminal(instance)
  }, [])

  const handleIndicators = useCallback(
    (list: ActiveIndicator[]) => {
      setIndicators(list)
      scheduleLayoutSave()
    },
    [scheduleLayoutSave]
  )

  const handleDrawings = useCallback(
    (state: DrawingStateSummary) => {
      // Dragging a shape fires this on every pointer move; only a summary that
      // actually differs is worth a render.
      setDrawings((previous) =>
        previous.tool === state.tool &&
        previous.count === state.count &&
        previous.canUndo === state.canUndo &&
        previous.canRedo === state.canRedo &&
        previous.selected === state.selected
          ? previous
          : state
      )
      scheduleLayoutSave()
    },
    [scheduleLayoutSave]
  )

  const handleSettings = useCallback((instanceId: string) => {
    setSettingsId(instanceId)
    setSettingsOpen(true)
  }, [])

  const handleToolConsumed = useCallback(() => setTool(null), [])

  const handleParams = useCallback((patch: Partial<TransformParams>) => {
    setParams((previous) => ({ ...previous, ...patch }))
  }, [])

  const handleAddIndicator = useCallback((indicatorId: string) => {
    terminalRef.current?.addIndicator(indicatorId)
  }, [])

  const handleToggleIndicator = useCallback((instanceId: string, visible: boolean) => {
    terminalRef.current?.setIndicatorVisible(instanceId, visible)
  }, [])

  const handleRemoveIndicator = useCallback((instanceId: string) => {
    terminalRef.current?.removeIndicator(instanceId)
  }, [])

  const handleClearIndicators = useCallback(() => {
    terminalRef.current?.clearIndicators()
  }, [])

  const handleUndo = useCallback(() => terminalRef.current?.undo(), [])
  const handleRedo = useCallback(() => terminalRef.current?.redo(), [])
  const handleClearDrawings = useCallback(() => terminalRef.current?.clearDrawings(), [])

  const handleFit = useCallback(() => terminalRef.current?.fitContent(), [])

  const handleScreenshot = useCallback(() => {
    terminalRef.current?.downloadScreenshot(`${symbol}-${intervalId}.png`)
  }, [symbol, intervalId])

  /*
    Real full screen, not a CSS trick: the chart's own ResizeObserver picks up
    the new geometry, so nothing here has to tell it about the size change.
  */
  const toggleFullscreen = useCallback(() => {
    const root = document.documentElement
    if (document.fullscreenElement) void document.exitFullscreen()
    else void root.requestFullscreen().catch(() => undefined)
  }, [])

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement !== null)
    document.addEventListener("fullscreenchange", sync)
    return () => document.removeEventListener("fullscreenchange", sync)
  }, [])

  /* --------------------------------------------------------------- view */

  const lowOnTime = connected && secondsLeft < 3600
  const stats = data?.stats
  const rising = (stats?.change ?? 0) >= 0
  const candles = data?.candles ?? NO_CANDLES
  const instrument =
    data?.instrument ?? instruments.find((entry) => entry.symbol === symbol) ?? null
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ------------------------------------------------------ command bar */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline bg-panel px-2">
        <Link
          to="/"
          aria-label="Back to setup"
          className="flex shrink-0 items-center gap-2 rounded px-1 py-1 outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <CandleMark />
          <span className="hidden font-display text-[13px] font-semibold tracking-tight sm:inline">
            Upstox
          </span>
        </Link>

        <Divider />

        <SymbolSearch symbol={symbol} onSelect={pickInstrument} />

        {/* The curated five stay one click away, which the 125k-row search is not. */}
        <div className="hidden items-center gap-0.5 xl:flex">
          {instruments.map((entry) => (
            <button
              key={entry.symbol}
              type="button"
              onClick={() => {
                setSymbol(entry.symbol)
                setInstrumentKey(entry.instrument_key)
              }}
              className={cn(
                "rounded px-1.5 py-1 font-mono text-[10px] transition-colors",
                symbol === entry.symbol
                  ? "bg-primary/15 text-violet"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {entry.symbol}
            </button>
          ))}
        </div>

        <Divider />

        <IntervalSwitcher value={intervalId} onChange={setIntervalId} />

        <ChartTypeMenu
          value={chartKind}
          onChange={setChartKind}
          params={params}
          onParamsChange={handleParams}
        />

        <IndicatorMenu onAdd={handleAddIndicator} activeCount={indicators.length} />

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <ChromeToggle
            label="Volume"
            icon={ChartColumnBig}
            pressed={volume}
            onPressedChange={setVolume}
          />
          <ChromeToggle
            label="Grid"
            icon={Grid3x3}
            pressed={grid}
            onPressedChange={setGrid}
          />
          <ChromeToggle
            label="Logarithmic scale"
            icon={Ruler}
            pressed={logScale}
            onPressedChange={setLogScale}
          />

          <Divider />

          <IconAction label="Fit content" icon={Maximize2} onClick={handleFit} />
          <IconAction label="Screenshot" icon={Camera} onClick={handleScreenshot} />
          <IconAction
            label={fullscreen ? "Leave full screen" : "Full screen"}
            icon={fullscreen ? Minimize : Expand}
            onClick={toggleFullscreen}
          />
          <IconAction
            label="Reload candles"
            icon={loading ? Loader2 : RefreshCw}
            onClick={refresh}
            spin={loading}
          />

          <Divider />

          {connected ? (
            <span className="flex items-center gap-1.5 pr-1">
              <span className="size-1.5 rounded-full bg-up" />
              <span className="eyebrow tabular hidden md:inline">
                {countdown(secondsLeft)}
              </span>
            </span>
          ) : (
            <Button
              asChild
              variant="ghost"
              size="xs"
              className="text-amber hover:bg-amber/10 hover:text-amber"
            >
              <Link to="/">
                <TriangleAlert />
                Offline
              </Link>
            </Button>
          )}
        </div>
      </div>

      {/*
        Signature. An Upstox token always dies at 3:30 AM IST, so the terminal
        carries one hairline that drains as the session burns down. Full bleed,
        two pixels, and the only thing on screen that moves on its own.
      */}
      <div className="relative h-[2px] shrink-0 bg-hairline">
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-1000 ease-linear"
          style={{
            width: connected ? `${lifetimeFraction * 100}%` : "0%",
            background: lowOnTime
              ? "var(--amber)"
              : "linear-gradient(90deg, var(--violet-dim), var(--violet))",
          }}
        />
      </div>

      {/* ------------------------------------------------------------- body */}
      <div className="flex min-h-0 flex-1">
        <div className="shrink-0 border-r border-hairline">
          <DrawingRail
            tool={tool}
            onToolChange={setTool}
            magnet={magnet}
            onMagnetChange={setMagnet}
            summary={drawings}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onClear={handleClearDrawings}
          />
        </div>

        {/*
          The canvas is mounted once and stays mounted. A refetch swaps the
          candles underneath it, so indicators, drawings and zoom survive.
        */}
        <div className="relative min-w-0 flex-1">
          <ChartCanvas
            className="h-full"
            title={
              <span className="flex items-baseline gap-1.5">
                <span className="font-display text-[12px] font-semibold tracking-tight">
                  {symbol}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {interval.label} · {instrument?.segment ?? "NSE"}
                </span>
              </span>
            }
            candles={candles}
            chartKind={chartKind}
            transformParams={params}
            volume={volume}
            grid={grid}
            logScale={logScale}
            magnet={magnet}
            tool={tool}
            onReady={handleReady}
            onIndicatorsChange={handleIndicators}
            onIndicatorSettings={handleSettings}
            onDrawingsChange={handleDrawings}
            onToolConsumed={handleToolConsumed}
          />


          {loading ? (
            <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-2 rounded border border-hairline bg-background/85 px-2 py-1 backdrop-blur-sm">
              <Loader2 className="size-3 animate-spin text-muted-foreground" />
              <span className="eyebrow">{interval.label}</span>
            </div>
          ) : null}

          {error ? (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-background/85 px-6 text-center backdrop-blur-sm">
              <TriangleAlert className="size-5 text-amber" />
              <p className="max-w-md text-sm text-muted-foreground">{error}</p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
                  <RefreshCw />
                  Try again
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/">Go to setup</Link>
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Panels earn their width only when the operator wants them. */}
        {panel ? (
          <aside className="flex w-64 shrink-0 flex-col border-l border-hairline bg-panel">
            <Tabs defaultValue="studies" className="flex min-h-0 flex-1 flex-col gap-0">
              <div className="flex items-center gap-1 border-b border-hairline px-1.5 py-1">
                <TabsList className="h-7 bg-transparent p-0">
                  <TabsTrigger value="studies" className="h-6 px-2 text-[11px]">
                    Studies
                  </TabsTrigger>
                  <TabsTrigger value="sessions" className="h-6 px-2 text-[11px]">
                    Sessions
                  </TabsTrigger>
                </TabsList>
                <IconAction
                  label="Hide panel"
                  icon={PanelRightClose}
                  onClick={() => setPanel(false)}
                  className="ml-auto"
                />
              </div>

              <TabsContent value="studies" className="min-h-0 flex-1 p-2">
                <IndicatorLayers
                  indicators={indicators}
                  onToggle={handleToggleIndicator}
                  onRemove={handleRemoveIndicator}
                  onSettings={handleSettings}
                  onClearAll={handleClearIndicators}
                />
              </TabsContent>

              <TabsContent value="sessions" className="min-h-0 flex-1 overflow-y-auto p-2">
                {data?.sessions.length ? (
                  <ul className="space-y-1">
                    {data.sessions.map((session) => {
                      const label = sessionLabel(session.date)
                      const up = session.change_pct >= 0
                      return (
                        <li
                          key={session.date}
                          className="rounded border border-hairline bg-panel-raised px-2 py-1.5"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-mono text-[11px]">{label.date}</span>
                            <span className="eyebrow text-[9px]">{label.day}</span>
                          </div>
                          <div className="mt-1 flex items-baseline justify-between gap-2">
                            <span
                              className={cn(
                                "font-mono text-sm tabular",
                                up ? "text-up" : "text-down"
                              )}
                            >
                              {decimal(session.close)}
                            </span>
                            <span
                              className={cn(
                                "font-mono text-[10px] tabular",
                                up ? "text-up" : "text-down"
                              )}
                            >
                              {signed(session.change_pct)}%
                            </span>
                          </div>
                          <div className="mt-1 flex justify-between gap-2 font-mono text-[10px] tabular text-muted-foreground">
                            <span>H {decimal(session.high)}</span>
                            <span>L {decimal(session.low)}</span>
                            <span>{quantity(session.volume)}</span>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                    Sessions appear once candles load.
                  </p>
                )}
              </TabsContent>
            </Tabs>
          </aside>
        ) : (
          <div className="shrink-0 border-l border-hairline bg-panel p-1">
            <IconAction
              label="Show panel"
              icon={PanelRightOpen}
              onClick={() => setPanel(true)}
            />
          </div>
        )}
      </div>

      {/* ------------------------------------------------------- status bar */}
      <div className="flex h-8 shrink-0 items-center gap-3 overflow-x-auto border-t border-hairline bg-panel px-3 font-mono text-[11px] tabular">
        {loading && !stats ? (
          <Skeleton className="h-3 w-40 bg-secondary" />
        ) : stats ? (
          <>
            <span className="shrink-0 font-semibold">{rupees(stats.last_price)}</span>
            <span className={cn("shrink-0", rising ? "text-up" : "text-down")}>
              {signed(stats.change)} ({signed(stats.change_pct)}%)
            </span>
            <Divider />
            <Reading label="H" value={decimal(stats.day_high)} tone="up" />
            <Reading label="L" value={decimal(stats.day_low)} tone="down" />
            <Reading
              label={`${interval.sessions}S`}
              value={`${decimal(stats.range_low)} - ${decimal(stats.range_high)}`}
            />
            <Reading label="VOL" value={quantity(stats.total_volume)} />
            <Reading label="BARS" value={String(stats.candle_count)} />
          </>
        ) : (
          <span className="text-muted-foreground">No candles loaded</span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <span className="text-muted-foreground">
            {indicators.length} studies · {drawings.count} drawings
          </span>
          {data ? (
            <>
              <Divider />
              <Badge
                variant="secondary"
                className={cn(
                  "font-mono text-[9px]",
                  data.source === "cache" ? "text-amber" : "text-up"
                )}
              >
                {data.source === "cache" ? "SQLITE CACHE" : "UPSTOX LIVE"}
              </Badge>
              <span className="text-muted-foreground">{istStamp(data.fetched_at)}</span>
            </>
          ) : null}
        </div>
      </div>

      <IndicatorSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        instanceId={settingsId}
        terminal={terminal}
      />
    </div>
  )
}
