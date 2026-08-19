import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { api, type AuthStatus } from "@/lib/api"

type SessionValue = {
  status: AuthStatus | null
  loading: boolean
  secondsLeft: number
  lifetimeFraction: number
  refresh: () => Promise<void>
}

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const issuedAt = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await api.getAuthStatus()
      setStatus(next)
      setSecondsLeft(next.seconds_to_expiry)
      issuedAt.current = next.issued_at ? Date.parse(next.issued_at) : null
    } catch {
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const poll = window.setInterval(() => void refresh(), 60_000)
    return () => window.clearInterval(poll)
  }, [refresh])

  useEffect(() => {
    if (!status?.connected) return
    const tick = window.setInterval(
      () => setSecondsLeft((value) => Math.max(0, value - 1)),
      1000
    )
    return () => window.clearInterval(tick)
  }, [status?.connected])

  const lifetimeFraction = useMemo(() => {
    if (!status?.connected || !status.expires_at || !issuedAt.current) return 0
    const total = (Date.parse(status.expires_at) - issuedAt.current) / 1000
    if (total <= 0) return 0
    return Math.min(1, Math.max(0, secondsLeft / total))
  }, [status, secondsLeft])

  const value = useMemo(
    () => ({ status, loading, secondsLeft, lifetimeFraction, refresh }),
    [status, loading, secondsLeft, lifetimeFraction, refresh]
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error("useSession must be used inside SessionProvider")
  return value
}
