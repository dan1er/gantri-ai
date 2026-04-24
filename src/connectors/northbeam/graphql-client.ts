export interface GraphqlClientOptions {
  endpoint?: string;
  getToken: () => Promise<string>;
  dashboardId: string;
}

export class NorthbeamGraphqlClient {
  private readonly endpoint: string;

  constructor(private readonly opts: GraphqlClientOptions) {
    this.endpoint = opts.endpoint ?? 'https://dashboard-api.northbeam.io/api/graphql';
  }

  async request<T = unknown>(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const token = await this.opts.getToken();
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-nb-dashboard-id': this.opts.dashboardId,
        'x-nb-impersonate-user': this.opts.dashboardId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operationName, query, variables }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Northbeam GraphQL HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      throw new Error(`Northbeam GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    if (!body.data) throw new Error('Northbeam GraphQL returned no data');
    return body.data;
  }
}
