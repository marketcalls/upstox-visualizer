/*
  The straddle parameter bar. The page owns the form state and the request; this
  component only edits that state, derives the grid the settings imply, and
  refuses to let a doomed run leave the browser. Every guard here mirrors a rule
  the backend enforces in HeatmapRequest, so a rejection is caught while it can
  still be pointed at the field that caused it.
*/

import { useEffect, useId, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { CircleAlert, Info, Loader2, Play } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { UnderlyingMode } from "@/lib/api"
import { cn } from "@/lib/utils"

/* The only three the backend resolves, fixed by the instrument master linkage. */
const UNDERLYINGS = ["NIFTY", "BANKNIFTY", "SENSEX"] as const
const UNDERLYING_NAMES: readonly string[] = UNDERLYINGS

/* What the ATM strike is measured against. The order runs spot first because that
   is the default, then the two futures-based measures that can disagree with it. */
const UNDERLYING_MODES: readonly { id: UnderlyingMode; label: string }[] = [
  { id: "spot", label: "Spot" },
  { id: "synthetic", label: "Synthetic" },
  { id: "future", label: "Future" },
]

const MODE_IDS: readonly string[] = UNDERLYING_MODES.map((mode) => mode.id)

/* HeatmapRequest caps the DISTINCT values on each axis. Past these it 422s. */
const ENTRY_LIMIT = 40
const STOP_LIMIT = 20
const LOTS_LIMIT = 100

/* Past this the run is measured in minutes, not seconds, so it gets a warning. */
const SLOW_CELLS = 400

/* A pathological step must not build a million strings before the count check. */
const SERIES_CEILING = 2000

/* Measured session shape: index bars run 09:15 to 15:29, options a little past. */
const SESSION_OPEN = "09:15"
const SESSION_CLOSE = "15:30"

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

/* en-CA renders YYYY-MM-DD, which is the wire format and sorts as text. */
const IST_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/* The desk is in IST, so "today" is never the browser's local day. */
function istToday(): string {
  return IST_DAY.format(new Date())
}

/** Epoch millis at UTC midnight of a YYYY-MM-DD day, or null when it is not one. */
function parseDay(value: string): number | null {
  const text = value.trim()
  if (!DAY_RE.test(text)) return null
  const stamp = Date.parse(`${text}T00:00:00Z`)
  return Number.isNaN(stamp) ? null : stamp
}

/** Minutes past midnight for HH:MM, or null when it is not a 24-hour clock time. */
function toMinutes(value: string): number | null {
  const text = value.trim()
  if (!CLOCK_RE.test(text)) return null
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))
}

