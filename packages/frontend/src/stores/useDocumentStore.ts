import { create } from "zustand";
import type { Document, DocumentStatus } from "@graphen/shared";
import type { ErrorStage, QueueStatus, UploadQueueItem } from "../utils/uploadQueue";

export type { UploadQueueItem, QueueStatus, ErrorStage } from "../utils/uploadQueue";

/** @deprecated Use UploadQueueItem instead — kept for UploadArea compat during migration */
export interface UploadItem {
  id: string;
  filename: string;
  progress: number;
  status: Exclude<DocumentStatus, "completed"> | "pending";
  error?: string;
}

export interface EditorDraft {
  originalContent: string;
  editedContent: string;
  isDirty: boolean;
  isLoadingContent: boolean;
  editorMode: "edit" | "preview";
  contentSource: "parsed" | "edited";
  truncated: boolean;
  totalCharCount: number;
}

interface DocumentFilters {
  query: string;
  status?: DocumentStatus;
}

interface DocumentState {
  documents: Document[];
  selectedDocumentId: string | null;
  uploads: UploadItem[];
  isUploading: boolean;
  filters: DocumentFilters;
  draftsByDocumentId: Record<string, EditorDraft>;

  // Batch upload state
  activeUploadRequests: number;
  batchUploadActive: boolean;
  batchUploadTotal: number;
  batchUploadCompleted: number;
  batchUploadFailed: number;
  uploadQueue: UploadQueueItem[];

  setDocuments: (documents: Document[]) => void;
  upsertDocument: (document: Document) => void;
  removeDocument: (documentId: string) => void;
  setSelectedDocumentId: (documentId: string | null) => void;
  setUploading: (uploading: boolean) => void;
  upsertUpload: (upload: UploadItem) => void;
  removeUpload: (uploadId: string) => void;
  setFilterQuery: (query: string) => void;
  setFilterStatus: (status?: DocumentStatus) => void;
  clearFilters: () => void;
  setDraft: (docId: string, draft: EditorDraft) => void;
  clearDraft: (docId: string) => void;
  setDraftContent: (docId: string, content: string) => void;
  reset: () => void;

  // Batch upload actions
  incrementActiveUploadRequests: () => void;
  decrementActiveUploadRequests: () => void;
  startBatchUpload: (total: number) => void;
  incrementBatchCompleted: () => void;
  incrementBatchFailed: () => void;
  finishBatchUpload: () => void;
  createQueueItem: (file: File) => UploadQueueItem;
  updateQueueItem: (itemId: string, patch: Partial<UploadQueueItem>) => void;
  markUploadError: (uploadId: string, stage: ErrorStage, message: string) => void;
  bindUploadDocumentId: (uploadId: string, documentId: string) => void;
  removeQueueItem: (itemId: string) => void;
  setUploadPipelineStatus: (
    documentId: string,
    status: "processing" | "completed" | "error",
    progress: number,
    errorMessage?: string
  ) => void;
}

const defaultFilters: DocumentFilters = {
  query: ""
};

