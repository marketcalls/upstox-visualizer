/*
  One generic form for all 86 indicators. Nothing in here knows an indicator by
  name: every field is generated from the descriptor's declared inputs plus the
  per-plot style inputs the runtime derives, so a newly registered indicator
  gets a working settings dialog without a line of code here changing.
*/

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { RotateCcw } from "lucide-react"
import {
  INDICATOR_SOURCES,
  indicatorDefaults,
  indicatorStyleInputs,
  type IndicatorDescriptor,
  type IndicatorInput,
} from "openalgo-charts"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ChartTerminal } from "@/lib/chart-terminal"
import { cn } from "@/lib/utils"

type NumberInput = Extract<IndicatorInput, { type: "number" }>

/*
  Every keystroke is applied to the live chart, but a full recompute is O(n) per
  indicator and no built-in implements calcTail, so typing "200" one digit at a
  time would run three of them. Coalesce free typing into one commit.
*/
const COMMIT_DELAY_MS = 200

const FALLBACK_COLOR = "#4f8cff"

interface FieldSection {
  key: string
  title: string
  inputs: IndicatorInput[]
}

export interface IndicatorSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instanceId: string | null
  terminal: ChartTerminal | null
}

/* ------------------------------------------------------------- descriptor */

/*
  ChartTerminal hands the descriptor back as `unknown` so it does not leak the
  chart library into its own signature. Shape-check it rather than blind-cast:
  a removed instance resolves to null and the dialog has to survive that.
*/
function asDescriptor(value: unknown): IndicatorDescriptor | null {
  if (value === null || typeof value !== "object") return null
  const candidate = value as Partial<IndicatorDescriptor>
  if (!Array.isArray(candidate.inputs) || !Array.isArray(candidate.plots)) return null
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return null
  return candidate as IndicatorDescriptor
}

/*
  Style keys are two families in one flat bag. `indicatorStyleInputs` generates
  colour, opacity, thickness, line style and plot style for every plot; a
  descriptor may additionally declare colours of its own that no plot names
  (band and fill colours such as `bandColor`). Both are appearance, so both
  belong on the Style tab.
*/
function styleInputsOf(descriptor: IndicatorDescriptor): IndicatorInput[] {
  const generated = indicatorStyleInputs(descriptor)
  const claimed = new Set(generated.map((input) => input.key))
  const declared = descriptor.inputs.filter(
    (input) => input.type === "color" && !claimed.has(input.key)
  )
  return [...generated, ...declared]
}

/*
  A plot's colourKey points at a declared input, so the generated list already
  covers it. Without this filter RSI would show its "Color" row twice, once per
  tab, and the two rows would fight over the same key.
*/
function calcInputsOf(descriptor: IndicatorDescriptor): IndicatorInput[] {
  const styling = new Set(styleInputsOf(descriptor).map((input) => input.key))
  return descriptor.inputs.filter((input) => !styling.has(input.key))
}

/*
  `indicatorDefaults` only walks the declared inputs, so the generated style
  keys have to be folded in by hand or a reset would leave the colours alone.
*/
function defaultsOf(descriptor: IndicatorDescriptor): Record<string, unknown> {
  const bag: Record<string, unknown> = { ...indicatorDefaults(descriptor) }
  for (const input of styleInputsOf(descriptor)) bag[input.key] = input.default
  return bag
}

/* Preserve declaration order; an ungrouped run becomes one untitled section. */
function sectionsOf(inputs: readonly IndicatorInput[]): FieldSection[] {
  const order: string[] = []
  const buckets = new Map<string, IndicatorInput[]>()

  for (const input of inputs) {
    const title = input.group ?? ""
    let bucket = buckets.get(title)
    if (!bucket) {
      bucket = []
      buckets.set(title, bucket)
      order.push(title)
    }
    bucket.push(input)
  }

  return order.map((title) => ({
    key: title === "" ? "__ungrouped" : title,
    title,
    inputs: buckets.get(title) ?? [],
  }))
}

/* ------------------------------------------------------------ value shape */

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function stringOf(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
}

function textOf(values: Record<string, unknown>): Record<string, string> {
  const text: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    text[key] = value === null || value === undefined ? "" : String(value)
  }
  return text
}

/* "0.001" -> 3. Enough to scrub the binary dust a divide-then-multiply leaves. */
function decimalsOf(step: number): number {
  const printed = String(step)
  const dot = printed.indexOf(".")
  return dot === -1 ? 0 : printed.length - dot - 1
}

function clampNumber(value: number, input: NumberInput): number {
  let next = value

  if (typeof input.step === "number" && input.step > 0) {
    const base = typeof input.min === "number" ? input.min : 0
    next = base + Math.round((next - base) / input.step) * input.step
    next = Number(next.toFixed(decimalsOf(input.step)))
  }
  if (typeof input.min === "number" && next < input.min) next = input.min
  if (typeof input.max === "number" && next > input.max) next = input.max

  return next
}

