import { Suspense, lazy, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { MainContent } from "./components/layout/MainContent";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { ChatView } from "./pages/ChatView";
import { DocumentView } from "./pages/DocumentView";
import type { AppView } from "./stores/useAppStore";
import { useAppStore } from "./stores/useAppStore";

const LazyGraphView = lazy(async () => {
  const module = await import("./pages/GraphView");
  return { default: module.GraphView };
});

function GraphRouteFallback() {
  return (
    <section className="page-shell">
      <header className="page-header">
        <p className="page-kicker">Knowledge Map</p>
        <h2 className="page-title">Loading Graph Explorer...</h2>
      </header>
      <div className="panel content-panel">
        <p className="muted">Loading Reagraph modules and graph UI chunks.</p>
      </div>
    </section>
  );
}

export function App() {
  const location = useLocation();
  const themeMode = useAppStore((state) => state.themeMode);
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  const setThemeMode = useAppStore((state) => state.setThemeMode);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const setCurrentView = useAppStore((state) => state.setCurrentView);

  useEffect(() => {
    if (themeMode === "system") {
      document.documentElement.removeAttribute("data-theme");
      return;
    }

    document.documentElement.setAttribute("data-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    const path = location.pathname;
    let nextView: AppView = "chat";
    if (path.startsWith("/graph")) {
      nextView = "graph";
    } else if (path.startsWith("/documents")) {
      nextView = "documents";
    }
    setCurrentView(nextView);
  }, [location.pathname, setCurrentView]);

  useEffect(() => {
    if (!settingsOpen) {
      document.body.removeAttribute("data-settings-open");
      return;
    }
    document.body.setAttribute("data-settings-open", "true");
  }, [settingsOpen]);

  return (
    <div className="app-shell">
      <TopBar
        themeMode={themeMode}
        settingsOpen={settingsOpen}
        onThemeChange={setThemeMode}
        onSidebarToggle={toggleSidebar}
        onSettingsToggle={() => setSettingsOpen(!settingsOpen)}
      />
      <div className="app-body">
        <Sidebar collapsed={sidebarCollapsed} />
        <MainContent>
          <Routes>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/chat" element={<ChatView />} />
            <Route
              path="/graph"
              element={
                <Suspense fallback={<GraphRouteFallback />}>
                  <LazyGraphView />
                </Suspense>
              }
            />
            <Route path="/documents" element={<DocumentView />} />
          </Routes>
        </MainContent>
      </div>
    </div>
  );
}
