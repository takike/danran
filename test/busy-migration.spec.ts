import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Busy calendar migration', () => {
  it('preserves existing calendar rows and defaults the new purpose flag to false', async () => {
    const busyMigrationIndex = env.TEST_MIGRATIONS.findIndex((migration) =>
      migration.name.includes('0006_naive_iron_man'),
    );
    if (busyMigrationIndex < 0) throw new Error('Busy calendar migration is missing');
    const priorMigrations = env.TEST_MIGRATIONS.slice(0, busyMigrationIndex);
    const busyMigration = env.TEST_MIGRATIONS[busyMigrationIndex];
    if (!busyMigration) throw new Error('Busy calendar migration is missing');
    await applyD1Migrations(env.MIGRATION_DB, priorMigrations);

    await env.MIGRATION_DB.prepare(
      'INSERT INTO users (id, google_sub, email, display_name) VALUES (?, ?, ?, ?)',
    )
      .bind('migration-user', 'migration-google-sub', 'migration@example.test', 'Migration User')
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO families (id, name, family_calendar_id, owner_user_id, creation_status) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('migration-family', 'Migration Family', 'family-cal', 'migration-user', 'ready')
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO members (id, family_id, user_id, kind, name, color, sort_order, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'migration-member',
        'migration-family',
        'migration-user',
        'adult',
        'Migration User',
        'indigo',
        0,
        'active',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO member_calendars (member_id, calendar_id, display_enabled) VALUES (?, ?, ?)',
    )
      .bind('migration-member', 'existing-calendar-id', 1)
      .run();

    const beforeMigrationColumns = await env.MIGRATION_DB.prepare(
      'PRAGMA table_info(member_calendars)',
    ).all<{ name: string }>();
    expect(beforeMigrationColumns.results.map(({ name }) => name)).not.toContain('include_in_busy');

    await applyD1Migrations(env.MIGRATION_DB, [busyMigration]);

    const migrated = await env.MIGRATION_DB.prepare(
      'SELECT member_id, calendar_id, display_enabled, include_in_busy FROM member_calendars WHERE member_id = ?',
    )
      .bind('migration-member')
      .first<{
        member_id: string;
        calendar_id: string;
        display_enabled: number;
        include_in_busy: number;
      }>();
    expect(migrated).toEqual({
      member_id: 'migration-member',
      calendar_id: 'existing-calendar-id',
      display_enabled: 1,
      include_in_busy: 0,
    });
  });
});
