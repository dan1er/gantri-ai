import { describe, it, expect } from 'vitest';
import {
  hasTickedBox,
  hasWrittenContent,
  isTemplateLine,
  normalizeLine,
} from '../../../../../src/connectors/asana/rca/rca-template.js';
import { isRcaFilledIn } from '../../../../../src/connectors/asana/rca/rca-digest.js';

/**
 * The Engineering Escape RCA body exactly as Asana creates it, captured from
 * task 1216958534002724 on 2026-07-28. Every assertion below is about telling
 * THIS — a pristine template — apart from one somebody actually worked.
 */
const PRISTINE_ENGINEERING = `Purpose
Identify why the defect was introduced and what engineering changes can prevent similar issues.

Root cause
What caused the defect?
Describe the technical or implementation-level cause.

Affected area/component:
Service, feature, workflow, integration, data, or infrastructure affected.

Originating ticket:
Link the original Asana ticket associated with the change that introduced the defect.

When was it introduced?
Link the PR, deployment, or change that introduced it.

Contributing factors — Select all that apply:
    [ ] Missing or incorrect requirements
    [ ] Incorrect implementation
    [ ] Missing validation or error handling
    [ ] Unexpected data or state
    [ ] Integration or dependency behavior
    [ ] Environment or configuration difference
    [ ] Insufficient code review
    [ ] Missing or ineffective automated tests
    [ ] Existing technical debt
    [ ] Monitoring or alerting gap
    [ ] Other

Details:
Explain the relevant contributing factors.

Could an automated test have caught this? — Select one:
    [ ] Unit test
    [ ] Integration or API test
    [ ] End-to-end test
    [ ] No — explain why

Preventive action:
Describe the code, test, monitoring, documentation, or process improvement.

Owner:`;

describe('normalizeLine', () => {
  it('ignores indentation, case, and trailing punctuation', () => {
    expect(normalizeLine('    Affected area/component:  ')).toBe('affected area/component');
    expect(normalizeLine('OWNER:')).toBe('owner');
  });
});

describe('isTemplateLine', () => {
  it('recognises every line of the pristine template as boilerplate', () => {
    const human = PRISTINE_ENGINEERING.split('\n').filter(
      (l) => l.trim() !== '' && !isTemplateLine(l),
    );
    expect(human).toEqual([]);
  });

  it('does not recognise an actual analysis', () => {
    expect(isTemplateLine('The modal grouped unassigned units under the pre-order heading.')).toBe(false);
  });
});

describe('hasTickedBox', () => {
  it('is false for the pristine template', () => {
    expect(hasTickedBox(PRISTINE_ENGINEERING)).toBe(false);
  });

  it('accepts every marker the team actually uses', () => {
    for (const mark of ['x', 'X', '+', '✓', 'v']) {
      expect(hasTickedBox(`    [${mark}] Incorrect implementation`)).toBe(true);
    }
  });

  it('accepts parenthesised boxes too', () => {
    expect(hasTickedBox('(X) Missing test coverage')).toBe(true);
  });

  it('survives a total rewording of the template', () => {
    // The drift-proof half: the option text is unrecognisable, the tick is not.
    expect(hasTickedBox('[x] Some brand new option nobody has seen before')).toBe(true);
  });
});

describe('hasWrittenContent', () => {
  it('is false for the pristine template', () => {
    expect(hasWrittenContent(PRISTINE_ENGINEERING)).toBe(false);
  });

  it('is false when the only novelty is a bare label', () => {
    // The exact drift that produced a false "filled in" during validation: a
    // heading present in the live template but missing from the capture.
    expect(hasWrittenContent(`${PRISTINE_ENGINEERING}\n\nTarget date:`)).toBe(false);
    expect(hasWrittenContent(`${PRISTINE_ENGINEERING}\n\nSome New Heading:`)).toBe(false);
  });

  it('is true once someone answers a label', () => {
    expect(hasWrittenContent(`${PRISTINE_ENGINEERING}\nOwner: Danny`)).toBe(true);
  });

  it('is true for a written analysis', () => {
    expect(
      hasWrittenContent('The modal grouped unassigned units under the pre-order heading.'),
    ).toBe(true);
  });
});

describe('isRcaFilledIn', () => {
  it('treats a pristine template as NOT filled in, however long it is', () => {
    expect(PRISTINE_ENGINEERING.length).toBeGreaterThan(1200);
    expect(isRcaFilledIn({ name: 'Engineering Escape RCA', notes: PRISTINE_ENGINEERING })).toBe(false);
  });

  it('accepts a ticked box as the analysis being started', () => {
    const worked = PRISTINE_ENGINEERING.replace('[ ] Incorrect implementation', '[x] Incorrect implementation');
    expect(isRcaFilledIn({ notes: worked })).toBe(true);
  });

  it('accepts prose typed into the template blanks', () => {
    const worked = `${PRISTINE_ENGINEERING}\nThe shipment record was missing at read time.`;
    expect(isRcaFilledIn({ notes: worked })).toBe(true);
  });

  it('accepts the legacy free-form subtask with any real text', () => {
    expect(isRcaFilledIn({ name: 'Root Cause', notes: 'Every frontend surface derived dates from Shipment records.' })).toBe(true);
  });

  it('accepts an attachment-only RCA ("See PDF below")', () => {
    expect(isRcaFilledIn({ notes: '', attachments: [{ gid: '1' }] })).toBe(true);
  });

  it('accepts the analysis written as a comment', () => {
    expect(isRcaFilledIn({ notes: '', hasComment: true })).toBe(true);
  });

  it('still honours the Asana completion checkbox', () => {
    expect(isRcaFilledIn({ completed: true, notes: PRISTINE_ENGINEERING })).toBe(true);
  });

  it('is false for a subtask nobody has touched at all', () => {
    expect(isRcaFilledIn({ name: 'QA Escape RCA', notes: '', attachments: [] })).toBe(false);
  });
});