function toClock(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

/* Percentages are typed by hand, so they are kept to two places end to end. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/* Both NSE and BSE open at 09:15, and desks quote entry windows off that clock
   rather than off whenever the first trade was taken. */
const SESSION_OPEN_MIN = 9 * 60 + 15

/*
  The first entry is whatever the user asked for, usually 09:16 to skip the
  opening minute. Every later entry snaps to the clock grid anchored at the
  session open, so a 30 minute step reads 09:45, 10:15, 10:45 and not 09:46,
  10:16, 10:46. Stepping naively from 09:16 drifts one minute off every half
  hour mark, which puts the whole grid on different bars from every other desk
  tool and makes the numbers look wrong when they are only misaligned.
*/
function entrySeries(startMin: number, endMin: number, step: number): string[] {
  const times: string[] = []
  if (step <= 0 || endMin < startMin) return times

  times.push(toClock(startMin))

  // First grid slot strictly after the opening entry.
  let index = Math.floor((startMin - SESSION_OPEN_MIN) / step) + 1
  while (times.length < SERIES_CEILING) {
    const minute = SESSION_OPEN_MIN + index * step
    if (minute > endMin) break
    if (minute > startMin) times.push(toClock(minute))
    index += 1
  }
  return times
}

function stopSeries(start: number, end: number, step: number): number[] {
  const values: number[] = []
  if (step <= 0 || end < start) return values

  // 0.1 steps do not land on their endpoint in binary, so the span is nudged
  // before flooring or a range like 10 to 100 by 0.1 loses its last column.
  const count = Math.floor((end - start) / step + 1e-9) + 1
  for (let index = 0; index < count && index < SERIES_CEILING; index += 1) {
    values.push(round2(start + index * step))
  }
  return values
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

export interface StraddleFormState {
  underlying: string
  date: string
  expiry: string
  entryStart: string
  entryEnd: string
  entryStepMin: number
  slStart: number
  slEnd: number
  slStep: number
  exitTime: string
  lots: number
  /** What the ATM strike is measured against. Goes to the backend on every request. */
  underlyingMode: UnderlyingMode
  /** Display only: show CE and PE separately instead of one combined pnl. */
  splitLegs: boolean
}

export interface StraddleControlsProps {
  value: StraddleFormState
  onChange: (patch: Partial<StraddleFormState>) => void
  expiries: string[]
  loading: boolean
  onRun: () => void
}

type FieldFlags = Partial<Record<keyof StraddleFormState, boolean>>

export interface StraddleGrid {
  /** The HH:MM minutes these settings imply, ascending and distinct. */
  entryTimes: string[]
  /** The stop-loss percentages these settings imply, ascending and distinct. */
  stopLosses: number[]
  cellCount: number
  /** Blocking problems. Run stays disabled while any of these stand. */
  errors: string[]
  /** Worth knowing, but the run is still allowed. */
  warnings: string[]
  /** Which fields to mark aria-invalid. */
  invalid: FieldFlags
  ready: boolean
}

/**
 * The single source of truth for what a form state means. The page should build
 * its HeatmapRequest from `entryTimes` and `stopLosses` rather than deriving
 * the same two series a second time.
 */
export function deriveStraddleGrid(
  value: StraddleFormState,
  expiries: string[]
): StraddleGrid {
  const errors: string[] = []
  const warnings: string[] = []
  const invalid: FieldFlags = {}

  /* ----------------------------------------------------------- instrument */

  if (!UNDERLYING_NAMES.includes(value.underlying)) {
    invalid.underlying = true
    errors.push("Pick an underlying.")
  }

  /* The backend takes a Literal, so a mode restored from an older stored form has
     to be caught here rather than as a 422 with no field to point at. */
  if (!MODE_IDS.includes(value.underlyingMode)) {
    invalid.underlyingMode = true
    errors.push("Pick what the ATM strike is measured against.")
  }

  const day = parseDay(value.date)
  const today = istToday()

  if (day === null) {
    invalid.date = true
    errors.push("Pick a backtest date.")
  } else if (value.date > today) {
    invalid.date = true
    errors.push(`${value.date} is in the future, so there are no candles for it yet.`)
  } else {
    const weekday = new Date(day).getUTCDay()
    if (weekday === 0 || weekday === 6) {
      invalid.date = true
      errors.push(`${value.date} is a ${WEEKDAYS[weekday]}, so the market was closed.`)
    } else if (value.date === today) {
      warnings.push("Today's session may still be running, so late entries can be missing.")
    }
  }

  const expiryDay = parseDay(value.expiry)

  if (expiryDay === null) {
    invalid.expiry = true
    errors.push("Pick an expiry.")
  } else if (expiries.length > 0 && !expiries.includes(value.expiry)) {
    // Usually the underlying just changed and the old expiry is still sitting
    // in the form. Only live contracts are backtestable, so this has to block.
    invalid.expiry = true
    errors.push(`${value.expiry} is not a live expiry for ${value.underlying}.`)
  } else if (day !== null && value.expiry < value.date) {
    invalid.expiry = true
    errors.push(`Expiry ${value.expiry} is before the backtest date ${value.date}.`)
  }

  /* ---------------------------------------------------------- entry times */

  const startMin = toMinutes(value.entryStart)
  const endMin = toMinutes(value.entryEnd)
  const exitMin = toMinutes(value.exitTime)

  if (startMin === null) {
    invalid.entryStart = true
    errors.push("Entry start needs a time in HH:MM.")
  }
  if (endMin === null) {
    invalid.entryEnd = true
    errors.push("Entry end needs a time in HH:MM.")
  }
  if (startMin !== null && endMin !== null && endMin <= startMin) {
    invalid.entryEnd = true
    errors.push(`Entry end ${value.entryEnd} must be after entry start ${value.entryStart}.`)
  }
  if (!Number.isInteger(value.entryStepMin) || value.entryStepMin < 1) {
    invalid.entryStepMin = true
    errors.push("Entry step must be a whole number of minutes, at least 1.")
  }

  if (exitMin === null) {
    invalid.exitTime = true
    errors.push("Exit time needs a time in HH:MM.")
  } else if (endMin !== null && exitMin <= endMin) {
    // The backend rejects the whole request when any entry is at or after the
    // exit, and the last entry can never be later than the entry end.
    invalid.exitTime = true
    errors.push(`Exit ${value.exitTime} must be after the last entry ${value.entryEnd}.`)
  }

  const entryTimes =
    startMin === null || endMin === null
      ? []
      : unique(entrySeries(startMin, endMin, value.entryStepMin))

  if (entryTimes.length > ENTRY_LIMIT) {
    invalid.entryStepMin = true
    errors.push(
      `${entryTimes.length} entry times is over the ${ENTRY_LIMIT} the backend accepts. Widen the step or shorten the range.`
    )
  }

  /* ---------------------------------------------------------- stop losses */

  if (!(value.slStart > 0) || !(value.slEnd > 0)) {
    invalid.slStart = !(value.slStart > 0)
    invalid.slEnd = !(value.slEnd > 0)
    errors.push("Stop loss must be greater than 0 percent.")
  } else if (value.slEnd < value.slStart) {
    invalid.slEnd = true
    errors.push(`Stop loss end ${value.slEnd} must be at or above the start ${value.slStart}.`)
  }
  if (!(value.slStep > 0)) {
    invalid.slStep = true
    errors.push("Stop loss step must be greater than 0.")
  }

  const stopLosses = unique(stopSeries(value.slStart, value.slEnd, value.slStep))

  if (stopLosses.length > STOP_LIMIT) {
    invalid.slStep = true
    errors.push(
      `${stopLosses.length} stop losses is over the ${STOP_LIMIT} the backend accepts. Widen the step or shorten the range.`
    )
  }

  /* ----------------------------------------------------------------- size */

  if (!Number.isInteger(value.lots) || value.lots < 1) {
    invalid.lots = true
    errors.push("Lots must be a whole number, at least 1.")
  } else if (value.lots > LOTS_LIMIT) {
    invalid.lots = true
    errors.push(`Lots cannot go past ${LOTS_LIMIT}.`)
  }

  /* ------------------------------------------------------------- warnings */

  const cellCount = entryTimes.length * stopLosses.length

  if (cellCount > SLOW_CELLS) {
    warnings.push(
      `${cellCount} cells is a slow run. Every distinct ATM strike costs one more Upstox fetch.`
    )
  }
  if (value.entryStart < SESSION_OPEN && startMin !== null) {
    warnings.push(`Entries before ${SESSION_OPEN} have no bars and come back unavailable.`)
  }
  if (value.exitTime > SESSION_CLOSE && exitMin !== null) {
    warnings.push(
      `Bars past ${SESSION_CLOSE} are not guaranteed, so the exit can fall back to the last bar of the session.`
    )
  }

  return {
    entryTimes,
    stopLosses,
    cellCount,
    errors,
    warnings,
    invalid,
    ready: errors.length === 0,
  }
}

/** The reference grid: 09:16 to 14:45 every 30 minutes against 10 to 100 percent. */
export function defaultStraddleForm(): StraddleFormState {
  return {
    underlying: "NIFTY",
    date: istToday(),
    expiry: "",
    entryStart: "09:16",
    entryEnd: "14:45",
    entryStepMin: 30,
    slStart: 10,
    slEnd: 100,
    slStep: 10,
    exitTime: "15:15",
    lots: 1,
    /* Spot stays the default, so an untouched form runs the grid it always did. */
    underlyingMode: "spot",
    splitLegs: false,
  }
}

const CONTROL = "h-8 font-mono text-sm tabular"

/* The native pickers ship a black glyph, which is invisible on the ink base. */
const PICKER =
  "[&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:[filter:invert(0.8)]"

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="eyebrow">
        {label}
      </label>
      {children}
    </div>
  )
}

