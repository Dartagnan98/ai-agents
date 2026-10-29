import { db } from '@/lib/db';
import { seal, unseal } from '@/lib/secret-crypto';

// The app's own keys (Slack bot token, alert hooks and the like), sealed at rest in the app database (lib/secret-crypto).
// The agents' saved keys are a separate vault (lib/ai/secrets.ts).
function table() {
  db.exec(`CREATE TABLE IF NOT EXISTS agency_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by INTEGER)`);
  return db;
}
const rows = () => table().prepare('SELECT name, value FROM agency_secrets').all() as { name: string; value: string }[];

/** A reader over the keys, read once (for a form that checks many names). '' when unset. */
export function agencySecrets(): (name: string) => string {
  const own = new Map(rows().map((r) => [r.name, r.value]));
  return (n) => { const v = own.get(n); if (!v) return ''; try { return unseal(v); } catch { return ''; } };
}

/** Every key, name -> value, unsealed in memory: only for lib/ai/tool-guard.ts, which hides these values in tool output. */
export function agencySecretValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows()) { try { out[r.name] = unseal(r.value); } catch { /* sealed with another key */ } }
  return out;
}

/** One key ('' when unset). */
export const agencySecret = (name: string): string => agencySecrets()(name);

/** Saves (or with '' clears) keys. */
export function setAgencySecrets(values: Record<string, string>, by: number | null = null): void {
  const d = table();
  const up = d.prepare(`INSERT INTO agency_secrets (name, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
  const del = d.prepare('DELETE FROM agency_secrets WHERE name = ?');
  d.transaction(() => {
    for (const [name, raw] of Object.entries(values)) {
      if (!/^[A-Z][A-Z0-9_]{2,120}$/.test(name)) throw new Error(`Not a key name: ${name}`);
      const v = String(raw ?? '').replace(/[\r\n]/g, '').trim();
      if (v) up.run(name, seal(v), Date.now(), by); else del.run(name);
    }
  })();
}
