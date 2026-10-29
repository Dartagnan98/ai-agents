'use client';

import { useState } from 'react';
import './ai.css';

// the agents tool steps (D, 2026-10-09), RunSteps look: the calls of a reply fold into one line ("Read 3 pages, 1 setting")
// that opens into one 28px row per call. While a call runs, the line is its title with the working glow; done calls get a check,
// failed ones a cross. The "Thinking..." line uses the same glow.
export type Step = { name: string; title: string; status: 'running' | 'done' | 'error' };

const NOUN: Record<string, [string, string]> = {
  metrics: ['page read', 'page reads'],
  contract_settings: ['setting read', 'setting reads'],
  remember: ['note saved', 'notes saved'],
  recall_memory: ['memory read', 'memory reads'],
  forget_memory: ['note removed', 'notes removed'],
  search_knowledge: ['knowledge search', 'knowledge searches'],
  read_goals: ['strategy read', 'strategy reads'],
  read_experiments: ['experiments read', 'experiments reads'],
};

/** "2 page reads, 1 setting read" from the calls, in first-seen order. */
export function stepSummary(steps: Step[]): string {
  const n = new Map<string, number>();
  for (const s of steps) { const k = NOUN[s.name] ? s.name : '_'; n.set(k, (n.get(k) ?? 0) + 1); }
  return [...n].map(([k, c]) => (k === '_' ? `${c} tool call${c === 1 ? '' : 's'}` : `${c} ${NOUN[k][c === 1 ? 0 : 1]}`)).join(', ');
}

const Caret = ({ open }: { open: boolean }) => (
  <svg className="fai-caret" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : undefined }}><path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

function StepIcon({ status }: { status: Step['status'] }) {
  if (status === 'running') return <span className="fai-sdot" aria-hidden="true" />;
  if (status === 'done') return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

/** The tool calls of one reply. `live` = this reply is still streaming. */
export function RunSteps({ steps, live }: { steps: Step[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const list = steps.filter(Boolean);
  if (!list.length) return null;
  const running = live ? list.find((s) => s.status === 'running') : undefined;
  const failed = list.filter((s) => s.status === 'error').length;
  return (
    <div className="fai-steps">
      <button type="button" className={`fai-called${open ? ' is-open' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={running ? 'fai-shimmer' : undefined}>{running ? `${running.title}...` : `${stepSummary(list)}${failed ? `, ${failed} failed` : ''}`}</span>
        <Caret open={open} />
      </button>
      {open && (
        <div className="fai-tools">
          {list.map((s, i) => (
            <div key={i} className={`fai-trow is-${s.status}${s.status === 'running' && !live ? ' is-stale' : ''}`}>
              <span className="ic"><StepIcon status={s.status} /></span>
              <span className="tt"><span className={s.status === 'running' && live ? 'fai-shimmer' : undefined}>{s.title}</span></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Thinking..." with the working glow, while a reply has nothing to show yet. */
export function Working({ label = 'Thinking...' }: { label?: string }) {
  return <div className="fai-working"><span className="fai-shimmer">{label}</span></div>;
}
