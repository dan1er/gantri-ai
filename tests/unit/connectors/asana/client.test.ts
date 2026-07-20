import { describe, it, expect, vi } from 'vitest';
import { AsanaApiClient, AsanaApiError } from '../../../../src/connectors/asana/client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('AsanaApiClient auth + core', () => {
  it('attaches Authorization: Bearer header on every request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const client = new AsanaApiClient({ accessToken: 'pat_abc', fetchImpl });
    await client.getProjectTasks('123', 'name');
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer pat_abc');
    expect(opts.headers.Accept).toBe('application/json');
  });

  it('passes opt_fields + limit in the query string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    await client.getProjectTasks('123', 'name,completed');
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/projects/123/tasks');
    expect(String(url)).toContain('limit=100');
    expect(String(url)).toMatch(/opt_fields=name(%2C|,)completed/);
  });

  it('getCurrentUser hits /users/me and returns data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { gid: '9', name: 'Danny' } }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const me = await client.getCurrentUser();
    expect(me).toEqual({ gid: '9', name: 'Danny' });
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/users/me');
  });

  it('getTaskStories hits /tasks/{gid}/stories', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ gid: 's1', resource_subtype: 'comment_added', text: 'hi' }],
    }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const stories = await client.getTaskStories('42', 'text');
    expect(stories.length).toBe(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/tasks/42/stories');
  });

  it('getTaskSubtasks hits /tasks/{gid}/subtasks with opt_fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ gid: 'sub1', name: 'Logo overlaps title', created_at: '2026-06-10T12:00:00Z', created_by: { name: 'Matthew Fite' } }],
    }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const subtasks = await client.getTaskSubtasks('42', 'name,created_at,created_by.name');
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0]).toMatchObject({ name: 'Logo overlaps title', created_by: { name: 'Matthew Fite' } });
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/tasks/42/subtasks');
    expect(String(url)).toMatch(/opt_fields=name(%2C|,)created_at/);
  });
});

describe('AsanaApiClient writes', () => {
  it('getTask hits /tasks/{gid} with opt_fields and returns data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { gid: '42', name: 'Refund flow', notes: 'body' } }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const t = await client.getTask('42', 'name,notes');
    expect(t).toMatchObject({ gid: '42', name: 'Refund flow', notes: 'body' });
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/tasks/42');
    expect(String(url)).toMatch(/opt_fields=name(%2C|,)notes/);
  });

  it('setEnumCustomField PUTs the wrapped custom_fields body as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { gid: '42' } }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    await client.setEnumCustomField('42', 'field-1', 'opt-t2');
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/tasks/42');
    expect(opts.method).toBe('PUT');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ data: { custom_fields: { 'field-1': 'opt-t2' } } });
  });

  it('createStory POSTs the comment text and returns the created story', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { gid: 'story-9', text: 'hi' } }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const story = await client.createStory('42', 'hi');
    expect(story.gid).toBe('story-9');
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/tasks/42/stories');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ data: { text: 'hi' } });
  });

  it('createStory POSTs html_text (not text) when an html variant is supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { gid: 'story-9' } }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    await client.createStory('42', 'plain', '<body>rich</body>');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, opts] = fetchImpl.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ data: { html_text: '<body>rich</body>' } });
  });

  it('createStory retries once as plain text when the html_text write is rejected with a 400', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'invalid html_text' }] }, 400))
      .mockResolvedValueOnce(jsonResponse({ data: { gid: 'story-9' } }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const story = await client.createStory('42', 'plain', '<body>bad</body>');
    expect(story.gid).toBe('story-9');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // First attempt is the rich-text body; the fallback is the plain text.
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ data: { html_text: '<body>bad</body>' } });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ data: { text: 'plain' } });
  });

  it('updateStory PUTs html_text when an html variant is supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { gid: 'story-9' } }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    await client.updateStory('story-9', 'plain', '<body>rich</body>');
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/stories/story-9');
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toEqual({ data: { html_text: '<body>rich</body>' } });
  });

  it('does not fall back on a non-400 failure of the html_text write', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: 'Forbidden' }] }, 403));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    await expect(client.createStory('42', 'plain', '<body>rich</body>')).rejects.toBeInstanceOf(AsanaApiError);
    // 403 is not the html-specific 400, so no plain-text retry is attempted.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a write once on 429 then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: { gid: 'story-9' } }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl, retryDelayMs: 1 });
    const story = await client.createStory('42', 'hi');
    expect(story.gid).toBe('story-9');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws AsanaApiError on a failed write', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: 'Forbidden' }] }, 403));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    await expect(client.setEnumCustomField('42', 'f', 'o')).rejects.toBeInstanceOf(AsanaApiError);
  });
});

describe('AsanaApiClient pagination', () => {
  it('follows next_page.offset until exhausted', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ gid: '1' }], next_page: { offset: 'OFF1', path: '', uri: '' } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ gid: '2' }], next_page: null }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const tasks = await client.getProjectTasks('123', 'name');
    expect(tasks.map((t) => t.gid)).toEqual(['1', '2']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // First call has no offset; second carries the offset token.
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('offset=');
    expect(String(fetchImpl.mock.calls[1][0])).toContain('offset=OFF1');
  });

  it('stops after a page with no next_page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ gid: 'x' }] }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const tasks = await client.getProjectTasks('123', 'name');
    expect(tasks.length).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('getTaskSubtasks follows next_page.offset until exhausted', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ gid: 'sub1', name: 'a' }], next_page: { offset: 'OFF1', path: '', uri: '' } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ gid: 'sub2', name: 'b' }], next_page: null }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const subtasks = await client.getTaskSubtasks('42', 'name');
    expect(subtasks.map((s) => s.gid)).toEqual(['sub1', 'sub2']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('offset=');
    expect(String(fetchImpl.mock.calls[1][0])).toContain('offset=OFF1');
  });
});

describe('AsanaApiClient error + retry', () => {
  it('throws AsanaApiError on 401 with status + body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: 'Not Authorized' }] }, 401));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    await expect(client.getCurrentUser()).rejects.toBeInstanceOf(AsanaApiError);
    try {
      await client.getCurrentUser();
    } catch (e) {
      expect((e as AsanaApiError).status).toBe(401);
      expect((e as AsanaApiError).body).toEqual({ errors: [{ message: 'Not Authorized' }] });
    }
  });

  it('retries once on 429 then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: { gid: '9', name: 'Danny' } }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl, retryDelayMs: 1 });
    const me = await client.getCurrentUser();
    expect(me.name).toBe('Danny');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries once on 5xx then throws if still failing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl, retryDelayMs: 1 });
    await expect(client.getCurrentUser()).rejects.toBeInstanceOf(AsanaApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('getTaskSubtasks throws AsanaApiError on a 404 with status + body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: 'Not Found' }] }, 404));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    await expect(client.getTaskSubtasks('42', 'name')).rejects.toBeInstanceOf(AsanaApiError);
    try {
      await client.getTaskSubtasks('42', 'name');
    } catch (e) {
      expect((e as AsanaApiError).status).toBe(404);
      expect((e as AsanaApiError).body).toEqual({ errors: [{ message: 'Not Found' }] });
    }
  });
});
