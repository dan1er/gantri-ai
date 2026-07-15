import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build fingerprint + boot-time module ledger behind `GET /internal/build`.
 *
 * Context: this app is deployed both by CI (fly-deploy.yml on push to main) and
 * by hand from feature-branch checkouts. A `fly deploy` replaces the WHOLE image,
 * so whoever deploys last silently drops the other's features — the delivery-tier
 * classifier has vanished from prod twice with zero errors. `/internal/build`
 * makes that observable: `sha`/`builtAt` say which commit is live, and `modules`
 * reports what actually got WIRED at boot (not merely what the code contains).
 * The deploy-canary workflow polls this endpoint and alerts when `modules.tier`
 * goes falsy.
 */

/** Immutable stamp baked into the image at `docker build` time. */
export interface BuildStamp {
  sha: string;
  builtAt: string;
}

/**
 * Which optional modules actually got wired during boot. `tier` carries the live
 * prompt version (a number) when its runner started, or `false` when it did not —
 * this is the exact signal the external deploy canary watches.
 */
export interface ModuleStatus {
  tier: number | false;
  productExport: boolean;
  reports: boolean;
  devops: boolean;
  flcReview: boolean;
}

export interface BuildInfo extends BuildStamp {
  modules: ModuleStatus;
}

const UNKNOWN_STAMP: BuildStamp = { sha: 'unknown', builtAt: 'unknown' };

/**
 * Read the build stamp the Dockerfile writes to `build-info.json` at the image
 * root. A missing or malformed file — local `tsx` dev, a hand-run container built
 * without the GIT_SHA arg, or tests — degrades gracefully to
 * `{ sha: 'unknown', builtAt: 'unknown' }` instead of throwing: `sha: "unknown"`
 * is still useful because `modules` is the real health signal.
 */
export function loadBuildStamp(explicitPath?: string): BuildStamp {
  const distRelative = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'build-info.json',
  );
  const candidates = (
    explicitPath
      ? [explicitPath]
      : [process.env.BUILD_INFO_PATH, distRelative, path.resolve(process.cwd(), 'build-info.json')]
  ).filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as Partial<BuildStamp>;
      return {
        sha: typeof parsed.sha === 'string' && parsed.sha ? parsed.sha : 'unknown',
        builtAt: typeof parsed.builtAt === 'string' && parsed.builtAt ? parsed.builtAt : 'unknown',
      };
    } catch {
      // File absent or unparseable — try the next candidate, else fall through.
    }
  }
  return { ...UNKNOWN_STAMP };
}

/** Fresh module ledger: everything off except the always-on reports runner. */
export function createModuleStatus(): ModuleStatus {
  return { tier: false, productExport: false, reports: true, devops: false, flcReview: false };
}

/** Assemble the `/internal/build` payload from a stamp + the live module ledger. */
export function renderBuildInfo(stamp: BuildStamp, modules: ModuleStatus): BuildInfo {
  return { sha: stamp.sha, builtAt: stamp.builtAt, modules: { ...modules } };
}

/** Minimal shape of the response object this handler touches (express-compatible). */
export interface BuildInfoResponse {
  status(code: number): { json(body: unknown): unknown };
}

/**
 * Express-compatible handler for `GET /internal/build`. Closes over the live
 * `modules` ledger by reference, so flags flipped later in boot (e.g. `tier` once
 * its runner starts) are reflected on the next request.
 */
export function makeBuildInfoHandler(stamp: BuildStamp, modules: ModuleStatus) {
  return (_req: unknown, res: BuildInfoResponse): void => {
    res.status(200).json(renderBuildInfo(stamp, modules));
  };
}
