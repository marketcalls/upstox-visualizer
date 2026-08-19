/*
  The layer stack: what is actually on the chart right now, and the three things
  a desk does to any of them (mute it, retune it, drop it). The list is a mirror
  of ChartTerminal.activeIndicators(), so it is driven entirely by props and
  holds no state of its own.
*/

import { Eye, EyeOff, Layers, Settings2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { ActiveIndicator } from "@/lib/chart-terminal"
import { cn } from "@/lib/utils"

export interface IndicatorLayersProps {
  indicators: ActiveIndicator[]
  onToggle: (instanceId: string, visible: boolean) => void
  onRemove: (instanceId: string) => void
  onSettings: (instanceId: string) => void
  onClearAll: () => void
}

/* Pane 0 is the price pane, so an indicator there is drawn over the candles. */
function paneLabel(paneIndex: number): string {
  return paneIndex === 0 ? "overlay" : `pane ${paneIndex}`
}

export function IndicatorLayers({
  indicators,
  onToggle,
  onRemove,
  onSettings,
  onClearAll,
}: IndicatorLayersProps) {
  const count = indicators.length

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-hairline bg-panel">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-hairline pr-1 pl-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Layers className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="eyebrow">Indicators</span>
          <span className="tabular shrink-0 rounded-full bg-secondary px-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
            {count}
          </span>
        </div>

        <Button
          variant="ghost"
          size="xs"
          disabled={count === 0}
          onClick={onClearAll}
          className="text-muted-foreground hover:text-foreground"
        >
          Clear all
        </Button>
      </div>

      {count === 0 ? (
        <p className="px-2.5 py-3 text-xs leading-relaxed text-muted-foreground">
          Nothing plotted yet. Pick a study from the Indicators menu to stack it here.
        </p>
      ) : (
        <ScrollArea className="max-h-[260px]">
          <ul className="flex flex-col gap-px p-1">
            {indicators.map((indicator) => (
              <li
                key={indicator.id}
                className="group/layer flex h-[34px] items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-accent focus-within:bg-accent"
              >
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "truncate text-xs leading-[15px] font-medium",
                      indicator.visible ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {indicator.name}
                  </div>
                  <div className="flex items-center gap-1 font-mono text-[10px] leading-[13px] text-muted-foreground">
                    <span className="truncate">{indicator.indicatorId}</span>
                    <span className="shrink-0 text-muted-foreground/50" aria-hidden="true">
                      /
                    </span>
                    <span className="shrink-0">{paneLabel(indicator.paneIndex)}</span>
                  </div>
                </div>

                {/*
                  Dimmed rather than hidden: opacity-0 would take the actions out
                  of sight for anyone tabbing through the stack, and a hover-only
                  reveal cannot be reached by keyboard at all.
                */}
                <div
                  className={cn(
                    "flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity",
                    "group-hover/layer:opacity-100 group-focus-within/layer:opacity-100",
                    !indicator.visible && "opacity-100"
                  )}
                >
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-pressed={indicator.visible}
                    aria-label={`${indicator.visible ? "Hide" : "Show"} ${indicator.name}`}
                    title={indicator.visible ? "Hide on chart" : "Show on chart"}
                    onClick={() => onToggle(indicator.id, !indicator.visible)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {indicator.visible ? <Eye /> : <EyeOff />}
                  </Button>

                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Settings for ${indicator.name}`}
                    title="Settings"
                    onClick={() => onSettings(indicator.id)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Settings2 />
                  </Button>

                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${indicator.name}`}
                    title="Remove"
                    onClick={() => onRemove(indicator.id)}
                    className="text-muted-foreground hover:bg-down/15 hover:text-down"
                  >
                    <X />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}