/** The word between two controls of one range. Never a label of its own. */
function Joiner({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="text-[10px] text-muted-foreground">
      {children}
    </span>
  )
}

function Divider() {
  return <span aria-hidden="true" className="mx-0.5 h-8 w-px shrink-0 self-end bg-hairline" />
}

/*
  What the ATM strike is measured against. A segmented radiogroup rather than a
  Select because there are only three and the choice silently moves which strike
  every cell trades, which is worth keeping visible instead of folded into a
  closed menu. Same height as the other controls, so the toolbar row stays flat.
*/
function ModeSwitch({
  labelId,
  hintId,
  value,
  invalid,
  onChange,
}: {
  labelId: string
  hintId: string
  value: UnderlyingMode
  invalid: boolean
  onChange: (next: UnderlyingMode) => void
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1">
      {/* A span, not a label: a label cannot point at a radiogroup, so the group
          takes its name from this element through aria-labelledby instead. */}
      <span id={labelId} className="eyebrow">
        ATM basis
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={hintId}
        aria-invalid={invalid}
        className={cn(
          "flex h-8 items-center gap-0.5 rounded-md border bg-panel-raised p-0.5",
          invalid ? "border-destructive" : "border-hairline"
        )}
      >
        {UNDERLYING_MODES.map((mode) => {
          const selected = mode.id === value
          return (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(mode.id)}
              className={cn(
                "h-full shrink-0 rounded-sm px-2 text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                selected
                  ? "bg-primary/15 text-violet"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {mode.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/*
  A number box that never publishes rubbish. The draft is local so the field can
  sit empty or half typed while the form keeps the last good number; nothing is
  committed until it parses inside the range, and a blur snaps the box back to
  whatever the form actually holds.
*/
function NumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  integer,
  invalid,
  className,
  onCommit,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  integer: boolean
  invalid: boolean
  className: string
  onCommit: (next: number) => void
}) {
  const [draft, setDraft] = useState(() => String(value))

  /* Follow the form when it moves on its own, but leave a draft that already
     means the same number alone so "1.50" is not rewritten under the cursor. */
  useEffect(() => {
    setDraft((current) => (Number(current) === value ? current : String(value)))
  }, [value])

  function handleChange(next: string) {
    setDraft(next)
    const parsed = Number(next)
    if (next.trim() === "" || !Number.isFinite(parsed)) return
    if (parsed < min || parsed > max) return
    // Half typed integers such as "1.5" wait for the blur rather than snapping
    // to 2 while the caret is still in the field.
    if (integer && !Number.isInteger(parsed)) return
    onCommit(parsed)
  }

  function handleBlur() {
    const parsed = Number(draft)
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    const settled = integer ? Math.round(clamped) : round2(clamped)
    setDraft(String(settled))
    if (settled !== value) onCommit(settled)
  }

  return (
    <Input
      id={id}
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      aria-label={label}
      aria-invalid={invalid}
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(event) => handleChange(event.target.value)}
      onBlur={handleBlur}
      className={cn(CONTROL, className)}
    />
  )
}

export function StraddleControls({
  value,
  onChange,
  expiries,
  loading,
  onRun,
}: StraddleControlsProps) {
  const uid = useId()
  const id = {
    underlying: `${uid}-underlying`,
    date: `${uid}-date`,
    expiry: `${uid}-expiry`,
    entryStart: `${uid}-entry-start`,
    entryEnd: `${uid}-entry-end`,
    entryStep: `${uid}-entry-step`,
    slStart: `${uid}-sl-start`,
    slEnd: `${uid}-sl-end`,
    slStep: `${uid}-sl-step`,
    exitTime: `${uid}-exit`,
    lots: `${uid}-lots`,
    modeLabel: `${uid}-mode-label`,
    modeHint: `${uid}-mode-hint`,
    splitLegs: `${uid}-split-legs`,
  }

  const grid = useMemo(() => deriveStraddleGrid(value, expiries), [value, expiries])
  const { entryTimes, stopLosses, cellCount, errors, warnings, invalid } = grid

  const first = entryTimes[0]
  const last = entryTimes[entryTimes.length - 1]
  const disabled = loading || !grid.ready

  function handleRun() {
    // The button is already disabled; this is the guard that survives a stray
    // programmatic click or an Enter on a stale render.
    if (disabled) return
    onRun()
  }

  return (
    <div className="shrink-0 border-b border-hairline bg-panel">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 px-3 py-2">
        <Field label="Underlying" htmlFor={id.underlying}>
          {/* Radix reads "" as the placeholder state, so the empty form stays
              controlled instead of flipping over on the first pick. */}
          <Select
            value={value.underlying}
            onValueChange={(next) => onChange({ underlying: next })}
          >
            <SelectTrigger
              id={id.underlying}
              size="sm"
              aria-invalid={invalid.underlying}
              className="w-34 font-mono text-sm"
            >
              <SelectValue placeholder="Pick one" />
            </SelectTrigger>
            <SelectContent>
              {UNDERLYINGS.map((name) => (
                <SelectItem key={name} value={name} className="font-mono text-sm">
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Date" htmlFor={id.date}>
          <Input
            id={id.date}
            type="date"
            max={istToday()}
            value={value.date}
            aria-invalid={invalid.date}
            onChange={(event) => onChange({ date: event.target.value })}
            className={cn(CONTROL, PICKER, "w-38")}
          />
        </Field>

        <Field label="Expiry" htmlFor={id.expiry}>
          <Select
            value={value.expiry}
            disabled={expiries.length === 0}
            onValueChange={(next) => onChange({ expiry: next })}
          >
            <SelectTrigger
              id={id.expiry}
              size="sm"
              aria-invalid={invalid.expiry}
              className="w-38 font-mono text-sm tabular"
            >
              <SelectValue
                placeholder={expiries.length === 0 ? "No live expiries" : "Pick one"}
              />
            </SelectTrigger>
            <SelectContent>
              {expiries.map((expiry) => (
                <SelectItem key={expiry} value={expiry} className="font-mono text-sm tabular">
                  {expiry}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <ModeSwitch
          labelId={id.modeLabel}
          hintId={id.modeHint}
          value={value.underlyingMode}
          invalid={Boolean(invalid.underlyingMode)}
          onChange={(next) => onChange({ underlyingMode: next })}
        />

        <Divider />

        <Field label="Entry times" htmlFor={id.entryStart}>
          <div className="flex items-center gap-1">
            <Input
              id={id.entryStart}
              type="time"
              step={60}
              value={value.entryStart}
              aria-label="Entry start time"
              aria-invalid={invalid.entryStart}
              onChange={(event) => onChange({ entryStart: event.target.value })}
              className={cn(CONTROL, PICKER, "w-28")}
            />
            <Joiner>to</Joiner>
            <Input
              id={id.entryEnd}
              type="time"
              step={60}
              value={value.entryEnd}
              aria-label="Entry end time"
              aria-invalid={invalid.entryEnd}
              onChange={(event) => onChange({ entryEnd: event.target.value })}
              className={cn(CONTROL, PICKER, "w-28")}
            />
            <Joiner>every</Joiner>
            <NumberField
              id={id.entryStep}
              label="Entry step in minutes"
              value={value.entryStepMin}
              min={1}
              max={360}
              step={1}
              integer
              invalid={Boolean(invalid.entryStepMin)}
              className="w-16"
              onCommit={(next) => onChange({ entryStepMin: next })}
            />
            <Joiner>min</Joiner>
          </div>
        </Field>

        <Divider />

        <Field label="Stop loss %" htmlFor={id.slStart}>
          <div className="flex items-center gap-1">
            <NumberField
              id={id.slStart}
              label="Stop loss start percent"
              value={value.slStart}
              min={0.5}
              max={500}
              step={5}
              integer={false}
              invalid={Boolean(invalid.slStart)}
              className="w-18"
              onCommit={(next) => onChange({ slStart: next })}
            />
            <Joiner>to</Joiner>
            <NumberField
              id={id.slEnd}
              label="Stop loss end percent"
              value={value.slEnd}
              min={0.5}
              max={500}
              step={5}
              integer={false}
              invalid={Boolean(invalid.slEnd)}
              className="w-18"
              onCommit={(next) => onChange({ slEnd: next })}
            />
            <Joiner>step</Joiner>
            <NumberField
              id={id.slStep}
              label="Stop loss step percent"
              value={value.slStep}
              min={0.5}
              max={100}
              step={5}
              integer={false}
              invalid={Boolean(invalid.slStep)}
              className="w-18"
              onCommit={(next) => onChange({ slStep: next })}
            />
          </div>
        </Field>

        <Divider />

        <Field label="Exit" htmlFor={id.exitTime}>
          <Input
            id={id.exitTime}
            type="time"
            step={60}
            value={value.exitTime}
            aria-invalid={invalid.exitTime}
            onChange={(event) => onChange({ exitTime: event.target.value })}
            className={cn(CONTROL, PICKER, "w-28")}
          />
        </Field>

        <Field label="Lots" htmlFor={id.lots}>
          <NumberField
            id={id.lots}
            label="Lots"
            value={value.lots}
            min={1}
            max={LOTS_LIMIT}
            step={1}
            integer
            invalid={Boolean(invalid.lots)}
            className="w-16"
            onCommit={(next) => onChange({ lots: next })}
          />
        </Field>

        {/* A view option, not a run parameter: it re-reads cells that are already
            in hand, so it carries no eyebrow and never disables the Run button.
            Off shows one combined net figure per cell, on splits it into the two
            legs that produced it. */}
        <label
          htmlFor={id.splitLegs}
          className="flex shrink-0 cursor-pointer select-none items-center gap-2 self-end pb-1.5"
        >
          <Switch
            id={id.splitLegs}
            checked={value.splitLegs}
            onCheckedChange={(on) => onChange({ splitLegs: on })}
            aria-label="Split each cell into its CE and PE legs"
          />
          <span
            className={cn(
              "font-mono text-xs transition-colors",
              value.splitLegs ? "text-violet" : "text-muted-foreground"
            )}
          >
            {value.splitLegs ? "Split CE/PE" : "Combined P&L"}
          </span>
        </label>

        <div className="ml-auto flex items-end self-end">
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={handleRun}
            className="min-w-34"
          >
            {loading ? <Loader2 className="animate-spin" /> : <Play />}
            {loading ? "Running" : "Run backtest"}
          </Button>
        </div>
      </div>

      {/*
        The cost of the run, stated before it is paid, and every reason the Run
        button is dark. Polite rather than assertive: it changes on every
        keystroke and must not interrupt the field being typed into.
      */}
      <div
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline px-3 py-1.5"
      >
        <span className="font-mono text-[11px] tabular text-muted-foreground">
          <span className="text-foreground">{entryTimes.length}</span> entry times
          {first && last ? (
            <span className="text-muted-foreground">
              {" "}
              ({first} to {last})
            </span>
          ) : null}{" "}
          x <span className="text-foreground">{stopLosses.length}</span> stop losses ={" "}
          <span className={cn(cellCount > SLOW_CELLS ? "text-amber" : "text-violet")}>
            {cellCount}
          </span>{" "}
          cells
        </span>

        {errors.map((message) => (
          <span key={message} className="flex items-center gap-1.5 text-[11px] text-amber">
            <CircleAlert className="size-3 shrink-0" />
            {message}
          </span>
        ))}

        {warnings.map((message) => (
          <span
            key={message}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <Info className="size-3 shrink-0" />
            {message}
          </span>
        ))}

        {/*
          The ATM basis hint. It lives on this line rather than under the switch
          because the toolbar row aligns its controls on one baseline, and a
          field grown by a second line of prose would lift that switch off it.
          The radiogroup points here with aria-describedby, so the two are still
          joined for a screen reader wherever the flex wrap puts them.
        */}
        <span
          id={id.modeHint}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <Info className="size-3 shrink-0" />
          The ATM strike is chosen from this price, and the futures-based options can
          select a different strike than spot.
        </span>
      </div>
    </div>
  )
}
