export type Settings = {
  configured: boolean
  api_key?: string | null
  api_secret_masked?: string | null
  redirect_uri: string
  updated_at?: string | null
  suggested_redirect_uri: string
}

export type AuthStatus = {
  connected: boolean
  configured: boolean
  user_id?: string | null
  user_name?: string | null
  email?: string | null
  broker?: string | null
  exchanges: string[]
  products: string[]
  issued_at?: string | null
  expires_at?: string | null
  seconds_to_expiry: number
}

export type Instrument = {
  symbol: string
  name: string
  instrument_key: string
  segment: string
}

/** One row of the instrument master, as the search box and chart header need it. */
export type InstrumentSearchResult = {
  instrument_key: string
  trading_symbol: string
  name?: string | null
  short_name?: string | null
  exchange?: string | null
  segment?: string | null
  instrument_type?: string | null
  isin?: string | null
  lot_size?: number | null
  /** Upstox publishes this in paise. Divide by 100 before showing a rupee tick. */
  tick_size?: number | null
  expiry?: string | null
  strike_price?: number | null
  underlying_key?: string | null
  underlying_symbol?: string | null
  weekly?: boolean | null
  security_type?: string | null
}

export type SegmentCount = {
  segment: string
  count: number
}

export type InstrumentSyncStatus = {
  status: "idle" | "running" | "ok" | "error"
  row_count: number
  started_at?: string | null
  finished_at?: string | null
  source_url?: string | null
  message?: string | null
  segments: SegmentCount[]
}

export type Candle = {
  time: number
  iso: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type SessionSummary = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  change_pct: number
  candles: number
}

export type CandleStats = {
  last_price: number
  change: number
  change_pct: number
  day_high: number
  day_low: number
  range_high: number
  range_low: number
  total_volume: number
  candle_count: number
  first_candle: string
  last_candle: string
}

export type CandleResponse = {
  instrument: Instrument
  unit: string
  interval: string
  sessions: SessionSummary[]
  candles: Candle[]
  stats: CandleStats | null
  source: "upstox" | "cache"
  fetched_at: string
  notice: string | null
}

/* --- ATM short straddle heatmap ---------------------------------------------- */

/** The three backtestable index chains. Mirrors the backend `Underlying` alias. */
export type Underlying = "NIFTY" | "BANKNIFTY" | "SENSEX"

const UNDERLYINGS: readonly Underlying[] = ["NIFTY", "BANKNIFTY", "SENSEX"]

/*
  Requests carry the union, responses carry a plain string, so anything that
  feeds a response back into a request has to narrow. Kept next to the type so
  the list cannot drift from it, and so the form and the audit share one guard.
*/
export function isUnderlying(value: string): value is Underlying {
  return (UNDERLYINGS as readonly string[]).includes(value)
}

/**
 * What the ATM strike is measured against at the entry minute.
 *
 * - `spot`      the index bar's open, the original behaviour and still the default
 * - `synthetic` put-call parity on the expiry being traded, K + CE - PE
 * - `future`    the current-month FUT contract's bar open
 *
 * Spot and the two futures-based measures routinely pick different strikes, which is
 * the whole reason this is a request field rather than a constant.
 */
export type UnderlyingMode = "spot" | "synthetic" | "future"

/** How a short leg was closed. `STOP_LOSS_GAP` means the bar opened past the stop. */
export type ExitReason = "STOP_LOSS" | "STOP_LOSS_GAP" | "TIME" | "NO_EXIT_DATA"

export type CellStatus = "ok" | "unavailable"

export type UnderlyingInfo = {
  symbol: string
  index_instrument_key: string
  option_segment: string
  lot_size: number
}

/**
 * The most recent date that actually has 1-minute data for one underlying.
 *
 * The form defaults to this rather than to today, because before the open, and on a
 * weekend or a holiday, today has no bars at all and every cell comes back
 * unavailable. `is_today` says which of the two the backend is offering.
 */
export type LastSessionInfo = {
  /** YYYY-MM-DD. */
  date: string
  is_today: boolean
}

/** One minute bar as the engine saw it, so a cell can be checked by hand. */
export type BarTrace = {
  /** HH:MM in IST, stamped at the bar open. */
  time: string
  open: number
  high: number
  low: number
  close: number
  stop_price: number
  triggered: boolean
}

/** The fill history of one short leg, CE or PE. */
export type LegDetail = {
  symbol: string
  instrument_key: string
  entry_price: number
  stop_price: number
  exit_price: number
  exit_reason: ExitReason
  /** HH:MM in IST. */
  exit_time: string
  pnl: number
}

/** One (entry time, stop loss) simulation. Everything but the key is null when unavailable. */
export type HeatmapCell = {
  entry_time: string
  stop_loss: number
  status: CellStatus
  /** Why the cell is unavailable, e.g. no bar at the entry minute. */
  reason?: string | null
  gross_pnl?: number | null
  net_pnl?: number | null
  ce?: LegDetail | null
  pe?: LegDetail | null
  strike?: number | null
  /** Always the raw index spot, whatever the mode, so the two can be compared. */
  spot_at_entry?: number | null
  quantity?: number | null
  /**
   * The number the ATM decision actually used: equal to `spot_at_entry` in spot mode,
   * and the synthetic or futures price otherwise. Per cell, because the mode is
   * evaluated at each entry minute and one minute can be unavailable on its own.
   */
  underlying_price?: number | null
  underlying_mode?: string | null
}

