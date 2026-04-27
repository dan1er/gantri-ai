import { Card, Metric, Text, Flex, BadgeDelta } from '@tremor/react';
import { resolveRef } from '../lib/valueRef.js';
import { fmt } from '../lib/format.js';

export function KpiBlock({ block, dataResults }: { block: any; dataResults: Record<string, unknown> }) {
  const v = resolveRef(block.value, dataResults);
  const display = fmt(v, block.format ?? 'number');
  let delta: { pct: number; abs: number } | null = null;
  if (block.delta && typeof v === 'number') {
    const fromV = resolveRef(block.delta.from, dataResults);
    if (typeof fromV === 'number' && fromV !== 0) {
      delta = { pct: (v - fromV) / fromV, abs: v - fromV };
    }
  }
  const widthClass = (
    { 1: 'col-span-1', 2: 'col-span-2', 3: 'col-span-3', 4: 'col-span-4' } as Record<number, string>
  )[block.width ?? 1];
  return (
    <Card decoration="left" decorationColor="blue" className={widthClass}>
      <Text>{block.label}</Text>
      <Metric>{display}</Metric>
      {delta && (
        <Flex justifyContent="start" className="mt-2">
          <BadgeDelta deltaType={delta.pct >= 0 ? 'increase' : 'decrease'}>
            {fmt(delta.pct, 'pct_delta')}
          </BadgeDelta>
          <Text className="ml-2">vs. previous period</Text>
        </Flex>
      )}
    </Card>
  );
}
