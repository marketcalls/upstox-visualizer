/*
  The result grid: entry minutes down the side, stop-loss levels across the top.
  Every number on screen is read straight out of the response, so this component
  holds no state and computes only two things: the colour scale, which needs the
  largest absolute P&L currently on screen to rank the cells against, and, in
  split mode, the per-leg row totals the response only carries net.

  Two modes, one table. Net mode is one row per entry minute. Split mode gives
  each entry minute a CE row and a PE row under one merged time cell, each
  coloured on its own leg, because a short straddle that nets out flat is a very
  different trade depending on whether both legs did nothing or one leg paid for
  the other.
*/

import { Fragment, useMemo } from "react"

import type { HeatmapCell, HeatmapResponse } from "@/lib/api"
import { cn } from "@/lib/utils"

export interface HeatmapGridProps {
  data: HeatmapResponse
  /* False is one net row per entry minute, true stacks a CE row and a PE row. */
  splitLegs: boolean
  onCellClick: (cell: HeatmapCell) => void
}

/* Stacked in this order inside one entry minute, short call above short put. */
const LEG_SIDES = ["CE", "PE"] as const
type Side = (typeof LEG_SIDES)[number]
type LegTotals = Record<Side, number>

/* Indian digit grouping, because every number in this grid is rupees. */
const whole = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 })
const fine = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

/*
  Four figures of P&L do not need paise, and a 20 column grid has no width to
  spare for them. Under a thousand one decimal survives, so a thin edge still
  shows up instead of rounding flat to zero.
*/
function money(value: number): string {
  const rounded =
    Math.abs(value) >= 1000 ? Math.round(value) : Math.round(value * 10) / 10
  // Math.round(-0.02 * 10) / 10 is -0, and Intl prints that as "-0.0".
  const safe = rounded === 0 ? 0 : rounded
  const text = Math.abs(safe) >= 1000 ? whole.format(safe) : fine.format(safe)
  return safe > 0 ? `+${text}` : text
}

/*
  The tint ceiling. Past roughly 60% the mixed colour swallows the foreground
  text, and the number in the cell is the whole point of the cell.
*/
const MAX_MIX = 55
const MIN_MIX = 8
/* Under this share of the peak a cell reads as flat, so it keeps the panel
   colour rather than a tint nobody can rank by eye. */
const DEAD_ZONE = 0.02

/*
  Diverging scale built from the design tokens, never from literal rgb: --up
  above zero, --down below, bg-panel through the middle. Mixing with transparent
  in oklab keeps the token's hue and only scales its alpha, so the tint sits
  correctly over the dark panel underneath.
*/
function tint(pnl: number, peak: number): string | undefined {
  if (peak <= 0) return undefined

  const ratio = Math.min(1, Math.abs(pnl) / peak)
  if (ratio < DEAD_ZONE) return undefined

  // Square root, not a straight ramp: one runaway cell would otherwise flatten
  // every other cell in the grid back into the background.
  const mix = MIN_MIX + (MAX_MIX - MIN_MIX) * Math.sqrt(ratio)
  const token = pnl >= 0 ? "var(--up)" : "var(--down)"
  return `color-mix(in oklab, ${token} ${mix.toFixed(1)}%, transparent)`
}

/*
  Row-major lookup key for the flat cells list. Both halves come out of the same
  JSON numbers the response was built from, so a stop loss of 20 can never
  stringify one way here and another way there.
*/
function cellKey(entryTime: string, stopLoss: number): string {
  return `${entryTime}|${stopLoss}`
}

/*
  col_totals is keyed by Python's str(float), which writes 20.0 where JavaScript
  writes 20. Re-key it by number so the column footer matches its header.
*/
function byNumber(totals: Record<string, number>): Map<number, number> {
  const map = new Map<number, number>()
  for (const [key, value] of Object.entries(totals)) map.set(Number(key), value)
  return map
}

/*
  The number one cell shows in the current mode. Null means there is nothing to
  draw: the cell is unavailable, or that one leg never came back.
*/
function pnlOf(cell: HeatmapCell | undefined, side: Side | null): number | null {
  if (cell === undefined || cell.status !== "ok") return null
  if (side === null) return cell.net_pnl ?? null
  return (side === "CE" ? cell.ce : cell.pe)?.pnl ?? null
}

