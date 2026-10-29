import {
  IconSparkles,
  IconFolderCheck, IconPalette, IconPlugConnected, IconUsers,
} from '@tabler/icons-react';

// Settings sections, in order: the phone list and the desktop sidebar read this one list. ?tab=<id> opens one.
export const SETTINGS_GROUPS = ['General', 'You'] as const;


const ALL = [
  { id: 'ai', label: 'AI connections', icon: IconSparkles, group: 'General', about: 'How the agents run (your Claude subscription or API keys), plus Slack, Telegram and WhatsApp.' },
  { id: 'connectors', label: 'Connectors', icon: IconPlugConnected, group: 'General', about: 'Apps the agents can use (Gmail, Calendar, Slack, Notion and 250+ more) through Composio.' },
  { id: 'users', label: 'Users', icon: IconUsers, group: 'General', about: 'Who can sign in and their role.' },
  { id: 'allowed-roots', label: 'Allowed roots', icon: IconFolderCheck, group: 'General', about: 'The folders on this computer the agents may read and send files from.' },
  { id: 'appearance', label: 'Appearance', icon: IconPalette, group: 'You', about: 'Theme and how the app looks for you.' },
];

export const SETTINGS_SECTIONS = SETTINGS_GROUPS.flatMap((g) => ALL.filter((x) => x.group === g));