function sortDocumentsByUploadedAt(documents: Document[]): Document[] {
  return [...documents].sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  documents: [],
  selectedDocumentId: null,
  uploads: [],
  isUploading: false,
  filters: defaultFilters,
  draftsByDocumentId: {},

  // Batch upload state
  activeUploadRequests: 0,
  batchUploadActive: false,
  batchUploadTotal: 0,
  batchUploadCompleted: 0,
  batchUploadFailed: 0,
  uploadQueue: [],

  setDocuments: (documents) =>
    set((state) => {
      const nextDocuments = sortDocumentsByUploadedAt(documents);
      const selectedDocumentExists = state.selectedDocumentId
        ? nextDocuments.some((doc) => doc.id === state.selectedDocumentId)
        : false;
      return {
        documents: nextDocuments,
        selectedDocumentId: selectedDocumentExists ? state.selectedDocumentId : null
      };
    }),
  upsertDocument: (document) =>
    set((state) => {
      const nextDocuments = state.documents.filter((item) => item.id !== document.id);
      nextDocuments.push(document);
      return {
        documents: sortDocumentsByUploadedAt(nextDocuments)
      };
    }),
  removeDocument: (documentId) =>
    set((state) => ({
      documents: state.documents.filter((doc) => doc.id !== documentId),
      selectedDocumentId:
        state.selectedDocumentId === documentId ? null : state.selectedDocumentId
    })),
  setSelectedDocumentId: (documentId) => set({ selectedDocumentId: documentId }),
  setUploading: (uploading) => set({ isUploading: uploading }),
  upsertUpload: (upload) =>
    set((state) => {
      const nextUploads = state.uploads.filter((item) => item.id !== upload.id);
      nextUploads.push(upload);
      nextUploads.sort((a, b) => b.filename.localeCompare(a.filename));
      return {
        uploads: nextUploads
      };
    }),
  removeUpload: (uploadId) =>
    set((state) => ({
      uploads: state.uploads.filter((upload) => upload.id !== uploadId)
    })),
  setFilterQuery: (query) =>
    set((state) => ({
      filters: {
        ...state.filters,
        query
      }
    })),
  setFilterStatus: (status) =>
    set((state) => {
      const filters: DocumentFilters = {
        ...state.filters
      };
      if (status === undefined) {
        delete filters.status;
      } else {
        filters.status = status;
      }
      return { filters };
    }),
  clearFilters: () => set({ filters: defaultFilters }),
  setDraft: (docId, draft) =>
    set((state) => ({
      draftsByDocumentId: { ...state.draftsByDocumentId, [docId]: draft }
    })),
  clearDraft: (docId) =>
    set((state) => {
      const { [docId]: _, ...rest } = state.draftsByDocumentId;
      return { draftsByDocumentId: rest };
    }),
  setDraftContent: (docId, content) =>
    set((state) => {
      const existing = state.draftsByDocumentId[docId];
      if (!existing) return state;
      return {
        draftsByDocumentId: {
          ...state.draftsByDocumentId,
          [docId]: {
            ...existing,
            editedContent: content,
            isDirty: content !== existing.originalContent
          }
        }
      };
    }),
  reset: () =>
    set({
      documents: [],
      selectedDocumentId: null,
      uploads: [],
      isUploading: false,
      filters: defaultFilters,
      draftsByDocumentId: {},
      activeUploadRequests: 0,
      batchUploadActive: false,
      batchUploadTotal: 0,
      batchUploadCompleted: 0,
      batchUploadFailed: 0,
      uploadQueue: []
    }),

  // Batch upload actions
  incrementActiveUploadRequests: () =>
    set((state) => ({
      activeUploadRequests: state.activeUploadRequests + 1,
      isUploading: true
    })),
  decrementActiveUploadRequests: () =>
    set((state) => {
      const next = Math.max(0, state.activeUploadRequests - 1);
      return {
        activeUploadRequests: next,
        isUploading: next > 0
      };
    }),
  startBatchUpload: (total) =>
    set({
      batchUploadActive: true,
      batchUploadTotal: total,
      batchUploadCompleted: 0,
      batchUploadFailed: 0
    }),
  incrementBatchCompleted: () =>
    set((state) => ({ batchUploadCompleted: state.batchUploadCompleted + 1 })),
  incrementBatchFailed: () =>
    set((state) => ({ batchUploadFailed: state.batchUploadFailed + 1 })),
  finishBatchUpload: () =>
    set({ batchUploadActive: false }),
  createQueueItem: (file) => {
    const item: UploadQueueItem = {
      id: globalThis.crypto.randomUUID(),
      filename: file.name,
      file,
      status: "queued",
      progress: 0
    };
    set((state) => ({ uploadQueue: [...state.uploadQueue, item] }));
    return item;
  },
  updateQueueItem: (itemId, patch) =>
    set((state) => ({
      uploadQueue: state.uploadQueue.map((item) =>
        item.id === itemId ? { ...item, ...patch } : item
      )
    })),
  markUploadError: (uploadId, stage, message) =>
    set((state) => ({
      uploadQueue: state.uploadQueue.map((item) =>
        item.id === uploadId
          ? { ...item, status: "error" as const, errorStage: stage, errorMessage: message }
          : item
      )
    })),
  bindUploadDocumentId: (uploadId, documentId) =>
    set((state) => ({
      uploadQueue: state.uploadQueue.map((item) =>
        item.id === uploadId ? { ...item, documentId } : item
      )
    })),
  removeQueueItem: (itemId) =>
    set((state) => ({
      uploadQueue: state.uploadQueue.filter((item) => item.id !== itemId)
    })),
  setUploadPipelineStatus: (documentId, status, progress, errorMessage) =>
    set((state) => ({
      uploadQueue: state.uploadQueue.map((item) =>
        item.documentId === documentId
          ? {
              ...item,
              status,
              progress,
              ...(errorMessage !== undefined
                ? { errorStage: "pipeline" as const, errorMessage }
                : {})
            }
          : item
      )
    }))
}));
