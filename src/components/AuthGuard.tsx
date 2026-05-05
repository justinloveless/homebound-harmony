import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (auth.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (auth.status === 'locked') {
    return <Navigate to="/unlock" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

export function PublicOnly({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  if (auth.status === 'unlocked') return <Navigate to="/" replace />;
  if (auth.status === 'locked') return <Navigate to="/unlock" replace />;
  return <>{children}</>;
}
