import { describe, it, expect, vi } from 'vitest';
import { NotionApiClient, NotionApiError } from '../../../../src/connectors/notion/client.js';

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('NotionApiClient.resolvePageId', () => {
  const client = new NotionApiClient({ token: 'secret_test', fetchImpl: vi.fn() });

  it('parses a slugified Title-<id> URL', () => {
    const id = client.resolvePageId(
      'https://www.notion.so/gantri/Review-FLC-Slack-Command-1234567890abcdef1234567890abcdef',
    );
    expect(id).toBe('1234567890abcdef1234567890abcdef');
  });

  it('parses a bare 32-hex URL', () => {
    expect(client.resolvePageId('https://www.notion.so/1234567890abcdef1234567890ABCDEF')).toBe(
      '1234567890abcdef1234567890abcdef',
    );
  });

  it('parses a dashed UUID and strips query strings', () => {
    const id = client.resolvePageId(
      'https://www.notion.so/Some-Page-12345678-90ab-cdef-1234-567890abcdef?v=abc&p=zzz',
    );
    expect(id).toBe('1234567890abcdef1234567890abcdef');
  });

  it('parses a /p/<id> short link', () => {
    expect(client.resolvePageId('https://www.notion.so/p/deadbeefdeadbeefdeadbeefdeadbeef')).toBe(
      'deadbeefdeadbeefdeadbeefdeadbeef',
    );
  });

  it('throws NotionApiError on a non-Notion url', () => {
    expect(() => client.resolvePageId('https://example.com/not-a-page')).toThrow(NotionApiError);
  });
});

describe('NotionApiClient.getPageMarkdown', () => {
  it('paginates children, recurses into has_children blocks, and extracts markdown + anchors', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/blocks/p1/children') && u.includes('start_cursor=c2')) {
        return jsonResponse({
          object: 'list',
          type: 'block',
          block: {},
          results: [
            {
              id: 't1',
              type: 'toggle',
              has_children: true,
              toggle: { rich_text: [{ plain_text: 'Details toggle' }] },
            },
          ],
          next_cursor: null,
          has_more: false,
        });
      }
      if (u.includes('/blocks/p1/children')) {
        return jsonResponse({
          object: 'list',
          type: 'block',
          block: {},
          results: [
            {
              id: 'h1',
              type: 'heading_1',
              has_children: false,
              heading_1: { rich_text: [{ plain_text: 'Overview' }] },
            },
            {
              id: 'pa1',
              type: 'paragraph',
              has_children: false,
              paragraph: { rich_text: [{ plain_text: 'the first paragraph body' }] },
            },
          ],
          next_cursor: 'c2',
          has_more: true,
        });
      }
      if (u.includes('/blocks/t1/children')) {
        return jsonResponse({
          object: 'list',
          type: 'block',
          block: {},
          results: [
            {
              id: 'n1',
              type: 'bulleted_list_item',
              has_children: false,
              bulleted_list_item: { rich_text: [{ plain_text: 'a nested bullet' }] },
            },
          ],
          next_cursor: null,
          has_more: false,
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const client = new NotionApiClient({ token: 'secret_test', fetchImpl: fetchImpl as unknown as typeof fetch });
    const { markdown, blocks } = await client.getPageMarkdown('p1');

    // pagination (2 calls for p1) + recursion (1 call for t1) = 3 fetches
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    expect(markdown).toContain('# Overview');
    expect(markdown).toContain('the first paragraph body');
    expect(markdown).toContain('- Details toggle');
    expect(markdown).toContain('a nested bullet');

    expect(blocks).toEqual([
      { blockId: 'h1', text: 'Overview' },
      { blockId: 'pa1', text: 'the first paragraph body' },
      { blockId: 't1', text: 'Details toggle' },
      { blockId: 'n1', text: 'a nested bullet' },
    ]);
  });

  it('extracts text from table_row cells', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        object: 'list',
        type: 'block',
        block: {},
        results: [
          {
            id: 'tr1',
            type: 'table_row',
            has_children: false,
            table_row: {
              cells: [[{ plain_text: 'Term' }], [{ plain_text: 'Definition' }]],
            },
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
    );
    const client = new NotionApiClient({ token: 'secret_test', fetchImpl: fetchImpl as unknown as typeof fetch });
    const { blocks } = await client.getPageMarkdown('p1');
    expect(blocks).toEqual([{ blockId: 'tr1', text: 'Term | Definition' }]);
  });
});

describe('NotionApiClient comments', () => {
  it('createPageComment posts parent.page_id + rich_text', async () => {
    const fetchImpl = vi.fn(async (url: string, opts?: { body?: string }) => {
      expect(String(url)).toContain('/comments');
      const body = JSON.parse(opts!.body!);
      expect(body.parent.page_id).toBe('page-123');
      expect(body.rich_text[0].text.content).toBe('a page-level note');
      return jsonResponse({ object: 'comment', id: 'cmt1' });
    });
    const client = new NotionApiClient({ token: 'secret_test', fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.createPageComment('page-123', 'a page-level note');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('createBlockComment posts parent.block_id + rich_text', async () => {
    const fetchImpl = vi.fn(async (url: string, opts?: { body?: string }) => {
      expect(String(url)).toContain('/comments');
      const body = JSON.parse(opts!.body!);
      expect(body.parent.block_id).toBe('block-999');
      expect(body.rich_text[0].text.content).toBe('anchored note');
      return jsonResponse({ object: 'comment', id: 'cmt2' });
    });
    const client = new NotionApiClient({ token: 'secret_test', fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.createBlockComment('block-999', 'anchored note');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('NotionApiClient error mapping', () => {
  it('maps a 404 into a typed NotionApiError with status', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { object: 'error', status: 404, code: 'object_not_found', message: 'Could not find block' },
        404,
      ),
    );
    const client = new NotionApiClient({ token: 'secret_test', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getPageMarkdown('missing')).rejects.toMatchObject({
      name: 'NotionApiError',
      status: 404,
    });
  });
});
