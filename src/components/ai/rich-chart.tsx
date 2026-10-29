'use client';

import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS_STYLE, CHART_COLORS, GRID_STYLE, TOOLTIP_STYLE } from '@/components/charts/chart-theme';
import type { ChartData } from './blocks';

// A ctrl-chart in a the agents reply (D, 2026-10-09): AnswerChart (bar, line, pie) drawn with Fleet's chart theme. Loaded
// lazily by rich-text.tsx so recharts only ships when a reply has a chart.
const fmt = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v ?? '');
  return Math.abs(n) >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const short = (v: unknown) => (String(v).length > 14 ? `${String(v).slice(0, 13)}...` : String(v));

export default function RichChart({ chart }: { chart: ChartData }) {
  const many = chart.data.length >= (typeof window !== 'undefined' && window.innerWidth < 640 ? 5 : 9);
  const colors = CHART_COLORS;
  return (
    <div className="fai-chart-box" role="img" aria-label={`${chart.kind} chart: ${chart.title || chart.series.join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        {chart.kind === 'pie' ? (
          <PieChart>
            <Tooltip {...TOOLTIP_STYLE} formatter={(v) => fmt(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Pie data={chart.data} dataKey={chart.series[0]} nameKey={chart.x} innerRadius="45%" outerRadius="80%" paddingAngle={1} stroke="var(--card)" isAnimationActive={false}>
              {chart.data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
            </Pie>
          </PieChart>
        ) : chart.kind === 'line' ? (
          <LineChart data={chart.data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis dataKey={chart.x} {...AXIS_STYLE} minTickGap={16} tickFormatter={short} />
            <YAxis {...AXIS_STYLE} width={56} tickFormatter={(v: number) => fmt(v)} />
            <Tooltip {...TOOLTIP_STYLE} cursor={{ stroke: 'var(--border)' }} formatter={(v) => fmt(v)} />
            {chart.series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {chart.series.map((s, i) => <Line key={s} type="monotone" dataKey={s} stroke={colors[i % colors.length]} strokeWidth={2} dot={chart.data.length <= 24} connectNulls={false} isAnimationActive={false} />)}
          </LineChart>
        ) : (
          <BarChart data={chart.data} margin={{ top: 8, right: 12, bottom: many ? 28 : 4, left: 0 }}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis dataKey={chart.x} {...AXIS_STYLE} interval={0} angle={many ? -30 : 0} textAnchor={many ? 'end' : 'middle'} height={many ? 48 : 24} tickFormatter={short} />
            <YAxis {...AXIS_STYLE} width={56} tickFormatter={(v: number) => fmt(v)} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v) => fmt(v)} />
            {chart.series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {chart.series.map((s, i) => <Bar key={s} dataKey={s} fill={colors[i % colors.length]} radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false} />)}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
