import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "@graphen/shared";
import { DocumentEditor } from "../../src/documents/DocumentEditor";
import type { EditorDraft } from "../../src/stores/useDocumentStore";

// Mock @uiw/react-md-editor since it requires browser APIs not available in jsdom
vi.mock("@uiw/react-md-editor", () => ({
  __esModule: true,
  default: ({ value, onChange }: { value: string; onChange: (v?: string) => void }) => (
    <textarea
      data-testid="md-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

afterEach(cleanup);

const baseDocument: Document = {
  id: "doc-1",
  filename: "test.md",
  fileType: "md",
  fileSize: 1024,
  status: "completed",
  uploadedAt: new Date("2026-01-01"),
  metadata: { chunkCount: 3, entityCount: 5, edgeCount: 2 },
};

function makeDraft(overrides?: Partial<EditorDraft>): EditorDraft {
  return {
    originalContent: "# Hello",
    editedContent: "# Hello",
    isDirty: false,
    isLoadingContent: false,
    editorMode: "edit" as const,
    contentSource: "parsed" as const,
    truncated: false,
    totalCharCount: 7,
    ...overrides,
  };
}

describe("DocumentEditor", () => {
  const handlers = {
    onContentChange: vi.fn(),
    onDelete: vi.fn(),
    onReparse: vi.fn(),
    onDiscard: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows empty state when no document is selected", () => {
    render(
      <DocumentEditor
        document={null}
        draft={null}
        isDeleting={false}
        isReparsing={false}
        {...handlers}
      />
    );
    expect(screen.getByText("Select a document to view.")).toBeInTheDocument();
  });

  it("shows 'No changes' when draft is not dirty", () => {
    render(
      <DocumentEditor
        document={baseDocument}
        draft={makeDraft()}
        isDeleting={false}
        isReparsing={false}
        {...handlers}
      />
    );
    expect(screen.getByText(/No changes/)).toBeInTheDocument();
  });

  it("shows 'Content modified' when draft is dirty", () => {
    render(
      <DocumentEditor
        document={baseDocument}
        draft={makeDraft({ isDirty: true, editedContent: "# Changed" })}
        isDeleting={false}
        isReparsing={false}
        {...handlers}
      />
    );
    expect(screen.getByText(/Content modified/)).toBeInTheDocument();
  });

  it("disables Discard button when not dirty", () => {
    render(
      <DocumentEditor
        document={baseDocument}
        draft={makeDraft()}
        isDeleting={false}
        isReparsing={false}
        {...handlers}
      />
    );
    const discardBtn = screen.getByText("Discard Changes");
    expect(discardBtn).toBeDisabled();
  });

  it("enables Discard button when dirty and calls onDiscard", () => {
    render(
      <DocumentEditor
        document={baseDocument}
        draft={makeDraft({ isDirty: true })}
        isDeleting={false}
        isReparsing={false}
        {...handlers}
      />
    );
    const discardBtn = screen.getByText("Discard Changes");
    expect(discardBtn).not.toBeDisabled();
    fireEvent.click(discardBtn);
    expect(handlers.onDiscard).toHaveBeenCalledOnce();
  });

  it("calls onReparse with document and content when Reparse is clicked", () => {
    const draft = makeDraft({ isDirty: true, editedContent: "# Edited" });
    render(
      <DocumentEditor
        document={baseDocument}
        draft={draft}
        isDeleting={false}
        isReparsing={false}
        {...handlers}
      />
    );
    fireEvent.click(screen.getByText("Reparse"));
    expect(handlers.onReparse).toHaveBeenCalledWith(baseDocument, "# Edited");
  });

  it("calls onDelete with document when Delete is clicked", () => {
    render(
      <DocumentEditor
        document={baseDocument}
        draft={makeDraft()}
        isDeleting={false}
        isReparsing={false}
        {...handlers}
      />
    );
    fireEvent.click(screen.getByText("Delete"));
    expect(handlers.onDelete).toHaveBeenCalledWith(baseDocument);
  });

  it("shows loading state", () => {
    render(
      <DocumentEditor
        document={baseDocument}
        draft={makeDraft({ isLoadingContent: true })}
        isDeleting={false}
        isReparsing={false}
        {...handlers}
      />
    );
    expect(screen.getByText("Loading content...")).toBeInTheDocument();
  });

  it("shows PDF info banner for PDF documents", () => {
    const pdfDoc = { ...baseDocument, fileType: "pdf" as const };
    render(
      <DocumentEditor
        document={pdfDoc}
        draft={makeDraft()}
        isDeleting={false}
        isReparsing={false}
        {...handlers}
      />
    );
    expect(screen.getByText(/解析文本/)).toBeInTheDocument();
  });

  it("shows truncation warning when content is truncated", () => {
    render(
      <DocumentEditor
        document={baseDocument}
        draft={makeDraft({ truncated: true, totalCharCount: 250000, editedContent: "x".repeat(200000) })}
        isDeleting={false}
        isReparsing={false}
        {...handlers}
      />
    );
    expect(screen.getByText(/内容已截断/)).toBeInTheDocument();
  });
});
