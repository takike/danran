import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Absence task migration', () => {
  it('adds only the partial unique conflict source_ref index and preserves existing rows', async () => {
    const migrationIndex = env.TEST_MIGRATIONS.findIndex((migration) =>
      migration.name.startsWith('0010_'),
    );
    if (migrationIndex < 0) throw new Error('Absence task migration is missing');
    const priorMigrations = env.TEST_MIGRATIONS.slice(0, migrationIndex);
    const migration = env.TEST_MIGRATIONS[migrationIndex];
    if (!migration) throw new Error('Absence task migration is missing');
    await applyD1Migrations(env.MIGRATION_DB, priorMigrations);

    await env.MIGRATION_DB.prepare(
      'INSERT INTO users (id, google_sub, email, display_name) VALUES (?, ?, ?, ?)',
    )
      .bind('absence_migration_user', 'absence-migration-sub', 'absence@example.test', 'User')
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO families (id, name, family_calendar_id, owner_user_id, creation_status) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('absence_migration_family', 'Family', 'calendar', 'absence_migration_user', 'ready')
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO tasks (id, family_id, title, due_at, due_kind, source, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'absence_migration_existing',
        'absence_migration_family',
        '既存タスク',
        '2026-10-12',
        'date',
        'conflict',
        'legacy-conflict-ref',
      )
      .run();

    const tablesBefore = await env.MIGRATION_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    const existingSchemasBefore = await Promise.all(
      ['tasks', 'families', 'event_meta', 'members', 'users'].map(async (table) => {
        const result = await env.MIGRATION_DB.prepare(`PRAGMA table_info(${table})`).all();
        return [table, result.results] as const;
      }),
    );
    const indexesBefore = await env.MIGRATION_DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
    ).all<{ name: string; sql: string | null }>();
    const rowBefore = await env.MIGRATION_DB.prepare('SELECT * FROM tasks WHERE id = ?')
      .bind('absence_migration_existing')
      .first<Record<string, unknown>>();

    await applyD1Migrations(env.MIGRATION_DB, [migration]);

    const tablesAfter = await env.MIGRATION_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    const existingSchemasAfter = await Promise.all(
      ['tasks', 'families', 'event_meta', 'members', 'users'].map(async (table) => {
        const result = await env.MIGRATION_DB.prepare(`PRAGMA table_info(${table})`).all();
        return [table, result.results] as const;
      }),
    );
    const indexesAfter = await env.MIGRATION_DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
    ).all<{ name: string; sql: string | null }>();
    const existing = await env.MIGRATION_DB.prepare('SELECT * FROM tasks WHERE id = ?')
      .bind('absence_migration_existing')
      .first<Record<string, unknown>>();

    expect(tablesAfter.results).toEqual(tablesBefore.results);
    expect(existingSchemasAfter).toEqual(existingSchemasBefore);
    expect(indexesAfter.results).toHaveLength(indexesBefore.results.length + 1);
    expect(indexesAfter.results.map((index) => index.name)).toEqual(
      [
        ...indexesBefore.results.map((index) => index.name),
        'tasks_conflict_source_ref_unique',
      ].sort(),
    );
    expect(
      indexesAfter.results.find((index) => index.name === 'tasks_conflict_source_ref_unique')?.sql,
    ).toContain("WHERE source = 'conflict' AND source_ref IS NOT NULL");
    expect(existing).toEqual(rowBefore);

    await env.MIGRATION_DB.prepare(
      'INSERT INTO tasks (id, family_id, title, due_at, due_kind, source, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'absence_migration_conflict_2',
        'absence_migration_family',
        '欠席を連絡',
        '2026-10-12',
        'date',
        'conflict',
        'new-conflict-ref',
      )
      .run();
    await expect(
      env.MIGRATION_DB.prepare(
        'INSERT INTO tasks (id, family_id, title, due_at, due_kind, source, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(
          'absence_migration_conflict_3',
          'absence_migration_family',
          '欠席を連絡',
          '2026-10-12',
          'date',
          'conflict',
          'new-conflict-ref',
        )
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
  });
});
