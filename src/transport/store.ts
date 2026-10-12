// The stores: memoryStore (the default) and fileStore, with the helpers their tests use.
export { memoryStore, type MemoryStoreOptions } from './memory-store.ts';
export { fileStore, fileStoreWith, safeFileName, type FileStoreLimits, type FileStoreOptions } from './file-store.ts';
export { MAX_LINE_BYTES } from './stored-entry.ts';
