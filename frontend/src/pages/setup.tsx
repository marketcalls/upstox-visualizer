import { useCallback, useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"

import { useSession } from "@/components/session-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { api, ApiError, type Settings } from "@/lib/api"
import { countdown, istStamp } from "@/lib/format"
import { cn } from "@/lib/utils"

const DEVELOPER_APPS_URL = "https://account.upstox.com/developer/apps"

function StepCard({
  step,
  title,
  description,
  children,
  done,
}: {
  step: string
  title: string
  description: string
  children: React.ReactNode
  done?: boolean
}) {
  return (
    <Card className="rise gap-5 border-hairline bg-panel">
      <CardHeader>
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "font-mono text-xs tabular",
              done ? "text-up" : "text-violet"
            )}
          >
            {done ? "DONE" : step}
          </span>
          <span className="h-px flex-1 bg-hairline" />
        </div>
        <CardTitle className="font-display text-lg tracking-tight">{title}</CardTitle>
        <CardDescription className="max-w-2xl leading-relaxed">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  )
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success("Redirect URL copied")
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Copy the URL manually — the clipboard is blocked here.")
    }
  }

  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-hairline bg-background">
      <code className="flex-1 overflow-x-auto px-4 py-3 font-mono text-sm text-foreground">
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        className="flex items-center gap-2 border-l border-hairline px-4 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {copied ? <Check className="size-3.5 text-up" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  )
}

