import { Card, Title, Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from '@tremor/react';
import { resolveRef } from '../lib/valueRef.js';
import { fmt } from '../lib/format.js';

export function TableBlock({ block, dataResults }: { block: any; dataResults: Record<string, unknown> }) {
  const data = resolveRef(block.data, dataResults);
  if (!Array.isArray(data)) {
    return <Card>{block.title && <Title>{block.title}</Title>}<div className="py-6 text-center text-sm text-gray-500">No data.</div></Card>;
  }
  let rows = [...data];
  if (block.sortBy) {
    const f = block.sortBy.field;
    const dir = block.sortBy.direction === 'asc' ? 1 : -1;
    rows.sort((a, b) => (((a as any)[f] ?? 0) > ((b as any)[f] ?? 0) ? dir : -dir));
  }
  const sliced = rows.slice(0, block.pageSize ?? 25);
  return (
    <Card>
      {block.title && <Title>{block.title}</Title>}
      <Table className="mt-4">
        <TableHead>
          <TableRow>
            {block.columns.map((c: any) => (
              <TableHeaderCell key={c.field} className={c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}>
                {c.label}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {sliced.map((r: any, i: number) => (
            <TableRow key={i}>
              {block.columns.map((c: any) => (
                <TableCell key={c.field} className={c.align === 'right' ? 'text-right tabular-nums' : c.align === 'center' ? 'text-center' : ''}>
                  {c.format === 'admin_order_link' && r[c.field]
                    ? <a href={`https://admin.gantri.com/orders/${r[c.field]}`} target="_blank" rel="noreferrer" className="text-blue-600 underline">#{r[c.field]}</a>
                    : fmt(r[c.field], c.format ?? 'number')}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
