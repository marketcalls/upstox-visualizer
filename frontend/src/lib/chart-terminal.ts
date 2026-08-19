/*
  Everything the chart does that is not rendering React: series lifecycle,
  transforms, indicators, drawings, persistence. Deliberately a plain class with
  no React import, so a 60 fps crosshair never becomes a state update and the
  component that mounts it is only a constructor plus a destroy.
*/

import {
  createChart,
  darkTheme,
  getIndicator,
  hasIndicator,
  type Bar,
  type Chart,
  type IndicatorApi,
  type SeriesApi,
  type SeriesStyle,
  type SeriesType,
} from "openalgo-charts"

// Side-effect import: registers the 86 built-in indicator descriptors.
import "openalgo-charts/indicators"

// Importing these bindings evaluates the tier, which registers the
// 'point-figure' and 'kagi' renderers.
import {
  HeikinAshiTransform,
  KagiTransform,
  LineBreakTransform,
  PointFigureTransform,
  RangeBarsTransform,
  RenkoTransform,
  runTransform,
  type ISeriesTransform,
} from "openalgo-charts/transform"

// Same again: this evaluates the draw tier and registers the 43 built-in tools.
import { DrawingController } from "openalgo-charts/draw"

import type { Candle } from "@/lib/api"
import type { ChartKind } from "@/lib/chart-catalog"

export interface ActiveIndicator {
  id: string
  indicatorId: string
  name: string
  paneIndex: number
  visible: boolean
}

export interface HoverReading {
  time: number | null
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
}

export interface DrawingStateSummary {
  tool: string | null
  count: number
  canUndo: boolean
  canRedo: boolean
  selected: string | null
}

export interface TransformParams {
  renkoBox: number
  rangeSize: number
  lineBreakLines: number
  pfBox: number
  kagiReversal: number
}

/** Box and range sizes are in rupees; the toolbar lets the desk retune them. */
export const DEFAULT_TRANSFORM_PARAMS: TransformParams = {
  renkoBox: 5,
  rangeSize: 5,
  lineBreakLines: 3,
  pfBox: 5,
  kagiReversal: 10,
}

export interface TerminalCallbacks {
  onHover?: (reading: HoverReading | null) => void
  onIndicatorsChange?: (list: ActiveIndicator[]) => void
  onIndicatorSettings?: (instanceId: string) => void
  onDrawingsChange?: (state: DrawingStateSummary) => void
  onError?: (message: string) => void
}

const UP = "#16c784"
const DOWN = "#f04452"
const VIOLET = "#7b61ff"
const VOLUME_UP = "rgba(22,199,132,0.35)"
const VOLUME_DOWN = "rgba(240,68,82,0.35)"

const CANDLE_STYLE: SeriesStyle = {
  upColor: UP,
  downColor: DOWN,
  borderUpColor: UP,
  borderDownColor: DOWN,
  wickUpColor: UP,
  wickDownColor: DOWN,
}

/*
  Kinds that are a transform of the raw bars, mapped to the renderer that draws
  the result. Heikin Ashi, Renko, Range and Line Break emit ordinary bars, so
  they all come out as candles; only P&F and Kagi have renderers of their own.
  Membership of this map is also what disables the volume overlay, because a
  transform re-times every element.
*/
const TRANSFORM_TARGETS: Partial<Record<ChartKind, SeriesType>> = {
  "heikin-ashi": "candlestick",
  renko: "candlestick",
  "range-bars": "candlestick",
  "line-break": "candlestick",
  "point-figure": "point-figure",
  kagi: "kagi",
}

const DRAW_EVENTS = [
  "draw:tool",
  "draw:add",
  "draw:update",
  "draw:remove",
  "draw:select",
] as const

