import 'server-only';
import { readEnvStore } from '@/lib/env-store';
import { claudeLoginFiles } from '@/lib/paths';
import { connSecret } from '@/lib/ai/connections';
import { isMultiTenant } from '@/lib/platform/mode';
import { currentAgencySync } from '@/lib/platform/tenant-db';

// The Claude subscription login for headless runs (claude -p) on the box: the agents' token (CLAUDE_CODE_OAUTH_TOKEN, the CLI's own
// supported way to sign in a script), never an API key. Shared by Ask the analyst and the agents. On a Mac in dev (no box files) the
// CLI's own signed-in login is used.
const LOGINS = claudeLoginFiles(); // CLAUDE_LOGIN_ENV_FILES (lib/paths.ts)

export function claudeEnv(): NodeJS.ProcessEnv | null {
  // a Claude token connected in Settings › AI connections wins (the agency's own subscription, D 2026-10-09)
  const own = (() => { try { return connSecret('claude-token'); } catch { return null; } })();
  if (own) { const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: own }; delete env.ANTHROPIC_API_KEY; return env; }
  // multi-agency mode (D, 2026-10-09, decision 6): only the install agency (the agency) may fall back to the box's Claude login or the
  // Mac's own CLI login; a new agency never runs on Ctrl Strategies' Claude plan (no token of its own = no Claude)
  if (isMultiTenant()) { try { if (!currentAgencySync().legacy) return null; } catch { return null; } }
  for (const p of LOGINS) {
    let text = '';
    try { text = readEnvStore(p); } catch { continue; } // sealed scorer.env (.enc) or plain
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    if (env.CLAUDE_CODE_OAUTH_TOKEN) { delete env.ANTHROPIC_API_KEY; return env; }
  }
  return { ...process.env }; // the AI agents app runs on the computer it is installed on: the signed-in Claude Code CLI, also in production
}

