import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, Users, Clock, CalendarDays, Settings, Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/clients', label: 'Clients', icon: Users },
  { to: '/travel', label: 'Travel Times', icon: Clock },
  { to: '/schedule', label: 'Schedule', icon: CalendarDays },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar - desktop */}
      <aside className="hidden md:flex flex-col w-64 bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
        <div className="p-6">
          <h1 className="text-xl font-bold tracking-tight text-sidebar-primary-foreground">
            <span className="text-primary">Route</span>Care
          </h1>
          <p className="text-xs text-sidebar-foreground/60 mt-1">Home Health Scheduler</p>
        </div>
        <nav className="flex-1 px-3 space-y-1">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-primary'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
              )}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-sidebar-border">
          <p className="text-[10px] text-sidebar-foreground/40">Data stored locally • No account needed</p>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <header className="md:hidden flex items-center justify-between px-4 py-3 border-b bg-card">
          <h1 className="text-lg font-bold"><span className="text-primary">Route</span>Care</h1>
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(!mobileOpen)}>
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </Button>
        </header>

        {/* Mobile nav drawer */}
        {mobileOpen && (
          <div className="md:hidden absolute inset-0 z-50 bg-background/80 backdrop-blur-sm" onClick={() => setMobileOpen(false)}>
            <nav className="w-64 h-full bg-sidebar p-4 space-y-1" onClick={e => e.stopPropagation()}>
              <div className="mb-6">
                <h1 className="text-xl font-bold text-sidebar-primary-foreground">
                  <span className="text-primary">Route</span>Care
                </h1>
              </div>
              {navItems.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) => cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-sidebar-accent text-sidebar-primary'
                      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50'
                  )}
                >
                  <item.icon className="w-4 h-4" />
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          {children}
        </main>

        {/* Mobile bottom nav */}
        <nav className="md:hidden flex border-t bg-card">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => cn(
                'flex-1 flex flex-col items-center py-2 text-[10px] font-medium transition-colors',
                isActive ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              <item.icon className="w-5 h-5 mb-0.5" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
