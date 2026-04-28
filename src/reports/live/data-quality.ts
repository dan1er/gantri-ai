/**
 * Compute a "data quality" verdict for a rendered live report. Used by the
 * data.json endpoint to surface a banner when the selected range produces an
 * essentially empty report — most often because the spec's default range had
 * data but a viewer-overridden range (via ?range=) does not.
 *
 * Without this, an empty report renders as zero KPIs + empty charts with no
 * indication that the report is "broken-looking" rather than "intentionally
 * showing zero".
 */

export interface DataQualityWarning {
  /** Stable identifier used by the SPA to vary the banner copy. */
  code: 'all_steps_empty' | 'step_errors' | 'partial_empty';
  message: string;
}

export interface DataQualityVerdict {
  warnings: DataQualityWarning[];
}

/**
 * `dataResults` is keyed by step id. Each value is whatever the tool returned.
 * `errors` lists per-step errors emitted by the runner.
 *
 * Rules:
 *   - any step error → 'step_errors'
 *   - all steps look empty (no errors AND every value is "empty-shaped") →
 *     'all_steps_empty'
 *   - some steps empty, some not → 'partial_empty' (informational)
 */
export function computeDataQuality(
  dataResults: Record<string, unknown>,
  errors: Array<{ stepId: string; tool: string; code: string; message: string }>,
): DataQualityVerdict {
  const warnings: DataQualityWarning[] = [];

  if (errors.length > 0) {
    const summary = errors.slice(0, 3).map((e) => `${e.tool} (${e.code})`).join(', ');
    warnings.push({
      code: 'step_errors',
      message: `${errors.length} data step${errors.length === 1 ? '' : 's'} failed: ${summary}${errors.length > 3 ? '…' : ''}`,
    });
  }

  const stepIds = Object.keys(dataResults);
  if (stepIds.length === 0) return { warnings };

  const emptySteps = stepIds.filter((id) => isStepEmpty(dataResults[id]));
  if (emptySteps.length === stepIds.length && errors.length === 0) {
    warnings.push({
      code: 'all_steps_empty',
      message: 'No data was returned for the selected date range. Try a different range, or check the source.',
    });
  } else if (emptySteps.length > 0 && emptySteps.length < stepIds.length) {
    warnings.push({
      code: 'partial_empty',
      message: `${emptySteps.length} of ${stepIds.length} data step${stepIds.length === 1 ? '' : 's'} returned no data: ${emptySteps.join(', ')}.`,
    });
  }

  return { warnings };
}

/** A step result is "empty" if every numeric leaf is 0/null AND every array
 *  leaf is empty. Strings, bools and metadata fields are ignored — they exist
 *  in successful results too (e.g. `dateRange`, `currency`). */
function isStepEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'number') return value === 0;
  if (Array.isArray(value)) return value.length === 0 || value.every(isStepEmpty);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    // Look only at numeric and array leaves — those carry the "data weight".
    let hasNumericOrArray = false;
    for (const [, v] of entries) {
      if (typeof v === 'number' || Array.isArray(v) || (v && typeof v === 'object')) {
        hasNumericOrArray = true;
        if (!isStepEmpty(v)) return false;
      }
    }
    // If the object had no numeric/array leaves at all, treat it as non-data
    // metadata (e.g. `{ok: true}`) and don't flag as empty.
    return hasNumericOrArray;
  }
  return false;
}
