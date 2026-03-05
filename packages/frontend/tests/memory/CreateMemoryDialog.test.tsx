import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateMemoryDialog } from "../../src/memory/CreateMemoryDialog";

afterEach(cleanup);

describe("CreateMemoryDialog", () => {
  it("does not render when closed", () => {
    render(
      <CreateMemoryDialog
        open={false}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.queryByRole("dialog", { name: "创建新记忆" })).not.toBeInTheDocument();
  });

  it("submits trimmed content", () => {
    const onSubmit = vi.fn();

    render(
      <CreateMemoryDialog
        open
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    fireEvent.change(screen.getByLabelText("记忆内容"), {
      target: { value: "  需要保存的记忆  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存记忆" }));

    expect(onSubmit).toHaveBeenCalledWith("需要保存的记忆");
  });

  it("disables submit button when content is empty", () => {
    render(
      <CreateMemoryDialog
        open
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("记忆内容"), {
      target: { value: "   " },
    });
    expect(screen.getByRole("button", { name: "保存记忆" })).toBeDisabled();
  });

  it("closes on Escape when not submitting", () => {
    const onClose = vi.fn();

    render(
      <CreateMemoryDialog
        open
        onClose={onClose}
        onSubmit={vi.fn()}
      />
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("does not close on Escape when submitting", () => {
    const onClose = vi.fn();

    render(
      <CreateMemoryDialog
        open
        isSubmitting
        onClose={onClose}
        onSubmit={vi.fn()}
      />
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("resets content after closing and reopening", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(
      <CreateMemoryDialog
        open
        onClose={onClose}
        onSubmit={onSubmit}
      />
    );

    const textarea = screen.getByLabelText("记忆内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "临时内容" } });
    expect(textarea.value).toBe("临时内容");

    rerender(
      <CreateMemoryDialog
        open={false}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    );

    rerender(
      <CreateMemoryDialog
        open
        onClose={onClose}
        onSubmit={onSubmit}
      />
    );

    expect((screen.getByLabelText("记忆内容") as HTMLTextAreaElement).value).toBe("");
  });
});
