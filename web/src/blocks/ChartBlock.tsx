import { Card, Title, LineChart, BarChart, AreaChart, DonutChart } from '@tremor/react';
import { resolveRef } from '../lib/valueRef.js';

const heightClass: Record<string, string> = { sm: 'h-56', md: 'h-80', lg: 'h-[28rem]' };

const GANTRI_COLORS = ['blue', 'cyan', 'indigo', 'violet', 'fuchsia', 'pink', 'rose', 'orange'] as const;

function truncate(s: unknown, max: number): string {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

export function ChartBlock({ block, dataResults }: { block: any; dataResults: Record<string, unknown> }) {
  const data = resolveRef(block.data, dataResults);
  if (!Array.isArray(data) || data.length === 0) {
    return (
      <Card className="!p-6">
        <Title>{block.title}</Title>
        <div className="py-12 text-center text-sm text-gray-500">No data for this period.</div>
      </Card>
    );
  }
  const categories = Array.isArray(block.y) ? block.y : [block.y];
  const valueFormatter = (n: number) => {
    if (block.yFormat === 'currency') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
    if (block.yFormat === 'percent') return `${(n * 100).toFixed(1)}%`;
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
  };
  const isHorizontal = block.variant === 'horizontal_bar';
  // Coerce string-numbers (NB returns metrics as strings like "482.115493") to
  // real numbers so Tremor doesn't render them as zeroed lines. Truncate long
  // x-axis labels for horizontal bars so they fit the y-axis margin.
  const processedData = data.map((row: any) => {
    const out: Record<string, unknown> = { ...row };
    for (const cat of categories) {
      const v = out[cat];
      if (typeof v === 'string' && v !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) out[cat] = n;
      }
    }
    if (isHorizontal && typeof block.x === 'string') {
      out[block.x] = truncate(out[block.x], 28);
    }
    return out;
  });

  const common = {
    data: processedData,
    index: block.x,
    categories,
    colors: GANTRI_COLORS.slice(0, categories.length) as any,
    valueFormatter,
    className: heightClass[block.height ?? 'md'],
    yAxisWidth: isHorizontal ? 240 : 64,
    showLegend: categories.length > 1,
    showGridLines: true,
    showAnimation: true,
    showXAxis: true,
    showYAxis: true,
  };

  return (
    <Card className="!p-6 !overflow-hidden">
      <Title>{block.title}</Title>
      <div className="mt-4">
        {block.variant === 'line' && <LineChart {...common} curveType="monotone" connectNulls />}
        {block.variant === 'area' && <AreaChart {...common} curveType="monotone" connectNulls />}
        {block.variant === 'bar' && <BarChart {...common} />}
        {block.variant === 'horizontal_bar' && <BarChart {...common} layout="vertical" />}
        {block.variant === 'donut' && <DonutChart data={data} category={categories[0]} index={block.x} valueFormatter={valueFormatter} className={heightClass[block.height ?? 'md']} colors={GANTRI_COLORS as any} />}
      </div>
    </Card>
  );
}