function cellTitle(cell: HeatmapCell): string {
  const lines = [`Entry ${cell.entry_time} on a ${cell.stop_loss}% stop`]
  if (cell.strike != null) lines.push(`ATM strike ${cell.strike}`)
  if (cell.spot_at_entry != null) lines.push(`Spot at entry ${cell.spot_at_entry}`)
  if (cell.ce) {
    lines.push(`CE ${cell.ce.exit_reason} at ${cell.ce.exit_time}, ${money(cell.ce.pnl)}`)
  }
  if (cell.pe) {
    lines.push(`PE ${cell.pe.exit_reason} at ${cell.pe.exit_time}, ${money(cell.pe.pnl)}`)
  }
  return lines.join("\n")
}

const GRAND_TOTAL_NOTE =
  "Diagnostic only. This adds up independent hypothetical trades, one straddle " +
  "per cell, that were never all taken together. It is not a strategy P&L."

/* The scale key. Without it a tinted grid is just decoration. */
const LEGEND_STEPS = [-1, -0.5, 0, 0.5, 1]

/*
  Split mode has to tell the leg column exactly how far from the left edge to
  stick, and a content-sized column cannot say. So both left-hand columns are
  pinned to a width, and the corner header is pinned to their sum. Keep the
  three in step: 56 + 32 = 88.
*/
const TIME_COL = "w-[56px]"
const LEG_COL = "w-[32px]"
const LEG_OFFSET = "left-[56px]"
const CORNER_BOX = "w-[88px]"

interface GridCellProps {
  cell: HeatmapCell | undefined
  entryTime: string
  stopLoss: number
  /* Null draws the cell's net P&L, CE or PE draws that leg on its own. */
  side: Side | null
  peak: number
  /* True on the second leg row, which keeps a fainter top edge so the pair
     reads as one entry minute rather than two unrelated rows. */
  inner: boolean
  onCellClick: (cell: HeatmapCell) => void
}

function GridCell({
  cell,
  entryTime,
  stopLoss,
  side,
  peak,
  inner,
  onCellClick,
}: GridCellProps) {
  const value = pnlOf(cell, side)
  const where = side === null ? `Entry ${entryTime}` : `Entry ${entryTime}, ${side} leg`
  // Per-side colour utilities only. An all-sides one alongside them would leave
  // the winner up to stylesheet order.
  const edge = cn("border-l-hairline/40", inner ? "border-t-hairline/15" : "border-t-hairline/40")

  if (cell === undefined || value === null) {
    const reason = cell?.reason ?? "No result was returned for this cell"
    return (
      <td
        title={reason}
        className={cn(
          "h-7 min-w-[72px] border-t border-l px-2 text-center font-mono text-[11px] text-muted-foreground/40",
          edge
        )}
      >
        <span aria-hidden="true">-</span>
        <span className="sr-only">
          {`${where}, stop loss ${stopLoss} percent, unavailable: ${reason}`}
        </span>
      </td>
    )
  }

  const background = tint(value, peak)

  return (
    <td className={cn("border-t border-l p-0", edge)}>
      <button
        type="button"
        onClick={() => onCellClick(cell)}
        title={cellTitle(cell)}
        aria-label={`${where}, stop loss ${stopLoss} percent, ${side === null ? "net " : ""}${money(value)} rupees`}
        style={{ backgroundColor: background }}
        className={cn(
          "tabular flex h-7 w-full min-w-[72px] items-center justify-end px-2 font-mono text-[11px] outline-none transition-shadow",
          "hover:ring-1 hover:ring-violet/60 hover:ring-inset",
          "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
          background === undefined ? "text-muted-foreground" : "text-foreground"
        )}
      >
        {money(value)}
      </button>
    </td>
  )
}

