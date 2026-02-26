import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Document, DocumentStatus } from "@graphen/shared";
import { useSSE } from "../hooks/useSSE";
import { apiClient } from "../services/api";
import { useDocumentStore } from "../stores/useDocumentStore";
import type { EditorDraft, UploadQueueItem } from "../stores/useDocumentStore";
import { processUploadQueue } from "../utils/uploadQueue";
import type { UploadSingleResult } from "../utils/uploadQueue";
import { DocumentEditor } from "./DocumentEditor";
import { DocumentSidebar } from "./DocumentSidebar";
import { UploadArea } from "./UploadArea";

interface StatusStreamPayload {
  id: string;
  status: DocumentStatus | "pending";
  phase?: string;
  progress?: number;
  message?: string;
  updatedAt: string;
  chunkCount?: number;
  entityCount?: number;
}

const PROCESSING_STATUSES = new Set<DocumentStatus>([
  "uploading",
  "parsing",
  "extracting",
  "embedding"
]);

const STATUS_PROGRESS_FALLBACK: Record<DocumentStatus | "pending", number> = {
  pending: 0,
  uploading: 10,
  parsing: 35,
  extracting: 65,
  embedding: 88,
  completed: 100,
  error: 100
};

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function inferFileType(filename: string): Document["fileType"] {
  const extension = filename.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "pdf":
      return "pdf";
    case "txt":
      return "txt";
    default:
      return "md";
  }
}

// --- Pre-validation (B8) ---
const SUPPORTED_EXTENSIONS = new Set(["pdf", "md", "txt"]);
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB — matches backend MAX_UPLOAD_SIZE
const MAX_BATCH_COUNT = 20;

function isSupportedFile(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_EXTENSIONS.has(ext);
}

interface ValidationResult {
  accepted: File[];
  rejected: Array<{ file: File; reason: string }>;
}

