import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TopBar } from "../../src/components/layout/TopBar";

afterEach(cleanup);

describe("TopBar", () => {
  it('renders "MemoryWaving" as the brand title', () => {
    render(
      <TopBar
        themeMode="light"
        settingsOpen={false}
        onThemeChange={() => {}}
        onSidebarToggle={() => {}}
        onSettingsToggle={() => {}}
      />,
    );
    const brandTitle = screen.getByText("MemoryWaving");
    expect(brandTitle).toBeInTheDocument();
    expect(brandTitle.className).toBe("brand-title");
  });
});
