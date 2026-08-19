import { NavLink, useLocation } from "react-router-dom"
import type { ReactNode } from "react"

import { useSession } from "@/components/session-provider"
import { countdown } from "@/lib/format"
import { cn } from "@/lib/utils"

/** The house mark: one candle, body and wick. */
function CandleMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <line x1="11" y1="1" x2="11" y2="21" stroke="var(--violet)" strokeWidth="1.5" />
      <rect
        x="5.5"
        y="6"
        width="11"
        height="10"
        rx="1.5"
        fill="var(--ink)"
        stroke="var(--violet)"
        strokeWidth="1.5"
      />
    </svg>
  )
}

/*
  Signature element. An Upstox access token always dies at 3:30 AM IST, so the
  whole app carries a hairline that drains as the session burns down.
*/
function TokenTape() {
  const { status, secondsLeft, lifetimeFraction } = useSession()
  const connected = Boolean(status?.connected) && secondsLeft > 0
  const lowOnTime = connected && secondsLeft < 3600

  return (
    <div>
      <div className="relative h-[2px] w-full bg-hairline">
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-1000 ease-linear"
          style={{
            width: connected ? `${lifetimeFraction * 100}%` : "0%",
            background: lowOnTime
              ? "var(--amber)"
              : "linear-gradient(90deg, var(--violet-dim), var(--violet))",
          }}
        />
      </div>
      <div className="mx-auto flex h-7 max-w-7xl items-center justify-between gap-4 overflow-hidden px-5">
        <span className="eyebrow truncate">
          {connected
            ? `Session · ${status?.user_name ?? status?.user_id ?? "Upstox"}`
            : "No active session"}
        </span>
        <span
          className={cn(
            "eyebrow tabular shrink-0",
            lowOnTime && "text-amber",
            connected && !lowOnTime && "text-foreground/70"
          )}
        >
          {connected
            ? `Token expires 03:30 IST · ${countdown(secondsLeft)}`
            : "Connect to load market data"}
        </span>
      </div>
    </div>
  )
}

function Tab({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "relative py-2 text-sm transition-colors",
          isActive
            ? "text-foreground after:absolute after:-bottom-[13px] after:left-0 after:h-[2px] after:w-full after:bg-violet"
            : "text-muted-foreground hover:text-foreground"
        )
      }
    >
      {children}
    </NavLink>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const { status, secondsLeft } = useSession()
  const connected = Boolean(status?.connected) && secondsLeft > 0
  const terminal = useLocation().pathname === "/chart"

  /*
    The terminal takes the whole viewport and never scrolls: the chart is the
    document, so the reading chrome that suits the setup page would only be
    stealing rows from it. That route brings its own bars.
  */
  if (terminal) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        {children}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-hairline bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-8 px-5">
          <div className="flex items-center gap-2.5">
            <CandleMark />
            <div className="leading-none">
              <div className="font-display text-[15px] font-semibold tracking-tight">
                Upstox Console
              </div>
              <div className="eyebrow mt-0.5 text-[9px]">NSE · Equity</div>
            </div>
          </div>

          <nav className="flex items-center gap-6">
            <Tab to="/">Setup</Tab>
            <Tab to="/chart">Chart</Tab>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <span
              className={cn(
                "size-1.5 rounded-full",
                connected ? "bg-up" : "bg-muted-foreground/50"
              )}
            />
            <span className="eyebrow">{connected ? "Live" : "Offline"}</span>
          </div>
        </div>
        <TokenTape />
      </header>

      <main className="grid-field mx-auto max-w-7xl px-5 py-10">{children}</main>

      <footer className="mx-auto max-w-7xl px-5 pb-10">
        <p className="eyebrow">
          Credentials and candles are stored in a local SQLite file · backend/upstox.db
        </p>
      </footer>
    </div>
  )
}
