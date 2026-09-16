export type MutationKind = 'voyage' | 'run' | 'environment' | 'reset' | 'import'

const DB_NAME = 'sea-trial-logger'
const DB_VERSION = 2
const LOCK_KEY = 'mutation-lock'
const RESET_KEY = 'reset-operation'
const TAB_ID = `${crypto.randomUUID()}-${Date.now()}`
const LOCK_TTL_MS = 30_000

let dbPromise: Promise<IDBDatabase> | undefined

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('voyages')) db.createObjectStore('voyages', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

export async function readAll<T>(store: string): Promise<T[]> {
  const db = await openDb()
  return new Promise<T[]>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error)
  })
}

export async function readMeta<T>(key: string): Promise<T | undefined> {
  const db = await openDb()
  return new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction('meta').objectStore('meta').get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

export async function writeStore(store: string, value: unknown, notify = true): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite')
    transaction.objectStore(store).put(value)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('資料庫寫入中止'))
  })
  if (notify) localStorage.setItem('lastSaved', new Date().toISOString())
}

export async function replaceStore(store: string, values: unknown[], notify = true): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite')
    const objectStore = transaction.objectStore(store)
    objectStore.clear()
    values.forEach(value => objectStore.put(value))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('資料庫寫入中止'))
  })
  if (notify) localStorage.setItem('lastSaved', new Date().toISOString())
}

export async function deleteMeta(key: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('meta', 'readwrite')
    transaction.objectStore('meta').delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('資料庫寫入中止'))
  })
}

export type ResetOperation = {
  key: typeof RESET_KEY
  id: string
  startedAt: string
  step: 'marked' | 'voyages-cleared' | 'environments-cleared' | 'local-storage-cleared'
}

async function writeMeta(value: unknown): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('meta', 'readwrite')
    transaction.objectStore('meta').put(value)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('資料庫寫入中止'))
  })
}

async function takeLock(kind: MutationKind): Promise<string> {
  const db = await openDb()
  const owner = `${TAB_ID}-${crypto.randomUUID()}`
  const lock = { key: LOCK_KEY, owner, kind, acquiredAt: Date.now(), expiresAt: Date.now() + LOCK_TTL_MS }
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('meta', 'readwrite')
    const store = transaction.objectStore('meta')
    const request = store.get(LOCK_KEY)
    request.onsuccess = () => {
      const existing = request.result as { owner?: string; expiresAt?: number } | undefined
      if (existing && existing.owner !== owner && (existing.expiresAt || 0) > Date.now()) {
        transaction.abort()
        reject(new Error('目前有另一個分頁正在寫入資料，請稍後再試'))
        return
      }
      store.put(lock)
    }
    request.onerror = () => { transaction.abort(); reject(request.error) }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('無法取得資料寫入鎖'))
  })
  return owner
}

async function releaseLock(owner: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('meta', 'readwrite')
    const store = transaction.objectStore('meta')
    const request = store.get(LOCK_KEY)
    request.onsuccess = () => {
      if ((request.result as { owner?: string } | undefined)?.owner === owner) store.delete(LOCK_KEY)
    }
    request.onerror = () => { transaction.abort(); reject(request.error) }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('無法釋放資料寫入鎖'))
  })
}

export async function withMutationLock<T>(kind: MutationKind, operation: () => Promise<T>): Promise<T> {
  const existingReset = await readMeta<ResetOperation>(RESET_KEY)
  if (existingReset && kind !== 'reset') throw new Error('重置正在進行，請等待重置完成')
  const owner = await takeLock(kind)
  try {
    const resetDuringWait = await readMeta<ResetOperation>(RESET_KEY)
    if (resetDuringWait && kind !== 'reset') throw new Error('重置正在進行，請等待重置完成')
    return await operation()
  } finally {
    await releaseLock(owner)
  }
}

export async function setResetOperation(operation: ResetOperation): Promise<void> {
  await writeMeta(operation)
}

export async function getResetOperation(): Promise<ResetOperation | undefined> {
  return readMeta<ResetOperation>(RESET_KEY)
}

export async function clearResetOperation(): Promise<void> {
  await deleteMeta(RESET_KEY)
}

export async function clearVoyageStores(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['voyages', 'runs'], 'readwrite')
    transaction.objectStore('voyages').clear()
    transaction.objectStore('runs').clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('航次資料清除中止'))
  })
}

export async function replaceVoyageAndRuns(voyage: unknown, runs: unknown[]): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['voyages', 'runs'], 'readwrite')
    const voyages = transaction.objectStore('voyages')
    const runStore = transaction.objectStore('runs')
    voyages.clear()
    runStore.clear()
    voyages.put(voyage)
    runs.forEach(run => runStore.put(run))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('航次資料匯入中止'))
  })
  localStorage.setItem('lastSaved', new Date().toISOString())
}
