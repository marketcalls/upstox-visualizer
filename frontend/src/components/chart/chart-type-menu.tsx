/*
  The chart-style picker. A Popover rather than a DropdownMenu because the
  transformed styles carry a number the desk has to retune, and a menu steals
  every keystroke for its own typeahead the moment an input lives inside it.
*/

import { useEffect, useId, useState } from "react"
import { CandlestickChart, Check, ChevronDown } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  CHART_KINDS,
  type ChartKind,
  type ChartKindGroup,
} from "@/lib/chart-catalog"
import type { TransformParams } from "@/lib/chart-terminal"
import { cn } from "@/lib/utils"

interface TransformParamSpec {
  key: keyof TransformParams
  label: string
  hint: string
  /* Strictly above zero: RenkoTransform, RangeBarsTransform and KagiTransform
     all throw in their constructor on a non-positive option. */
  min: number
  step: number
  integer: boolean
  /* Built here rather than with a computed key so the patch stays typed. */
  patch: (value: number) => Partial<TransformParams>
}

/*
  Only the styles that take a size appear here. Heikin Ashi is a transform too
  but derives everything from the previous bar, so it has nothing to tune.
*/
const PARAM_SPECS: Partial<Record<ChartKind, TransformParamSpec>> = {
  renko: {
    key: "renkoBox",
    label: "Box size",
    hint: "Rupees of movement per brick.",
    min: 0.01,
    step: 0.5,
    integer: false,
    patch: (value) => ({ renkoBox: value }),
  },
  "range-bars": {
    key: "rangeSize",
    label: "Range",
    hint: "Rupees of high to low per bar.",
    min: 0.01,
    step: 0.5,
    integer: false,
    patch: (value) => ({ rangeSize: value }),
  },
  "line-break": {
    key: "lineBreakLines",
    label: "Lines",
    hint: "Lines to break before the trend flips.",
    min: 1,
    step: 1,
    integer: true,
    patch: (value) => ({ lineBreakLines: value }),
  },
  "point-figure": {
    key: "pfBox",
    label: "Box size",
    hint: "Rupees per box of X or O.",
    min: 0.01,
    step: 0.5,
    integer: false,
    patch: (value) => ({ pfBox: value }),
  },
  kagi: {
    key: "kagiReversal",
    label: "Reversal",
    hint: "Rupees of counter move before the line turns.",
    min: 0.01,
    step: 0.5,
    integer: false,
    patch: (value) => ({ kagiReversal: value }),
  },
}

/* Read off the catalogue in its own order, so a group added there just shows up. */
const GROUPS = CHART_KINDS.reduce<ChartKindGroup[]>((groups, entry) => {
  if (!groups.includes(entry.group)) groups.push(entry.group)
  return groups
}, [])

function settleValue(spec: TransformParamSpec, value: number): number {
  const floored = value < spec.min ? spec.min : value
  return spec.integer ? Math.round(floored) : floored
}

/*
  A controlled number box that refuses to publish rubbish. The draft is local so
  the field can sit empty or half typed while the chart keeps drawing the last
  good size; nothing reaches the terminal until it parses above the minimum.
*/
function ParamField({
  spec,
  value,
  onCommit,
}: {
  spec: TransformParamSpec
  value: number
  onCommit: (next: number) => void
}) {
  const fieldId = useId()
  const [draft, setDraft] = useState(() => String(value))

  /*
    Follow the committed value when it moves on its own, from a restored layout
    or a style switch, but leave a draft that already means the same number
    alone so "5.50" is not rewritten to "5" under the cursor.
  */
  useEffect(() => {
    setDraft((current) => (Number(current) === value ? current : String(value)))
  }, [value])

  const parsed = Number(draft)
  const usable = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= spec.min

  function handleChange(next: string) {
    setDraft(next)
    const candidate = Number(next)
    if (next.trim() === "" || !Number.isFinite(candidate)) return
    if (candidate < spec.min) return
    // Half typed integers such as "1.5" wait for the blur rather than snapping
    // to 2 while the caret is still in the field.
    if (spec.integer && !Number.isInteger(candidate)) return
    onCommit(candidate)
  }

  function handleBlur() {
    // An empty or out of range box would otherwise imply a size the chart never
    // received, so it snaps back to whatever is actually drawn.
    if (!usable) {
      setDraft(String(value))
      return
    }
    const settled = settleValue(spec, parsed)
    setDraft(String(settled))
    if (settled !== value) onCommit(settled)
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId} className="text-xs text-muted-foreground">
        {spec.label}
      </Label>
      <Input
        id={fieldId}
        type="number"
        inputMode="decimal"
        min={spec.min}
        step={spec.step}
        value={draft}
        aria-invalid={!usable}
        aria-describedby={`${fieldId}-hint`}
        onChange={(event) => handleChange(event.target.value)}
        onBlur={handleBlur}
        className="h-8 font-mono text-sm tabular"
      />
      <p id={`${fieldId}-hint`} className="text-xs text-muted-foreground">
        {usable ? spec.hint : `Enter ${spec.min} or more.`}
      </p>
    </div>
  )
}

export interface ChartTypeMenuProps {
  value: ChartKind
  onChange: (kind: ChartKind) => void
  params: TransformParams
  onParamsChange: (patch: Partial<TransformParams>) => void
}

export function ChartTypeMenu({
  value,
  onChange,
  params,
  onParamsChange,
}: ChartTypeMenuProps) {
  const [open, setOpen] = useState(false)

  const active = CHART_KINDS.find((entry) => entry.id === value)
  const spec = PARAM_SPECS[value]

  function choose(kind: ChartKind) {
    if (kind !== value) onChange(kind)
    // Picking a sized style is almost always followed by tuning that number, so
    // the sheet stays open for it and closes for everything else.
    if (!PARAM_SPECS[kind]) setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Chart style, ${active?.name ?? value}`}
        >
          <CandlestickChart className="text-muted-foreground" />
          <span className="max-w-36 truncate">{active?.name ?? value}</span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-84 p-0">
        <div role="radiogroup" aria-label="Chart style" className="p-2">
          {GROUPS.map((group, index) => (
            <div key={group} className={index === 0 ? undefined : "mt-3"}>
              <p className="eyebrow px-1">{group}</p>

              <div className="mt-1.5 grid grid-cols-2 gap-1">
                {CHART_KINDS.filter((entry) => entry.group === group).map((entry) => {
                  const selected = entry.id === value
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => choose(entry.id)}
                      className={cn(
                        "flex h-7 w-full items-center justify-between gap-1 rounded-sm px-2 text-left text-xs transition-colors outline-none",
                        "hover:bg-accent hover:text-accent-foreground",
                        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        selected
                          ? "bg-secondary font-medium text-foreground"
                          : "text-muted-foreground"
                      )}
                    >
                      <span className="truncate">{entry.name}</span>
                      {selected ? <Check className="size-3 shrink-0 text-primary" /> : null}
                    </button>
                  )
                })}
              </div>

              {group === "Transformed" ? (
                <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">
                  Transformed styles rebuild every bar from price movement, so volume
                  is hidden and the time axis is re-indexed, which leaves drawings
                  placed on the raw candles sitting somewhere else.
                </p>
              ) : null}
            </div>
          ))}
        </div>

        {spec ? (
          <div className="border-t border-hairline bg-panel/60 p-3">
            <ParamField
              key={spec.key}
              spec={spec}
              value={params[spec.key]}
              onCommit={(next) => onParamsChange(spec.patch(next))}
            />
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
