import type { GoogleCalendarListEntry } from '@shared/schemas/google-calendar';

/**
 * Builds the canonical summary string for a Danran family Google Calendar.
 */
export function buildFamilyCalendarSummary(familyName: string): string {
  return `Danran（${familyName}）`;
}

/**
 * Builds the canonical description marker for a Danran family Google Calendar.
 * Format: `danran-family:<familyId>;creation:<calendarCreationId>`
 */
export function buildFamilyCalendarDescription(
  familyId: string,
  calendarCreationId: string,
): string {
  return `danran-family:${familyId};creation:${calendarCreationId}`;
}

export interface MatchFamilyCalendarCriteria {
  familyId: string;
  calendarCreationId: string;
  familyName: string;
  ownerEmail: string;
}

/**
 * Pure predicate checking whether a GoogleCalendarListEntry matches the specific family calendar.
 *
 * Matching requirements:
 * 1. summary === `Danran（${familyName}）`
 * 2. description === `danran-family:${familyId};creation:${calendarCreationId}`
 * 3. accessRole === 'owner'
 * 4. primary !== true (not primary calendar)
 * 5. deleted !== true (not marked as deleted)
 * 6. dataOwner if present must match ownerEmail (case-insensitive)
 */
export function matchFamilyCalendar(
  entry: GoogleCalendarListEntry,
  criteria: MatchFamilyCalendarCriteria,
): boolean {
  if (entry.deleted === true) return false;
  if (entry.primary === true) return false;
  if (entry.accessRole !== 'owner') return false;

  const expectedSummary = buildFamilyCalendarSummary(criteria.familyName);
  if (entry.summary !== expectedSummary) return false;

  const expectedDescription = buildFamilyCalendarDescription(
    criteria.familyId,
    criteria.calendarCreationId,
  );
  if (entry.description !== expectedDescription) return false;

  if (entry.dataOwner !== undefined && entry.dataOwner !== null) {
    if (entry.dataOwner.toLowerCase() !== criteria.ownerEmail.toLowerCase()) {
      return false;
    }
  }

  return true;
}
