import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { AppUpdateGate } from "@/components/AppUpdateGate";
import { AuthGuard, PublicOnly } from "@/components/AuthGuard";
import { WorkspaceProvider } from "@/hooks/useWorkspace";
import { AppLayout } from "@/components/AppLayout";
import Workspace from "./pages/Workspace";
import Clients from "./pages/Clients";
import Schedule from "./pages/Schedule";
import SettingsPage from "./pages/Settings";
import NotFound from "./pages/NotFound";
import LoginPage from "./pages/Login";
import RegisterPage from "./pages/Register";
import RecoverPage from "./pages/Recover";
import UnlockPage from "./pages/Unlock";
import ShareManagePage from "./pages/ShareManage";
import SharePublicPage from "./pages/Share";

const queryClient = new QueryClient();

function ProtectedShell() {
  return (
    <AuthGuard>
      <WorkspaceProvider>
        <AppLayout>
          <Routes>
            <Route path="/" element={<Workspace />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/share/manage" element={<ShareManagePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AppLayout>
      </WorkspaceProvider>
    </AuthGuard>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AuthProvider>
        <BrowserRouter>
          <AppUpdateGate>
          <Routes>
            <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
            <Route path="/register" element={<PublicOnly><RegisterPage /></PublicOnly>} />
            <Route path="/recover" element={<PublicOnly><RecoverPage /></PublicOnly>} />
            <Route path="/unlock" element={<UnlockPage />} />
            <Route path="/s/:id" element={<SharePublicPage />} />
            <Route path="/*" element={<ProtectedShell />} />
          </Routes>
          </AppUpdateGate>
        </BrowserRouter>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
