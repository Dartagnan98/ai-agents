'use client';

import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

// Next's app-router Link fetches the whole page on hover or touch with `unstable_dynamicOnHover` (16.2 runtime,
// next/dist/client/app-dir/link.js), but next/link's public types do not list the prop yet: one cast here instead of
// one per link. Same component at runtime.
type Props = ComponentProps<typeof Link> & { unstable_dynamicOnHover?: boolean };
export const AppLink = Link as unknown as (p: Props) => ReactNode;