export function SetupPage() {
  const { status, secondsLeft, refresh } = useSession()
  const [params, setParams] = useSearchParams()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [apiSecret, setApiSecret] = useState("")
  const [redirectUri, setRedirectUri] = useState("")
  const [saving, setSaving] = useState(false)
  const [authorising, setAuthorising] = useState(false)

  const callbackError = params.get("error")
  const connected = Boolean(status?.connected) && secondsLeft > 0

  const load = useCallback(async () => {
    const next = await api.getSettings()
    setSettings(next)
    setApiKey(next.api_key ?? "")
    setRedirectUri(next.redirect_uri || next.suggested_redirect_uri)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (callbackError) toast.error(callbackError)
  }, [callbackError])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const next = await api.saveSettings({
        api_key: apiKey.trim(),
        api_secret: apiSecret.trim(),
        redirect_uri: redirectUri.trim(),
      })
      setSettings(next)
      setApiSecret("")
      toast.success("Credentials saved to SQLite")
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not save credentials")
    } finally {
      setSaving(false)
    }
  }

  const authorise = async () => {
    setAuthorising(true)
    try {
      const { login_url } = await api.getLoginUrl()
      window.location.href = login_url
    } catch (error) {
      setAuthorising(false)
      toast.error(error instanceof ApiError ? error.message : "Could not build the login URL")
    }
  }

  const disconnect = async () => {
    await api.logout()
    await refresh()
    toast.success("Session cleared")
  }

  const suggested = settings?.suggested_redirect_uri ?? "http://127.0.0.1:8000/api/auth/callback"
  const savedRedirect = settings?.configured ? settings.redirect_uri : suggested

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-6">
        <header className="space-y-3">
          <p className="eyebrow">Broker connection</p>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Set up Upstox API access
          </h1>
          <p className="max-w-2xl leading-relaxed text-muted-foreground">
            Three steps: register the redirect URL on your Upstox app, save the key and
            secret here, then authorise. Everything is stored locally in SQLite — no
            environment files involved.
          </p>
        </header>

        {callbackError ? (
          <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Upstox rejected the login</p>
              <p className="font-mono text-xs text-muted-foreground">{callbackError}</p>
            </div>
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto"
              onClick={() => setParams({}, { replace: true })}
            >
              Dismiss
            </Button>
          </div>
        ) : null}

        <StepCard
          step="STEP 01"
          title="Register the redirect URL"
          description="After you log in, Upstox sends the authorization code back to a URL you registered on the app. It must match what this backend listens on, character for character."
        >
          <CopyField value={suggested} />

          <ol className="space-y-3 text-sm text-muted-foreground">
            <li className="flex gap-3">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-violet" />
              <span>
                Open{" "}
                <a
                  href={DEVELOPER_APPS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline decoration-violet/50 underline-offset-4 hover:decoration-violet"
                >
                  account.upstox.com/developer/apps
                  <ExternalLink className="size-3" />
                </a>{" "}
                and create an app, or edit the one you already have.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-violet" />
              <span>
                Paste the URL above into <span className="text-foreground">Redirect URI</span>.
                Pick any app name; the redirect URL is the field that matters.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-violet" />
              <span>
                Save the app, then copy the <span className="text-foreground">API key</span>{" "}
                and <span className="text-foreground">API secret</span> it shows you.
              </span>
            </li>
          </ol>

          <Separator className="bg-hairline" />

          <ul className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <li>
              <span className="text-foreground">Exact match.</span> Scheme, host, port and
              path all count. <code className="font-mono">127.0.0.1</code> and{" "}
              <code className="font-mono">localhost</code> are different URLs.
            </li>
            <li>
              <span className="text-foreground">No trailing slash.</span> Register the path
              ending in <code className="font-mono">/callback</code>.
            </li>
            <li>
              <span className="text-foreground">http is fine locally.</span> Upstox accepts
              plain http on a loopback address for development.
            </li>
            <li>
              <span className="text-foreground">Avoid .php endpoints.</span> Upstox filters
              those out of redirect URLs.
            </li>
          </ul>
        </StepCard>

        <StepCard
          step="STEP 02"
          title="Save your API key and secret"
          description="These are written to the local SQLite database and used server-side to exchange the authorization code for an access token."
          done={settings?.configured}
        >
          <form onSubmit={save} className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="api-key">API key</Label>
                <Input
                  id="api-key"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="615b1297-d443-3b39-ba19-1927fbcdddc7"
                  className="font-mono text-sm"
                  autoComplete="off"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="api-secret">API secret</Label>
                <Input
                  id="api-secret"
                  type="password"
                  value={apiSecret}
                  onChange={(event) => setApiSecret(event.target.value)}
                  placeholder={
                    settings?.configured ? settings.api_secret_masked ?? "" : "Your app secret"
                  }
                  className="font-mono text-sm"
                  autoComplete="off"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="redirect-uri">Redirect URL</Label>
              <Input
                id="redirect-uri"
                value={redirectUri}
                onChange={(event) => setRedirectUri(event.target.value)}
                className="font-mono text-sm"
                autoComplete="off"
                required
              />
              <p className="text-xs text-muted-foreground">
                Change this only if you registered a different URL on the Upstox app.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : <KeyRound />}
                Save credentials
              </Button>
              {settings?.configured && settings.updated_at ? (
                <span className="font-mono text-xs text-muted-foreground">
                  Saved {istStamp(settings.updated_at)}
                </span>
              ) : null}
            </div>
          </form>
        </StepCard>

        <StepCard
          step="STEP 03"
          title="Authorise with Upstox"
          description="You are sent to upstox.com to log in. Upstox returns an authorization code to your redirect URL, and the backend swaps it for an access token."
          done={connected}
        >
          {connected ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild>
                <Link to="/chart">
                  Open RELIANCE chart
                  <ArrowRight />
                </Link>
              </Button>
              <Button variant="outline" onClick={disconnect}>
                <LogOut />
                Disconnect
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <Button onClick={authorise} disabled={!settings?.configured || authorising}>
                {authorising ? <Loader2 className="animate-spin" /> : null}
                Log in with Upstox
              </Button>
              {!settings?.configured ? (
                <span className="text-xs text-muted-foreground">
                  Save your credentials first.
                </span>
              ) : null}
            </div>
          )}
        </StepCard>
      </div>

      <aside className="space-y-6 lg:sticky lg:top-28 lg:self-start">
        <Card className="rise gap-4 border-hairline bg-panel">
          <CardHeader>
            <CardTitle className="eyebrow">Session</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {connected ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-up" />
                  <span className="font-display text-lg font-semibold tracking-tight">
                    {status?.user_name ?? "Connected"}
                  </span>
                </div>
                <dl className="space-y-2 font-mono text-xs">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">User</dt>
                    <dd className="tabular">{status?.user_id ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Broker</dt>
                    <dd>{status?.broker ?? "UPSTOX"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Expires in</dt>
                    <dd className="tabular">{countdown(secondsLeft)}</dd>
                  </div>
                </dl>
                {status?.exchanges?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {status.exchanges.map((exchange) => (
                      <Badge
                        key={exchange}
                        variant="secondary"
                        className="font-mono text-[10px]"
                      >
                        {exchange}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm leading-relaxed text-muted-foreground">
                No access token yet. Finish the three steps and the chart screen unlocks.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="gap-4 border-hairline bg-panel">
          <CardHeader>
            <CardTitle className="eyebrow">Reference</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 font-mono text-xs">
              <div>
                <dt className="text-muted-foreground">Callback</dt>
                <dd className="mt-1 break-all">{savedRedirect}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Token lifetime</dt>
                <dd className="mt-1">Until 03:30 IST next day</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Storage</dt>
                <dd className="mt-1">backend/upstox.db</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">API docs</dt>
                <dd className="mt-1">
                  <a
                    href="https://upstox.com/developer/api-documentation"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 underline decoration-violet/50 underline-offset-4"
                  >
                    upstox.com/developer
                    <ExternalLink className="size-3" />
                  </a>
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </aside>
    </div>
  )
}
