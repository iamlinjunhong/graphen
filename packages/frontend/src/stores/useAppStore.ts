import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeMode = "light" | "dark" | "system";
export type AppView = "chat" | "graph" | "documents";

interface AppState {
  themeMode: ThemeMode;
  currentView: AppView;
  sidebarCollapsed: boolean;
  settingsOpen: boolean;
  setThemeMode: (mode: ThemeMode) => void;
  setCurrentView: (view: AppView) => void;
  toggleSidebar: () => void;
  setSettingsOpen: (open: boolean) => void;
  resetUi: () => void;
}

const defaultState = {
  themeMode: "system" as ThemeMode,
  currentView: "chat" as AppView,
  sidebarCollapsed: false,
  settingsOpen: false
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      ...defaultState,
      setThemeMode: (mode) => set({ themeMode: mode }),
      setCurrentView: (view) => set({ currentView: view }),
      toggleSidebar: () =>
        set((state) => ({
          sidebarCollapsed: !state.sidebarCollapsed
        })),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      resetUi: () =>
        set({
          currentView: defaultState.currentView,
          sidebarCollapsed: defaultState.sidebarCollapsed,
          settingsOpen: defaultState.settingsOpen
        })
    }),
    {
      name: "graphen-app-store",
      partialize: (state) => ({
        themeMode: state.themeMode,
        sidebarCollapsed: state.sidebarCollapsed
      })
    }
  )
);
