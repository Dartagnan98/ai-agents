'use client';

import { useEffect } from 'react';

// Drop-down panels built on <details data-popover> (change owner, custom dates, page picker, lead search) close on a click outside them or
// Esc (D, 2026-10-05: they stayed open until their own button was clicked again). Mounted once in the dashboard layout.
export function PopoverCloser() {
  useEffect(() => {
    const closeAll = (keep?: Node | null) => {
      for (const d of document.querySelectorAll<HTMLDetailsElement>('details[data-popover][open]')) if (!keep || !d.contains(keep)) d.removeAttribute('open');
    };
    const down = (e: PointerEvent) => closeAll(e.target as Node);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAll(); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, []);
  return null;
}
