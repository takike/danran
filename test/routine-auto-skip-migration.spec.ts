import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Routine auto skip migration', () => {
  it('adds the ledger and nullable horizon while preserving prior routine rows', async () => {
    const migrationIndex = env.TEST_MIGRATIONS.findIndex((migration) =>
      migration.name.startsWith('0008_'),
    );
    if (migrationIndex < 0) throw new Error('Routine auto skip migration is missing');
    const priorMigrations = env.TEST_MIGRATIONS.slice(0, migrationIndex);
    const migration = env.TEST_MIGRATIONS[migrationIndex];
    if (!migration) throw new Error('Routine auto skip migration is missing');
    await applyD1Migrations(env.MIGRATION_DB, priorMigrations);

    await env.MIGRATION_DB.prepare(
      'INSERT INTO users (id, google_sub, email, display_name) VALUES (?, ?, ?, ?)',
    )
      .bind(
        'auto_skip_migration_user',
        'auto-skip-migration-sub',
        'auto-skip-migration@example.test',
        'Migration User',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO families (id, name, family_calendar_id, owner_user_id, creation_status) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(
        'auto_skip_migration_family',
        'Migration Family',
        'auto-skip-migration-calendar',
        'auto_skip_migration_user',
        'ready',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO members (id, family_id, user_id, kind, name, color, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'auto_skip_migration_member',
        'auto_skip_migration_family',
        'auto_skip_migration_user',
        'adult',
        'Member',
        'indigo',
        'active',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO routine_settings (id, family_id, calendar_id, recurring_event_id, category, skip_holidays, skip_new_year, affects_availability, default_assignee_member_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'auto_skip_migration_routine',
        'auto_skip_migration_family',
        'auto-skip-migration-calendar',
        'auto-skip-migration-master',
        'lesson',
        1,
        0,
        0,
        'auto_skip_migration_member',
      )
      .run();
    const routineBefore = await env.MIGRATION_DB.prepare(
      'SELECT id, family_id, calendar_id, recurring_event_id, category, skip_holidays, skip_new_year, affects_availability, default_assignee_member_id, created_at, updated_at FROM routine_settings WHERE id = ?',
    )
      .bind('auto_skip_migration_routine')
      .first<Record<string, unknown>>();
    const tablesBefore = await env.MIGRATION_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(tablesBefore.results.map(({ name }) => name)).not.toContain('routine_auto_skips');

    await applyD1Migrations(env.MIGRATION_DB, [migration]);

    const routineColumns = await env.MIGRATION_DB.prepare(
      'PRAGMA table_info(routine_settings)',
    ).all<{ name: string; notnull: number; dflt_value: string | null }>();
    expect(routineColumns.results.map(({ name }) => name)).toContain('auto_skip_applied_until');
    const horizonColumn = routineColumns.results.find(
      ({ name }) => name === 'auto_skip_applied_until',
    );
    expect(horizonColumn).toMatchObject({ notnull: 0, dflt_value: null });

    const routineAfter = await env.MIGRATION_DB.prepare(
      'SELECT id, family_id, calendar_id, recurring_event_id, category, skip_holidays, skip_new_year, affects_availability, default_assignee_member_id, created_at, updated_at, auto_skip_applied_until FROM routine_settings WHERE id = ?',
    )
      .bind('auto_skip_migration_routine')
      .first<Record<string, unknown>>();
    expect(routineAfter).toMatchObject(routineBefore ?? {});
    expect(routineAfter?.auto_skip_applied_until).toBeNull();

    const ledgerColumns = await env.MIGRATION_DB.prepare(
      'PRAGMA table_info(routine_auto_skips)',
    ).all<{ name: string; notnull: number; dflt_value: string | null }>();
    expect(ledgerColumns.results.map(({ name }) => name)).toEqual([
      'id',
      'routine_settings_id',
      'original_start',
      'reason',
      'status',
      'created_at',
    ]);
    const ledgerSql = await env.MIGRATION_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'routine_auto_skips'",
    ).first<{ sql: string }>();
    expect(ledgerSql?.sql.toUpperCase()).toContain('ON DELETE CASCADE');
    expect(ledgerSql?.sql).not.toMatch(/title|location|description/i);
    const indexes = await env.MIGRATION_DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'routine_auto_skips' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
    ).all<{ name: string; sql: string | null }>();
    expect(indexes.results.map(({ name }) => name)).toEqual([
      'routine_auto_skips_settings_start_unique',
      'routine_auto_skips_settings_status_idx',
    ]);
    expect(indexes.results[0]?.sql).toContain('UNIQUE');
    expect(indexes.results[1]?.sql).toContain('status');

    await env.MIGRATION_DB.prepare(
      'INSERT INTO routine_auto_skips (id, routine_settings_id, original_start, reason) VALUES (?, ?, ?, ?)',
    )
      .bind(
        'auto_skip_migration_record',
        'auto_skip_migration_routine',
        '2026-11-03T17:00:00+09:00',
        'holiday',
      )
      .run();
    const defaultStatus = await env.MIGRATION_DB.prepare(
      'SELECT status, created_at FROM routine_auto_skips WHERE id = ?',
    )
      .bind('auto_skip_migration_record')
      .first<{ status: string; created_at: number }>();
    expect(defaultStatus?.status).toBe('applied');
    expect(defaultStatus?.created_at).toEqual(expect.any(Number));

    await expect(
      env.MIGRATION_DB.prepare(
        'INSERT INTO routine_auto_skips (id, routine_settings_id, original_start, reason) VALUES (?, ?, ?, ?)',
      )
        .bind(
          'auto_skip_migration_duplicate',
          'auto_skip_migration_routine',
          '2026-11-03T17:00:00+09:00',
          'holiday',
        )
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
    await expect(
      env.MIGRATION_DB.prepare(
        'INSERT INTO routine_auto_skips (id, routine_settings_id, original_start, reason) VALUES (?, ?, ?, ?)',
      )
        .bind(
          'auto_skip_migration_bad_reason',
          'auto_skip_migration_routine',
          '2026-11-04T17:00:00+09:00',
          'closure',
        )
        .run(),
    ).rejects.toThrow(/CHECK/i);
    await expect(
      env.MIGRATION_DB.prepare(
        'INSERT INTO routine_auto_skips (id, routine_settings_id, original_start, reason, status) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(
          'auto_skip_migration_bad_status',
          'auto_skip_migration_routine',
          '2026-11-05T17:00:00+09:00',
          'holiday',
          'pending',
        )
        .run(),
    ).rejects.toThrow(/CHECK/i);
    await expect(
      env.MIGRATION_DB.prepare(
        'INSERT INTO routine_auto_skips (id, routine_settings_id, original_start, reason) VALUES (?, ?, ?, ?)',
      )
        .bind(
          'auto_skip_migration_bad_fk',
          'missing_routine',
          '2026-11-06T17:00:00+09:00',
          'holiday',
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);

    await env.MIGRATION_DB.prepare('DELETE FROM families WHERE id = ?')
      .bind('auto_skip_migration_family')
      .run();
    const deletedLedger = await env.MIGRATION_DB.prepare(
      'SELECT id FROM routine_auto_skips WHERE id = ?',
    )
      .bind('auto_skip_migration_record')
      .first();
    const deletedRoutine = await env.MIGRATION_DB.prepare(
      'SELECT id FROM routine_settings WHERE id = ?',
    )
      .bind('auto_skip_migration_routine')
      .first();
    expect(deletedLedger).toBeNull();
    expect(deletedRoutine).toBeNull();
  });
});
