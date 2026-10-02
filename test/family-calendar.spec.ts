import {
  buildFamilyCalendarDescription,
  buildFamilyCalendarSummary,
  matchFamilyCalendar,
} from '@shared/domain/familyCalendar';
import type { GoogleCalendarListEntry } from '@shared/schemas/google-calendar';
import { describe, expect, it } from 'vitest';

describe('familyCalendar pure domain logic', () => {
  const familyId = 'fam_abc12345';
  const calendarCreationId = 'creat_xyz789';
  const familyName = '池町家';
  const ownerEmail = 'owner@example.com';

  it('builds canonical summary and description', () => {
    expect(buildFamilyCalendarSummary(familyName)).toBe('Danran（池町家）');
    expect(buildFamilyCalendarDescription(familyId, calendarCreationId)).toBe(
      'danran-family:fam_abc12345;creation:creat_xyz789',
    );
  });

  it('matches exact valid family calendar entry', () => {
    const entry: GoogleCalendarListEntry = {
      id: 'cal_target_123',
      summary: 'Danran（池町家）',
      description: 'danran-family:fam_abc12345;creation:creat_xyz789',
      accessRole: 'owner',
      primary: false,
      deleted: false,
      dataOwner: 'OWNER@EXAMPLE.COM',
    };

    expect(
      matchFamilyCalendar(entry, {
        familyId,
        calendarCreationId,
        familyName,
        ownerEmail,
      }),
    ).toBe(true);
  });

  it('matches when optional primary, deleted, and dataOwner fields are omitted', () => {
    const entry: GoogleCalendarListEntry = {
      id: 'cal_minimal_123',
      summary: buildFamilyCalendarSummary(familyName),
      description: buildFamilyCalendarDescription(familyId, calendarCreationId),
      accessRole: 'owner',
    };

    expect(
      matchFamilyCalendar(entry, { familyId, calendarCreationId, familyName, ownerEmail }),
    ).toBe(true);
  });

  it('rejects entry if deleted is true or primary is true', () => {
    const base: GoogleCalendarListEntry = {
      id: 'cal_target_123',
      summary: 'Danran（池町家）',
      description: 'danran-family:fam_abc12345;creation:creat_xyz789',
      accessRole: 'owner',
    };

    expect(
      matchFamilyCalendar(
        { ...base, deleted: true },
        { familyId, calendarCreationId, familyName, ownerEmail },
      ),
    ).toBe(false);

    expect(
      matchFamilyCalendar(
        { ...base, primary: true },
        { familyId, calendarCreationId, familyName, ownerEmail },
      ),
    ).toBe(false);
  });

  it('rejects entry if accessRole is not owner', () => {
    const entry: GoogleCalendarListEntry = {
      id: 'cal_target_123',
      summary: 'Danran（池町家）',
      description: 'danran-family:fam_abc12345;creation:creat_xyz789',
      accessRole: 'writer',
    };

    expect(
      matchFamilyCalendar(entry, {
        familyId,
        calendarCreationId,
        familyName,
        ownerEmail,
      }),
    ).toBe(false);
  });

  it('rejects entry if summary or description does not match', () => {
    const base: GoogleCalendarListEntry = {
      id: 'cal_target_123',
      summary: 'Danran（池町家）',
      description: 'danran-family:fam_abc12345;creation:creat_xyz789',
      accessRole: 'owner',
    };

    expect(
      matchFamilyCalendar(
        { ...base, summary: 'Danran (池町家)' }, // half-width parentheses
        { familyId, calendarCreationId, familyName, ownerEmail },
      ),
    ).toBe(false);

    expect(
      matchFamilyCalendar(
        { ...base, description: 'danran-family:fam_other;creation:creat_xyz789' },
        { familyId, calendarCreationId, familyName, ownerEmail },
      ),
    ).toBe(false);

    expect(
      matchFamilyCalendar(
        { ...base, description: 'danran-family:fam_abc12345;creation:different_token' },
        { familyId, calendarCreationId, familyName, ownerEmail },
      ),
    ).toBe(false);
  });

  it('rejects entry if dataOwner does not match owner email', () => {
    const entry: GoogleCalendarListEntry = {
      id: 'cal_target_123',
      summary: 'Danran（池町家）',
      description: 'danran-family:fam_abc12345;creation:creat_xyz789',
      accessRole: 'owner',
      dataOwner: 'someone_else@example.com',
    };

    expect(
      matchFamilyCalendar(entry, {
        familyId,
        calendarCreationId,
        familyName,
        ownerEmail,
      }),
    ).toBe(false);
  });
});