const EMPTY_DRAWINGS: DrawingStateSummary = {
  tool: null,
  count: 0,
  canUndo: false,
  canRedo: false,
  selected: null,
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describe(api: IndicatorApi): ActiveIndicator {
  return {
    id: api.id,
    indicatorId: api.indicatorId,
    name: api.name,
    paneIndex: api.paneIndex,
    visible: api.visible(),
  }
}

/*
  Column and histogram renderers grow from `base`, which defaults to zero. On a
  price series that stretches every bar from the axis origin and flattens the
  detail, so anchor the base just under the lowest low instead.
*/
function baseUnder(bars: readonly Bar[]): number {
  if (bars.length === 0) return 0
  let low = Infinity
  let high = -Infinity
  for (const bar of bars) {
    if (bar.low < low) low = bar.low
    if (bar.high > high) high = bar.high
  }
  return low - (high - low) * 0.05
}

export class ChartTerminal {
  private readonly callbacks: TerminalCallbacks
  private chart: Chart | null
  private price: SeriesApi | null = null
  private volume: SeriesApi | null = null
  private drawings: DrawingController | null = null
  private offs: Array<() => void> = []

  /* Raw bars are kept so a chart-kind change re-derives without a refetch. */
  private raw: Bar[] = []
  private seriesType: SeriesType = "candlestick"
  private kind: ChartKind = "candlestick"
  private params: TransformParams = { ...DEFAULT_TRANSFORM_PARAMS }

  private volumeOn = true
  private gridOn = true
  private logOn = false
  private magnetOn = false
  private destroyed = false

  constructor(container: HTMLElement, callbacks: TerminalCallbacks = {}) {
    this.callbacks = callbacks

    const chart = createChart(container, {
      theme: darkTheme,
      crosshairMode: "magnet",
      ariaLabel: "Interactive price chart",
      /*
        Indicator legend rows are drawn on canvas from this origin. The host
        renders its own symbol and OHLC line at the very top, so the rows start
        below it instead of printing over it.
      */
      legendOffset: { top: 24, left: 10 },
    })
    this.chart = chart

    this.buildSeries("candlestick", [])

    this.drawings = new DrawingController(chart, {
      magnet: this.magnetOn,
      stayInDrawingMode: false,
      historyLimit: 100,
      defaultStyle: { color: VIOLET, lineWidth: 2 },
    })

    // The legend's own x button removes indicators behind our back, so the
    // active list is always re-read from the chart rather than tracked here.
    this.offs.push(chart.on("indicatorRemoved", () => this.emitIndicators()))

    this.offs.push(
      chart.on("indicatorSettings", (payload) => {
        const instanceId = (payload as { instanceId?: string } | null)?.instanceId
        if (instanceId) this.callbacks.onIndicatorSettings?.(instanceId)
      })
    )

    for (const event of DRAW_EVENTS) {
      this.offs.push(chart.on(event, () => this.emitDrawings()))
    }

    // Single-slot callback: registering a second one would replace this.
    chart.subscribeCrosshairMove((event) => {
      if (this.destroyed) return
      const bar = event.bar
      this.callbacks.onHover?.(
        bar === null
          ? null
          : {
              time: bar.time,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume ?? null,
            }
      )
    })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true

    for (const off of this.offs) off()
    this.offs = []

    // chart.destroy() does not tear the controller down, and a leaked one can
    // strand the chart in placement mode.
    this.drawings?.destroy()
    this.drawings = null

    this.chart?.destroy()
    this.chart = null
    this.price = null
    this.volume = null
  }

  /* ---------------------------------------------------------------- data */

  setCandles(candles: readonly Candle[]): void {
    if (this.destroyed) return
    // candle.time is already UTC seconds and the library labels the axis in
    // IST itself, so the timestamps are handed over untouched.
    this.raw = candles.map((candle) => ({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }))
    this.render()
  }

  setChartKind(kind: ChartKind): void {
    if (this.destroyed || kind === this.kind) return
    this.kind = kind
    this.render()
  }

  chartKind(): ChartKind {
    return this.kind
  }

  setTransformParams(patch: Partial<TransformParams>): void {
    if (this.destroyed) return
    this.params = { ...this.params, ...patch }
    if (TRANSFORM_TARGETS[this.kind]) this.render()
  }

  transformParams(): TransformParams {
    return { ...this.params }
  }

  /* -------------------------------------------------------------- chrome */

  setVolumeVisible(on: boolean): void {
    if (this.destroyed) return
    this.volumeOn = on
    this.syncVolume()
  }

  volumeVisible(): boolean {
    return this.volumeOn
  }

  setGrid(on: boolean): void {
    if (this.destroyed) return
    this.gridOn = on
    this.chart?.setGridOptions({ vertLines: on, horzLines: on })
  }

  gridVisible(): boolean {
    return this.gridOn
  }

  setLogScale(on: boolean): void {
    if (this.destroyed) return
    this.logOn = on
    this.applyPriceScale()
  }

  logScale(): boolean {
    return this.logOn
  }

  /* ---------------------------------------------------------- indicators */

  addIndicator(indicatorId: string): ActiveIndicator | null {
    const chart = this.chart
    if (!chart) return null

    // Probe the registry rather than catching the throw from addIndicator.
    if (!hasIndicator(indicatorId)) {
      this.fail(`"${indicatorId}" is not a registered indicator.`)
      return null
    }

    try {
      const api = chart.addIndicator(indicatorId)
      this.emitIndicators()
      return describe(api)
    } catch (error) {
      this.fail(`Could not add ${indicatorId}: ${messageOf(error)}`)
      return null
    }
  }

  removeIndicator(instanceId: string): void {
    // The removal fires indicatorRemoved, which is what refreshes the list.
    this.chart?.removeIndicator(instanceId)
  }

  setIndicatorVisible(instanceId: string, on: boolean): void {
    const api = this.indicatorApi(instanceId)
    if (!api) return
    api.setVisible(on)
    this.emitIndicators()
  }

  getIndicatorSettings(instanceId: string): Record<string, unknown> | null {
    return this.indicatorApi(instanceId)?.settings() ?? null
  }

  setIndicatorSettings(instanceId: string, patch: Record<string, unknown>): void {
    const api = this.indicatorApi(instanceId)
    if (!api) return
    try {
      api.setSettings(patch)
    } catch (error) {
      this.fail(`Could not apply the ${api.name} settings: ${messageOf(error)}`)
      return
    }
    this.emitIndicators()
  }

  /** The library descriptor, so a dialog can build its own form from the inputs. */
  indicatorDescriptorFor(instanceId: string): unknown | null {
    const api = this.indicatorApi(instanceId)
    if (!api || !hasIndicator(api.indicatorId)) return null
    return getIndicator(api.indicatorId)
  }

  activeIndicators(): ActiveIndicator[] {
    return (this.chart?.indicators() ?? []).map(describe)
  }

  clearIndicators(): void {
    const chart = this.chart
    if (!chart) return
    // Snapshot first: removing mutates the list this would otherwise iterate.
    for (const api of [...chart.indicators()]) chart.removeIndicator(api.id)
  }

  /* ------------------------------------------------------------ drawings */

  setTool(toolId: string | null): void {
    if (this.destroyed) return
    try {
      this.drawings?.setTool(toolId)
    } catch (error) {
      this.fail(messageOf(error))
    }
  }

  activeTool(): string | null {
    return this.drawings?.activeTool() ?? null
  }

  setMagnet(on: boolean): void {
    if (this.destroyed) return
    this.magnetOn = on
    this.drawings?.setOptions({ magnet: on })
  }

  magnet(): boolean {
    return this.magnetOn
  }

  // undo, redo and clear sync the layers but emit no bus event, so the summary
  // has to be pushed by hand.
  undo(): void {
    this.drawings?.undo()
    this.emitDrawings()
  }

  redo(): void {
    this.drawings?.redo()
    this.emitDrawings()
  }

  clearDrawings(): void {
    this.drawings?.clear()
    this.emitDrawings()
  }

  drawingSummary(): DrawingStateSummary {
    const controller = this.drawings
    if (!controller) return { ...EMPTY_DRAWINGS }
    return {
      tool: controller.activeTool(),
      count: controller.drawings().length,
      canUndo: controller.canUndo(),
      canRedo: controller.canRedo(),
      selected: controller.selected(),
    }
  }

  /* ----------------------------------------------------------- viewport */

  fitContent(): void {
    this.chart?.fitContent()
  }

  resetScale(): void {
    this.chart?.resetScale()
  }

  /*
    A saved layout carries `autoScale: false` plus the pinned range that was on
    screen when it was written. Restoring that for a different instrument leaves
    the new candles outside the band and the pane looks empty, with only the
    volume overlay visible because it owns a separate hidden scale. The bars
    that just loaded are the authority on the price band, so hand every pane
    back to autoscale after a restore. The time viewport is left alone.
  */
  autoscalePrices(): void {
    const chart = this.chart
    if (!chart) return
    for (const pane of chart.panes()) pane.priceScale.setAutoScale(true)
  }

  downloadScreenshot(filename: string): void {
    this.chart?.downloadScreenshot(filename)
  }

  saveLayout(key: string): void {
    const chart = this.chart
    if (!chart) return
    try {
      localStorage.setItem(key, JSON.stringify(chart.getState()))
    } catch (error) {
      this.fail(`Could not save the layout: ${messageOf(error)}`)
    }
  }

  restoreLayout(key: string): boolean {
    const chart = this.chart
    if (!chart) return false

    try {
      const stored = localStorage.getItem(key)
      if (!stored) return false

      const report = chart.restoreState(JSON.parse(stored) as unknown)
      if (!report.applied) return false

      // restoreState overwrites the drawing slot but does not push it into an
      // already-live controller, so hand it over explicitly.
      this.drawings?.fromJSON(chart.drawingState())

      this.gridOn = chart.gridOptions().vertLines
      this.emitIndicators()
      this.emitDrawings()
      return true
    } catch (error) {
      this.fail(`Could not restore the layout: ${messageOf(error)}`)
      return false
    }
  }

  /* ------------------------------------------------------------ internal */

  private indicatorApi(instanceId: string): IndicatorApi | null {
    return this.chart?.indicators().find((api) => api.id === instanceId) ?? null
  }

  private fail(message: string): void {
    this.callbacks.onError?.(message)
  }

  private emitIndicators(): void {
    if (this.destroyed) return
    this.callbacks.onIndicatorsChange?.(this.activeIndicators())
  }

  private emitDrawings(): void {
    if (this.destroyed) return
    this.callbacks.onDrawingsChange?.(this.drawingSummary())
  }

  /** Derive the bars to draw and the renderer that draws them. */
  private resolve(): { type: SeriesType; bars: Bar[] } {
    const target = TRANSFORM_TARGETS[this.kind]

    // Untransformed kinds are their own series type, one for one.
    if (!target) return { type: this.kind as SeriesType, bars: this.raw }

    try {
      const transform = this.buildTransform()
      if (!transform) return { type: this.kind as SeriesType, bars: this.raw }
      return { type: target, bars: runTransform(transform, this.raw) }
    } catch (error) {
      // A non-positive box, range or reversal throws in the constructor.
      this.fail(`${this.kind} needs a positive size: ${messageOf(error)}`)
      return { type: "candlestick", bars: this.raw }
    }
  }

  private buildTransform(): ISeriesTransform | null {
    const params = this.params
    switch (this.kind) {
      case "heikin-ashi":
        return new HeikinAshiTransform()
      case "renko":
        return new RenkoTransform({ boxSize: params.renkoBox })
      case "range-bars":
        return new RangeBarsTransform({ range: params.rangeSize })
      case "line-break":
        return new LineBreakTransform({ lines: params.lineBreakLines })
      case "point-figure":
        return new PointFigureTransform({ boxSize: params.pfBox })
      case "kagi":
        return new KagiTransform({ reversal: params.kagiReversal })
      default:
        return null
    }
  }

  private render(): void {
    const chart = this.chart
    if (!chart) return

    const { type, bars } = this.resolve()

    if (type === this.seriesType && this.price) {
      this.price.setData(this.paint(type, bars))
      this.applyPriceScale()
      this.syncVolume()
      return
    }

    // A series type cannot change in place, so keep the user's zoom across the
    // rebuild rather than snapping back to a fit.
    const before = chart.getVisibleLogicalRange()
    this.buildSeries(type, bars)
    if (
      before &&
      Number.isFinite(before.from) &&
      Number.isFinite(before.to) &&
      before.to > before.from
    ) {
      chart.setVisibleLogicalRange(before)
    }
  }

  /*
    Rebuild the price series and the volume overlay together. Removing the price
    series clears the chart's primary-series slot, so it has to be re-added
    before any overlay or the OHLC legend and magnet crosshair bind to the wrong
    one.
  */
  private buildSeries(type: SeriesType, bars: readonly Bar[]): void {
    const chart = this.chart
    if (!chart) return

    this.price?.remove()
    this.price = null
    this.volume?.remove()
    this.volume = null

    const painted = this.paint(type, bars)

    let series: SeriesApi
    try {
      series = chart.addSeries(type, { style: this.styleFor(type, painted) })
    } catch (error) {
      this.fail(`Could not draw a ${type} series: ${messageOf(error)}`)
      series = chart.addSeries("candlestick", { style: CANDLE_STYLE })
      type = "candlestick"
    }

    series.setData(painted)
    this.price = series
    this.seriesType = type
    this.applyPriceScale()

    this.volume = chart.addSeries("histogram", {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      style: { color: VOLUME_UP, priceLineVisible: false, lastValueVisible: false },
    })
    // Fractions of pane height: the bars sit in the bottom sixth, clear of the
    // candles, and pane 1 upwards stays free for indicators.
    this.volume.priceScale().setOptions({ marginTop: 0.84, marginBottom: 0 })
    this.syncVolume()
  }

  private applyPriceScale(): void {
    const price = this.price
    if (!price) return
    price.priceScale().setOptions({
      marginTop: 0.08,
      marginBottom: 0.22,
      mode: this.logOn ? "logarithmic" : "linear",
    })
    // setOptions merges but schedules no repaint of its own.
    price.applyOptions({})
  }

  private syncVolume(): void {
    const volume = this.volume
    if (!volume) return

    /*
      Every series shares one time axis. A transform re-times each element, so
      feeding the raw volume alongside it puts the raw timestamps back on that
      axis and the bricks render scattered. Hide the overlay instead.
    */
    const on = this.volumeOn && !TRANSFORM_TARGETS[this.kind]
    if (!on) {
      volume.setData([])
      volume.applyOptions({ visible: false })
      return
    }

    volume.applyOptions({ visible: true })
    volume.setData(
      this.raw.map((bar) => ({
        time: bar.time,
        value: bar.volume ?? 0,
        color: bar.close >= bar.open ? VOLUME_UP : VOLUME_DOWN,
      }))
    )
  }

  /** Column and histogram renderers read a per-bar colour; nothing else does. */
  private paint(type: SeriesType, bars: readonly Bar[]): Bar[] {
    if (type !== "column" && type !== "histogram") return [...bars]
    return bars.map((bar) => ({
      ...bar,
      color: bar.close >= bar.open ? UP : DOWN,
    }))
  }

  private styleFor(type: SeriesType, bars: readonly Bar[]): SeriesStyle {
    switch (type) {
      case "candlestick":
      case "hollow-candle":
      case "volume-candle":
      case "bar":
      case "high-low":
        return CANDLE_STYLE
      case "line":
      case "line-markers":
      case "step":
        return { color: VIOLET, lineWidth: 2 }
      case "area":
        return {
          color: VIOLET,
          lineWidth: 2,
          areaTopColor: "rgba(123,97,255,0.34)",
          areaBottomColor: "rgba(123,97,255,0)",
        }
      case "hlc-area":
        return { highColor: UP, lowColor: DOWN, closeColor: VIOLET, lineWidth: 1.5 }
      case "baseline":
        // The default baseValue is 0, which would paint an entire price series
        // as "above base"; the opening print is the useful split.
        return {
          topColor: UP,
          bottomColor: DOWN,
          lineWidth: 2,
          baseValue: bars.length > 0 ? bars[0].close : 0,
        }
      case "column":
      case "histogram":
        return { color: VIOLET, base: baseUnder(bars) }
      case "point-figure":
        return { upColor: UP, downColor: DOWN }
      case "kagi":
        return { thickColor: UP, thinColor: DOWN }
      default:
        return {}
    }
  }
}
