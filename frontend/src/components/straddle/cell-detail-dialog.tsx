/*
  The drill-down that makes one heatmap cell auditable. A cell in the grid is a
  single number; this dialog is where that number is checked against the trade
  it claims to describe, so every input the engine used is printed verbatim: the
  contracts it resolved, the fill prices, the stop it computed and the reason
  each leg left. Nothing here is recomputed from the response, because a second
  arithmetic path would only give the grid and the audit two ways to disagree.

  The summary alone stops one step short of an audit: it says a leg left at a
  price without showing the candle that took it there. So opening the dialog
  also asks /api/straddle/audit to re-run this one cell and hand back every bar
  the engine actually walked. Those bars are the last link in the chain, the one
  a reader can hold against the broker's own chart, and they are fetched lazily
  because a grid of 120 cells must never carry 120 bar traces it will not show.
*/

import { useEffect, useState } from "react"
import { Loader2, TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import {
  api,
  ApiError,
  isUnderlying,
  type AuditResponse,
  type BarTrace,
  type HeatmapCell,
  type HeatmapResponse,
  type LegDetail,
} from "@/lib/api"
import { decimal, rupees } from "@/lib/format"
import { cn } from "@/lib/utils"

/*
  The engine speaks in codes; someone auditing a fill needs a sentence. An
  unknown code falls through to the raw string, so a reason added later is still
  visible instead of rendering an empty badge.
*/
const EXIT_REASON_LABEL: Record<string, string | undefined> = {
  STOP_LOSS: "Stop loss hit",
  STOP_LOSS_GAP: "Gapped through stop",
  TIME: "Exited at exit time",
  NO_EXIT_DATA: "No exit data",
}

/* Amber for a stop that filled where it was placed, red for one the market jumped. */
const EXIT_REASON_TONE: Record<string, string | undefined> = {
  STOP_LOSS: "text-amber",
  STOP_LOSS_GAP: "text-down",
  TIME: "text-violet",
  NO_EXIT_DATA: "text-muted-foreground",
}

/* Below half a paisa is rounding dust, not a cost. */
const CHARGE_EPSILON = 0.005

export interface CellDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cell: HeatmapCell | null
  data: HeatmapResponse | null
}

/** Signed money reads as +₹1,200.00 on a desk, never as ₹-1,200.00. */
function money(value: number): string {
  return `${value < 0 ? "-" : "+"}₹${decimal(Math.abs(value))}`
}

function pnlTone(value: number): string {
  if (value > 0) return "text-up"
  if (value < 0) return "text-down"
  return "text-muted-foreground"
}

/*
  An ok cell always carries these, but the response types them optional because
  an unavailable one does not. Print "n/a" rather than a zero that would read as
  a real price.
*/
function figure(
  value: number | null | undefined,
  format: (input: number) => string
): string {
  return value === null || value === undefined ? "n/a" : format(value)
}

/** One labelled figure: eyebrow above, monospaced value below. */
function Stat({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <span className={cn("truncate font-mono text-sm tabular", className)}>{value}</span>
    </div>
  )
}

/** One line inside a leg panel. */
function LegRow({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-xs tabular", className)}>{value}</span>
    </div>
  )
}

/** The full fill history of one short leg. Legs are independent, so each stands alone. */
function LegPanel({ side, leg }: { side: "CE" | "PE"; leg: LegDetail }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-hairline bg-panel p-3">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
          SHORT {side}
        </Badge>
        <span className="truncate text-xs font-medium">{leg.symbol}</span>
      </div>
      <p className="truncate font-mono text-xs text-muted-foreground">{leg.instrument_key}</p>

      <Separator />

      <div className="flex flex-col gap-1.5">
        <LegRow label="Entry" value={rupees(leg.entry_price)} />
        <LegRow label="Stop" value={rupees(leg.stop_price)} className="text-amber" />
        <LegRow label="Exit" value={rupees(leg.exit_price)} />
        <LegRow label="Exit time" value={`${leg.exit_time} IST`} />
      </div>

      <Separator />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge
          variant="outline"
          className={cn("font-medium", EXIT_REASON_TONE[leg.exit_reason])}
        >
          {EXIT_REASON_LABEL[leg.exit_reason] ?? leg.exit_reason}
        </Badge>
        <span className={cn("font-mono text-sm tabular", pnlTone(leg.pnl))}>
          {money(leg.pnl)}
        </span>
      </div>
    </div>
  )
}

