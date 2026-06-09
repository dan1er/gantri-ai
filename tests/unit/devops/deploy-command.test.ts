import { describe, it, expect, vi } from 'vitest';
import { candidateDeployTags, previousBackendDeployTag, findSkipped } from '../../../src/slack/devops/deploy-command.js';
import type { Job, JobSpec, DeployItem } from '../../../src/devops/types.js';

function job(spec: JobSpec, status: Job['status'] = 'ready'): Job {
  return {
    id: 'j', kind: 'deploy', target: 'backend', status, spec,
    requestedBy: 'U', channelId: 'C', messageTs: null, runId: null,
    error: null, createdAt: 't', updatedAt: 't',
  };
}
const be = (pr: number): DeployItem => ({ tag: `deploy-${pr}-d`, sha: 's', pr });
const fe = (repo: DeployItem['repo'], pr: number): DeployItem => ({ repo, tag: `deploy-${pr}-d`, sha: 's', pr });
const tag = (pr: number | null, committedAt = '') => ({ tag: `deploy-${pr}-d`, sha: 's', pr, committedAt });

describe('candidateDeployTags', () => {
  it('returns all tags when the repo has no deploy jobs yet', () => {
    const tags = [tag(5199, '2026-06-09'), tag(5198, '2026-06-08'), tag(5196, '2026-06-07')];
    expect(candidateDeployTags(tags, [], 'porter')).toEqual(tags);
  });

  it('porter: hides tags committed at or before the latest deployed backend tag', () => {
    const tags = [tag(5200, '2026-06-09'), tag(5199, '2026-06-08'), tag(5198, '2026-06-07'), tag(5196, '2026-06-06')];
    const jobs = [job({ deployBackend: be(5198) })]; // 5198 live (committed 2026-06-07)
    // 5198 and everything committed before it are already in prod
    expect(candidateDeployTags(tags, jobs, 'porter').map((t) => t.pr)).toEqual([5200, 5199]);
  });

  it('shows a newer commit even when its PR# is lower (out-of-order merge)', () => {
    // 5180 merged late: lower number than 5200/5205, but a NEWER commit.
    const tags = [
      tag(5180, '2026-06-09T15:54:00Z'),
      tag(5205, '2026-06-09T03:00:00Z'),
      tag(5200, '2026-06-08T18:00:00Z'),
    ];
    const jobs = [job({ deployBackend: be(5200) })]; // 5200 live (older commit)
    // PR-number ordering would wrongly hide 5180 (< 5200); commit-date keeps it.
    expect(candidateDeployTags(tags, jobs, 'porter').map((t) => t.pr)).toEqual([5180, 5205]);
  });

  it('frontend: watermark is per-repo — a core deploy does not hide mantle tags', () => {
    const tags = [tag(1203, '2026-06-09'), tag(1202, '2026-06-08'), tag(1201, '2026-06-07')];
    const jobs = [job({ deployFrontends: [fe('core', 1203)] })];
    // deployed core@1203, but we're picking for mantle → nothing hidden
    expect(candidateDeployTags(tags, jobs, 'mantle').map((t) => t.pr)).toEqual([1203, 1202, 1201]);
    // for core, 1203 (newest) is live → nothing newer to offer
    expect(candidateDeployTags(tags, jobs, 'core')).toEqual([]);
  });

  it('takes the latest commit across multiple jobs and mixed backend/frontend items', () => {
    const tags = [tag(5205, '2026-06-09'), tag(5202, '2026-06-08'), tag(5200, '2026-06-07')];
    const jobs = [
      job({ deployBackend: be(5200) }),
      job({ deployBackend: be(5202), deployFrontends: [fe('made', 5202)] }),
    ];
    // latest deployed porter = 5202 (2026-06-08) → only 5205 (newer) remains
    expect(candidateDeployTags(tags, jobs, 'porter').map((t) => t.pr)).toEqual([5205]);
  });

  it('never hides a tag without a commit date', () => {
    const tags = [tag(null, ''), tag(5196, '2026-06-09'), tag(5195, '2026-06-08')];
    const jobs = [job({ deployBackend: be(5195) })]; // 5195 live (2026-06-08)
    const result = candidateDeployTags(tags, jobs, 'porter').map((t) => t.pr);
    expect(result).toContain(null); // no commit date → always shown
    expect(result).toContain(5196); // newer commit → shown
    expect(result).not.toContain(5195); // the live tag → hidden
  });
});

describe('findSkipped', () => {
  const t = (pr: number, committedAt: string) => ({ tag: `deploy-x-${pr}`, sha: 's', pr, committedAt });
  const deps = (deployedPrs: number[], tags: ReturnType<typeof t>[]) => ({
    repo: { listDeployJobs: vi.fn().mockResolvedValue(deployedPrs.map((pr) => job({ deployBackend: { tag: `deploy-x-${pr}`, sha: 's', pr } }))) },
    gh: { listDeployTags: vi.fn().mockResolvedValue(tags) },
  }) as any;

  it('does not flag tags older than what is already live in prod (bundled into a prior deploy)', async () => {
    // prod is at 5213; deploying 5214 right after → nothing is being skipped.
    const tags = [
      t(5214, '2026-06-09T21:14:00Z'), t(5213, '2026-06-09T20:13:00Z'),
      t(5209, '2026-06-09T19:58:00Z'), t(5180, '2026-06-09T15:54:00Z'),
      t(5196, '2026-06-08T16:09:00Z'),
    ];
    const out = await findSkipped(deps([5213, 5205], tags), { deployBackend: { tag: 'deploy-x-5214', sha: 's', pr: 5214 } });
    expect(out).toEqual([]);
  });

  it('flags only undeployed tags between the live commit and the picked tag', async () => {
    // prod at 5200; picking 5214 → 5209 and 5180 ride along; 5196 (older than live) does not.
    const tags = [
      t(5214, '2026-06-09T21:14:00Z'), t(5209, '2026-06-09T19:58:00Z'),
      t(5180, '2026-06-09T15:54:00Z'), t(5200, '2026-06-08T17:58:00Z'),
      t(5196, '2026-06-08T16:09:00Z'),
    ];
    const out = await findSkipped(deps([5200], tags), { deployBackend: { tag: 'deploy-x-5214', sha: 's', pr: 5214 } });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('deploy-x-5209');
    expect(out[0]).toContain('deploy-x-5180');
    expect(out[0]).not.toContain('deploy-x-5196');
  });
});

describe('previousBackendDeployTag', () => {
  it('returns the most recent prior backend deploy tag (jobs are newest-first)', () => {
    const jobs = [
      job({ deployFrontends: [fe('mantle', 1203)] }),   // newest, no backend → skip
      job({ deployBackend: be(5198) }),                 // the previous backend release
      job({ deployBackend: be(5196) }),
    ];
    expect(previousBackendDeployTag(jobs)).toBe('deploy-5198-d');
  });

  it('returns undefined when no prior job carried a backend', () => {
    expect(previousBackendDeployTag([job({ deployFrontends: [fe('core', 1) ] })])).toBeUndefined();
    expect(previousBackendDeployTag([])).toBeUndefined();
  });
});
