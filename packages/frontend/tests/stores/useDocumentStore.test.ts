import { afterEach, describe, expect, it } from "vitest";
import { useDocumentStore } from "../../src/stores/useDocumentStore";

afterEach(() => {
  useDocumentStore.getState().reset();
});

describe("useDocumentStore editor draft", () => {
  it("setDraft stores a draft for a document", () => {
    const { setDraft } = useDocumentStore.getState();
    setDraft("doc-1", {
      originalContent: "Hello",
      editedContent: "Hello",
      isDirty: false,
      isLoadingContent: false,
      editorMode: "edit",
      contentSource: "parsed",
      truncated: false,
      totalCharCount: 5,
    });

    const draft = useDocumentStore.getState().draftsByDocumentId["doc-1"];
    expect(draft).toBeDefined();
    expect(draft!.originalContent).toBe("Hello");
    expect(draft!.isDirty).toBe(false);
  });

  it("setDraftContent marks isDirty when content differs from original", () => {
    const { setDraft, setDraftContent } = useDocumentStore.getState();
    setDraft("doc-1", {
      originalContent: "Hello",
      editedContent: "Hello",
      isDirty: false,
      isLoadingContent: false,
      editorMode: "edit",
      contentSource: "parsed",
      truncated: false,
      totalCharCount: 5,
    });

    setDraftContent("doc-1", "Hello World");
    const draft = useDocumentStore.getState().draftsByDocumentId["doc-1"];
    expect(draft!.isDirty).toBe(true);
    expect(draft!.editedContent).toBe("Hello World");
  });

  it("setDraftContent clears isDirty when content matches original", () => {
    const { setDraft, setDraftContent } = useDocumentStore.getState();
    setDraft("doc-1", {
      originalContent: "Hello",
      editedContent: "Changed",
      isDirty: true,
      isLoadingContent: false,
      editorMode: "edit",
      contentSource: "parsed",
      truncated: false,
      totalCharCount: 5,
    });

    setDraftContent("doc-1", "Hello");
    const draft = useDocumentStore.getState().draftsByDocumentId["doc-1"];
    expect(draft!.isDirty).toBe(false);
    expect(draft!.editedContent).toBe("Hello");
  });

  it("clearDraft removes the draft for a document", () => {
    const { setDraft, clearDraft } = useDocumentStore.getState();
    setDraft("doc-1", {
      originalContent: "Hello",
      editedContent: "Hello",
      isDirty: false,
      isLoadingContent: false,
      editorMode: "edit",
      contentSource: "parsed",
      truncated: false,
      totalCharCount: 5,
    });

    clearDraft("doc-1");
    expect(useDocumentStore.getState().draftsByDocumentId["doc-1"]).toBeUndefined();
  });

  it("discard pattern: reset editedContent to originalContent clears dirty", () => {
    const { setDraft, setDraftContent } = useDocumentStore.getState();
    setDraft("doc-1", {
      originalContent: "Original",
      editedContent: "Original",
      isDirty: false,
      isLoadingContent: false,
      editorMode: "edit",
      contentSource: "parsed",
      truncated: false,
      totalCharCount: 8,
    });

    // User edits
    setDraftContent("doc-1", "Edited by user");
    expect(useDocumentStore.getState().draftsByDocumentId["doc-1"]!.isDirty).toBe(true);

    // Discard: set back to original
    const draft = useDocumentStore.getState().draftsByDocumentId["doc-1"]!;
    setDraft("doc-1", {
      ...draft,
      editedContent: draft.originalContent,
      isDirty: false,
    });

    const after = useDocumentStore.getState().draftsByDocumentId["doc-1"]!;
    expect(after.isDirty).toBe(false);
    expect(after.editedContent).toBe("Original");
  });

  it("reparse clears draft (simulating clearDraft after successful reparse)", () => {
    const { setDraft, setDraftContent, clearDraft } = useDocumentStore.getState();
    setDraft("doc-1", {
      originalContent: "Before",
      editedContent: "Before",
      isDirty: false,
      isLoadingContent: false,
      editorMode: "edit",
      contentSource: "parsed",
      truncated: false,
      totalCharCount: 6,
    });

    setDraftContent("doc-1", "After editing");
    expect(useDocumentStore.getState().draftsByDocumentId["doc-1"]!.isDirty).toBe(true);

    // Reparse success → clearDraft
    clearDraft("doc-1");
    expect(useDocumentStore.getState().draftsByDocumentId["doc-1"]).toBeUndefined();
  });
});
