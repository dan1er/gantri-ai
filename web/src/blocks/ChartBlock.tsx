import { Card, Title, LineChart, BarChart, AreaChart, DonutChart } from '@tremor/react';
import { resolveRef } from '../lib/valueRef.js';

const heightClass: Record<string, string> = { sm: 'h-48', md: 'h-72', lg: 'h-96' };

export function ChartBlock({ block, dataResults }: { block: any; dataResults: Record<string, unknown> }) {
  const data = resolveRef(block.data, dataResults);
  if (!Array.isArray(data) || data.length === 0) {
    return <Card><Title>{block.title}</Title><div className="py-8 text-center text-sm text-gray-500">No data for this period.</div></Card>;
  }
  const categories = Array.isArray(block.y) ? block.y : [block.y];
  const valueFormatter = (n: number) => {
    if (block.yFormat === 'currency') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
    if (block.yFormat === 'percent') return `${(n * 100).toFixed(1)}%`;
    return new Intl.NumberFormat('en-US').format(n);
  };
  const common = { data, index: block.x, categories, valueFormatter, className: heightClass[block.height ?? 'md'], yAxisWidth: 60 };
  return (
    <Card>
      <Title>{block.title}</Title>
      {block.variant === 'line' && <LineChart {...common} />}
      {block.variant === 'area' && <AreaChart {...common} />}
      {block.variant === 'bar' && <BarChart {...common} />}
      {block.variant === 'horizontal_bar' && <BarChart {...common} layout="vertical" />}
      {block.variant === 'donut' && <DonutChart data={data} category={categories[0]} index={block.x} valueFormatter={valueFormatter} className={heightClass[block.height ?? 'md']} />}
    </Card>
  );
}
