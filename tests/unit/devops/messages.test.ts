import { describe, it, expect } from 'vitest';
import { renderJobBlocks } from '../../../src/devops/messages.js';
import type { Job } from '../../../src/devops/types.js';

const baseJob: Job = {
  id: 'j1', kind: 'preview', target: 'backend', status: 'backend_running',
  spec: { backend: { ref: 'feat/as-2215', slug: 'as-2215' } },
  requestedBy: 'U1', channelId: 'C1', messageTs: null, runId: 5,
  error: null, createdAt: 't', updatedAt: 't',
};

describe('renderJobBlocks', () => {
  it('shows a building backend with the requester', () => {
    const blocks = renderJobBlocks(baseJob);
    const text = JSON.stringify(blocks);
    expect(text).toContain('<@U1>');
    expect(text).toContain('as-2215');
    expect(text).toContain('⏳');
  });

  it('shows the URL and a Tear down button when ready', () => {
    const blocks = renderJobBlocks({
      ...baseJob, status: 'ready',
      spec: { backend: { ref: 'feat/as-2215', slug: 'as-2215', url: 'https://as-2215.preview.api.gantri.com' } },
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('https://as-2215.preview.api.gantri.com');
    expect(text).toContain('Tear down');
    expect(text).toContain('preview_teardown');
  });

  it('shows the error when failed', () => {
    const blocks = renderJobBlocks({ ...baseJob, status: 'failed', error: 'boom' });
    expect(JSON.stringify(blocks)).toContain('boom');
  });
});
