/*
  The React half of the terminal: mount, feed, unmount. Everything the chart
  actually does lives in ChartTerminal, so this file only has to obey the
  lifecycle rules - build once in an effect, keep the instance in a ref, destroy
  it in the cleanup - and push each prop through the matching imperative setter.
  No prop ever rebuilds the chart.
*/

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react"
import { ChartCandlestick } from "lucide-react"
import { formatIstDate, formatIstTime } from "openalgo-charts"
import { toast } from "sonner"

import type { Candle } from "@/lib/api"
import type { ChartKind } from "@/lib/chart-catalog"
import {
  ChartTerminal,
  type ActiveIndicator,
  type DrawingStateSummary,
  type HoverReading,
  type TransformParams,
} from "@/lib/chart-terminal"
import { decimal, quantity } from "@/lib/format"
import { cn } from "@/lib/utils"

export interface ChartCanvasHandle {
  terminal: () => ChartTerminal | null
}

export interface ChartCanvasProps {
  candles: Candle[]
  chartKind: ChartKind
  transformParams: TransformParams
  volume: boolean
  grid: boolean
  logScale: boolean
  magnet: boolean
  tool: string | null
  onReady: (terminal: ChartTerminal) => void
  onIndicatorsChange: (list: ActiveIndicator[]) => void
  onIndicatorSettings: (instanceId: string) => void
  onDrawingsChange: (state: DrawingStateSummary) => void
  onToolConsumed: () => void
  /** Rendered at the head of the legend line: symbol, interval, segment. */
  title?: ReactNode
  className?: string
}

/*
  The crosshair fires on every pointer move, but the legend only changes when it
  crosses into another bar. Comparing the reading before it reaches state keeps
  a pixel-by-pixel drag from re-rendering React sixty times a second.
*/
function sameReading(a: HoverReading | null, b: HoverReading | null): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  return a.time === b.time && a.close === b.close && a.volume === b.volume
}

function readingOf(candle: Candle): HoverReading {
  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }
}

