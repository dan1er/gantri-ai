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
  };
}

export async function fetchReport(slug: string, token: string, refresh = false): Promise<ReportPayload> {
  const url = `/r/${slug}/data.json?t=${encodeURIComponent(token)}${refresh ? '&refresh=1' : ''}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return await res.json();
}
