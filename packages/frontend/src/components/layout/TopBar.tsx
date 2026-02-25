import { Bell, Box, ChevronDown, Moon, Settings, Sun } from "lucide-react";
import type { ThemeMode } from "../../stores/useAppStore";

interface TopBarProps {
  themeMode: ThemeMode;
  settingsOpen: boolean;
  onThemeChange: (mode: ThemeMode) => void;
  onSidebarToggle: () => void;
  onSettingsToggle: () => void;
}

export function TopBar({
  themeMode,
  settingsOpen,
  onThemeChange,
  onSettingsToggle
}: TopBarProps) {
  return (
    <header className="topbar">
      {/* Brand */}
      <div className="brand-block">
        <div className="brand-dot">
          <Box size={18} strokeWidth={2.5} />
        </div>
        <h1 className="brand-title">GraphRAG</h1>
      </div>

      {/* Right actions */}
      <div className="topbar-actions">
        {/* Theme switcher */}
        <div className="theme-switcher" role="group" aria-label="Theme mode">
          <button
            type="button"
            className={themeMode === "light" ? "is-active" : ""}
            onClick={() => onThemeChange("light")}
            aria-label="Light theme"
          >
            <Sun size={15} />
          </button>
          <button
            type="button"
            className={themeMode === "dark" ? "is-active" : ""}
            onClick={() => onThemeChange("dark")}
            aria-label="Dark theme"
          >
            <Moon size={15} />
          </button>
        </div>

        {/* Notification */}
        <button type="button" className="icon-button" aria-label="Notifications">
          <Bell size={17} />
        </button>

        {/* Settings */}
        <button
          type="button"
          className={settingsOpen ? "icon-button is-active" : "icon-button"}
          aria-label="Settings"
          onClick={onSettingsToggle}
        >
          <Settings size={17} />
        </button>

        {/* User avatar */}
        <div className="topbar-user">
          <div className="topbar-avatar">L</div>
          <span className="topbar-user-name">Lin Junhong</span>
          <ChevronDown size={13} strokeWidth={2} style={{ color: "var(--text-muted)" }} />
        </div>
      </div>
    </header>
  );
}
