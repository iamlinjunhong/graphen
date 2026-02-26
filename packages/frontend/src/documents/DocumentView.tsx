import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Document, DocumentStatus } from "@graphen/shared";
import { useSSE } from "../hooks/useSSE";
import { apiClient } from "../services/api";
import { useDocumentStore } from "../stores/useDocumentStore";
import { DocumentPreview } from "./DocumentPreview";
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

async function extractPreviewSnippet(file: File): Promise<string | null> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension !== "md" && extension !== "txt") {
    return null;
  }

  const content = await file.text();
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }

  const maxLength = 4000;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}\n\n...`
    : normalized;
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
  const setUploading = useDocumentStore((state) => state.setUploading);
  const upsertUpload = useDocumentStore((state) => state.upsertUpload);
  const removeUpload = useDocumentStore((state) => state.removeUpload);
  const setFilterQuery = useDocumentStore((state) => state.setFilterQuery);
  const setFilterStatus = useDocumentStore((state) => state.setFilterStatus);

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
  const [previewByDocumentId, setPreviewByDocumentId] = useState<Record<string, string>>({});

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

  const selectedPreview = selectedDocumentId
    ? (previewByDocumentId[selectedDocumentId] ?? null)
    : null;
  const selectedDocumentStatus = selectedDocument?.status;

  // Fetch preview from backend when selecting a completed document
  useEffect(() => {
    if (!selectedDocumentId || !selectedDocumentStatus) return;
    if (selectedDocumentStatus !== "completed") return;
    if (previewByDocumentId[selectedDocumentId]) return;

    const controller = new AbortController();
    apiClient.documents
      .getPreview(selectedDocumentId, controller.signal)
      .then((preview) => {
        setPreviewByDocumentId((current) => ({
          ...current,
          [selectedDocumentId]: preview
        }));
      })
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
      });

    return () => controller.abort();
  }, [selectedDocumentId, selectedDocumentStatus, previewByDocumentId]);

  const handleUpload = useCallback(async (file: File) => {
    const uploadId = globalThis.crypto.randomUUID();

    setError(null);
    setUploading(true);
    upsertUpload({
      id: uploadId,
      filename: file.name,
      progress: 10,
      status: "uploading"
    });

    try {
      const previewSnippet = await extractPreviewSnippet(file);
      const uploadResult = await apiClient.documents.upload(file);
      const documentId = uploadResult.documentId || uploadId;
      const now = new Date();

      upsertDocument({
        id: documentId,
        filename: file.name,
        fileType: inferFileType(file.name),
        fileSize: file.size,
        status: "uploading",
        uploadedAt: now,
        metadata: {}
      });
      setSelectedDocumentId(documentId);

      if (previewSnippet) {
        setPreviewByDocumentId((current) => ({
          ...current,
          [documentId]: previewSnippet
        }));
      }

      setProgressByDocumentId((current) => ({
        ...current,
        [documentId]: 10
      }));

      removeUpload(uploadId);
      await refreshDocuments();

      const latestDoc = useDocumentStore.getState().documents.find((d) => d.id === documentId);
      if (latestDoc && latestDoc.status === "error") {
        setProgressByDocumentId((current) => ({ ...current, [documentId]: 100 }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      setError(message);
      upsertUpload({
        id: uploadId,
        filename: file.name,
        progress: 100,
        status: "error",
        error: message
      });
    } finally {
      setUploading(false);
    }
  }, [refreshDocuments, removeUpload, setSelectedDocumentId, setUploading, upsertDocument, upsertUpload]);

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
      setPreviewByDocumentId((current) => {
        const { [document.id]: _removed, ...rest } = current;
        return rest;
      });

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

  const handleReparse = useCallback(async (document: Document) => {
    setError(null);
    setIsReparsing(true);

    try {
      await apiClient.documents.reparse(document.id);
      upsertDocument({
        ...document,
        status: "uploading",
        metadata: {}
      });
      setProgressByDocumentId((current) => ({
        ...current,
        [document.id]: STATUS_PROGRESS_FALLBACK.uploading
      }));
      await refreshDocuments();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reparse document";
      setError(message);
    } finally {
      setIsReparsing(false);
    }
  }, [refreshDocuments, upsertDocument]);

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

  return (
    <section className="page-shell">
      <input
        ref={fileInputRef}
        type="file"
        hidden
        accept=".pdf,.md,.txt,text/plain,text/markdown,application/pdf"
        onChange={(event) => {
          const file = event.currentTarget.files?.item(0);
          if (file) {
            void handleUpload(file);
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
          onSelect={setSelectedDocumentId}
          onQueryChange={setFilterQuery}
          onStatusChange={setFilterStatus}
          onUploadClick={() => fileInputRef.current?.click()}
        />

        <div className="docs-right-column">
          {uploads.length > 0 ? (
            <UploadArea isUploading={isUploading} uploads={uploads} onUpload={handleUpload} />
          ) : null}

          <DocumentPreview
            document={selectedDocument}
            previewText={selectedPreview}
            onDelete={handleDelete}
            onReparse={handleReparse}
            isDeleting={isDeleting}
            isReparsing={isReparsing}
          />
        </div>
      </div>

      {error ? <p className="docs-error-banner">{error}</p> : null}
    </section>
  );
}
