import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';

export function AdminGate({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  if (!auth.me?.isAdmin) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
