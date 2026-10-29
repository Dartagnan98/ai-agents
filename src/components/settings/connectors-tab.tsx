'use client';

import { ComposioApps } from '@/components/settings/composio-apps';

// Connectors is Composio. Square, ads, mail, and the rest are linked as apps there, not as their own key lists.
export function ConnectorsTab() {
  return <ComposioApps />;
}
