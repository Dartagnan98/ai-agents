import { tenantKey } from './platform/context';

// "Create my tables once" flags, per agency database (D, 2026-10-09). Modules used `let ready = false`, which in multi-agency mode
// would skip the CREATE TABLE in every agency after the first. In single-agency mode the key is always '' (same as before).
export function schemaOnce() {
  const done = new Set<string>();
  return { done: () => done.has(tenantKey()), mark: () => { done.add(tenantKey()); } };
}
