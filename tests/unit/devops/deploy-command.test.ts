import { describe, it, expect } from 'vitest';
import { candidateDeployTags, previousBackendDeployTag } from '../../../src/slack/devops/deploy-command.js';
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
const tag = (pr: number | null) => ({ tag: `deploy-${pr}-d`, sha: 's', pr });

describe('candidateDeployTags', () => {
  it('returns all tags when the repo has no deploy jobs yet', () => {
    const tags = [tag(5199), tag(5198), tag(5196)];
    expect(candidateDeployTags(tags, [], 'porter')).toEqual(tags);
  });

  it('porter: hides tags at or below the highest deployed backend PR#', () => {
    const tags = [tag(5200), tag(5199), tag(5198), tag(5196)];
    const jobs = [job({ deployBackend: be(5198) })];
    // 5198 deployed → 5198 and everything below it are already in prod
    expect(candidateDeployTags(tags, jobs, 'porter').map((t) => t.pr)).toEqual([5200, 5199]);
  });

  it('frontend: watermark is per-repo — a core deploy does not hide mantle tags', () => {
    const tags = [tag(1203), tag(1202), tag(1201)];
    const jobs = [job({ deployFrontends: [fe('core', 1203)] })];
    // deployed core@1203, but we're picking for mantle → nothing hidden
    expect(candidateDeployTags(tags, jobs, 'mantle').map((t) => t.pr)).toEqual([1203, 1202, 1201]);
    // for core, 1203 and below are hidden
    expect(candidateDeployTags(tags, jobs, 'core')).toEqual([]);
  });

  it('takes the max across multiple jobs and mixed backend/frontend items', () => {
    const tags = [tag(5205), tag(5202), tag(5200)];
    const jobs = [
      job({ deployBackend: be(5200) }),
      job({ deployBackend: be(5202), deployFrontends: [fe('made', 5202)] }),
    ];
    expect(candidateDeployTags(tags, jobs, 'porter').map((t) => t.pr)).toEqual([5205]);
  });

  it('never hides a tag without a parseable PR# (pr null)', () => {
    const tags = [tag(null), tag(5196)];
    const jobs = [job({ deployBackend: be(5199) })];
    // null-pr tag still shown; 5196 hidden (<= 5199)
    expect(candidateDeployTags(tags, jobs, 'porter').map((t) => t.pr)).toEqual([null]);
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
