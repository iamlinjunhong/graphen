import { create } from "zustand";
import type { Document, DocumentStatus } from "@graphen/shared";

export interface UploadItem {
  id: string;
  filename: string;
  progress: number;
  status: Exclude<DocumentStatus, "completed"> | "pending";
  error?: string;
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
  reset: () => void;
}

const defaultFilters: DocumentFilters = {
  query: ""
};

function sortDocumentsByUploadedAt(documents: Document[]): Document[] {
  return [...documents].sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}

export const useDocumentStore = create<DocumentState>((set) => ({
  documents: [],
  selectedDocumentId: null,
  uploads: [],
  isUploading: false,
  filters: defaultFilters,
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
  reset: () =>
    set({
      documents: [],
      selectedDocumentId: null,
      uploads: [],
      isUploading: false,
      filters: defaultFilters
    })
}));
