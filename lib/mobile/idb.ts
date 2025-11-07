/* eslint-disable no-undef */
import type { MobileBundleResponse } from "./types";

const DB_NAME = "dd-mobile";
const DB_VERSION = 1;
const STORE_BUNDLES = "bundles";
const STORE_SUBMISSIONS = "pendingSubmissions";

export type PendingSubmission = {
  task_id: string;
  assignment_id: string;
  payload: unknown;
  duration_ms: number;
  playback_ratio: number;
  created_at: number;
  endpoint: string;
  idempotencyKey: string;
};

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_BUNDLES)) {
        db.createObjectStore(STORE_BUNDLES);
      }
      if (!db.objectStoreNames.contains(STORE_SUBMISSIONS)) {
        db.createObjectStore(STORE_SUBMISSIONS, { keyPath: "idempotencyKey" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (objectStore: IDBObjectStore) => void
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDB();
      const tx = db.transaction(store, mode);
      const objectStore = tx.objectStore(store);
      fn(objectStore);
      tx.oncomplete = () => {
        db.close();
        resolve(undefined as T);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    } catch (error) {
      reject(error);
    }
  });
}

export async function cacheBundle(bundle: MobileBundleResponse) {
  await runTransaction(STORE_BUNDLES, "readwrite", (store) => {
    store.put(bundle, bundle.bundle_id);
  });
}

export async function loadCachedBundles(): Promise<MobileBundleResponse[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BUNDLES, "readonly");
    const store = tx.objectStore(STORE_BUNDLES);
    const request = store.getAll();
    request.onsuccess = () => {
      db.close();
      resolve((request.result as MobileBundleResponse[]) || []);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function queueSubmission(submission: PendingSubmission) {
  await runTransaction(STORE_SUBMISSIONS, "readwrite", (store) => {
    store.put(submission);
  });
}

export async function getPendingSubmissions(): Promise<PendingSubmission[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SUBMISSIONS, "readonly");
    const store = tx.objectStore(STORE_SUBMISSIONS);
    const request = store.getAll();
    request.onsuccess = () => {
      db.close();
      resolve((request.result as PendingSubmission[]) || []);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function clearPendingSubmission(idempotencyKey: string) {
  await runTransaction(STORE_SUBMISSIONS, "readwrite", (store) => {
    store.delete(idempotencyKey);
  });
}
