import path from 'path';

// Where the install's other parts live (D, 2026-10-12: "no hard coded" paths). Every location comes from an env var; the defaults
// follow the repo layout (dashboard/ and fleet-sync/ side by side), so a fresh clone works as is. the agency's box sets its own values.
/** The fleet-sync folder (Python jobs, fleet-run, fleet-secrets). */
export const fleetSyncDir = () => process.env.FLEET_SYNC_DIR || path.resolve(process.cwd(), '..', 'fleet-sync');
/** The Python that runs fleet-sync (the install's venv). */
export const fleetSyncPython = () => process.env.FLEET_SYNC_PYTHON || path.join(fleetSyncDir(), '.venv', 'bin', 'python');
/** fleet-run: starts a fleet-sync script with the sealed keys in its environment only. */
export const fleetRunBin = () => process.env.FLEET_RUN || path.join(fleetSyncDir(), 'fleet-run');
/** Env files holding CLAUDE_CODE_OAUTH_TOKEN for headless Claude runs, first one with a token wins (comma list). */
export const claudeLoginFiles = () => (process.env.CLAUDE_LOGIN_ENV_FILES || path.join(fleetSyncDir(), 'scorer.env')).split(',').map((s) => s.trim()).filter(Boolean);
