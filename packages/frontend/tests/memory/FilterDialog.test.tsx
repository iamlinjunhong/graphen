import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterDialog } from "../../src/memory/FilterDialog";
import type { MemoryListFilters } from "../../src/stores/useMemoryStore";

const EMPTY_FILTERS: MemoryListFilters = {
  sourceTypes: [],
  categories: [],
  states: [],
  reviewStatuses: [],
};

afterEach(cleanup);

describe("FilterDialog", () => {
  it("does not render when open is false", () => {
    render(
      <FilterDialog
        open={false}
        filters={EMPTY_FILTERS}
        categories={[]}
        onApply={vi.fn()}
        onClear={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByRole("dialog", { name: "筛选记忆" })).not.toBeInTheDocument();
  });

  it("applies selected category filters", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();

    render(
      <FilterDialog
        open
        filters={EMPTY_FILTERS}
        categories={[
          { name: "工作", count: 3 },
          { name: "家庭", count: 1 },
        ]}
        onApply={onApply}
        onClear={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "分类" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /工作/ }));
    fireEvent.click(screen.getByRole("button", { name: "应用筛选" }));

    expect(onApply).toHaveBeenCalledWith({
      sourceTypes: [],
      categories: ["工作"],
      states: [],
      reviewStatuses: [],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows loading hint in category tab", () => {
    render(
      <FilterDialog
        open
        filters={EMPTY_FILTERS}
        categories={[]}
        isCategoriesLoading
        onApply={vi.fn()}
        onClear={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "分类" }));
    expect(screen.getByText("分类加载中...")).toBeInTheDocument();
  });

  it("clears and closes when clicking 清除全部", () => {
    const onClear = vi.fn();
    const onClose = vi.fn();

    render(
      <FilterDialog
        open
        filters={{
          sourceTypes: ["document"],
          categories: ["工作"],
          states: ["active"],
          reviewStatuses: ["auto"],
        }}
        categories={[{ name: "工作", count: 2 }]}
        onApply={vi.fn()}
        onClear={onClear}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "清除全部" }));
    expect(onClear).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape key", () => {
    const onClose = vi.fn();

    render(
      <FilterDialog
        open
        filters={EMPTY_FILTERS}
        categories={[]}
        onApply={vi.fn()}
        onClear={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