export function HeatmapGrid({ data, splitLegs, onCellClick }: HeatmapGridProps) {
  /*
    The peak is taken over the values actually on screen, so switching to split
    mode rescales the grid instead of leaving two leg rows washed out against a
    net maximum they can never reach.
  */
  const { index, peak, colTotals, legTotals } = useMemo(() => {
    const map = new Map<string, HeatmapCell>()
    const legs = new Map<string, LegTotals>()
    let top = 0

    for (const cell of data.cells) {
      map.set(cellKey(cell.entry_time, cell.stop_loss), cell)
      if (cell.status !== "ok") continue

      // Leg totals follow the backend's rule for row_totals: an unavailable cell
      // contributes nothing rather than a zero.
      const running = legs.get(cell.entry_time) ?? { CE: 0, PE: 0 }
      for (const side of LEG_SIDES) {
        const pnl = pnlOf(cell, side)
        if (pnl === null) continue
        running[side] += pnl
        if (splitLegs && Math.abs(pnl) > top) top = Math.abs(pnl)
      }
      legs.set(cell.entry_time, running)

      if (!splitLegs && cell.net_pnl != null) {
        const magnitude = Math.abs(cell.net_pnl)
        if (magnitude > top) top = magnitude
      }
    }

    return {
      index: map,
      peak: top,
      colTotals: byNumber(data.col_totals),
      legTotals: legs,
    }
  }, [data, splitLegs])

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-hairline bg-panel">
      {/* ------------------------------------------------------------ legend */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-2.5">
        <span className="eyebrow shrink-0">{splitLegs ? "Leg P&L" : "Net P&L"}</span>
        <span className="tabular hidden font-mono text-[10px] text-muted-foreground sm:inline">
          {money(-peak)}
        </span>
        <span className="flex shrink-0 items-center gap-px" aria-hidden="true">
          {LEGEND_STEPS.map((step) => (
            <span
              key={step}
              className="h-3 w-5 rounded-[2px] border border-hairline"
              style={{ backgroundColor: tint(step * peak, peak) }}
            />
          ))}
        </span>
        <span className="tabular hidden font-mono text-[10px] text-muted-foreground sm:inline">
          {money(peak)}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span>
            {data.entry_times.length} x {data.stop_losses.length} cells
          </span>
          {data.unavailable_count > 0 ? (
            <span className="text-amber">{data.unavailable_count} unavailable</span>
          ) : null}
        </span>
      </div>

      {/*
        The only scroller on the page. The table is sized to its content, so a
        wide grid moves inside this box and never pushes the page sideways.
      */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max border-separate border-spacing-0 text-right">
          <caption className="sr-only">
            {`ATM short straddle ${splitLegs ? "P&L split into CE and PE legs" : "net P&L"} for ${data.underlying} on ${data.date}, expiry ${data.expiry}, entry time by stop loss percent. Quantity ${data.quantity}.`}
          </caption>

          <thead>
            <tr>
              {/* Corner: sticks in both directions, so it outranks both edges. */}
              {splitLegs ? (
                <th
                  scope="col"
                  colSpan={2}
                  className="sticky top-0 left-0 z-30 border-r border-b border-hairline bg-panel-raised p-0 text-left"
                >
                  {/* Fixed box, so the label can never widen the two pinned
                      columns out from under the sticky offset below. */}
                  <div className={cn(CORNER_BOX, "overflow-hidden px-2 py-1.5 whitespace-nowrap")}>
                    <span className="eyebrow text-[9px]">Entry / SL</span>
                  </div>
                </th>
              ) : (
                <th
                  scope="col"
                  className="sticky top-0 left-0 z-30 border-r border-b border-hairline bg-panel-raised px-2 py-1.5 text-left"
                >
                  <span className="eyebrow text-[9px]">Entry / SL</span>
                </th>
              )}

              {data.stop_losses.map((stopLoss) => (
                <th
                  key={stopLoss}
                  scope="col"
                  className="tabular sticky top-0 z-20 border-b border-hairline bg-panel-raised px-2 py-1.5 font-mono text-[11px] font-medium text-muted-foreground"
                >
                  {stopLoss}%
                </th>
              ))}

              <th
                scope="col"
                className="sticky top-0 z-20 border-b border-l border-hairline bg-panel-raised px-2 py-1.5"
              >
                <span className="eyebrow text-[9px]">Total</span>
              </th>
            </tr>
          </thead>

          <tbody>
            {splitLegs
              ? data.entry_times.map((entryTime) => (
                  <Fragment key={entryTime}>
                    {LEG_SIDES.map((side, position) => (
                      <tr key={side}>
                        {/* One time cell for the pair. It is written on the CE
                            row and spans down over the PE row. */}
                        {position === 0 ? (
                          <th
                            scope="row"
                            rowSpan={2}
                            className={cn(
                              "tabular sticky left-0 z-10 border-r border-hairline bg-panel-raised px-2 font-mono text-[11px] font-normal text-muted-foreground",
                              TIME_COL
                            )}
                          >
                            {entryTime}
                          </th>
                        ) : null}

                        <th
                          scope="row"
                          className={cn(
                            "sticky z-10 border-t border-r border-r-hairline bg-panel-raised px-1 text-center font-mono text-[9px] font-normal tracking-[0.1em] text-muted-foreground/70",
                            LEG_COL,
                            LEG_OFFSET,
                            position === 0 ? "border-t-hairline/40" : "border-t-hairline/15"
                          )}
                        >
                          {side}
                        </th>

                        {data.stop_losses.map((stopLoss) => (
                          <GridCell
                            key={stopLoss}
                            cell={index.get(cellKey(entryTime, stopLoss))}
                            entryTime={entryTime}
                            stopLoss={stopLoss}
                            side={side}
                            peak={peak}
                            inner={position > 0}
                            onCellClick={onCellClick}
                          />
                        ))}

                        {/* Row total: this leg, this entry minute, every stop loss. */}
                        <td
                          className={cn(
                            "tabular border-t border-l border-l-hairline px-2 font-mono text-[11px] text-muted-foreground",
                            position === 0 ? "border-t-hairline" : "border-t-hairline/15"
                          )}
                        >
                          {money(legTotals.get(entryTime)?.[side] ?? 0)}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))
              : data.entry_times.map((entryTime) => (
                  <tr key={entryTime}>
                    <th
                      scope="row"
                      className="tabular sticky left-0 z-10 border-r border-hairline bg-panel-raised px-2 font-mono text-[11px] font-normal text-muted-foreground"
                    >
                      {entryTime}
                    </th>

                    {data.stop_losses.map((stopLoss) => (
                      <GridCell
                        key={stopLoss}
                        cell={index.get(cellKey(entryTime, stopLoss))}
                        entryTime={entryTime}
                        stopLoss={stopLoss}
                        side={null}
                        peak={peak}
                        inner={false}
                        onCellClick={onCellClick}
                      />
                    ))}

                    {/* Row total: this entry minute across every stop loss. */}
                    <td className="tabular border-t border-l border-hairline px-2 font-mono text-[11px] text-muted-foreground">
                      {money(data.row_totals[entryTime] ?? 0)}
                    </td>
                  </tr>
                ))}
          </tbody>

          {/* The footer stays net in both modes: a column of CE plus a column of
              PE is the same money as a column of straddles, so splitting it
              would only invite the reader to add the two up twice. */}
          <tfoot>
            <tr>
              {splitLegs ? (
                <th
                  scope="row"
                  colSpan={2}
                  className="sticky left-0 z-10 border-t border-r border-hairline bg-panel-raised p-0 text-left"
                >
                  <div className={cn(CORNER_BOX, "overflow-hidden px-2 py-1.5 whitespace-nowrap")}>
                    <span className="eyebrow text-[9px]">Net total</span>
                  </div>
                </th>
              ) : (
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-t border-r border-hairline bg-panel-raised px-2 py-1.5 text-left"
                >
                  <span className="eyebrow text-[9px]">Total</span>
                </th>
              )}

              {data.stop_losses.map((stopLoss) => (
                <td
                  key={stopLoss}
                  className="tabular border-t border-l border-hairline px-2 py-1.5 font-mono text-[11px] text-muted-foreground"
                >
                  {money(colTotals.get(stopLoss) ?? 0)}
                </td>
              ))}

              <td
                title={GRAND_TOTAL_NOTE}
                className="tabular border-t border-l border-hairline bg-panel-raised px-2 py-1.5 font-mono text-[11px] font-semibold"
              >
                {money(data.grand_total)}
                <span className="sr-only"> diagnostic total. {GRAND_TOTAL_NOTE}</span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
