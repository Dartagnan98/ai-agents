'use client';

import { createContext, useContext } from 'react';

// The ⌘K palette's open signal, apart from the palette itself (2026-10-21): the palette (cmdk, ~100 KB) loads on first open, but every page's
// search buttons need the signal.
export const PaletteContext = createContext<{ open: () => void }>({ open: () => {} });
export const usePalette = () => useContext(PaletteContext);
