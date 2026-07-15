import { describe, it, expect } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadBuildStamp,
  createModuleStatus,
  renderBuildInfo,
  makeBuildInfoHandler,
} from '../../../src/server/build-info.js';

function writeStamp(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-'));
  const file = path.join(dir, 'build-info.json');
  fs.writeFileSync(file, contents);
  return file;
}

describe('loadBuildStamp', () => {
  it('reads a valid stamp from an explicit path', () => {
    const file = writeStamp(JSON.stringify({ sha: 'abc123', builtAt: '2026-07-15T00:00:00Z' }));
    expect(loadBuildStamp(file)).toEqual({ sha: 'abc123', builtAt: '2026-07-15T00:00:00Z' });
  });

  it('degrades to "unknown" when the file is missing', () => {
    expect(loadBuildStamp('/nonexistent/build-info.json')).toEqual({ sha: 'unknown', builtAt: 'unknown' });
  });

  it('degrades to "unknown" on malformed JSON', () => {
    const file = writeStamp('{ not json');
    expect(loadBuildStamp(file)).toEqual({ sha: 'unknown', builtAt: 'unknown' });
  });

  it('fills missing fields with "unknown" (partial stamp)', () => {
    const file = writeStamp(JSON.stringify({ sha: 'onlysha' }));
    expect(loadBuildStamp(file)).toEqual({ sha: 'onlysha', builtAt: 'unknown' });
  });
});

describe('createModuleStatus / renderBuildInfo', () => {
  it('defaults everything off except the always-on reports runner', () => {
    expect(createModuleStatus()).toEqual({
      tier: false,
      productExport: false,
      reports: true,
      devops: false,
      flcReview: false,
    });
  });

  it('carries the tier prompt version through as a number when set', () => {
    const modules = createModuleStatus();
    modules.tier = 3;
    const info = renderBuildInfo({ sha: 's', builtAt: 'b' }, modules);
    expect(info).toEqual({
      sha: 's',
      builtAt: 'b',
      modules: { tier: 3, productExport: false, reports: true, devops: false, flcReview: false },
    });
  });

  it('snapshots the ledger (mutating the source afterward does not leak in)', () => {
    const modules = createModuleStatus();
    const info = renderBuildInfo({ sha: 's', builtAt: 'b' }, modules);
    modules.devops = true;
    expect(info.modules.devops).toBe(false);
  });
});

describe('GET /internal/build handler', () => {
  async function fetchBuild(stamp: { sha: string; builtAt: string }, modules = createModuleStatus()) {
    const app = express();
    app.get('/internal/build', makeBuildInfoHandler(stamp, modules));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/internal/build`);
      return { status: res.status, json: (await res.json()) as ReturnType<typeof renderBuildInfo>, modules };
    } finally {
      server.close();
    }
  }

  it('returns 200 with sha, builtAt, and the module ledger', async () => {
    const r = await fetchBuild({ sha: 'deadbeef', builtAt: '2026-07-15T12:00:00Z' });
    expect(r.status).toBe(200);
    expect(r.json.sha).toBe('deadbeef');
    expect(r.json.builtAt).toBe('2026-07-15T12:00:00Z');
    expect(r.json.modules).toEqual({
      tier: false,
      productExport: false,
      reports: true,
      devops: false,
      flcReview: false,
    });
  });

  it('reflects the LIVE ledger — a flag flipped after registration shows up', async () => {
    const modules = createModuleStatus();
    const app = express();
    app.get('/internal/build', makeBuildInfoHandler({ sha: 'x', builtAt: 'y' }, modules));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      // Simulate the tier runner starting after the route was registered.
      modules.tier = 7;
      const res = await fetch(`http://127.0.0.1:${port}/internal/build`);
      const body = (await res.json()) as ReturnType<typeof renderBuildInfo>;
      expect(body.modules.tier).toBe(7);
    } finally {
      server.close();
    }
  });
});
