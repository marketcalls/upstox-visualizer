/*
  The straddle research screen. Every rule about what a run means lives in the
  backend engine and every rule about what a form means lives in
  deriveStraddleGrid, so this page is only the controller: it owns the form,
  turns one form into one request, and hands the response down. A run costs real
  Upstox calls, so exactly one fires on its own: the landing run described under
  "first load". Every run after it is a press of the Run button.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Grid3x3, Loader2, RefreshCw, TriangleAlert, X } from "lucide-react"
import { toast } from "sonner"

import { useSession } from "@/components/session-provider"
import { CellDetailDialog } from "@/components/straddle/cell-detail-dialog"
import { HeatmapGrid } from "@/components/straddle/heatmap-grid"
import {
  StraddleControls,
  defaultStraddleForm,
  deriveStraddleGrid,
  type StraddleFormState,
} from "@/components/straddle/straddle-controls"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  api,
  ApiError,
  isUnderlying,
  type HeatmapCell,
  type HeatmapResponse,
  type UnderlyingInfo,
} from "@/lib/api"
import { cn } from "@/lib/utils"

const FORM_KEY = "upstox-straddle-form"
const SAVE_DELAY_MS = 400

/*
  Past this share of holes the grid is mostly dashes, and the reason is worth
  stating once at the top instead of leaving the reader to hover every cell.
*/
const SPARSE_SHARE = 0.4

/* A skeleton wider or taller than this stops describing the run and starts
   being a wall, so the placeholder is capped even when the grid is not. */
const SKELETON_COLS = 12
const SKELETON_ROWS = 12

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/*
  The three bases the backend can price the ATM decision from, in the order the
  contract lists them. Mirrors UnderlyingMode in schemas.py, and the form field
  carries the same union, so a saved value only has to be checked against this.
*/
const MODES = ["spot", "synthetic", "future"] as const

type Mode = (typeof MODES)[number]

/** How the results header names each basis, in the reader's words. */
const MODE_NAMES: Record<Mode, string> = {
  spot: "the index spot",
  synthetic: "the synthetic future",
  future: "the current-month future",
}

function pattern(value: unknown, shape: RegExp, fallback: string): string {
  return typeof value === "string" && shape.test(value) ? value : fallback
}

function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

/* Narrows by comparison rather than by a cast, so this is also the guard that
   turns the form's mode into the union the request field wants. */
function toMode(value: unknown, fallback: Mode): Mode {
  for (const mode of MODES) {
    if (value === mode) return mode
  }
  return fallback
}

/**
 * Names the basis a finished run actually chose its strikes from. The response
 * carries a plain string, and a build that predates the field means spot,
 * because spot was the only behaviour there was.
 */
function modeName(mode: string | null | undefined): string {
  for (const known of MODES) {
    if (mode === known) return MODE_NAMES[known]
  }
  return mode ? mode : MODE_NAMES.spot
}

/*
  A stored form is user data written by an older build, so every field is
  re-validated on the way in and a bad one falls back rather than throwing.
  deriveStraddleGrid still has the last word: a value that parses but cannot be
  run only darkens the Run button, it does not have to be repaired here.
*/
function readForm(): StraddleFormState {
  const base = defaultStraddleForm()

  try {
    const stored = localStorage.getItem(FORM_KEY)
    if (!stored) return base

    const saved = JSON.parse(stored) as Partial<StraddleFormState> | null
    if (!saved || typeof saved !== "object") return base

    const underlying =
      typeof saved.underlying === "string" ? saved.underlying : base.underlying

    return {
      underlying: isUnderlying(underlying) ? underlying : base.underlying,
      date: pattern(saved.date, DAY_RE, base.date),
      /* An expiry only survives the trip if the chain still lists it, which the
         expiry effect checks once the live list has landed. */
      expiry: pattern(saved.expiry, DAY_RE, ""),
      entryStart: pattern(saved.entryStart, CLOCK_RE, base.entryStart),
      entryEnd: pattern(saved.entryEnd, CLOCK_RE, base.entryEnd),
      entryStepMin: count(saved.entryStepMin, base.entryStepMin),
      slStart: count(saved.slStart, base.slStart),
      slEnd: count(saved.slEnd, base.slEnd),
      slStep: count(saved.slStep, base.slStep),
      exitTime: pattern(saved.exitTime, CLOCK_RE, base.exitTime),
      lots: count(saved.lots, base.lots),
      /* Both new in this build, so most stored forms simply do not carry them
         and fall to the default the same way a corrupt value would. */
      underlyingMode: toMode(saved.underlyingMode, base.underlyingMode),
      splitLegs: flag(saved.splitLegs, base.splitLegs),
    }
  } catch {
    return base
  }
}

