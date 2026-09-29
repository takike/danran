import type { DateKey } from '@shared/schemas/date';
import { describe, expect, it } from 'vitest';
import { type DayLayoutEventInput, getDayLayout } from './dayLayout';

describe('src/shared/domain/dayLayout', () => {
  describe('weekend-card classification', () => {
    it('classifies Saturdays and Sundays as weekend-card', () => {
      // 2026-10-10 is Saturday, 2026-10-11 is Sunday
      expect(getDayLayout({ date: '2026-10-10' as DateKey })).toBe('weekend-card');
      expect(getDayLayout({ date: '2026-10-11' as DateKey })).toBe('weekend-card');
    });

    it('classifies Japanese national holidays as weekend-card', () => {
      // 2026-10-12 is Sports Day (Monday)
      expect(getDayLayout({ date: '2026-10-12' as DateKey })).toBe('weekend-card');
      // 2027-03-22 is Spring Equinox Substitute Holiday (Monday)
      expect(getDayLayout({ date: '2027-03-22' as DateKey })).toBe('weekend-card');
      // 2026-05-06 is Children's Day Substitute Holiday (Wednesday)
      expect(getDayLayout({ date: '2026-05-06' as DateKey })).toBe('weekend-card');
    });

    it('classifies closure days as weekend-card', () => {
      // Ordinary Tuesday with isClosure flag
      expect(
        getDayLayout({
          date: '2026-10-06' as DateKey,
          isClosure: true,
        }),
      ).toBe('weekend-card');

      // Ordinary Wednesday matching closureDates array
      expect(
        getDayLayout({
          date: '2026-10-07' as DateKey,
          closureDates: ['2026-10-07' as DateKey],
        }),
      ).toBe('weekend-card');
    });

    it('prioritizes weekend-card over expanded', () => {
      const activeNonRoutine: DayLayoutEventInput[] = [
        { id: 'ev1', title: 'Weekend Outing', isRoutine: false, status: 'confirmed' },
      ];

      // Saturday with non-routine event remains weekend-card
      expect(
        getDayLayout({
          date: '2026-10-10' as DateKey,
          events: activeNonRoutine,
        }),
      ).toBe('weekend-card');

      // Holiday Monday with non-routine event remains weekend-card
      expect(
        getDayLayout({
          date: '2026-10-12' as DateKey,
          events: activeNonRoutine,
        }),
      ).toBe('weekend-card');

      // Closure Tuesday with non-routine event remains weekend-card
      expect(
        getDayLayout({
          date: '2026-10-06' as DateKey,
          isClosure: true,
          events: activeNonRoutine,
        }),
      ).toBe('weekend-card');
    });
  });

  describe('weekday classification (expanded vs compact)', () => {
    const ordinaryTuesday = '2026-10-06' as DateKey;

    it('expands weekday with single active non-routine family event', () => {
      const events: DayLayoutEventInput[] = [
        { id: 'ev1', title: 'Dentist Appointment', isRoutine: false, status: 'confirmed' },
      ];
      expect(getDayLayout({ date: ordinaryTuesday, events })).toBe('expanded');
    });

    it('stays compact for weekday with only routine family events', () => {
      const events: DayLayoutEventInput[] = [
        { id: 'ev1', title: 'Swimming Lesson', isRoutine: true, status: 'confirmed' },
        { id: 'ev2', title: 'Math Tutor', isRoutine: true, status: 'confirmed' },
      ];
      expect(getDayLayout({ date: ordinaryTuesday, events })).toBe('compact');
    });

    it('stays compact when non-routine family event is cancelled', () => {
      const events: DayLayoutEventInput[] = [
        { id: 'ev1', title: 'Cancelled Dinner', isRoutine: false, status: 'cancelled' },
      ];
      expect(getDayLayout({ date: ordinaryTuesday, events })).toBe('compact');
    });

    it('stays compact when weekday has no events', () => {
      expect(getDayLayout({ date: ordinaryTuesday, events: [] })).toBe('compact');
      expect(getDayLayout({ date: ordinaryTuesday })).toBe('compact');
    });

    it('does not mutate input events array', () => {
      const events: DayLayoutEventInput[] = [
        { id: 'ev1', title: 'Piano', isRoutine: true, status: 'confirmed' },
      ];
      const snapshot = JSON.stringify(events);
      getDayLayout({ date: ordinaryTuesday, events });
      expect(JSON.stringify(events)).toBe(snapshot);
    });
  });
});
