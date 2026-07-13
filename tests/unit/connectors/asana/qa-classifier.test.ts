import { describe, it, expect, vi } from 'vitest';
import { classifyBouncedFeatures, type BouncedFeatureInput } from '../../../../src/connectors/asana/qa-classifier.js';

function claudeReturning(text: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text }],
      }),
    },
  };
}

const FEATURES: BouncedFeatureInput[] = [
  {
    gid: 'g1',
    taskName: 'Broken PDP render',
    bounces: [{ by: 'Matthew Fite', from: 'QA Review', to: 'Rework', at: '2026-06-10T12:00:00Z', evidenceComments: ['image 404s'] }],
  },
  {
    gid: 'g2',
    taskName: 'Unclear criteria',
    bounces: [{ by: 'Joshua Nie', from: 'QA Review', to: 'Code Review', at: '2026-06-11T12:00:00Z', evidenceComments: ['acceptance criteria unclear'] }],
  },
];

describe('classifyBouncedFeatures', () => {
  it('returns empty + not degraded and does NOT call the LLM when there are no features', async () => {
    const claude = claudeReturning('[]');
    const res = await classifyBouncedFeatures([], { claude });
    expect(res.degraded).toBe(false);
    expect(res.classifications.size).toBe(0);
    expect(claude.messages.create).not.toHaveBeenCalled();
  });

  it('parses a clean JSON array into per-gid classifications', async () => {
    const claude = claudeReturning(JSON.stringify([
      { gid: 'g1', isRealBug: true, reason: 'image 404 on PDP' },
      { gid: 'g2', isRealBug: false, reason: 'unclear acceptance criteria' },
    ]));
    const res = await classifyBouncedFeatures(FEATURES, { claude });
    expect(res.degraded).toBe(false);
    expect(res.classifications.get('g1')).toEqual({ isRealBug: true, reason: 'image 404 on PDP' });
    expect(res.classifications.get('g2')).toEqual({ isRealBug: false, reason: 'unclear acceptance criteria' });
  });

  it('extracts the JSON array even when the model wraps it in prose', async () => {
    const claude = claudeReturning('Sure! Here you go:\n[{"gid":"g1","isRealBug":true,"reason":"crash"}]\nHope that helps.');
    const res = await classifyBouncedFeatures([FEATURES[0]], { claude });
    expect(res.degraded).toBe(false);
    expect(res.classifications.get('g1')).toEqual({ isRealBug: true, reason: 'crash' });
  });

  it('marks degraded when the LLM call throws', async () => {
    const claude = {
      messages: { create: vi.fn().mockRejectedValue(new Error('boom')) },
    };
    const res = await classifyBouncedFeatures(FEATURES, { claude });
    expect(res.degraded).toBe(true);
    expect(res.classifications.size).toBe(0);
  });

  it('marks degraded when the response is unparseable', async () => {
    const claude = claudeReturning('not json at all');
    const res = await classifyBouncedFeatures(FEATURES, { claude });
    expect(res.degraded).toBe(true);
    expect(res.classifications.size).toBe(0);
  });

  it('marks degraded when the JSON shape violates the schema', async () => {
    const claude = claudeReturning(JSON.stringify([{ gid: 'g1', isRealBug: 'yes' }]));
    const res = await classifyBouncedFeatures(FEATURES, { claude });
    expect(res.degraded).toBe(true);
  });

  // A large window on the busy board produces far more bounced features than a
  // single call's output-token budget can emit; the classifier must fan them out
  // into bounded batches so the array never truncates and blanks the whole run.
  function manyFeatures(n: number): BouncedFeatureInput[] {
    return Array.from({ length: n }, (_, i) => ({
      gid: `g${i}`,
      taskName: `Feature ${i}`,
      bounces: [{ by: 'Matthew Fite', from: 'QA Review', to: 'Rework', at: '2026-06-10T12:00:00Z', evidenceComments: [] }],
    }));
  }

  /** Mock that echoes a classification row for every gid present in the batch's
   *  prompt — so each batched call only ever answers for its own features. */
  function claudeEchoingRealBugs() {
    const create = vi.fn(async (args: any) => {
      const content: string = args.messages[0].content;
      const gids = [...content.matchAll(/"gid":"([^"]+)"/g)].map((m) => m[1]);
      const rows = gids.map((gid) => ({ gid, isRealBug: true, reason: 'bug' }));
      return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
    });
    return { messages: { create } };
  }

  it('splits a large batch across multiple LLM calls and classifies every feature', async () => {
    const claude = claudeEchoingRealBugs();
    const res = await classifyBouncedFeatures(manyFeatures(90), { claude });
    expect(res.degraded).toBe(false);
    expect(res.classifications.size).toBe(90);
    // 90 features at a 40/batch cap => 3 calls, none of which can overflow.
    expect(claude.messages.create).toHaveBeenCalledTimes(3);
    expect(res.classifications.get('g0')?.isRealBug).toBe(true);
    expect(res.classifications.get('g89')?.isRealBug).toBe(true);
  });

  it('degrades only the failed batch — surviving batches still classify (partial fallback)', async () => {
    let call = 0;
    const create = vi.fn(async (args: any) => {
      call += 1;
      if (call === 2) throw new Error('overloaded'); // the second batch fails outright
      const content: string = args.messages[0].content;
      const gids = [...content.matchAll(/"gid":"([^"]+)"/g)].map((m) => m[1]);
      return { content: [{ type: 'text', text: JSON.stringify(gids.map((gid) => ({ gid, isRealBug: false, reason: 'x' }))) }] };
    });
    const res = await classifyBouncedFeatures(manyFeatures(90), { claude: { messages: { create } } });
    expect(res.degraded).toBe(true);
    // Batches 1 (g0-g39) and 3 (g80-g89) survive; batch 2 (g40-g79) is lost.
    expect(res.classifications.size).toBe(50);
    expect(res.classifications.has('g0')).toBe(true);
    expect(res.classifications.has('g40')).toBe(false);
    expect(res.classifications.has('g80')).toBe(true);
  });
});
