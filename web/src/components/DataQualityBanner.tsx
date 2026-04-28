interface Warning {
  code: 'all_steps_empty' | 'step_errors' | 'partial_empty';
  message: string;
}

/**
 * Yellow warning banner shown above the report grid when the runner detects
 * the rendered data is empty or partially errored. Surfaces "this report
 * looks broken" rather than letting zeros render silently — most often
 * triggered when a viewer overrides ?range= to a window that has no data.
 */
export function DataQualityBanner({ warnings }: { warnings: Warning[] }) {
  if (warnings.length === 0) return null;
  const isError = warnings.some((w) => w.code === 'step_errors');
  const palette = isError
    ? 'border-red-200 bg-red-50 text-red-800'
    : 'border-amber-200 bg-amber-50 text-amber-900';
  const title = isError ? 'Some data could not be loaded' : 'Heads up about this report';
  return (
    <div className={`mb-5 rounded-lg border ${palette} p-3.5 text-sm`} role="status" aria-live="polite">
      <div className="font-semibold mb-1">{title}</div>
      <ul className="list-disc list-inside space-y-0.5">
        {warnings.map((w, i) => (
          <li key={i}>{w.message}</li>
        ))}
      </ul>
    </div>
  );
}
