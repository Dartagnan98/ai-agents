/**
 * AI Agents - Chart theme configuration.
 * Ink ledger palette for all Recharts components.
 */

// -- Color palette --

// Apple system series (liquid glass, 2026-10-28; was Porcelain Signal): blue first, then teal, violet, amber, pink, slate, ink.
// The CHART_GOLD names stay for old imports; they now mean the primary cobalt series.
export const CHART_GOLD = 'var(--chart-1)';
export const CHART_GOLD_LIGHT = '#66AFFF';
export const CHART_GOLD_DARK = '#0040DD';
export const CHART_GOLD_MUTED = 'rgba(0, 122, 255, 0.07)';
/** Previous-period / ghost series. */
export const CHART_GHOST = '#C7C7CC';

export const CHART_COLORS = [
  'var(--chart-1)', // cobalt
  'var(--chart-2)', // teal
  'var(--chart-3)', // violet
  'var(--chart-4)', // amber
  'var(--chart-5)', // pink
  '#64748B', // slate
  'var(--foreground)', // ink
] as const;

// -- Model-specific colors (for cost charts) --

export const MODEL_COLORS: Record<string, string> = {
  opus: 'var(--chart-1)',
  sonnet: 'var(--chart-2)',
  haiku: 'var(--chart-3)',
};

// -- Severity colors --

export const SEVERITY_COLORS: Record<string, string> = {
  info: '#2563EB',
  warning: '#8A6A52',
  error: '#EF4444',
};

// -- Recharts default props --

export const AXIS_STYLE = {
  fontSize: 10.5,
  fontFamily: 'var(--font-jetbrains), JetBrains Mono, monospace',
  fill: 'var(--label)',
  tickLine: false,
  axisLine: false,
} as const;

export const GRID_STYLE = {
  stroke: 'var(--hairline)',
  vertical: false,
} as const;

export const TOOLTIP_STYLE = {
  // Dark ink tag, like the value tags on the design boards.
  contentStyle: {
    backgroundColor: '#0E1422',
    border: 'none',
    borderRadius: 10,
    boxShadow: '0 12px 28px -8px rgba(14, 20, 34, 0.45)',
    fontSize: 12,
    padding: '8px 12px',
    color: '#FFFFFF',
  },
  labelStyle: {
    color: '#A3ADC2',
    fontFamily: 'var(--font-jetbrains), JetBrains Mono, monospace',
    fontSize: 10.5,
    letterSpacing: '0.06em',
    marginBottom: 4,
  },
  itemStyle: {
    color: '#FFFFFF',
    fontWeight: 600,
  },
  cursor: { fill: 'rgba(40, 72, 232, 0.06)' },
} as const;

// -- Helper functions --

/** Get a color by index, cycling through CHART_COLORS */
export function getChartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

/** Get a model color with fallback */
export function getModelColor(model: string): string {
  const key = model.toLowerCase();
  for (const [name, color] of Object.entries(MODEL_COLORS)) {
    if (key.includes(name)) return color;
  }
  return CHART_COLORS[0];
}

/** Generate a gradient ID for an area chart */
export function gradientId(prefix: string, index: number = 0): string {
  return `${prefix}-gradient-${index}`;
}
