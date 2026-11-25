const cacheStore = new Map();

export function getCachedKey(key) {
  return cacheStore.get(key) ?? null;
}

export function setCachedKey(key, value, ttlMs = 60_000) {
  cacheStore.set(key, { value, expiresAt: Date.now() + ttlMs });
  return true;
}

export function acquireDistributedLock(resourceKey, ttlMs = 5000) {
  if (cacheStore.has(`lock:${resourceKey}`)) {
    return { acquired: false, resourceKey };
  }
  cacheStore.set(`lock:${resourceKey}`, { lockedUntil: Date.now() + ttlMs });
  return { acquired: true, resourceKey, ttlMs };
}