/*
  The bars one leg was walked over, oldest first. The engine stops looking the
  moment a stop fires, so the list ends AT the exit bar rather than at the exit
  time: its length is the audit, and the last row is the fill. Rendered as a
  plain scroller because a session is a few hundred rows and virtualising them
  would put a second, cleverer thing between the reader and the candles.
*/
function BarTable({ side, bars }: { side: "CE" | "PE"; bars: BarTrace[] }) {
  if (bars.length === 0) return null

  /* One stop per leg, unchanged for the whole walk, so it belongs in the header
     and not repeated down a column that would only steal width from the OHLC. */
  const stop = bars[0].stop_price

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-hairline bg-panel p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="eyebrow">{side} bars walked</span>
        <span className="font-mono text-[10px] tabular text-muted-foreground">
          stop <span className="text-amber">{rupees(stop)}</span> · {bars.length}{" "}
          {bars.length === 1 ? "bar" : "bars"}
        </span>
      </div>

      <div className="max-h-64 overflow-y-auto">
        <table className="w-full border-separate border-spacing-0 text-right">
          <thead>
            <tr>
              {["Time", "Open", "High", "Low", "Close"].map((label, index) => (
                <th
                  key={label}
                  scope="col"
                  className={cn(
                    "sticky top-0 z-10 border-b border-hairline bg-panel px-1 py-1 font-mono text-[10px] font-medium text-muted-foreground",
                    index === 0 && "text-left"
                  )}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {bars.map((bar, index) => (
              <tr
                key={bar.time}
                className={cn(
                  bar.triggered && "bg-amber/10",
                  /* The first row is the entry bar, and entry is its OPEN. Marking
                     it is what lets a reader see where the entry price came from. */
                  index === 0 && !bar.triggered && "bg-secondary/40"
                )}
              >
                <td
                  className={cn(
                    "tabular border-b border-hairline px-1 py-0.5 text-left font-mono text-[10px]",
                    bar.triggered ? "text-amber" : "text-muted-foreground"
                  )}
                >
                  {bar.time}
                </td>
                {[bar.open, bar.high, bar.low, bar.close].map((value, column) => (
                  <td
                    key={column}
                    className={cn(
                      "tabular border-b border-hairline px-1 py-0.5 font-mono text-[10px]",
                      /* Open and high are the two the stop is tested against, in
                         that order, so they are the ones to read on a filled row. */
                      bar.triggered && column <= 1 && "font-medium text-amber"
                    )}
                  >
                    {decimal(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        The walk stops at the bar that filled, so the last row is the exit bar. A
        highlighted row is one whose high reached the stop, or whose open was already
        past it.
      </p>
    </div>
  )
}

export function CellDetailDialog({ open, onOpenChange, cell, data }: CellDetailDialogProps) {
  /*
    One narrowed pair so the header, the body and the footer share a single
    guard instead of each re-testing both props for null.
  */
  const detail = cell !== null && data !== null ? { cell, data } : null
  const available = detail !== null && detail.cell.status === "ok"

  /*
    HeatmapCell carries gross and net only, so the charge line is the gap
    between them. It is 0.0 in v1: a cost model that does not exist yet, not a
    free trade, and the caption below says so.
  */
  const gross = detail?.cell.gross_pnl ?? null
  const net = detail?.cell.net_pnl ?? null
  const charges = gross !== null && net !== null ? gross - net : null
  const chargesText =
    charges === null || Math.abs(charges) < CHARGE_EPSILON ? "Not modelled" : money(-charges)

  const [audit, setAudit] = useState<AuditResponse | null>(null)
  const [auditing, setAuditing] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)

  /*
    Keyed on the identity of the cell rather than on the objects that carry it,
    so re-rendering the parent does not re-fetch, and clicking a different cell
    does. Only an `ok` cell is worth asking about: an unavailable one has no
    bars by definition, and the reason is already on screen.
  */
  const auditable = detail !== null && detail.cell.status === "ok" ? detail.cell : null
  const entryTime = auditable === null ? null : auditable.entry_time
  const stopLoss = auditable === null ? null : auditable.stop_loss
  const chain = data?.underlying ?? ""
  const day = data?.date ?? ""
  const expiry = data?.expiry ?? ""
  const exitTime = data?.exit_time ?? ""
  const lots = data?.lots ?? 1

  useEffect(() => {
    if (!open || entryTime === null || stopLoss === null || !isUnderlying(chain)) {
      setAudit(null)
      setAuditError(null)
      return
    }

    /* Reopening on another cell must not leave the previous cell's bars on
       screen while the new ones are in flight. */
    setAudit(null)
    setAuditError(null)
    setAuditing(true)

    const controller = new AbortController()
    api
      .auditStraddleCell(
        {
          underlying: chain,
          date: day,
          expiry,
          entry_time: entryTime,
          stop_loss: stopLoss,
          exit_time: exitTime,
          lots,
        },
        controller.signal
      )
      .then((next) => {
        if (controller.signal.aborted) return
        setAudit(next)
      })
      .catch((exception: unknown) => {
        if (controller.signal.aborted) return
        /* The summary above is still true and still useful, so a failed trace
           is reported in place instead of taking the dialog down with it. */
        setAuditError(
          exception instanceof ApiError ? exception.message : "Could not load the bars"
        )
      })
      .finally(() => {
        if (controller.signal.aborted) return
        setAuditing(false)
      })

    return () => controller.abort()
  }, [open, chain, day, expiry, entryTime, stopLoss, exitTime, lots])

  /*
    The audit re-runs the same engine over the same bars, so it must land on the
    same rupee. Saying so when it does not is the whole point of an audit; it is
    never papered over by preferring one number.
  */
  const auditNet = audit?.cell.net_pnl ?? null
  const disagrees =
    net !== null && auditNet !== null && Math.abs(net - auditNet) >= CHARGE_EPSILON

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {detail
              ? `${detail.data.underlying} · ${detail.cell.entry_time} entry · ${detail.cell.stop_loss}% stop`
              : "Cell detail"}
          </DialogTitle>
          <DialogDescription>
            {detail
              ? `ATM short straddle on ${detail.data.date}, ${detail.data.expiry} expiry, flat by ${detail.data.exit_time} IST.`
              : "Select a cell in the grid to see how it was simulated."}
          </DialogDescription>
        </DialogHeader>

        {detail && !available ? (
          <div className="flex items-start gap-3 rounded-md border border-amber/40 bg-panel px-4 py-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber" />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-amber">This cell was not simulated</p>
              <p className="text-sm text-muted-foreground">
                {detail.cell.reason ?? "The engine reported no reason."}
              </p>
            </div>
          </div>
        ) : null}

        {detail && available ? (
          <>
            <div className="grid grid-cols-2 gap-4 rounded-md border border-hairline bg-panel px-4 py-3 sm:grid-cols-4">
              <Stat
                label="Spot at entry"
                value={figure(detail.cell.spot_at_entry, decimal)}
              />
              <Stat
                label="ATM strike"
                value={figure(detail.cell.strike, decimal)}
                className="text-violet"
              />
              <Stat label="Lot size" value={String(detail.data.lot_size)} />
              <Stat
                label="Quantity"
                value={`${detail.cell.quantity ?? detail.data.quantity} (${detail.data.lots} ${
                  detail.data.lots === 1 ? "lot" : "lots"
                })`}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {detail.cell.ce ? <LegPanel side="CE" leg={detail.cell.ce} /> : null}
              {detail.cell.pe ? <LegPanel side="PE" leg={detail.cell.pe} /> : null}
            </div>

            <div className="flex flex-col gap-2 rounded-md border border-hairline bg-panel px-4 py-3">
              <div className="grid grid-cols-3 gap-4">
                <Stat
                  label="Gross P&L"
                  value={figure(gross, money)}
                  className={pnlTone(gross ?? 0)}
                />
                <Stat label="Charges" value={chargesText} className="text-muted-foreground" />
                <Stat
                  label="Net P&L"
                  value={figure(net, money)}
                  className={pnlTone(net ?? 0)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Brokerage, exchange fees, STT, stamp duty and slippage are not modelled in
                v1, so net equals gross. Both are pre-cost figures, not what the account
                would have seen.
              </p>
            </div>

            {disagrees ? (
              <div className="flex items-start gap-3 rounded-md border border-down/40 bg-panel px-4 py-3">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-down" />
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-down">
                    The re-run disagrees with the grid
                  </p>
                  <p className="text-sm text-muted-foreground">
                    The grid holds {money(net ?? 0)} and re-running this cell produced{" "}
                    {money(auditNet ?? 0)}. Treat both as unverified until the difference
                    is explained.
                  </p>
                </div>
              </div>
            ) : null}

            {auditing ? (
              <div className="flex items-center gap-2 rounded-md border border-hairline bg-panel px-4 py-3">
                <Loader2 className="size-3.5 animate-spin text-violet" />
                <span className="text-sm text-muted-foreground">
                  Loading the bars this cell was walked over
                </span>
              </div>
            ) : null}

            {auditError !== null ? (
              <div className="flex items-start gap-3 rounded-md border border-amber/40 bg-panel px-4 py-3">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber" />
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-amber">
                    The bar trace could not be loaded
                  </p>
                  <p className="text-sm text-muted-foreground">{auditError}</p>
                </div>
              </div>
            ) : null}

            {audit !== null ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <BarTable side="CE" bars={audit.ce_trace} />
                <BarTable side="PE" bars={audit.pe_trace} />
              </div>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