export function ChartCanvas({
  candles,
  chartKind,
  transformParams,
  volume,
  grid,
  logScale,
  magnet,
  tool,
  onReady,
  onIndicatorsChange,
  onIndicatorSettings,
  onDrawingsChange,
  onToolConsumed,
  title,
  className,
  ref,
}: ChartCanvasProps & { ref?: Ref<ChartCanvasHandle> }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<ChartTerminal | null>(null)
  const [hover, setHover] = useState<HoverReading | null>(null)

  /*
    The terminal's callbacks are registered once at construction, so they read
    the current props through a ref. Putting the props themselves in the effect
    deps would tear the chart down on every parent render.
  */
  const handlers = useRef({
    onReady,
    onIndicatorsChange,
    onIndicatorSettings,
    onDrawingsChange,
    onToolConsumed,
  })
  handlers.current = {
    onReady,
    onIndicatorsChange,
    onIndicatorSettings,
    onDrawingsChange,
    onToolConsumed,
  }

  /* Which tool the rail believes is armed, so a commit can un-arm it once. */
  const armedRef = useRef<string | null>(null)

  /* First bar of the loaded window: a new one means a new symbol or interval. */
  const anchorRef = useRef<number | null>(null)

  useImperativeHandle(ref, () => ({ terminal: () => terminalRef.current }), [])

  // Create and destroy. Empty deps on purpose: the chart outlives every prop.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Captured per effect run, so a Strict Mode remount cannot let the first
    // instance's callbacks write into the second one's React state.
    let alive = true

    const terminal = new ChartTerminal(container, {
      onHover: (reading) => {
        if (!alive) return
        setHover((previous) => (sameReading(previous, reading) ? previous : reading))
      },
      onIndicatorsChange: (list) => {
        if (alive) handlers.current.onIndicatorsChange(list)
      },
      onIndicatorSettings: (instanceId) => {
        if (alive) handlers.current.onIndicatorSettings(instanceId)
      },
      onDrawingsChange: (state) => {
        if (!alive) return
        handlers.current.onDrawingsChange(state)
        /*
          The controller runs with stayInDrawingMode off, so committing a shape
          drops it back to no tool. That is the only signal the rail gets that
          its armed button should pop back out.
        */
        if (state.tool === null && armedRef.current !== null) {
          armedRef.current = null
          handlers.current.onToolConsumed()
        }
      },
      onError: (message) => {
        if (alive) toast.error(message)
      },
    })

    terminalRef.current = terminal
    handlers.current.onReady(terminal)

    return () => {
      alive = false
      terminal.destroy()
      terminalRef.current = null
    }
  }, [])

  /*
    One effect per prop, all of them pushing into a chart that already exists.
    Declaration order is the apply order on mount and on a Strict Mode remount,
    so the renderer and its transform settle before the bars arrive.
  */

  useEffect(() => {
    terminalRef.current?.setChartKind(chartKind)
  }, [chartKind])

  const { renkoBox, rangeSize, lineBreakLines, pfBox, kagiReversal } = transformParams

  // Depending on the numbers rather than the object means an inline params
  // literal from the parent cannot force a redraw of a Renko or Kagi chart.
  useEffect(() => {
    terminalRef.current?.setTransformParams({
      renkoBox,
      rangeSize,
      lineBreakLines,
      pfBox,
      kagiReversal,
    })
  }, [renkoBox, rangeSize, lineBreakLines, pfBox, kagiReversal])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    terminal.setCandles(candles)
    setHover(null)

    /*
      Fit only when the window itself moved. A refresh that appends the newest
      bar must not throw away the zoom the trader set.
    */
    const anchor = candles.length > 0 ? candles[0].time : null
    if (anchor !== null && anchor !== anchorRef.current) {
      anchorRef.current = anchor
      terminal.fitContent()
    }
  }, [candles])

  useEffect(() => {
    terminalRef.current?.setVolumeVisible(volume)
  }, [volume])

  useEffect(() => {
    terminalRef.current?.setGrid(grid)
  }, [grid])

  useEffect(() => {
    terminalRef.current?.setLogScale(logScale)
  }, [logScale])

  useEffect(() => {
    terminalRef.current?.setMagnet(magnet)
  }, [magnet])

  useEffect(() => {
    armedRef.current = tool
    terminalRef.current?.setTool(tool)
  }, [tool])

  const last = candles.length > 0 ? candles[candles.length - 1] : null
  const readout = hover ?? (last === null ? null : readingOf(last))
  const rising =
    readout === null || readout.close === null || readout.open === null
      ? true
      : readout.close >= readout.open

  return (
    <div className={cn("relative", className)}>
      {/*
        A resolved height is mandatory: an auto-height parent gives the canvas
        zero pixels. The library's own ResizeObserver does the rest, so there is
        no width or height prop and no window listener here.
      */}
      {/* Fills whatever the caller sized. The chart's own ResizeObserver does
          the rest, so the height belongs to the layout, not to this component. */}
      <div ref={containerRef} className="h-full w-full" />

      {/*
        One legend line, unboxed, the way a desk reads a chart. The library
        draws its own indicator rows on canvas below this, which is what
        legendOffset in ChartTerminal reserves room for.
      */}
      {readout === null ? null : (
        <div className="pointer-events-none absolute left-2.5 top-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[11px] tabular">
          {title}
          <span className="text-muted-foreground">
            {readout.time === null
              ? "--"
              : `${formatIstDate(readout.time)} ${formatIstTime(readout.time)}`}
          </span>
          {(
            [
              ["O", readout.open],
              ["H", readout.high],
              ["L", readout.low],
              ["C", readout.close],
            ] as const
          ).map(([label, value]) => (
            <span key={label} className="flex gap-1">
              <span className="text-muted-foreground">{label}</span>
              <span className={cn(rising ? "text-up" : "text-down")}>
                {value === null ? "--" : decimal(value)}
              </span>
            </span>
          ))}
          {readout.volume === null ? null : (
            <span className="flex gap-1">
              <span className="text-muted-foreground">VOL</span>
              <span>{quantity(readout.volume)}</span>
            </span>
          )}
        </div>
      )}

      {candles.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <ChartCandlestick className="size-6 text-muted-foreground" />
          <p className="font-display text-sm text-foreground">Nothing to plot yet</p>
          <p className="eyebrow text-muted-foreground">
            Choose a symbol and an interval to load candles
          </p>
        </div>
      ) : null}
    </div>
  )
}
