/// <reference types="vite/client" />

// File System Access API types (not in default lib)
declare global {
  interface Window {
    showOpenFilePicker?: (options?: {
      types?: { description?: string; accept: Record<string, string[]> }[];
      multiple?: boolean;
    }) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: { description?: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
  }

  interface FileSystemFileHandle {
    name: string;
    createWritable(): Promise<FileSystemWritableFileStream>;
  }

  interface FileSystemWritableFileStream {
    write(data: string | BufferSource | Blob): Promise<void>;
    close(): Promise<void>;
  }
}

export {}