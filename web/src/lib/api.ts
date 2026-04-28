export interface ReportPayload {
  dataResults: Record<string, unknown>;
  ui: any[];
  errors: Array<{ stepId: string; tool: string; code: string; message: string }>;
  meta: {
    slug: string;
    title: string;
    description?: string | null;
    owner_slack_id: string;
    owner_display_name?: string;
    intent: string;
    createdAt: string;
    updatedAt: string;
    lastRefreshedAt: string;
    sources: string[];
    spec: any;
    effectiveRange?: unknown;
    parametric?: boolean;
    effectivePeriod?: { startDate: string; endDate: string };
    dataQuality?: {
      warnings: Array<{
        code: 'all_steps_empty' | 'step_errors' | 'partial_empty';
        message: string;
      }>;
    };
  };
}

export async function fetchReport(
  slug: string,
  token: string,
  refresh = false,
  range?: string | { start: string; end: string } | null,
): Promise<ReportPayload> {
  const params = new URLSearchParams({ t: token });
  if (refresh) params.set('refresh', '1');
  if (typeof range === 'string') {
    params.set('range', range);
  } else if (range && typeof range === 'object') {
    params.set('from', range.start);
    params.set('to', range.end);
  }
  const url = `/r/${slug}/data.json?${params.toString()}`;
  // `cache: 'no-cache'` forces the browser to revalidate via If-None-Match,
  // even when its HTTP cache thinks the response is fresh. This protects
  // viewers whose cache holds a stale response from an earlier server bug:
  // without it, a broken cached payload (e.g. partnerCount=0) keeps loading
  // until cacheTtlSec expires. Network impact is small — server returns 304
  // when ETag matches.
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return await res.json();
}
