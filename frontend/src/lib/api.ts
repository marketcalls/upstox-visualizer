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
}
