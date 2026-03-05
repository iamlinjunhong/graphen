import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "@graphen/shared";
import { UpdateMemoryDialog } from "../../src/memory/UpdateMemoryDialog";

function makeEntry(id: string, content: string): MemoryEntry {
  return {
    id,
    content,
    normalizedContentKey: `key-${id}`,
    state: "active",
    reviewStatus: "auto",
    categories: [],
    sourceType: "manual",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(cleanup);

describe("UpdateMemoryDialog", () => {
  it("does not render when closed or entry is null", () => {
    const { rerender } = render(
      <UpdateMemoryDialog
        open
        entry={null}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerender(
      <UpdateMemoryDialog
        open={false}
        entry={makeEntry("entry-1", "内容A")}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("prefills content and shows entry id in title", () => {
    render(
      <UpdateMemoryDialog
        open
        entry={makeEntry("entry-12345678", "原始内容")}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { name: "编辑记忆 #entry-12" })).toBeInTheDocument();
    expect((screen.getByLabelText("记忆内容") as HTMLTextAreaElement).value).toBe("原始内容");
  });

  it("submits trimmed content", () => {
    const onSubmit = vi.fn();

    render(
      <UpdateMemoryDialog
        open
        entry={makeEntry("entry-1", "旧内容")}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    fireEvent.change(screen.getByLabelText("记忆内容"), {
      target: { value: "  新内容  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    expect(onSubmit).toHaveBeenCalledWith("新内容");
  });

  it("updates textarea when switching to another entry", () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    const { rerender } = render(
      <UpdateMemoryDialog
        open
        entry={makeEntry("entry-1", "内容A")}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    );

    expect((screen.getByLabelText("记忆内容") as HTMLTextAreaElement).value).toBe("内容A");

    rerender(
      <UpdateMemoryDialog
        open
        entry={makeEntry("entry-2", "内容B")}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    );

    expect((screen.getByLabelText("记忆内容") as HTMLTextAreaElement).value).toBe("内容B");
  });

  it("does not close on Escape while submitting", () => {
    const onClose = vi.fn();

    render(
      <UpdateMemoryDialog
        open
        entry={makeEntry("entry-1", "内容A")}
        isSubmitting
        onClose={onClose}
        onSubmit={vi.fn()}
      />
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
