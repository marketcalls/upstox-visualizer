/** Every timestamp in this app is Indian market time. */
export const IST_OFFSET_SECONDS = 5.5 * 3600

const price = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function rupees(value: number): string {
  return `₹${price.format(value)}`
}

export function decimal(value: number): string {
  return price.format(value)
}

export function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${price.format(value)}`
}

/** Indian market convention: thousands, lakh, crore. */
export function quantity(value: number): string {
  if (value >= 1e7) return `${(value / 1e7).toFixed(2)} Cr`
  if (value >= 1e5) return `${(value / 1e5).toFixed(2)} L`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} K`
  return String(value)
}

/** Chart times are shifted into IST, so read them back as UTC. */
const clock = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
})

const dayShort = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
})

const weekday = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  timeZone: "UTC",
})

export function shiftedTime(seconds: number): string {
  return clock.format(new Date(seconds * 1000))
}

export function shiftedDay(seconds: number): string {
  return dayShort.format(new Date(seconds * 1000))
}

export function sessionLabel(isoDate: string): { day: string; date: string } {
  const stamp = new Date(`${isoDate}T00:00:00Z`)
  return { day: weekday.format(stamp), date: dayShort.format(stamp) }
}

/** "2026-08-05T14:35:00+05:30" as it should be read on a trading desk. */
export function istStamp(iso: string): string {
  const [datePart, timePart = ""] = iso.split("T")
  return `${datePart} ${timePart.slice(0, 5)} IST`
}

export function countdown(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = Math.floor(safe % 60)
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
}
