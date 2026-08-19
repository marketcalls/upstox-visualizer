/*
  Static catalogues for the chart terminal. Plain data with no chart-library
  import, so the toolbar, the terminal class and the fetch layer can all read
  the same list without pulling the renderer into their bundle.
*/

export type ChartKind =
  | "candlestick"
  | "hollow-candle"
  | "volume-candle"
  | "bar"
  | "high-low"
  | "line"
  | "line-markers"
  | "step"
  | "area"
  | "hlc-area"
  | "baseline"
  | "column"
  | "histogram"
  | "point-figure"
  | "kagi"
  | "heikin-ashi"
  | "renko"
  | "range-bars"
  | "line-break"

export type ChartKindGroup = "Candles" | "Lines" | "Transformed"

export interface ChartKindEntry {
  id: ChartKind
  name: string
  group: ChartKindGroup
}

/*
  "Transformed" is the group whose bars are re-bucketed by price movement
  instead of the clock, which is also the group that invalidates the volume
  overlay and any time-anchored drawing. Grouping mirrors that behaviour, not
  just the visual family.
*/
export const CHART_KINDS: readonly ChartKindEntry[] = [
  { id: "candlestick", name: "Candlestick", group: "Candles" },
  { id: "hollow-candle", name: "Hollow candle", group: "Candles" },
  { id: "volume-candle", name: "Volume candle", group: "Candles" },
  { id: "bar", name: "OHLC bar", group: "Candles" },
  { id: "high-low", name: "High low", group: "Candles" },

  { id: "line", name: "Line", group: "Lines" },
  { id: "line-markers", name: "Line with markers", group: "Lines" },
  { id: "step", name: "Step line", group: "Lines" },
  { id: "area", name: "Area", group: "Lines" },
  { id: "hlc-area", name: "HLC area", group: "Lines" },
  { id: "baseline", name: "Baseline", group: "Lines" },
  { id: "column", name: "Column", group: "Lines" },
  { id: "histogram", name: "Histogram", group: "Lines" },

  { id: "heikin-ashi", name: "Heikin Ashi", group: "Transformed" },
  { id: "renko", name: "Renko", group: "Transformed" },
  { id: "range-bars", name: "Range bars", group: "Transformed" },
  { id: "line-break", name: "Line break", group: "Transformed" },
  { id: "point-figure", name: "Point and figure", group: "Transformed" },
  { id: "kagi", name: "Kagi", group: "Transformed" },
]

export interface IntervalEntry {
  id: string
  label: string
  unit: "minutes" | "hours" | "days" | "weeks" | "months"
  interval: string
  sessions: number
}

/*
  `sessions` is how many trading days the backend keeps after trimming, capped
  at 30 by the route. A 1m chart over 30 days is 11k bars nobody reads, so the
  fine intervals ask for a few days and the coarse ones take the whole window.
*/
export const INTERVALS: readonly IntervalEntry[] = [
  { id: "1m", label: "1m", unit: "minutes", interval: "1", sessions: 2 },
  { id: "3m", label: "3m", unit: "minutes", interval: "3", sessions: 3 },
  { id: "5m", label: "5m", unit: "minutes", interval: "5", sessions: 5 },
  { id: "10m", label: "10m", unit: "minutes", interval: "10", sessions: 8 },
  { id: "15m", label: "15m", unit: "minutes", interval: "15", sessions: 12 },
  { id: "30m", label: "30m", unit: "minutes", interval: "30", sessions: 20 },
  { id: "1h", label: "1h", unit: "hours", interval: "1", sessions: 25 },
  { id: "4h", label: "4h", unit: "hours", interval: "4", sessions: 30 },
  { id: "1d", label: "1d", unit: "days", interval: "1", sessions: 30 },
  { id: "1w", label: "1w", unit: "weeks", interval: "1", sessions: 30 },
]

export const DEFAULT_INTERVAL_ID = "5m"

const DEFAULT_INTERVAL =
  INTERVALS.find((entry) => entry.id === DEFAULT_INTERVAL_ID) ?? INTERVALS[0]

/** Falls back to the default rather than throwing: a stale saved id is not an error. */
export function intervalById(id: string): IntervalEntry {
  return INTERVALS.find((entry) => entry.id === id) ?? DEFAULT_INTERVAL
}
