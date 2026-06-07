import { describe, it, expect } from 'vitest';
import { isOpsChannel, buildTypeButtons, buildBackendModal, parseBackendSubmission } from '../../../src/slack/devops/preview-command.js';

describe('preview command helpers', () => {
  it('isOpsChannel gates to the configured channel', () => {
    expect(isOpsChannel('C1', 'C1')).toBe(true);
    expect(isOpsChannel('C2', 'C1')).toBe(false);
  });

  it('buildTypeButtons returns three actions', () => {
    const blocks = buildTypeButtons();
    const text = JSON.stringify(blocks);
    expect(text).toContain('preview_backend');
    expect(text).toContain('preview_frontend');
    expect(text).toContain('preview_fullstack');
  });

  it('buildBackendModal has a porter ref input + a known callback_id', () => {
    const view = buildBackendModal();
    expect(view.callback_id).toBe('preview_backend_submit');
    expect(JSON.stringify(view)).toContain('porter');
  });

  it('parseBackendSubmission pulls the ref out of view state', () => {
    const view = { state: { values: { ref_block: { ref_input: { value: 'feat/as-2215-x' } } } } };
    expect(parseBackendSubmission(view as any)).toEqual({ ref: 'feat/as-2215-x' });
  });
});
