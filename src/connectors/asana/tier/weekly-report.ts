import type { WebClient } from '@slack/web-api';
import type { AsanaApiClient } from '../client.js';
import type {
  TierClassificationsRepo,
  TierClassificationRecord,
} from '../../../storage/repositories/tier-classifications.js';
import type { TierWeeklyReportsRepo } from '../../../storage/repositories/tier-weekly-reports.js';
import {
  SOFTWARE_BOARD_PROJECT_GID,
  TYPE_FIELD_GID,
  TYPE_QA_ESCAPE_OPTION_GID,
  TYPE_ESCAPES_OPTION_GID,
} from '../board-config.js';
import { logger } from '../../../logger.js';

/**
 * Monday delivery-tier report. Deterministic aggregation over
 * `tier_classifications` + a light Asana read for escapes; the output is a
 * template, no LLM. It runs from the poller tick: once now ≥ Monday 09:00
 * America/New_York and there is no `tier_weekly_reports` row for the week, it
 * computes the report, DMs Danny, and inserts the row (idempotent).
 *
 * Every section is a RECOMMENDATION — nothing auto-moves. Danny edits fields by
 * hand.
 */

const REPORT_TZ = 'America/New_York';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/** A domain's inconclusive rate above this fraction is flagged as "needs sharpening". */
const INCONCLUSIVE_FLAG_THRESHOLD = 0.3;
/** Minimum completed T2 tickets with zero escapes before recommending a move down. */
const MOVE_DOWN_MIN_T2 = 3;
/** Rough tokens per classification, for the volume/cost line. */
const APPROX_TOKENS_PER_CLASSIFICATION = 4300;

interface NyParts {
  y: number;
  m: number;
  d: number;
  hour: number;
  /** Monday = 0 … Sunday = 6. */
  weekdayIdx: number;
}

const WEEKDAY_IDX: Record<string, number> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

function nyParts(d: Date): NyParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    // Intl renders midnight as "24" in some runtimes; normalize to 0.
    hour: Number(parts.hour) % 24,
    weekdayIdx: WEEKDAY_IDX[parts.weekday] ?? 0,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** The Monday (00:00 NY) of the week containing `now`, as `YYYY-MM-DD`. */
export function nyWeekStart(now: Date): string {
  const p = nyParts(now);
  // Anchor at NY noon to stay clear of DST edges, then step back to Monday.
  const base = Date.UTC(p.y, p.m - 1, p.d, 12);
  const monday = new Date(base - p.weekdayIdx * 24 * 60 * 60 * 1000);
  return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
}

/** True once the current NY week's Monday 09:00 has passed. */
export function isAfterMonday9am(now: Date): boolean {
  const p = nyParts(now);
  if (p.weekdayIdx === 0 && p.hour < 9) return false; // Monday before 9am
  return true;
}

// --- Report computation (pure) ---------------------------------------------

export interface EscapeTask {
  gid: string;
  domain: string;
}

export interface WeeklyReportInputs {
  /** All classifications created in the last 30 days. */
  classificationsLast30d: TierClassificationRecord[];
  /** Escape-typed Software Board tasks in the last 30 days, mapped to a domain. */
  escapeTasksLast30d: EscapeTask[];
  /** Human-override rows from the last 7 days. */
  overridesLast7d: TierClassificationRecord[];
}

export interface MoveUpRec {
  domain: string;
  escapes: number;
  ticketsBelowT2: number;
}
export interface MoveDownRec {
  domain: string;
  from: 'T2' | 'T1';
  to: 'T1' | 'T0';
  cleanTickets: number;
}
export interface DisagreementRec {
  taskGid: string;
  botTier: string;
  humanTier: string | null;
}
export interface InconclusiveRec {
  domain: string;
  ratePct: number;
  lifted: number;
  total: number;
}

export interface WeeklyReportPayload {
  weekStart: string;
  moveUp: MoveUpRec[];
  moveDown: MoveDownRec[];
  disagreements: DisagreementRec[];
  inconclusive: InconclusiveRec[];
  volume: { classified7d: number; approxTokens: number };
}

function domainOf(rec: TierClassificationRecord): string {
  return rec.domain ?? 'unknown';
}

/**
 * Compute the report payload from already-gathered inputs. Pure and deterministic
 * so it can be tested against seeded fixtures.
 */
