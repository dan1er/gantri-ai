import { describe, it, expect } from 'vitest';
import { pipedriveWebUrl } from '../../../../src/connectors/pipedrive/client.js';

describe('pipedriveWebUrl', () => {
  it('lead URL uses /leads/inbox/<uuid>', () => {
    expect(pipedriveWebUrl('lead', '550e8400-e29b-41d4-a716-446655440000'))
      .toBe('https://gantri.pipedrive.com/leads/inbox/550e8400-e29b-41d4-a716-446655440000');
  });

  it('person URL uses /person/<id>', () => {
    expect(pipedriveWebUrl('person', 2841)).toBe('https://gantri.pipedrive.com/person/2841');
  });

  it('organization URL uses /organization/<id>', () => {
    expect(pipedriveWebUrl('organization', 2245)).toBe('https://gantri.pipedrive.com/organization/2245');
  });

  it('deal URL uses /deal/<id>', () => {
    expect(pipedriveWebUrl('deal', 816)).toBe('https://gantri.pipedrive.com/deal/816');
  });

  it('activity URL uses /activities/list?activity=<id>', () => {
    expect(pipedriveWebUrl('activity', 8801)).toBe('https://gantri.pipedrive.com/activities/list?activity=8801');
  });
});
