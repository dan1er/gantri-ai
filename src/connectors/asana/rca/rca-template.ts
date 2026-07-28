/**
 * The boilerplate of the RCA subtask templates, captured from the live board on
 * 2026-07-28.
 *
 * Why this file exists: the `Engineering Escape RCA` / `QA Escape RCA` subtasks
 * arrive pre-filled with ~1,300–1,900 characters of scaffolding — headings,
 * instruction sentences, and a list of `[ ]` options. So "has a description" says
 * nothing about whether anyone wrote an analysis, and "has prose" is worse: the
 * instructions themselves are prose ("Describe the technical or
 * implementation-level cause."). The only way to tell a filled-in RCA from a
 * pristine one is to know what pristine looks like.
 *
 * Asana's own template API does NOT expose this — `GET /task_templates/<gid>`
 * for the Bug Template returns `subtasks: []`. Hence a captured copy.
 *
 * DRIFT IS SAFE BY DESIGN. If the team edits the template, its new lines are not
 * in this set, so they read as human-written and the RCA counts as filled in. The
 * bot under-reports rather than nagging someone who did the work — the right
 * direction to fail. Refresh this list when the template changes.
 */

/** Every line the two templates ship with, plus the shared headings. Compared
 *  after `normalizeLine` (trimmed, lowercased, whitespace-collapsed, trailing
 *  punctuation dropped), so indentation and casing tweaks do not break it. */
const TEMPLATE_LINES: readonly string[] = [
  // Shared scaffolding
  'purpose',
  'identify why the defect was introduced and what engineering changes can prevent similar issues',
  'identify why the defect reached production and what qa changes can prevent similar issues',
  'root cause',
  'what caused the defect?',
  'describe the technical or implementation-level cause',
  'why did the defect reach production?',
  'describe why the defect was not identified during qa testing before release',
  'affected area/component',
  'service, feature, workflow, integration, data, or infrastructure affected',
  'originating ticket',
  'link the original asana ticket associated with the change that introduced the defect',
  'when was it introduced?',
  'link the pr, deployment, or change that introduced it',
  'deployment, or change that introduced the defect',
  'contributing factors — select all that apply',
  'details',
  'explain the relevant contributing factors',
  'explain the relevant contributing factors and why the defect was not detected before reaching production',
  'preventive action',
  'target date',
  'describe the code, test, monitoring, documentation, or process improvement',
  'describe how qa test cases, test coverage, testing practices, or release validation will be improved to prevent similar defects from reaching production',
  'owner',

  // Engineering: contributing factors + automation question
  'missing or incorrect requirements',
  'incorrect implementation',
  'missing validation or error handling',
  'unexpected data or state',
  'integration or dependency behavior',
  'environment or configuration difference',
  'insufficient code review',
  'missing or ineffective automated tests',
  'existing technical debt',
  'monitoring or alerting gap',
  'other',
  'could an automated test have caught this? — select one',
  'unit test',
  'integration or api test',
  'end-to-end test',
  'no — explain why',

  // QA: contributing factors + TestRail / automation / test-case questions
  'missing or unclear requirements',
  'missing or incomplete acceptance criteria',
  'missing test coverage',
  'existing test case did not cover the scenario',
  'existing test case was incorrect or outdated',
  'test case was not executed',
  'unexpected data or application state',
  'test environment limitation',
  'insufficient regression testing',
  'insufficient exploratory testing',
  'production-only behavior',
  'communication or handoff gap',
  'was this scenario covered in testrail? — select one',
  'yes — the test case did not identify the defect',
  'yes — but the test case was not executed',
  'no — the scenario was not covered',
  'not applicable',
  'could qa automation have caught this defect? — select one',
  'visual regression test',
  'other automated test',
  'were test cases added or updated as part of this ticket? — select one',
  'yes',
  'no — explain why',
];

/** A checklist line: `[ ] Option`, `[x] Option`, `(X) Option`, `[+] Option`.
 *  Group 1 is whatever sits between the brackets. */
export const CHECKBOX_LINE_RE = /^\s*[[(]\s*(.{0,3}?)\s*[\])]\s*(.*)$/;

/** Normalize a line for comparison against the captured template: lowercase,
 *  collapse whitespace, drop trailing punctuation and the various dash forms. */
export function normalizeLine(line: string): string {
  return line
    // Asana rich text emits non-breaking spaces and both dash widths; written
    // as escapes so the literals do not sit invisibly in the source.
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2013\u2014]/g, '\u2014')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.:;,]+$/, '')
    .trim();
}

const TEMPLATE_LINE_SET = new Set(TEMPLATE_LINES.map(normalizeLine));

/** True when a line is part of the shipped template rather than something a
 *  human wrote. Checklist lines are matched on their LABEL, so `[ ] Unit test`
 *  and `Unit test` both count as boilerplate — the tick itself is evaluated
 *  separately by `hasTickedBox`. */
export function isTemplateLine(line: string): boolean {
  const box = CHECKBOX_LINE_RE.exec(line);
  const text = normalizeLine(box ? box[2] : line);
  if (text === '') return true; // blank / bare checkbox — no content either way
  return TEMPLATE_LINE_SET.has(text);
}

/**
 * True when any checklist box has been marked. The template ships every box
 * blank, so a single `[x]` / `[X]` / `[+]` / `[✓]` is proof someone worked the
 * RCA — this is the drift-proof half of the check: it keeps working even when
 * the template's wording changes completely.
 */
export function hasTickedBox(notes: string): boolean {
  for (const line of notes.split('\n')) {
    const m = CHECKBOX_LINE_RE.exec(line);
    if (!m) continue;
    // Anything non-blank between the brackets counts as a tick. The team uses
    // x / X / + interchangeably, and nobody agrees on a convention.
    if (m[1].trim().length > 0) return true;
  }
  return false;
}

/**
 * A line that is only a label — `Owner:`, `Target date:` — with nothing after the
 * colon. Scaffolding, whether or not it is in the captured template.
 *
 * This guard is what makes template drift genuinely safe rather than merely
 * documented as safe: a single heading added to the template and missing from
 * the capture would otherwise read as human-written and silently clear a
 * pristine RCA. That happened in validation — one stray `Target date:` cleared
 * two untouched Escape RCAs.
 */
function isEmptyLabel(line: string): boolean {
  const t = line.trim();
  return t.length <= 60 && /^[^:]+:$/.test(t);
}

/**
 * True when the notes contain at least one line that is neither template
 * boilerplate, nor a bare checklist entry, nor an empty label — i.e. somebody
 * typed an actual answer. This is what catches an RCA written as prose into the
 * template's blanks without any box being ticked.
 */
export function hasWrittenContent(notes: string): boolean {
  return notes
    .split('\n')
    .some((line) => line.trim() !== '' && !isTemplateLine(line) && !isEmptyLabel(line));
}