export function computeWeeklyReport(inputs: WeeklyReportInputs, now: Date): WeeklyReportPayload {
  const weekStart = nyWeekStart(now);
  const nowMs = now.getTime();
  const cutoff7d = new Date(nowMs - SEVEN_DAYS_MS).getTime();

  // 1. Move up: domains with an escape in the last 30d whose recent tickets
  //    classified below T2.
  const escapesByDomain = new Map<string, number>();
  for (const e of inputs.escapeTasksLast30d) {
    escapesByDomain.set(e.domain, (escapesByDomain.get(e.domain) ?? 0) + 1);
  }
  const moveUp: MoveUpRec[] = [];
  for (const [domain, escapes] of escapesByDomain) {
    const ticketsBelowT2 = inputs.classificationsLast30d.filter(
      (c) => domainOf(c) === domain && c.decidedBy === 'bot' && c.tier !== 'T2',
    ).length;
    if (ticketsBelowT2 > 0) moveUp.push({ domain, escapes, ticketsBelowT2 });
  }
  moveUp.sort((a, b) => b.escapes - a.escapes || a.domain.localeCompare(b.domain));

  // 2. Move down: domains with ≥ MOVE_DOWN_MIN_T2 T2 tickets in 30d and zero
  //    escape-typed tasks → recommend T2→T1. Same shape for T1→T0.
  const moveDown: MoveDownRec[] = [];
  const byDomain = new Map<string, TierClassificationRecord[]>();
  for (const c of inputs.classificationsLast30d) {
    if (c.decidedBy !== 'bot') continue;
    const list = byDomain.get(domainOf(c)) ?? [];
    list.push(c);
    byDomain.set(domainOf(c), list);
  }
  for (const [domain, recs] of byDomain) {
    if ((escapesByDomain.get(domain) ?? 0) > 0) continue; // an escape here → never move down
    const t2 = recs.filter((r) => r.tier === 'T2').length;
    const t1 = recs.filter((r) => r.tier === 'T1').length;
    if (t2 >= MOVE_DOWN_MIN_T2) {
      moveDown.push({ domain, from: 'T2', to: 'T1', cleanTickets: t2 });
    } else if (t1 >= MOVE_DOWN_MIN_T2) {
      moveDown.push({ domain, from: 'T1', to: 'T0', cleanTickets: t1 });
    }
  }
  moveDown.sort((a, b) => b.cleanTickets - a.cleanTickets || a.domain.localeCompare(b.domain));

  // 3. Disagreements: human overrides in the last 7d.
  const disagreements: DisagreementRec[] = inputs.overridesLast7d
    .map((o) => ({ taskGid: o.taskGid, botTier: o.tier, humanTier: o.humanTier }))
    .sort((a, b) => a.taskGid.localeCompare(b.taskGid));

  // 4. Inconclusive rate per domain over 7d; flag domains above the threshold.
  const inconclusive: InconclusiveRec[] = [];
  const sevenDay = inputs.classificationsLast30d.filter(
    (c) => c.decidedBy === 'bot' && c.createdAt !== null && Date.parse(c.createdAt) >= cutoff7d,
  );
  const domain7d = new Map<string, TierClassificationRecord[]>();
  for (const c of sevenDay) {
    const list = domain7d.get(domainOf(c)) ?? [];
    list.push(c);
    domain7d.set(domainOf(c), list);
  }
  for (const [domain, recs] of domain7d) {
    const lifted = recs.filter((r) => r.liftedByUnclear).length;
    const ratio = lifted / recs.length;
    if (ratio > INCONCLUSIVE_FLAG_THRESHOLD) {
      inconclusive.push({
        domain,
        ratePct: Math.round(ratio * 1000) / 10,
        lifted,
        total: recs.length,
      });
    }
  }
  inconclusive.sort((a, b) => b.ratePct - a.ratePct || a.domain.localeCompare(b.domain));

  return {
    weekStart,
    moveUp,
    moveDown,
    disagreements,
    inconclusive,
    volume: {
      classified7d: sevenDay.length,
      approxTokens: sevenDay.length * APPROX_TOKENS_PER_CLASSIFICATION,
    },
  };
}

/** Render the payload to a Slack message body. Deterministic, no LLM. */
export function renderWeeklyReport(payload: WeeklyReportPayload): string {
  const lines: string[] = [];
  lines.push(`🤖 *Delivery Tier — weekly report* (week of ${payload.weekStart})`);
  lines.push('These are recommendations only; nothing auto-moves.');
  lines.push('');

  lines.push('*1. Move up* (escape in the last 30d, recent tickets below T2)');
  if (payload.moveUp.length === 0) {
    lines.push('• none');
  } else {
    for (const r of payload.moveUp) {
      lines.push(`• ${r.domain}: ${r.escapes} escape(s), ${r.ticketsBelowT2} recent ticket(s) below T2`);
    }
  }
  lines.push('');

  lines.push('*2. Move down* (≥3 clean tickets in 30d, zero escapes)');
  if (payload.moveDown.length === 0) {
    lines.push('• none');
  } else {
    for (const r of payload.moveDown) {
      lines.push(`• ${r.domain}: ${r.from}→${r.to} (${r.cleanTickets} clean ${r.from} ticket(s))`);
    }
  }
  lines.push('');

  lines.push('*3. Disagreements* (human overrides in the last 7d)');
  if (payload.disagreements.length === 0) {
    lines.push('• none');
  } else {
    for (const r of payload.disagreements) {
      lines.push(`• task ${r.taskGid}: bot ${r.botTier} → human ${r.humanTier ?? 'cleared'}`);
    }
  }
  lines.push('');

  lines.push('*4. Inconclusive rate* (domains > 30% lifted-by-unclear over 7d)');
  if (payload.inconclusive.length === 0) {
    lines.push('• none — rubric is resolving cleanly');
  } else {
    for (const r of payload.inconclusive) {
      lines.push(`• ${r.domain}: ${r.ratePct}% (${r.lifted}/${r.total}) — rubric needs sharpening here`);
    }
  }
  lines.push('');

  lines.push(
    `*5. Volume* — ${payload.volume.classified7d} ticket(s) classified this week, ≈${payload.volume.approxTokens.toLocaleString('en-US')} tokens.`,
  );
  return lines.join('\n');
}

