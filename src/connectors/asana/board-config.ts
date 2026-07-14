/**
 * Domain constants for the Gantri Asana "Software Board", validated against the
 * live board on 2026-07-13. These gids are stable identifiers Asana assigns to
 * the workspace, project, custom field, enum option, and board sections. If the
 * team renames a section the NAME changes but the gid does not — however the
 * story-analyzer parses section transitions from story TEXT (which uses section
 * names, not gids), so the name constants below are the ones the parser relies
 * on. The gids are kept for API filtering (Type=Feature) and documentation.
 */

/** Raw Asana REST API base. The RAW API supports offset pagination via
 *  `next_page.offset` (unlike some MCP wrappers that only expose a single page). */
export const ASANA_API_BASE = 'https://app.asana.com/api/1.0';

/** Gantri workspace. */
export const WORKSPACE_GID = '1186582822873190';

/** The "Software Board" project — the engineering board every dev ticket lives on. */
export const SOFTWARE_BOARD_PROJECT_GID = '1210754051061529';

/** Human name of the board, as it appears in section-move story text
 *  ('... in Software Board'). Used to ignore moves that happened in OTHER
 *  projects a task may also belong to. */
export const BOARD_NAME = 'Software Board';

/** Custom field "Type" and its "Feature" enum option. A task is a Feature iff
 *  its Type custom field's `enum_value.gid` equals FEATURE. */
export const TYPE_FIELD_GID = '1211288498996171';
export const TYPE_FEATURE_OPTION_GID = '1211288498996175';

/** Type enum options the weekly delivery-tier report treats as QA escapes — a
 *  defect that reached production and got a dedicated ticket. Used to recommend
 *  moving a domain UP a tier. */
export const TYPE_QA_ESCAPE_OPTION_GID = '1216003613864064';
export const TYPE_ESCAPES_OPTION_GID = '1216455780657179';

/** Type option names excluded from delivery-tier auto-classification. Everything
 *  else classifies (infra/backend work lands T0 naturally via `ui_testable=no`).
 *  Matched case-insensitively against the Type enum option's display name. */
export const TIER_EXCLUDED_TYPE_NAMES: readonly string[] = ['Not a Bug', 'Qa Work', 'Research'];

/** Custom field "Delivery Tier" and its three enum options (T0/T1/T2). The
 *  delivery-tier auto-classifier writes one of these option gids to the field.
 *  Validated against the live board on 2026-07-14. */
export const DELIVERY_TIER_FIELD_GID = '1216565279651993';
export const DELIVERY_TIER_OPTION_GIDS = {
  T0: '1216565279651994',
  T1: '1216565279651995',
  T2: '1216565279651996',
} as const;

export type DeliveryTier = keyof typeof DELIVERY_TIER_OPTION_GIDS;

/** Map a tier label to its Asana enum option gid. */
export function tierToOptionGid(tier: DeliveryTier): string {
  return DELIVERY_TIER_OPTION_GIDS[tier];
}

/** Map an Asana enum option gid back to a tier label, or null if it is not one
 *  of the three Delivery Tier options (e.g. an option the bot never sets). */
export function optionGidToTier(optionGid: string | null | undefined): DeliveryTier | null {
  if (!optionGid) return null;
  for (const [tier, gid] of Object.entries(DELIVERY_TIER_OPTION_GIDS) as [DeliveryTier, string][]) {
    if (gid === optionGid) return tier;
  }
  return null;
}

/** Ordering of the three tiers, low → high. Used by the PR re-check to decide
 *  whether a diff-derived tier is strictly higher than the current one (raise). */
export const TIER_RANK: Record<DeliveryTier, number> = { T0: 0, T1: 1, T2: 2 };

/** True when tier `a` is strictly higher than tier `b` (T2 > T1 > T0). */
export function isHigherTier(a: DeliveryTier, b: DeliveryTier): boolean {
  return TIER_RANK[a] > TIER_RANK[b];
}

/** True when a Type option display name is excluded from tier classification. */
export function isTierExcludedType(typeName: string | null | undefined): boolean {
  if (!typeName) return false;
  const n = typeName.trim().toLowerCase();
  return TIER_EXCLUDED_TYPE_NAMES.some((t) => t.toLowerCase() === n);
}

/** Asana's "new feature" template task. It is a Type=Feature artifact that lives
 *  on the board and records phantom QA section moves whenever the template is
 *  edited, which would otherwise pollute the QA-stats denominator. Excluded from
 *  the analysis entirely by exact (trimmed) name match. */
export const FEATURE_TEMPLATE_TASK_NAME = 'Feature template';

/** True when a task is the Asana "Feature template" artifact (exact trimmed name
 *  match) and must be excluded from the analysis. */
export function isFeatureTemplateTask(task: { name?: string }): boolean {
  return (task.name ?? '').trim() === FEATURE_TEMPLATE_TASK_NAME;
}

/** Software Board section names → gids. The parser keys off names (story text),
 *  but the gids document the exact sections this logic was built against. */
export const SECTION_GIDS = {
  Backlog: '1210754051061530',
  'In Progress': '1210754051061532',
  Blocked: '1210754051061534',
  Rework: '1210754051061533',
  'Code Review': '1210754051061535',
  'QA Review': '1210754051061536',
  'Post Release QA': '1215600103829145',
  'Stakeholder Review': '1210950900735466',
  'Ready To Deploy': '1210756193945761',
  Done: '1210754051061538',
} as const;

export type SectionName = keyof typeof SECTION_GIDS;

/** The two sections that represent an active QA stage. A section move whose
 *  `from` OR `to` is one of these is a "QA-stage event". */
export const QA_STAGE_SECTIONS: readonly string[] = ['QA Review', 'Post Release QA'];

/** Backward destinations that constitute a bounce OUT of a QA stage — QA (or a
 *  dev) kicked the ticket back to be reworked / re-reviewed. */
export const BOUNCE_TARGET_SECTIONS: readonly string[] = [
  'Rework',
  'Code Review',
  'In Progress',
  'Blocked',
  'Backlog',
];

/** Terminal sections a completed feature sits in. A move OUT of one of these
 *  back into a review section is a "reopen" (a late QA/stakeholder catch). */
export const REOPEN_FROM_SECTIONS: readonly string[] = ['Done', 'Ready To Deploy'];

/** Review sections a reopen lands in. */
export const REOPEN_TO_SECTIONS: readonly string[] = [
  'QA Review',
  'Post Release QA',
  'Code Review',
  'Stakeholder Review',
  'Rework',
];

/** The QA team. Everyone else who bounces a ticket is a developer / other. */
export interface QaReviewer {
  name: string;
  shortName: string;
}
export const QA_REVIEWERS: readonly QaReviewer[] = [
  { name: 'Matthew Fite', shortName: 'Matt' },
  { name: 'Joshua Nie', shortName: 'Josh' },
];

/** True when a story author is a member of the QA team. */
export function isQaReviewer(name: string | undefined | null): boolean {
  if (!name) return false;
  return QA_REVIEWERS.some((r) => r.name === name);
}

/** Display short name: 'Matt' / 'Josh' for QA, first name otherwise. */
export function shortNameFor(name: string): string {
  const qa = QA_REVIEWERS.find((r) => r.name === name);
  if (qa) return qa.shortName;
  return name.trim().split(/\s+/)[0] ?? name;
}
