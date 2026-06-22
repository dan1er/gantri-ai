import { describe, it, expect } from 'vitest';
import { isDmChannel, decideCommandChannel, channelFromView } from '../../../src/slack/devops/channel-access.js';

const OPS = 'C0PS';
const DM_DANNY = 'D123';
const DANNY = 'UK0JM2PTM';

describe('isDmChannel', () => {
  it('treats only D-prefixed channels as DMs', () => {
    expect(isDmChannel('D123')).toBe(true);
    expect(isDmChannel('C0PS')).toBe(false);
    expect(isDmChannel('G987')).toBe(false); // multi-person DM, not a 1:1 with the bot
  });
});

describe('decideCommandChannel', () => {
  it('allows the ops channel for anyone', () => {
    expect(decideCommandChannel('/preview', OPS, [], OPS, 'Uanyone').allowed).toBe(true);
  });

  it('allows an allowlisted user in their DM', () => {
    expect(decideCommandChannel('/deploy', OPS, [DANNY], DM_DANNY, DANNY).allowed).toBe(true);
  });

  it('rejects a DM from a non-allowlisted user', () => {
    const d = decideCommandChannel('/deploy', OPS, [DANNY], 'D999', 'Uother');
    expect(d.allowed).toBe(false);
    expect(d.message).toContain(OPS);
  });

  it('rejects an allowlisted user in some other (non-ops, non-DM) channel', () => {
    expect(decideCommandChannel('/preview', OPS, [DANNY], 'C0THER', DANNY).allowed).toBe(false);
  });

  it('rejects every DM when the allowlist is empty', () => {
    expect(decideCommandChannel('/preview', OPS, [], DM_DANNY, DANNY).allowed).toBe(false);
  });
});

describe('channelFromView', () => {
  it('reads the channel from private_metadata', () => {
    expect(channelFromView({ private_metadata: JSON.stringify({ channel: 'D123' }) }, OPS)).toBe('D123');
  });
  it('falls back when metadata is missing or malformed', () => {
    expect(channelFromView({ private_metadata: '' }, OPS)).toBe(OPS);
    expect(channelFromView({ private_metadata: 'not-json' }, OPS)).toBe(OPS);
    expect(channelFromView(undefined, OPS)).toBe(OPS);
  });
});