// --- Orchestration (I/O) ----------------------------------------------------

const OPT_FIELDS_ESCAPE = [
  'created_at',
  'custom_fields.gid',
  'custom_fields.enum_value.gid',
].join(',');

export interface WeeklyReporterDeps {
  classifications: TierClassificationsRepo;
  weeklyRepo: TierWeeklyReportsRepo;
  client: AsanaApiClient;
  slack: WebClient;
  /** Resolve Danny's Slack user id (authorized_users row / env override). */
  resolveDannySlackId: () => Promise<string | null>;
  /** Fallback channel when the DM cannot be opened. */
  opsChannelId?: string;
  now?: () => Date;
}

/** Read escape-typed Software Board tasks created in the last 30d and map each to
 *  a domain via its own classification (unknown when not classified). */
async function fetchEscapeTasks(
  deps: WeeklyReporterDeps,
  nowMs: number,
): Promise<EscapeTask[]> {
  const cutoff = nowMs - THIRTY_DAYS_MS;
  const tasks = await deps.client.getProjectTasks(SOFTWARE_BOARD_PROJECT_GID, OPT_FIELDS_ESCAPE);
  const escapeOptions = new Set([TYPE_QA_ESCAPE_OPTION_GID, TYPE_ESCAPES_OPTION_GID]);
  const escapes: EscapeTask[] = [];
  for (const t of tasks) {
    const createdMs = t.created_at ? Date.parse(t.created_at) : 0;
    if (createdMs < cutoff) continue;
    const type = (t.custom_fields ?? []).find((f) => f.gid === TYPE_FIELD_GID);
    const optGid = type?.enum_value?.gid;
    if (!optGid || !escapeOptions.has(optGid)) continue;
    const cls = await deps.classifications.get(t.gid);
    escapes.push({ gid: t.gid, domain: cls?.domain ?? 'unknown' });
  }
  return escapes;
}

export class WeeklyTierReporter {
  constructor(private readonly deps: WeeklyReporterDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Send the Monday report if due and not already sent this week. */
  async maybeSend(): Promise<{ sent: boolean; reason?: string; weekStart: string }> {
    const now = this.now();
    const weekStart = nyWeekStart(now);
    if (!isAfterMonday9am(now)) return { sent: false, reason: 'before_monday_9am', weekStart };

    const existing = await this.deps.weeklyRepo.get(weekStart);
    if (existing) return { sent: false, reason: 'already_sent', weekStart };

    const nowMs = now.getTime();
    const [classificationsLast30d, overridesLast7d, escapeTasksLast30d] = await Promise.all([
      this.deps.classifications.listSince(new Date(nowMs - THIRTY_DAYS_MS).toISOString()),
      this.deps.classifications.listOverridesSince(new Date(nowMs - SEVEN_DAYS_MS).toISOString()),
      fetchEscapeTasks(this.deps, nowMs),
    ]);

    const payload = computeWeeklyReport(
      { classificationsLast30d, overridesLast7d, escapeTasksLast30d },
      now,
    );
    const text = renderWeeklyReport(payload);

    await this.deliver(text);
    await this.deps.weeklyRepo.insert(weekStart, payload);
    logger.info({ weekStart }, 'delivery_tier_weekly_report_sent');
    return { sent: true, weekStart };
  }

  /** DM Danny; fall back to the ops channel if the DM cannot be resolved. */
  private async deliver(text: string): Promise<void> {
    const dannyId = await this.deps.resolveDannySlackId();
    if (dannyId) {
      try {
        const dm = await this.deps.slack.conversations.open({ users: dannyId });
        const channel = dm.ok ? dm.channel?.id : null;
        if (channel) {
          await this.deps.slack.chat.postMessage({ channel, text });
          return;
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'delivery_tier_report_dm_failed');
      }
    }
    if (this.deps.opsChannelId) {
      await this.deps.slack.chat.postMessage({ channel: this.deps.opsChannelId, text });
      return;
    }
    logger.error('delivery_tier_report_undeliverable: no Danny DM and no ops channel');
  }
}
