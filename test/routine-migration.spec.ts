import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Routine settings migration', () => {
  it('adds only routine_settings with safe defaults and leaves existing tables intact', async () => {
    const migrationIndex = env.TEST_MIGRATIONS.findIndex((migration) =>
      migration.name.startsWith('0007_'),
    );
    if (migrationIndex < 0) throw new Error('Routine settings migration is missing');
    const priorMigrations = env.TEST_MIGRATIONS.slice(0, migrationIndex);
    const migration = env.TEST_MIGRATIONS[migrationIndex];
    if (!migration) throw new Error('Routine settings migration is missing');
    await applyD1Migrations(env.MIGRATION_DB, priorMigrations);

    const memberCalendarColumnsBefore = await env.MIGRATION_DB.prepare(
      'PRAGMA table_info(member_calendars)',
    ).all<{ name: string }>();
    const eventMetaColumnsBefore = await env.MIGRATION_DB.prepare(
      'PRAGMA table_info(event_meta)',
    ).all<{ name: string }>();
    await applyD1Migrations(env.MIGRATION_DB, [migration]);

    const columnsAfter = await env.MIGRATION_DB.prepare('PRAGMA table_info(routine_settings)').all<{
      name: string;
    }>();
    expect(columnsAfter.results.map(({ name }) => name)).toEqual([
      'id',
      'family_id',
      'calendar_id',
      'recurring_event_id',
      'category',
      'skip_holidays',
      'skip_new_year',
      'affects_availability',
      'default_assignee_member_id',
      'created_at',
      'updated_at',
    ]);
    const memberCalendarColumnsAfter = await env.MIGRATION_DB.prepare(
      'PRAGMA table_info(member_calendars)',
    ).all<{ name: string }>();
    const eventMetaColumnsAfter = await env.MIGRATION_DB.prepare(
      'PRAGMA table_info(event_meta)',
    ).all<{ name: string }>();
    expect(memberCalendarColumnsAfter.results.map(({ name }) => name)).toEqual(
      memberCalendarColumnsBefore.results.map(({ name }) => name),
    );
    expect(eventMetaColumnsAfter.results.map(({ name }) => name)).toEqual(
      eventMetaColumnsBefore.results.map(({ name }) => name),
    );

    const tableSql = await env.MIGRATION_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'routine_settings'",
    ).first<{ sql: string }>();
    expect(tableSql?.sql.toUpperCase()).toContain('ON DELETE CASCADE');
    expect(tableSql?.sql.toUpperCase()).toContain('ON DELETE SET NULL');
    const uniqueIndex = await env.MIGRATION_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'routine_settings_calendar_recurring_event_unique'",
    ).first<{ sql: string }>();
    expect(uniqueIndex?.sql).toContain('UNIQUE');

    await env.MIGRATION_DB.prepare(
      'INSERT INTO users (id, google_sub, email, display_name) VALUES (?, ?, ?, ?)',
    )
      .bind(
        'routine_migration_user',
        'routine_migration_sub',
        'routine-migration@example.test',
        'Migration User',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO families (id, name, family_calendar_id, owner_user_id, creation_status) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(
        'routine_migration_family',
        'Migration Family',
        'routine-migration-calendar',
        'routine_migration_user',
        'ready',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO members (id, family_id, user_id, kind, name, color, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'routine_migration_member',
        'routine_migration_family',
        'routine_migration_user',
        'adult',
        'Member',
        'indigo',
        'active',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO routine_settings (id, family_id, calendar_id, recurring_event_id, category, default_assignee_member_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'routine_migration_row',
        'routine_migration_family',
        'routine-migration-calendar',
        'routine-master',
        'lesson',
        'routine_migration_member',
      )
      .run();
    const defaultValues = await env.MIGRATION_DB.prepare(
      'SELECT skip_holidays, skip_new_year, affects_availability FROM routine_settings WHERE id = ?',
    )
      .bind('routine_migration_row')
      .first<{ skip_holidays: number; skip_new_year: number; affects_availability: number }>();
    expect(defaultValues).toEqual({ skip_holidays: 0, skip_new_year: 0, affects_availability: 1 });
    await expect(
      env.MIGRATION_DB.prepare(
        'INSERT INTO routine_settings (id, family_id, calendar_id, recurring_event_id, category) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(
          'routine_migration_duplicate',
          'routine_migration_family',
          'routine-migration-calendar',
          'routine-master',
          'other',
        )
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
    await env.MIGRATION_DB.prepare('DELETE FROM members WHERE id = ?')
      .bind('routine_migration_member')
      .run();
    const clearedAssignee = await env.MIGRATION_DB.prepare(
      'SELECT default_assignee_member_id FROM routine_settings WHERE id = ?',
    )
      .bind('routine_migration_row')
      .first<{ default_assignee_member_id: string | null }>();
    expect(clearedAssignee?.default_assignee_member_id).toBeNull();
    await env.MIGRATION_DB.prepare('DELETE FROM families WHERE id = ?')
      .bind('routine_migration_family')
      .run();
    const deletedWithFamily = await env.MIGRATION_DB.prepare(
      'SELECT id FROM routine_settings WHERE id = ?',
    )
      .bind('routine_migration_row')
      .first();
    expect(deletedWithFamily).toBeNull();
  });
});
