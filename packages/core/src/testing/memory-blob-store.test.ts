import { blobStoreContract } from "./blob-store-contract.ts";
import { memoryBlobStore } from "./memory-blob-store.ts";

// The fake the catalog tests run against keeps the same contract as blob-fs.
blobStoreContract("catalog: memory store", () => ({ store: memoryBlobStore(), cleanup: () => {} }));
