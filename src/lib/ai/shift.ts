import { reportTz } from '@/lib/report-tz';

// Day and night mode (D 2026-10-28; the old fleet's SOUL.md rules): day 08:00 to 00:00 business time is led by the
// people; at night an agent working on its own works the board and finds work, and sends nothing to people. In the prompts of runs nobody
// is watching (comms.ts: tasks, asks, hand-offs). Night shift cards (a task per agent each night) are not on (waits on D).
export const DAY_START = 8;
export function isNight(d = new Date()): boolean {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: reportTz() }).format(d)) < DAY_START;
}
export function shiftBlock(d = new Date()): string {
  return isNight(d)
    ? '=== Night mode (00:00 to 08:00) ===\nWork through your tasks on the board (list_tasks), put new work you find on the board (create_task), deliver outputs and hand pieces to teammates (message_agent, hand_off). No messages to people unless critical: no Slack posts, no texts, no deletes. Scheduled routines still deliver as set.'
    : '=== Day mode (08:00 to 00:00) ===\nLed by the people you work with: their asks first, then messages from other agents and your tasks. New big work waits for their go; put ideas on the board with create_task.';
}