export type HeatmapRequest = {
  underlying: Underlying
  /** YYYY-MM-DD. */
  date: string
  /** YYYY-MM-DD, must still be live in the instrument master. */
  expiry: string
  /** HH:MM, 1 to 40 distinct values. The backend sorts and dedupes them. */
  entry_times: string[]
  /** Percent, so 20 means a stop 20% above entry. 1 to 20 distinct values, each > 0. */
  stop_losses: number[]
  exit_time?: string
  lots?: number
  /** Omitted means "spot", the same default the backend applies. */
  underlying_mode?: UnderlyingMode
}

export type HeatmapResponse = {
  underlying: string
  date: string
  expiry: string
  exit_time: string
  lots: number
  lot_size: number
  /** lots * lot_size, the per-leg quantity every pnl was computed against. */
  quantity: number
  entry_times: string[]
  stop_losses: number[]
  /** Flat and row major: entry_times rows by stop_losses columns. */
  cells: HeatmapCell[]
  /** entry_time -> sum of that row. */
  row_totals: Record<string, number>
  /** String(stop_loss) -> sum of that column. */
  col_totals: Record<string, number>
  /**
   * Diagnostic only. It adds up independent hypothetical trades that were never all
   * taken together, so label it as such and never show it as a strategy pnl.
   */
  grand_total: number
  unavailable_count: number
  warnings: string[]
  /** Echoed back, so a saved grid still says what its strikes were picked from. */
  underlying_mode: string
}

/** Re-run a single cell and keep every bar the engine walked. */
export type AuditRequest = {
  underlying: Underlying
  date: string
  expiry: string
  entry_time: string
  stop_loss: number
  exit_time?: string
  lots?: number
  /**
   * Must be the same value the grid was run with, or the audit resolves a different
   * strike and disagrees with the cell it is supposed to explain.
   */
  underlying_mode?: UnderlyingMode
}

export type AuditResponse = {
  underlying: string
  date: string
  expiry: string
  spot_at_entry: number
  strike: number
  lot_size: number
  quantity: number
  ce_key: string
  ce_symbol: string
  pe_key: string
  pe_symbol: string
  cell: HeatmapCell
  ce_trace: BarTrace[]
  pe_trace: BarTrace[]
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  })

  const body = await response.text()
  const payload = body ? JSON.parse(body) : null

  if (!response.ok) {
    const detail = payload?.detail
    const message = Array.isArray(detail)
      ? detail.map((d: { msg?: string }) => d.msg ?? "Invalid input").join(". ")
      : typeof detail === "string"
        ? detail
        : `Request failed with status ${response.status}`
    throw new ApiError(message, response.status)
  }

  return payload as T
}

export const api = {
  getSettings: () => request<Settings>("/api/settings"),

  saveSettings: (body: {
    api_key: string
    api_secret: string
    redirect_uri: string
  }) =>
    request<Settings>("/api/settings", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getAuthStatus: () => request<AuthStatus>("/api/auth/status"),

  getLoginUrl: () =>
    request<{ login_url: string; redirect_uri: string }>("/api/auth/login-url"),

  logout: () => request<{ disconnected: boolean }>("/api/auth/logout", { method: "POST" }),

  getInstruments: () => request<Instrument[]>("/api/market/instruments"),

  refreshInstruments: () =>
    request<{ updated: string[]; available: number }>(
      "/api/market/instruments/refresh",
      { method: "POST" }
    ),

  getCandles: (
    symbol: string,
    opts?: {
      unit?: string
      interval?: string
      sessions?: number
      /** Wins over `symbol` on the backend: use it to chart an exact search hit. */
      instrumentKey?: string | null
    }
  ) => {
    const query = new URLSearchParams({
      symbol,
      unit: opts?.unit ?? "minutes",
      interval: opts?.interval ?? "5",
      sessions: String(opts?.sessions ?? 5),
    })
    if (opts?.instrumentKey) query.set("instrument_key", opts.instrumentKey)
    return request<CandleResponse>(`/api/market/candles?${query.toString()}`)
  },

  searchInstruments: (
    q: string,
    opts?: { exchange?: string; segment?: string; limit?: number },
    signal?: AbortSignal
  ) => {
    const query = new URLSearchParams({ q, limit: String(opts?.limit ?? 25) })
    if (opts?.exchange) query.set("exchange", opts.exchange)
    if (opts?.segment) query.set("segment", opts.segment)
    return request<InstrumentSearchResult[]>(
      `/api/market/search?${query.toString()}`,
      { signal }
    )
  },

  instrumentSyncStatus: () =>
    request<InstrumentSyncStatus>("/api/market/instruments/status"),

  downloadInstruments: () =>
    request<InstrumentSyncStatus>("/api/market/instruments/download", {
      method: "POST",
    }),

  getStraddleUnderlyings: () =>
    request<UnderlyingInfo[]>("/api/straddle/underlyings"),

  /** Live expiries only: an expired chain is gone from the master and cannot be run. */
  getStraddleExpiries: (underlying: string) => {
    const query = new URLSearchParams({ underlying })
    return request<string[]>(`/api/straddle/expiries?${query.toString()}`)
  },

  /**
   * The newest date that really has 1-minute bars, for defaulting the date picker.
   * Unlike the two calls above this one reads candles, so it needs a live Upstox
   * session and 409s when no recent session turned up any data at all.
   */
  getLastSession: (underlying: string) => {
    const query = new URLSearchParams({ underlying })
    return request<LastSessionInfo>(`/api/straddle/last-session?${query.toString()}`)
  },

  runStraddleHeatmap: (body: HeatmapRequest, signal?: AbortSignal) =>
    request<HeatmapResponse>("/api/straddle/heatmap", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),

  auditStraddleCell: (body: AuditRequest, signal?: AbortSignal) =>
    request<AuditResponse>("/api/straddle/audit", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
}
