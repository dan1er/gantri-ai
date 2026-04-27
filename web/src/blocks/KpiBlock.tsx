import { Card, BadgeDelta } from '@tremor/react';
import { resolveRef } from '../lib/valueRef.js';
import { fmt } from '../lib/format.js';

export function KpiBlock({ block, dataResults }: { block: any; dataResults: Record<string, unknown> }) {
  const v = resolveRef(block.value, dataResults);
  const display = fmt(v, block.format ?? 'number');
  let delta: { pct: number } | null = null;
  if (block.delta && typeof v === 'number') {
    const fromV = resolveRef(block.delta.from, dataResults);
    const fromN = typeof fromV === 'number' ? fromV : Number(fromV);
    if (Number.isFinite(fromN) && fromN !== 0) {
      delta = { pct: (Number(v) - fromN) / fromN };
    }
  }
  const widthClass = ({ 1: 'col-span-1', 2: 'col-span-2', 3: 'col-span-3', 4: 'col-span-4' } as Record<number, string>)[block.width ?? 1];
  return (
    <Card className={`${widthClass} !p-5`}>
      <p className="text-xs uppercase tracking-wider text-gray-500 font-medium">{block.label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-gantri-ink tabular-nums">{display}</p>
      {delta && (
        <div className="mt-3 flex items-center gap-2">
          <BadgeDelta deltaType={delta.pct >= 0 ? 'increase' : 'decrease'}>
            {fmt(delta.pct, 'pct_delta')}
          </BadgeDelta>
          <span className="text-xs text-gray-500">vs. previous period</span>
        </div>
      )}
    </Card>
  );
}
