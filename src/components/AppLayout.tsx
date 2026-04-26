import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LayoutGrid, Users, CalendarDays, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';

const navItems = [
  { to: '/', label: 'Workspace', icon: LayoutGrid },
  { to: '/clients', label: 'Clients', icon: Users },
  { to: '/schedule', label: 'Schedule', icon: CalendarDays },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';
  const location = useLocation();

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="p-4">
        {!collapsed ? (
          <>
            <h1 className="text-xl font-bold tracking-tight">
              <span className="text-primary">Route</span>Care
            </h1>
            <p className="text-xs text-sidebar-foreground/60 mt-1">Home Health Scheduler</p>
          </>
        ) : (
          <div className="text-xl font-bold text-primary text-center">R</div>
        )}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map(item => {
                const isActive =
                  item.to === '/'
                    ? location.pathname === '/'
                    : location.pathname.startsWith(item.to);
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild tooltip={item.label} isActive={isActive}>
                      <NavLink to={item.to} end={item.to === '/'}>
                        <item.icon className="w-4 h-4" />
                        <span>{item.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {!collapsed && (
        <SidebarFooter className="p-4 border-t border-sidebar-border">
          <p className="text-[10px] text-sidebar-foreground/40">
            Data stored locally • No account needed
          </p>
        </SidebarFooter>
      )}
    </Sidebar>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-12 flex items-center border-b bg-card px-2 sticky top-0 z-30">
            <SidebarTrigger />
            <h1 className="ml-3 text-sm font-semibold md:hidden">
              <span className="text-primary">Route</span>Care
            </h1>
          </header>
          <main className={cn('flex-1 overflow-y-auto p-4 md:p-8')}>
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
