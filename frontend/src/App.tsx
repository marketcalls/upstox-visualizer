import { Navigate, Route, Routes } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { SessionProvider } from "@/components/session-provider"
import { Toaster } from "@/components/ui/sonner"
import { ChartPage } from "@/pages/chart"
import { SetupPage } from "@/pages/setup"
import { StraddlePage } from "@/pages/straddle"

function App() {
  return (
    <SessionProvider>
      <AppShell>
        <Routes>
          <Route path="/" element={<SetupPage />} />
          <Route path="/chart" element={<ChartPage />} />
          <Route path="/straddle" element={<StraddlePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
      <Toaster />
    </SessionProvider>
  )
}

export default App
