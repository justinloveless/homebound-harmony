import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/contexts/AuthContext';
import { AppUpdateGate } from '@/components/AppUpdateGate';
import { AuthGuard, PublicOnly } from '@/components/AuthGuard';
import { WorkspaceProvider } from '@/hooks/useWorkspace';
import { AppLayout } from '@/components/AppLayout';
import { queryClient } from '@/lib/queryClient';
import Workspace from './pages/Workspace';
import Clients from './pages/Clients';
import Schedule from './pages/Schedule';
import SettingsPage from './pages/Settings';
import NotFound from './pages/NotFound';
import LoginPage from './pages/Login';
import RegisterPage from './pages/Register';
import AdminUsersPage from './pages/admin/AdminUsers';
import AdminUserDetailPage from './pages/admin/AdminUserDetail';
import AdminAuditPage from './pages/admin/AdminAudit';
import WorkspaceTeamPage from './pages/WorkspaceTeam';
import CaregiverVisitView from './pages/CaregiverVisitView';
import VisitDetailPage from './pages/VisitDetail';
import AuthorizationsList from './pages/AuthorizationsList';
import EvvPipelinePage from './pages/EvvPipelinePage';
import BillingDashboard from './pages/BillingDashboard';
import ClaimsList from './pages/ClaimsList';

function WorkspaceShell() {
  return (
    <AuthGuard>
      <WorkspaceProvider>
        <AppLayout>
          <Routes>
            <Route path="/" element={<Workspace />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/visits" element={<CaregiverVisitView />} />
            <Route path="/visits/:id" element={<VisitDetailPage />} />
            <Route path="/authorizations" element={<AuthorizationsList />} />
            <Route path="/evv/pipeline" element={<EvvPipelinePage />} />
            <Route path="/billing" element={<BillingDashboard />} />
            <Route path="/billing/claims" element={<ClaimsList />} />
            <Route path="/workspace/team" element={<WorkspaceTeamPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AppLayout>
      </WorkspaceProvider>
    </AuthGuard>
  );
}

function AdminShell() {
  return (
    <AuthGuard>
      <AppLayout>
        <Routes>
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="users/:id" element={<AdminUserDetailPage />} />
          <Route path="audit" element={<AdminAuditPage />} />
          <Route path="*" element={<Navigate to="users" replace />} />
        </Routes>
      </AppLayout>
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
              <Route
                path="/login"
                element={
                  <PublicOnly>
                    <LoginPage />
                  </PublicOnly>
                }
              />
              <Route
                path="/register"
                element={
                  <PublicOnly>
                    <RegisterPage />
                  </PublicOnly>
                }
              />
              <Route path="/admin/*" element={<AdminShell />} />
              <Route path="/*" element={<WorkspaceShell />} />
            </Routes>
          </AppUpdateGate>
        </BrowserRouter>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