function validateFiles(files: File[]): ValidationResult {
  const accepted: File[] = [];
  const rejected: ValidationResult["rejected"] = [];

  for (const file of files) {
    if (!isSupportedFile(file)) {
      rejected.push({ file, reason: "Unsupported file type. Only .pdf, .md, .txt are allowed." });
    } else if (file.size > MAX_FILE_SIZE) {
      rejected.push({ file, reason: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.` });
    } else {
      accepted.push(file);
    }
  }

  return { accepted, rejected };
}


export function DocumentView() {
  const documents = useDocumentStore((state) => state.documents);
  const selectedDocumentId = useDocumentStore((state) => state.selectedDocumentId);
  const uploads = useDocumentStore((state) => state.uploads);
  const isUploading = useDocumentStore((state) => state.isUploading);
  const filters = useDocumentStore((state) => state.filters);
  const setDocuments = useDocumentStore((state) => state.setDocuments);
  const upsertDocument = useDocumentStore((state) => state.upsertDocument);
  const removeDocument = useDocumentStore((state) => state.removeDocument);
  const setSelectedDocumentId = useDocumentStore((state) => state.setSelectedDocumentId);
  const upsertUpload = useDocumentStore((state) => state.upsertUpload);
  const removeUpload = useDocumentStore((state) => state.removeUpload);
  const setFilterQuery = useDocumentStore((state) => state.setFilterQuery);
  const setFilterStatus = useDocumentStore((state) => state.setFilterStatus);
  const draftsByDocumentId = useDocumentStore((state) => state.draftsByDocumentId);
  const setDraft = useDocumentStore((state) => state.setDraft);
  const clearDraft = useDocumentStore((state) => state.clearDraft);
  const setDraftContent = useDocumentStore((state) => state.setDraftContent);

  // Batch upload actions
  const incrementActiveUploadRequests = useDocumentStore((s) => s.incrementActiveUploadRequests);
  const decrementActiveUploadRequests = useDocumentStore((s) => s.decrementActiveUploadRequests);
  const startBatchUpload = useDocumentStore((s) => s.startBatchUpload);
  const incrementBatchCompleted = useDocumentStore((s) => s.incrementBatchCompleted);
  const incrementBatchFailed = useDocumentStore((s) => s.incrementBatchFailed);
  const finishBatchUpload = useDocumentStore((s) => s.finishBatchUpload);
  const createQueueItem = useDocumentStore((s) => s.createQueueItem);
  const markUploadError = useDocumentStore((s) => s.markUploadError);
  const bindUploadDocumentId = useDocumentStore((s) => s.bindUploadDocumentId);
  const batchUploadActive = useDocumentStore((s) => s.batchUploadActive);

  const {
    isConnected: isStatusConnected,
    isConnecting: isStatusConnecting,
    start: startStatusStream,
    stop: stopStatusStream
  } = useSSE();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isReparsing, setIsReparsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressByDocumentId, setProgressByDocumentId] = useState<Record<string, number>>({});

  const refreshDocuments = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    setError(null);

    try {
      const listParams: {
        page: number;
        pageSize: number;
        signal?: AbortSignal;
      } = {
        page: 1,
        pageSize: 100
      };
      if (signal) {
        listParams.signal = signal;
      }
      const { items } = await apiClient.documents.list(listParams);

      setDocuments(items);
      const currentSelectedId = useDocumentStore.getState().selectedDocumentId;
      const firstItem = items[0];
      if (!currentSelectedId && firstItem) {
        setSelectedDocumentId(firstItem.id);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }

      const message = error instanceof Error ? error.message : "Failed to load documents";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [setDocuments, setSelectedDocumentId]);

  // B9: Debounced + single-flight refresh
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRefreshingRef = useRef(false);

  const scheduleRefreshDocuments = useCallback(
    (delay = 250) => {
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current);
      }
      refreshDebounceRef.current = setTimeout(() => {
        refreshDebounceRef.current = null;
        if (isRefreshingRef.current) return; // single-flight
        isRefreshingRef.current = true;
        void refreshDocuments().finally(() => {
          isRefreshingRef.current = false;
        });
      }, delay);
    },
    [refreshDocuments]
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshDocuments(controller.signal);
    return () => controller.abort();
  }, [refreshDocuments]);

  const selectedDocument = useMemo(
    () => documents.find((document) => document.id === selectedDocumentId) ?? null,
    [documents, selectedDocumentId]
  );

  const filteredDocuments = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return documents.filter((document) => {
      if (filters.status && document.status !== filters.status) {
        return false;
      }
      if (query.length === 0) {
        return true;
      }
      return document.filename.toLowerCase().includes(query);
    });
  }, [documents, filters.query, filters.status]);

  const selectedDocumentStatus = selectedDocument?.status;

  // Load editor content when selecting a completed document
  useEffect(() => {
    if (!selectedDocumentId || !selectedDocumentStatus) return;
    if (selectedDocumentStatus !== "completed") return;
    // Read draft from store snapshot to avoid re-triggering this effect
    const existingDraft = useDocumentStore.getState().draftsByDocumentId[selectedDocumentId];
    if (existingDraft) return;

    // Mark as loading
    setDraft(selectedDocumentId, {
      originalContent: "",
      editedContent: "",
      isDirty: false,
      isLoadingContent: true,
      editorMode: "edit",
      contentSource: "parsed",
      truncated: false,
      totalCharCount: 0,
    });

    const controller = new AbortController();
    apiClient.documents
      .getContent(selectedDocumentId, controller.signal)
      .then((resp) => {
        const draft: EditorDraft = {
          originalContent: resp.content,
          editedContent: resp.content,
          isDirty: false,
          isLoadingContent: false,
          editorMode: "edit",
          contentSource: resp.contentSource,
          truncated: resp.truncated,
          totalCharCount: resp.totalCharCount,
        };
        setDraft(selectedDocumentId, draft);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return;
        // Clear loading state on error
        clearDraft(selectedDocumentId);
      });

    return () => controller.abort();
  }, [selectedDocumentId, selectedDocumentStatus, setDraft, clearDraft]);

  // B7: handleUploadSingle — returns UploadSingleResult, uses activeUploadRequests
  const handleUploadSingle = useCallback(
    async (
      item: UploadQueueItem,
      options?: { autoSelectOnSuccess?: boolean }
    ): Promise<UploadSingleResult> => {
      incrementActiveUploadRequests();
      try {
        const uploadResult = await apiClient.documents.upload(item.file!);
        const documentId = uploadResult.documentId;
        bindUploadDocumentId(item.id, documentId);

        upsertDocument({
          id: documentId,
          filename: item.filename,
          fileType: inferFileType(item.filename),
          fileSize: item.file!.size,
          status: "uploading",
          uploadedAt: new Date(),
          metadata: {}
        });

        if (options?.autoSelectOnSuccess ?? true) {
          setSelectedDocumentId(documentId);
        }

        return { ok: true, documentId };
      } catch (err) {
        return {
          ok: false,
          stage: "upload",
          message: err instanceof Error ? err.message : "Upload failed"
        };
      } finally {
        decrementActiveUploadRequests();
      }
    },
    [incrementActiveUploadRequests, decrementActiveUploadRequests, bindUploadDocumentId, upsertDocument, setSelectedDocumentId]
  );

  // B8: handleBatchUpload — pre-validation + single/multi path
  const handleBatchUpload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      // Batch count limit
      if (files.length > MAX_BATCH_COUNT) {
        setError(`Maximum ${MAX_BATCH_COUNT} files per batch. Please split into smaller batches.`);
        return;
      }

      setError(null);

      // Pre-validate
      const { accepted, rejected } = validateFiles(files);
      for (const { file, reason } of rejected) {
        const item = createQueueItem(file);
        markUploadError(item.id, "upload", reason);
      }

      if (accepted.length === 0) return;

      // Single file — preserve original auto-select behavior
      if (accepted.length === 1) {
        const item = createQueueItem(accepted[0]!);
        // Also show in legacy upload list for UploadArea compat
        upsertUpload({ id: item.id, filename: item.filename, progress: 10, status: "uploading" });
        const result = await handleUploadSingle(item, { autoSelectOnSuccess: true });
        if (result.ok) {
          removeUpload(item.id);
        } else {
          markUploadError(item.id, "upload", result.message);
          upsertUpload({ id: item.id, filename: item.filename, progress: 100, status: "error", error: result.message });
        }
        scheduleRefreshDocuments();
        return;
      }

      // Multi-file batch upload
      startBatchUpload(accepted.length);
      const queueItems = accepted.map((file) => createQueueItem(file));

      await processUploadQueue(
        queueItems,
        async (item) => handleUploadSingle(item, { autoSelectOnSuccess: false }),
        {
          concurrency: 3,
          onStatusChange: (itemId, status) => {
            const store = useDocumentStore.getState();
            store.updateQueueItem(itemId, { status });
          },
          onWorkerResult: (itemId, result) => {
            if (result.ok) {
              incrementBatchCompleted();
            } else {
              incrementBatchFailed();
              const store = useDocumentStore.getState();
              store.markUploadError(itemId, "upload", result.message);
            }
          }
        }
      );

      scheduleRefreshDocuments();
      finishBatchUpload();
    },
    [
      handleUploadSingle, createQueueItem, markUploadError, upsertUpload, removeUpload,
      startBatchUpload, incrementBatchCompleted, incrementBatchFailed, finishBatchUpload,
      scheduleRefreshDocuments
    ]
  );

  // Legacy single-file handler — delegates to handleBatchUpload for backward compat
  const handleUpload = useCallback(
    async (file: File) => {
      await handleBatchUpload([file]);
    },
    [handleBatchUpload]
  );

  const handleDelete = useCallback(async (document: Document) => {
    const confirmed = window.confirm(`Delete document "${document.filename}"? This action cannot be undone.`);
    if (!confirmed) {
      return;
    }

    setError(null);
    setIsDeleting(true);

    try {
      await apiClient.documents.delete(document.id);
      removeDocument(document.id);

      setProgressByDocumentId((current) => {
        const { [document.id]: _removed, ...rest } = current;
        return rest;
      });
      clearDraft(document.id);

      const state = useDocumentStore.getState();
      const firstDocument = state.documents[0];
      if (!state.selectedDocumentId && firstDocument) {
        setSelectedDocumentId(firstDocument.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete document";
      setError(message);
    } finally {
      setIsDeleting(false);
    }
  }, [removeDocument, setSelectedDocumentId]);

  const handleReparse = useCallback(async (document: Document, content?: string) => {
    setError(null);
    setIsReparsing(true);

    try {
      const isDirty = content !== undefined && content !== draftsByDocumentId[document.id]?.originalContent;
      await apiClient.documents.reparse(document.id, isDirty ? content : undefined);
      upsertDocument({
        ...document,
        status: "uploading",
        metadata: {}
      });
      setProgressByDocumentId((current) => ({
        ...current,
        [document.id]: STATUS_PROGRESS_FALLBACK.uploading
      }));
      clearDraft(document.id);
      await refreshDocuments();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reparse document";
      setError(message);
    } finally {
      setIsReparsing(false);
    }
  }, [refreshDocuments, upsertDocument, clearDraft, draftsByDocumentId]);

  const handleStatusEvent = useCallback((rawData: string) => {
    const payload = parseJson<StatusStreamPayload>(rawData);
    if (!payload) {
      return;
    }

    const progress = payload.progress ?? STATUS_PROGRESS_FALLBACK[payload.status] ?? 0;
    setProgressByDocumentId((current) => ({
      ...current,
      [payload.id]: progress
    }));

    if (payload.status !== "pending") {
      const current = useDocumentStore
        .getState()
        .documents.find((document) => document.id === payload.id);
      if (current) {
        const updatedMetadata = { ...current.metadata };
        if (payload.chunkCount !== undefined) {
          updatedMetadata.chunkCount = payload.chunkCount;
        }
        if (payload.entityCount !== undefined) {
          updatedMetadata.entityCount = payload.entityCount;
        }

        upsertDocument({
          ...current,
          status: payload.status,
          metadata: updatedMetadata
        });
      }
    }

    if (payload.status === "completed" || payload.status === "error") {
      void refreshDocuments();
    }
  }, [refreshDocuments, upsertDocument]);

  useEffect(() => {
    if (!selectedDocumentId || !selectedDocumentStatus) {
      stopStatusStream();
      return;
    }

    if (!PROCESSING_STATUSES.has(selectedDocumentStatus)) {
      stopStatusStream();
      return;
    }

    void startStatusStream({
      url: apiClient.documents.statusStreamUrl(selectedDocumentId),
      method: "GET",
      onMessage: (event) => {
        if (event.event === "status") {
          handleStatusEvent(event.data);
        }
      },
      onError: (streamError) => {
        setError(streamError.message);
        void refreshDocuments();
      },
      onClose: () => {
        void refreshDocuments();
      }
    });

    return stopStatusStream;
  }, [handleStatusEvent, refreshDocuments, selectedDocumentId, selectedDocumentStatus, startStatusStream, stopStatusStream]);

  // Polling fallback: if the selected document is still processing but SSE is
  // not connected, periodically refresh so we don't get stuck on a stale status.
  useEffect(() => {
    if (!selectedDocumentId || !selectedDocumentStatus) return;
    if (!PROCESSING_STATUSES.has(selectedDocumentStatus)) return;
    if (isStatusConnected || isStatusConnecting) return;

    const timer = setInterval(() => {
      void refreshDocuments();
    }, 3000);

    return () => clearInterval(timer);
  }, [isStatusConnected, isStatusConnecting, refreshDocuments, selectedDocumentId, selectedDocumentStatus]);

  // B9: Batch-mode polling — 3s interval while batch is active or documents are processing
  useEffect(() => {
    if (!batchUploadActive) return;

    const timer = setInterval(() => {
      scheduleRefreshDocuments(0);
    }, 3000);

    return () => clearInterval(timer);
  }, [batchUploadActive, scheduleRefreshDocuments]);

  const handleContentChange = useCallback(
    (content: string) => {
      if (selectedDocumentId) {
        setDraftContent(selectedDocumentId, content);
      }
    },
    [selectedDocumentId, setDraftContent]
  );

  const handleDiscard = useCallback(() => {
    if (!selectedDocumentId) return;
    const draft = draftsByDocumentId[selectedDocumentId];
    if (!draft) return;
    setDraft(selectedDocumentId, {
      ...draft,
      editedContent: draft.originalContent,
      isDirty: false,
    });
  }, [selectedDocumentId, draftsByDocumentId, setDraft]);

  const handleSelectDocument = useCallback(
    (docId: string | null) => {
      if (selectedDocumentId && docId !== selectedDocumentId) {
        const currentDraft = draftsByDocumentId[selectedDocumentId];
        if (currentDraft?.isDirty) {
          const discard = window.confirm(
            "You have unsaved changes. Discard and switch document?"
          );
          if (!discard) return;
          // Clear dirty state
          setDraft(selectedDocumentId, {
            ...currentDraft,
            editedContent: currentDraft.originalContent,
            isDirty: false,
          });
        }
      }
      setSelectedDocumentId(docId);
    },
    [selectedDocumentId, draftsByDocumentId, setDraft, setSelectedDocumentId]
  );

  const selectedDraft = selectedDocumentId
    ? (draftsByDocumentId[selectedDocumentId] ?? null)
    : null;

  return (
    <section className="page-shell">
      <input
        ref={fileInputRef}
        type="file"
        hidden
        multiple
        accept=".pdf,.md,.txt,text/plain,text/markdown,application/pdf"
        onChange={(event) => {
          const fileList = event.currentTarget.files;
          if (fileList && fileList.length > 0) {
            void handleBatchUpload(Array.from(fileList));
          }
          event.currentTarget.value = "";
        }}
      />

      <div className="split-layout docs-page-layout">
        <DocumentSidebar
          documents={filteredDocuments}
          selectedDocumentId={selectedDocumentId}
          progressByDocumentId={progressByDocumentId}
          query={filters.query}
          status={filters.status}
          isLoading={isLoading}
          onSelect={handleSelectDocument}
          onQueryChange={setFilterQuery}
          onStatusChange={setFilterStatus}
          onUploadClick={() => fileInputRef.current?.click()}
        />

        <div className="docs-right-column">
          {uploads.length > 0 ? (
            <UploadArea isUploading={isUploading} uploads={uploads} onUpload={handleUpload} />
          ) : null}

          <DocumentEditor
            document={selectedDocument}
            draft={selectedDraft}
            onContentChange={handleContentChange}
            onDelete={handleDelete}
            onReparse={handleReparse}
            onDiscard={handleDiscard}
            isDeleting={isDeleting}
            isReparsing={isReparsing}
          />
        </div>
      </div>

      {error ? <p className="docs-error-banner">{error}</p> : null}
    </section>
  );
}
