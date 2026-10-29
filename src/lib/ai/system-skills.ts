// Built-in skills: ready to run with "/" for every owner and admin. A skill of your own with the same command wins.
export interface SystemSkill { name: string; title: string; description: string; body: string }
export const SYSTEM_SKILLS: SystemSkill[] = [
  { name: 'research-brief', title: 'Research brief', description: 'A short, sourced brief on any topic',
    body: 'Research the topic the person gives (ask for it if missing). Search the web when you have it, and Knowledge and memory first. Write: a three-line answer up top, then the key facts as bullets each with its source link, then what is still unclear. Keep it under 400 words. Say when a source is old or weak.' },
  { name: 'summarize', title: 'Summarize', description: 'The point of a document, thread or file in a few lines',
    body: 'Summarize what the person shares (an attached file, a pasted text, a Knowledge document or a Slack thread). Lead with the one-sentence point, then up to five bullets of what matters, then any decisions or deadlines in it with who owns them. Quote numbers exactly.' },
  { name: 'meeting-notes', title: 'Meeting notes', description: 'Clean notes and action items from a transcript',
    body: 'Turn the transcript or rough notes into: a two-line summary, decisions made, action items as a ctrl-table (Who, What, When), and open questions. Use people\'s names as written. Offer to put the action items on the task board (create_task) and to save the notes to Knowledge.' },
  { name: 'write-email', title: 'Write an email', description: 'A clear email draft in your voice',
    body: 'Draft the email the person describes: a subject line, then the body. Short sentences, one ask, no filler. If memory has notes on how this person writes, follow them. Give one draft, then offer a shorter or warmer version. Never send it yourself.' },
  { name: 'weekly-report', title: 'Weekly report', description: 'What the agents did this week and what is next',
    body: 'Report on the last 7 days: tasks finished and still open (list_tasks), routines that ran or failed (list_routines), each agent\'s goals and progress (list_goals), and anything waiting in the Inbox. End with three priorities for next week.' },
  { name: 'plan-project', title: 'Plan a project', description: 'Break a goal into steps, owners and tasks',
    body: 'Ask what the goal and deadline are if missing. Break it into 5 to 10 steps, each with an owner (a person or one of the agents from agents_list) and a rough date. Show it as a ctrl-table, then offer to put each step on the task board for its agent.' },
];
