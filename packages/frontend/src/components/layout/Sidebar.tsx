import * as Tooltip from "@radix-ui/react-tooltip";
import { CloudUpload, MessageSquare, Network } from "lucide-react";
import type { ComponentType } from "react";
import { NavLink } from "react-router-dom";

interface NavigationItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

interface SidebarProps {
  collapsed?: boolean;
}

const navItems: NavigationItem[] = [
  { to: "/chat", label: "AI Chat", icon: MessageSquare },
  { to: "/documents", label: "Data Upload", icon: CloudUpload },
  { to: "/graph", label: "Graph Explorer", icon: Network }
];

export function Sidebar({ collapsed = false }: SidebarProps) {
  return (
    <Tooltip.Provider delayDuration={200}>
      <aside className={collapsed ? "sidebar is-collapsed" : "sidebar"}>
        <nav className="sidebar-nav" aria-label="Primary">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Tooltip.Root key={item.to}>
                {/* 
                  Wrapping NavLink in a span so Tooltip.Trigger (asChild) 
                  applies its ref/event handlers to the span — not the NavLink.
                  This prevents Radix from merging its own className onto NavLink
                  and overriding the isActive className logic.
                */}
                <Tooltip.Trigger asChild>
                  <span style={{ display: "contents" }}>
                    <NavLink
                      to={item.to}
                      className={({ isActive }) =>
                        isActive ? "sidebar-link is-active" : "sidebar-link"
                      }
                      aria-label={item.label}
                    >
                      <Icon size={20} strokeWidth={2} />
                    </NavLink>
                  </span>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className="tooltip-content"
                    side="right"
                    sideOffset={12}
                  >
                    {item.label}
                    <Tooltip.Arrow className="tooltip-arrow" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            );
          })}
        </nav>
      </aside>
    </Tooltip.Provider>
  );
}
