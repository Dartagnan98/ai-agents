'use client';

import { createContext, useContext } from 'react';
import { AREAS, type Area } from '@/lib/nav';

// The areas of this install (core areas + the businesses in businesses.json), provided by the shell.
export const AreasContext = createContext<Area[]>(AREAS);
export const useAreas = () => useContext(AreasContext);

/** A manager who also sells (D, 2026-10-20): which view the nav shows and where each one opens. null = one view only. */
export interface Views { on: 'team' | 'me'; team: string; me: string }
export const ViewsContext = createContext<Views | null>(null);
export const useViews = () => useContext(ViewsContext);
