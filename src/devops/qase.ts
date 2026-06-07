// Minimal Qase TestOps client — the dev-ops E2E gate creates a run up front so
// it knows the exact run URL to link in Slack, then hands the id to
// gantri-e2e's qase-trigger (qase_run_id) which appends the Playwright results
// to that same run.

export interface QaseReader {
  createRun(title: string): Promise<number | null>;
  runUrl(id: number): string;
}

const QASE_PROJECT = 'GANTRI';

export class QaseClient implements QaseReader {
  constructor(private readonly token: string) {}

  async createRun(title: string): Promise<number | null> {
    try {
      const res = await fetch(`https://api.qase.io/v1/run/${QASE_PROJECT}`, {
        method: 'POST',
        headers: { Token: this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { result?: { id?: number } };
      return body.result?.id ?? null;
    } catch {
      return null;
    }
  }

  runUrl(id: number): string {
    return `https://app.qase.io/run/${QASE_PROJECT}/dashboard/${id}`;
  }
}