/* A native colour well only speaks #rrggbb; descriptors may carry rgba or #rgb. */
function swatchHex(value: string): string {
  const trimmed = value.trim()
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(trimmed)) return trimmed.slice(0, 7).toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
  return FALLBACK_COLOR
}

/* ------------------------------------------------------------- component */

export function IndicatorSettingsDialog({
  open,
  onOpenChange,
  instanceId,
  terminal,
}: IndicatorSettingsDialogProps) {
  const uid = useId()

  const [descriptor, setDescriptor] = useState<IndicatorDescriptor | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [text, setText] = useState<Record<string, string>>({})
  const [tab, setTab] = useState("inputs")

  /*
    What the chart has actually been told. Kept in a ref, not state, because the
    debounced commits and the blur handler read it after their own render.
  */
  const applied = useRef<Record<string, unknown>>({})
  const pending = useRef(new Map<string, { timer: number; run: () => void }>())

  const flushAll = useCallback(() => {
    const queue = pending.current
    for (const entry of queue.values()) {
      window.clearTimeout(entry.timer)
      entry.run()
    }
    queue.clear()
  }, [])

  const flushKey = useCallback((key: string) => {
    const entry = pending.current.get(key)
    if (!entry) return
    window.clearTimeout(entry.timer)
    pending.current.delete(key)
    entry.run()
  }, [])

  const schedule = useCallback((key: string, run: () => void) => {
    const queue = pending.current
    const existing = queue.get(key)
    if (existing) window.clearTimeout(existing.timer)

    const entry = {
      timer: window.setTimeout(() => {
        queue.delete(key)
        run()
      }, COMMIT_DELAY_MS),
      run,
    }
    queue.set(key, entry)
  }, [])

  // Declared before the load effect so a close flushes the last keystroke
  // before the state that keystroke belongs to is torn down.
  useEffect(() => {
    if (!open) flushAll()
  }, [open, flushAll])

  useEffect(() => flushAll, [flushAll])

  useEffect(() => {
    if (!open || !terminal || instanceId === null) {
      setDescriptor(null)
      setValues({})
      setText({})
      applied.current = {}
      return
    }

    const found = asDescriptor(terminal.indicatorDescriptorFor(instanceId))
    const current = terminal.getIndicatorSettings(instanceId)
    if (!found || !current) {
      setDescriptor(null)
      setValues({})
      setText({})
      applied.current = {}
      return
    }

    // A settings bag only carries keys that were explicitly set, so the
    // descriptor's defaults have to backfill the rest or fields render empty.
    const merged = { ...defaultsOf(found), ...current }
    applied.current = { ...merged }
    setDescriptor(found)
    setValues(merged)
    setText(textOf(merged))
    setTab(calcInputsOf(found).length > 0 ? "inputs" : "style")
  }, [open, instanceId, terminal])

  const calcInputs = useMemo(
    () => (descriptor ? calcInputsOf(descriptor) : []),
    [descriptor]
  )
  const styleInputs = useMemo(
    () => (descriptor ? styleInputsOf(descriptor) : []),
    [descriptor]
  )

  const commit = useCallback(
    (key: string, value: unknown) => {
      if (applied.current[key] === value) return
      applied.current[key] = value
      setValues((prev) => ({ ...prev, [key]: value }))
      if (terminal && instanceId !== null) {
        terminal.setIndicatorSettings(instanceId, { [key]: value })
      }
    },
    [terminal, instanceId]
  )

  const typeInto = useCallback(
    (key: string, raw: string) => setText((prev) => ({ ...prev, [key]: raw })),
    []
  )

  function onNumberInput(input: NumberInput, raw: string) {
    typeInto(input.key, raw)
    const parsed = Number(raw)
    // A half-typed "-" or an emptied box is not a number yet: leave the chart
    // on its last good value rather than recomputing against NaN.
    if (raw.trim() === "" || !Number.isFinite(parsed)) return
    schedule(input.key, () => commit(input.key, clampNumber(parsed, input)))
  }

  /* Blur is where the box is normalised, so the user sees what actually applied. */
  function onNumberBlur(input: NumberInput) {
    flushKey(input.key)
    const raw = text[input.key] ?? ""
    const parsed = Number(raw)
    const settled =
      raw.trim() === "" || !Number.isFinite(parsed)
        ? numberOf(applied.current[input.key], input.default)
        : clampNumber(parsed, input)
    typeInto(input.key, String(settled))
    commit(input.key, settled)
  }

  function onTextInput(key: string, raw: string) {
    typeInto(key, raw)
    schedule(key, () => commit(key, raw))
  }

  function resetToDefaults() {
    if (!descriptor || !terminal || instanceId === null) return
    flushAll()

    const defaults = defaultsOf(descriptor)
    applied.current = { ...applied.current, ...defaults }
    setValues((prev) => ({ ...prev, ...defaults }))
    setText((prev) => ({ ...prev, ...textOf(defaults) }))
    // One patch, so the indicator recomputes once rather than once per key.
    terminal.setIndicatorSettings(instanceId, defaults)
  }

  function fieldId(key: string): string {
    return `${uid}-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`
  }

  function renderControl(input: IndicatorInput, id: string) {
    switch (input.type) {
      case "number":
        return (
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            min={input.min}
            max={input.max}
            step={input.step}
            value={text[input.key] ?? ""}
            onChange={(event) => onNumberInput(input, event.target.value)}
            onBlur={() => onNumberBlur(input)}
            className="h-8 w-full text-right font-mono text-xs tabular md:text-xs"
          />
        )

      case "boolean":
        return (
          <Switch
            id={id}
            checked={booleanOf(values[input.key], input.default)}
            onCheckedChange={(on) => commit(input.key, on)}
          />
        )

      case "color": {
        const value = stringOf(values[input.key], input.default)
        return (
          <div className="flex w-full items-center gap-2">
            <input
              id={id}
              type="color"
              aria-label={input.label}
              value={swatchHex(value)}
              onChange={(event) => onTextInput(input.key, event.target.value)}
              className="size-8 shrink-0 cursor-pointer rounded-md border border-hairline bg-transparent p-0.5"
            />
            <Input
              aria-label={`${input.label} value`}
              value={text[input.key] ?? ""}
              onChange={(event) => onTextInput(input.key, event.target.value)}
              className="h-8 min-w-0 flex-1 font-mono text-xs md:text-xs"
            />
          </div>
        )
      }

      case "text":
        return (
          <Input
            id={id}
            value={text[input.key] ?? ""}
            onChange={(event) => onTextInput(input.key, event.target.value)}
            className="h-8 w-full text-xs md:text-xs"
          />
        )

      case "select":
        return (
          <Select
            value={stringOf(values[input.key], input.default)}
            onValueChange={(next) => commit(input.key, next)}
          >
            <SelectTrigger id={id} size="sm" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {input.options.map((option) => (
                <SelectItem key={option.value} value={option.value} className="text-xs">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )

      case "source":
        return (
          <Select
            value={stringOf(values[input.key], input.default)}
            onValueChange={(next) => commit(input.key, next)}
          >
            <SelectTrigger id={id} size="sm" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INDICATOR_SOURCES.map((option) => (
                <SelectItem key={option.value} value={option.value} className="text-xs">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )

      default:
        // An input type this build does not know about still gets a row, so a
        // library upgrade degrades to a read-only label instead of a blank tab.
        return <span className="text-xs text-muted-foreground">Unsupported field</span>
    }
  }

  function renderRow(input: IndicatorInput) {
    const id = fieldId(input.key)
    return (
      <div
        key={input.key}
        className="grid grid-cols-[minmax(0,1fr)_11rem] items-center gap-3"
      >
        <Label htmlFor={id} className="text-sm font-normal text-muted-foreground">
          {input.label}
        </Label>
        <div className="flex items-center justify-end">{renderControl(input, id)}</div>
      </div>
    )
  }

  function renderFields(inputs: readonly IndicatorInput[], empty: string) {
    if (inputs.length === 0) {
      return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
    }
    return (
      <div className="flex flex-col gap-4">
        {sectionsOf(inputs).map((section, index) => (
          <div
            key={section.key}
            className={cn(
              "flex flex-col gap-3",
              index > 0 && "border-t border-hairline pt-4"
            )}
          >
            {section.title ? <p className="eyebrow">{section.title}</p> : null}
            {section.inputs.map(renderRow)}
          </div>
        ))}
      </div>
    )
  }

  const placement =
    descriptor?.placement === "onchart" ? "overlays the price pane" : "draws in its own pane"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{descriptor ? descriptor.name : "Indicator settings"}</DialogTitle>
          <DialogDescription>
            {descriptor
              ? `${descriptor.id} (${placement}). Changes apply to the chart as you make them.`
              : "This indicator is no longer on the chart."}
          </DialogDescription>
        </DialogHeader>

        {descriptor ? (
          <>
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="w-full">
                <TabsTrigger value="inputs">Inputs</TabsTrigger>
                <TabsTrigger value="style">Style</TabsTrigger>
              </TabsList>

              <TabsContent value="inputs">
                <ScrollArea className="max-h-[52vh] pr-3">
                  {renderFields(calcInputs, "This indicator takes no calculation inputs.")}
                </ScrollArea>
              </TabsContent>

              <TabsContent value="style">
                <ScrollArea className="max-h-[52vh] pr-3">
                  {renderFields(styleInputs, "This indicator plots nothing to style.")}
                </ScrollArea>
              </TabsContent>
            </Tabs>

            <DialogFooter className="sm:justify-between">
              <Button variant="ghost" size="sm" onClick={resetToDefaults}>
                <RotateCcw />
                Reset to defaults
              </Button>
              <DialogClose asChild>
                <Button size="sm">Done</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