/** One labelled figure on the run summary line. */
function Meta({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className={cn("text-foreground", className)}>{value}</span>
    </span>
  )
}

/** An amber strip, the app's idiom for something true but not fatal. */
function Notice({
  title,
  children,
  action,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-amber/40 bg-panel px-4 py-3">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium text-amber">{title}</p>
        {children}
      </div>
      {action}
    </div>
  )
}

/*
  The shape of the grid that is being computed, not a spinner: the run takes as
  long as its distinct strikes take to fetch, and seeing the geometry that is
  coming is the only honest progress this page can show. The same placeholder
  also covers the moment before the landing run, when the geometry is still what
  the form implies and nothing is being simulated yet, so it says which it is.
*/
function SkeletonGrid({
  rows,
  cols,
  simulating,
}: {
  rows: number
  cols: number
  simulating: boolean
}) {
  const shownRows = Math.min(rows, SKELETON_ROWS)
  const shownCols = Math.min(cols, SKELETON_COLS)

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-panel">
      <div className="flex h-9 items-center gap-2 border-b border-hairline px-2.5">
        <Loader2 className="size-3 animate-spin text-violet" />
        <span className="eyebrow">
          {simulating
            ? `Simulating ${rows} x ${cols} cells`
            : "Finding the last session that has data"}
        </span>
        {simulating ? (
          <span className="ml-auto hidden font-mono text-[10px] text-muted-foreground sm:inline">
            One fetch per distinct ATM strike, not one per cell
          </span>
        ) : null}
      </div>

      <div className="space-y-1 overflow-hidden p-2.5" aria-hidden="true">
        {Array.from({ length: shownRows }, (_, row) => (
          <div key={row} className="flex gap-1">
            <Skeleton className="h-7 w-14 shrink-0 bg-secondary" />
            {Array.from({ length: shownCols }, (_, col) => (
              <Skeleton key={col} className="h-7 w-[72px] shrink-0 bg-secondary" />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function StraddlePage() {
  const { status, secondsLeft } = useSession()
  const connected = Boolean(status?.connected) && secondsLeft > 0

  /* Read the stored form once per mount, not once per module load. */
  const bootRef = useRef<StraddleFormState | null>(null)
  if (bootRef.current === null) bootRef.current = readForm()

  /* The chain the page opened with. The landing lookup asks about this one and
     never about whatever the user has switched to since. */
  const startChain = bootRef.current.underlying

  const [form, setForm] = useState<StraddleFormState>(bootRef.current)
  const [underlyings, setUnderlyings] = useState<UnderlyingInfo[]>([])
  const [expiries, setExpiries] = useState<string[]>([])
  const [data, setData] = useState<HeatmapResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notesOpen, setNotesOpen] = useState(true)
  const [cell, setCell] = useState<HeatmapCell | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  /* The most recent date that really has 1-minute bars, or null once the lookup
     has settled without one. */
  const [lastSession, setLastSession] = useState<{
    date: string
    is_today: boolean
  } | null>(null)
  const [lookupDone, setLookupDone] = useState(false)
  /* True once the first expiry fetch has settled, empty list or not, so the
     landing run waits for the chain instead of racing it. */
  const [chainSettled, setChainSettled] = useState(false)
  /* The window between mount and the landing run's verdict. It exists so the
     page opens on the shape of a grid rather than on "No run yet". */
  const [booting, setBooting] = useState(true)

  const patch = useCallback((next: Partial<StraddleFormState>) => {
    setForm((previous) => ({ ...previous, ...next }))
  }, [])

  /* What the current settings imply, derived in exactly one place so the
     skeleton, the Run guard and the request can never disagree. */
  const plan = useMemo(() => deriveStraddleGrid(form, expiries), [form, expiries])

  /* ------------------------------------------------------------- reference */

  useEffect(() => {
    api
      .getStraddleUnderlyings()
      .then(setUnderlyings)
      .catch(() => setUnderlyings([]))
  }, [])

  /* A ticket per chain: switching underlying twice must not land out of order. */
  const expiryRef = useRef(0)

  useEffect(() => {
    const chain = form.underlying
    const ticket = expiryRef.current + 1
    expiryRef.current = ticket

    setExpiries([])
    api
      .getStraddleExpiries(chain)
      .then((list) => {
        if (expiryRef.current !== ticket) return
        setExpiries(list)

        /* The chain just changed, so an expiry left over from the previous one
           is not a live contract here. Fall to the nearest one that is. */
        setForm((previous) =>
          previous.underlying === chain && !list.includes(previous.expiry)
            ? { ...previous, expiry: list[0] ?? "" }
            : previous
        )
        setChainSettled(true)
      })
      .catch(() => {
        if (expiryRef.current !== ticket) return
        setExpiries([])
        /* A chain with no expiries settles too. The landing run then has every
           answer it is going to get and declines on the spot. */
        setChainSettled(true)
      })
  }, [form.underlying])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(FORM_KEY, JSON.stringify(form))
      } catch {
        // A blocked or full store is not worth an error on a research page.
      }
    }, SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [form])

  /* ------------------------------------------------------------------- run */

  const runRef = useRef<AbortController | null>(null)

  const run = useCallback(async () => {
    const settings = deriveStraddleGrid(form, expiries)
    const underlying = form.underlying

    if (!settings.ready || !isUnderlying(underlying)) {
      // The Run button is already disabled; this catches a stale render.
      toast.error(settings.errors[0] ?? "Fix the settings before running")
      return
    }

    /* A second run must not race the first one home. */
    runRef.current?.abort()
    const controller = new AbortController()
    runRef.current = controller

    setLoading(true)
    setError(null)
    try {
      const next = await api.runStraddleHeatmap(
        {
          underlying,
          date: form.date,
          expiry: form.expiry,
          entry_times: settings.entryTimes,
          stop_losses: settings.stopLosses,
          exit_time: form.exitTime,
          lots: form.lots,
          underlying_mode: toMode(form.underlyingMode, "spot"),
        },
        controller.signal
      )
      if (controller.signal.aborted) return

      setData(next)
      setNotesOpen(true)
      toast.success(
        `${next.cells.length} cells simulated for ${next.underlying} on ${next.date}`
      )
    } catch (exception) {
      if (controller.signal.aborted) return
      setError(
        exception instanceof ApiError ? exception.message : "Could not run the backtest"
      )
      setData(null)
    } finally {
      if (runRef.current === controller) {
        runRef.current = null
        setLoading(false)
      }
    }
  }, [form, expiries])

  /* Leaving the page must not leave a request talking to a dead component. */
  useEffect(() => () => runRef.current?.abort(), [])

  /* ------------------------------------------------------------ first load */

  /*
    The page should open on a grid, not on an empty state, so one run fires by
    itself: ask which session actually has 1-minute data, move the date onto it,
    then run once the expiry list has landed.

    Two refs keep that to exactly one run per mount. They are the guard rather
    than a dependency array because Strict Mode invokes every effect twice in
    development on the same fiber, so a ref set in the effect body is the only
    thing the second pass can see. Neither ref is ever cleared: once the landing
    run has had its turn, a control the user touches afterwards must not start
    another one, and the Run button is the only way back.
  */
  const lookupRef = useRef(false)
  const autoRunRef = useRef(false)

  useEffect(() => {
    if (lookupRef.current) return
    lookupRef.current = true

    /* Deliberately not cancelled on unmount: the result only ever lands in
       state, which is a no-op once the component is gone, and dropping it in
       Strict Mode's first cleanup would leave the second pass with nothing. */
    api
      .getLastSession(startChain)
      .then((session) => {
        setLastSession({ date: session.date, is_today: session.is_today })

        /* The user's own settings survive a reload, their date does not. A date
           saved days ago is the single most common reason a run comes back with
           nothing, so it is refreshed to the session that has bars behind it. */
        setForm((previous) =>
          previous.date === session.date
            ? previous
            : { ...previous, date: session.date }
        )
      })
      .catch(() => {
        // No token, or nothing recent has bars. Either way there is no date
        // worth defaulting to, so the saved one stands and nothing auto-runs.
        setLastSession(null)
      })
      .finally(() => setLookupDone(true))
  }, [startChain])

  useEffect(() => {
    if (autoRunRef.current) return
    /* Both answers have to be in: the date decides what to run and the expiry
       list decides whether the form is runnable at all. */
    if (!lookupDone || !chainSettled) return

    /* Whatever this pass decides, the landing run is now spent. */
    autoRunRef.current = true
    setBooting(false)

    /* Without a known session the only date on offer is the saved one, and
       spending the automatic run on a date nothing backs would report a wall of
       unavailable cells as though it were a result. Leave it to the button. */
    if (lastSession === null || !plan.ready) return
    void run()
  }, [lookupDone, chainSettled, lastSession, plan.ready, run])

  const openCell = useCallback((next: HeatmapCell) => {
    setCell(next)
    setDetailOpen(true)
  }, [])

  /* ------------------------------------------------------------------ view */

  const info = underlyings.find((entry) => entry.symbol === form.underlying) ?? null

  /* Adjacent entry minutes usually share an ATM strike, so how many distinct
     ones a run touched is the number that explains what it cost. */
  const strikes = useMemo(() => {
    if (data === null) return [] as number[]
    const seen = new Set<number>()
    for (const item of data.cells) {
      if (item.strike !== null && item.strike !== undefined) seen.add(item.strike)
    }
    return Array.from(seen).sort((left, right) => left - right)
  }, [data])

  const cellCount = data === null ? 0 : data.entry_times.length * data.stop_losses.length
  const sparse = data !== null && cellCount > 0 && data.unavailable_count >= cellCount * SPARSE_SHARE
  const empty = data !== null && data.unavailable_count >= cellCount

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <p className="eyebrow">Options research</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          ATM short straddle heatmap
        </h1>
        <p className="max-w-3xl leading-relaxed text-muted-foreground">
          One trading day, one live expiry. The at-the-money straddle is sold at every
          entry minute in the range and held to the exit time, with a percentage stop on
          each leg. This is historical analysis over stored candles: it places no orders,
          touches no positions and reads no funds.
        </p>
      </header>

      {!connected ? (
        <Notice
          title="No live Upstox session"
          action={
            <Button asChild variant="ghost" size="xs" className="shrink-0">
              <Link to="/">Setup</Link>
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">
            Minutes already in the local candle cache still run. Anything the cache is
            missing needs a token, so connect first or expect unavailable cells.
          </p>
        </Notice>
      ) : null}

      {/* The controls ship as a bar with their own bottom rule. Inside a panel
          the wrapper already draws that edge, so the bar's one is dropped. */}
      <div className="overflow-hidden rounded-lg border border-hairline [&>div]:border-b-0">
        <StraddleControls
          value={form}
          onChange={patch}
          expiries={expiries}
          loading={loading}
          onRun={run}
        />
      </div>

      {data !== null && notesOpen && data.warnings.length > 0 ? (
        <Notice
          title={data.warnings.length === 1 ? "One note on this run" : `${data.warnings.length} notes on this run`}
          action={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss the notes on this run"
              onClick={() => setNotesOpen(false)}
              className="-mr-1 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X />
            </Button>
          }
        >
          <ul className="space-y-1">
            {data.warnings.map((warning) => (
              <li key={warning} className="text-sm text-muted-foreground">
                {warning}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {loading || booting ? (
        <SkeletonGrid
          rows={plan.entryTimes.length}
          cols={plan.stopLosses.length}
          simulating={loading}
        />
      ) : error !== null ? (
        <div className="flex flex-col items-center gap-4 rounded-lg border border-hairline bg-panel px-6 py-14 text-center">
          <TriangleAlert className="size-5 text-amber" />
          <div className="space-y-1">
            <p className="text-sm font-medium">The backtest did not run</p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">{error}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={run} disabled={!plan.ready}>
              <RefreshCw />
              Try again
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/">Go to setup</Link>
            </Button>
          </div>
        </div>
      ) : data !== null ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-md border border-hairline bg-panel px-3 py-2 font-mono text-[11px] tabular">
            <Meta label="Chain" value={`${data.underlying} ${data.expiry}`} />
            <Meta label="Session" value={data.date} />
            <Meta label="Flat by" value={`${data.exit_time} IST`} />
            <Meta
              label="Size"
              value={`${data.lots} x ${data.lot_size} = ${data.quantity} per leg`}
            />
            <Meta
              label="ATM"
              value={
                strikes.length === 0
                  ? "none resolved"
                  : strikes.length <= 3
                    ? strikes.join(", ")
                    : `${strikes.length} strikes, ${strikes[0]} to ${strikes[strikes.length - 1]}`
              }
              className="text-violet"
            />
            {/* Spot and the two futures-based measures routinely pick different
                strikes, so which one produced these is never left implied. */}
            <Meta label="ATM chosen from" value={modeName(data.underlying_mode)} />
          </div>

          {sparse ? (
            <Notice
              title={
                empty
                  ? "Nothing in this grid could be simulated"
                  : `${data.unavailable_count} of ${cellCount} cells could not be simulated`
              }
            >
              <p className="text-sm text-muted-foreground">
                A cell is unavailable when the resolved contract has no bar at that entry
                minute. Illiquid strikes start late and have holes, and a deep in-the-money
                strike can return nothing at all, so no neighbouring minute or strike is
                ever substituted. Hover a dash to read the exact reason for that cell.
              </p>
            </Notice>
          ) : null}

          {/* The grid brings its own scroller. Bounding it here is what makes
              the sticky header and entry column do their job. */}
          <div className="grid max-h-[min(70vh,720px)] grid-rows-[minmax(0,1fr)]">
            <HeatmapGrid data={data} onCellClick={openCell} splitLegs={form.splitLegs} />
          </div>

          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Click any cell to audit it: the contracts, the fill prices, the stop that was
            computed and the reason each leg left. The grand total is diagnostic only. It
            adds up independent hypothetical trades, one straddle per cell, that were never
            all taken together. Charges are not modelled in v1, so net equals gross.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-lg border border-hairline bg-panel px-6 py-14 text-center">
          <Grid3x3 className="size-5 text-violet" />
          <div className="space-y-1">
            <p className="text-sm font-medium">No run yet</p>
            <p className="mx-auto max-w-lg text-sm leading-relaxed text-muted-foreground">
              Set the day, the expiry, the entry window and the stop-loss range above, then
              press Run backtest. Each entry minute becomes a row and each stop loss a
              column, and every cell holds the net P&amp;L of that one short straddle.
            </p>
          </div>
          <p className="font-mono text-[11px] tabular text-muted-foreground">
            {plan.entryTimes.length} x {plan.stopLosses.length} = {plan.cellCount} cells
            {info !== null ? ` · ${info.symbol} lot size ${info.lot_size} on ${info.option_segment}` : ""}
            {lastSession !== null
              ? ` · last session with data ${lastSession.date}${lastSession.is_today ? " (today)" : ""}`
              : ""}
          </p>
        </div>
      )}

      <CellDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        cell={cell}
        data={data}
      />
    </div>
  )
}
