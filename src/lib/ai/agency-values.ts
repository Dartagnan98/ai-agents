import 'server-only';
import { getStrategy, listGoals } from '@/lib/operations/store';

/** Operations › Strategy as a prompt block for every owner/admin run (D, 2026-10-28: "wire it in"): north star, bottleneck, today's focus
 *  and the goals in priority order, so agents work toward them without having to look. Empty = nothing set, no block. */
export function strategyPrompt(): string {
  try {
    const s = getStrategy(), goals = listGoals();
    const lines = [s.north_star && `North star: ${s.north_star}`, s.bottleneck && `Current bottleneck: ${s.bottleneck}`, s.daily_focus && `Today's focus: ${s.daily_focus}`,
      goals.length ? `Goals in priority order:\n${goals.slice(0, 8).map((g, i) => `${i + 1}. ${g.title} (${g.progress}%)`).join('\n')}` : ''].filter(Boolean);
    if (!lines.length) return '';
    return `=== Where the agency is going (Operations › Strategy) ===\n${lines.join('\n')}\nWork toward these. When something you learn changes them (a goal moved, a new bottleneck, a better focus), propose the change with propose_strategy.`;
  } catch { return ''; }
}
