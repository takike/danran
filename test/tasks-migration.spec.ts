import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Tasks migration', () => {
  it('adds only tasks and preserves prior tables and rows', async () => {
    const migrationIndex = env.TEST_MIGRATIONS.findIndex((migration) =>
      migration.name.startsWith('0009_'),
    );
    if (migrationIndex < 0) throw new Error('Tasks migration is missing');
    const priorMigrations = env.TEST_MIGRATIONS.slice(0, migrationIndex);
    const migration = env.TEST_MIGRATIONS[migrationIndex];
    if (!migration) throw new Error('Tasks migration is missing');
    await applyD1Migrations(env.MIGRATION_DB, priorMigrations);

    await env.MIGRATION_DB.prepare(
      'INSERT INTO users (id, google_sub, email, display_name) VALUES (?, ?, ?, ?)',
    )
      .bind('tasks_migration_user', 'tasks-migration-sub', 'tasks@example.test', 'Tasks User')
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO families (id, name, family_calendar_id, owner_user_id, creation_status) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(
        'tasks_migration_family',
        'Tasks Family',
        'tasks-calendar',
        'tasks_migration_user',
        'ready',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO members (id, family_id, user_id, kind, name, color, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'tasks_migration_member',
        'tasks_migration_family',
        'tasks_migration_user',
        'adult',
        'Tasks Member',
        'indigo',
        'active',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO event_meta (id, family_id, calendar_id, event_id, items_json) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(
        'tasks_migration_meta',
        'tasks_migration_family',
        'tasks-calendar',
        'tasks-event',
        '["水筒"]',
      )
      .run();

    const tablesBefore = await env.MIGRATION_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    const oldRowsBefore = await env.MIGRATION_DB.prepare(
      'SELECT f.id AS family_id, f.name, f.family_calendar_id, f.owner_user_id, e.id AS event_meta_id, e.event_id, e.items_json FROM families f JOIN event_meta e ON e.family_id = f.id WHERE f.id = ?',
    )
      .bind('tasks_migration_family')
      .first<Record<string, unknown>>();
    const existingSchemasBefore = await Promise.all(
      ['families', 'event_meta', 'members', 'users'].map(async (table) => {
        const result = await env.MIGRATION_DB.prepare(`PRAGMA table_info(${table})`).all<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
        }>();
        return [table, result.results] as const;
      }),
    );

    expect(tablesBefore.results.map(({ name }) => name)).not.toContain('tasks');
    await applyD1Migrations(env.MIGRATION_DB, [migration]);

    const tablesAfter = await env.MIGRATION_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(tablesAfter.results.map(({ name }) => name)).toEqual(
      [...tablesBefore.results.map(({ name }) => name), 'tasks'].sort(),
    );
    const oldRowsAfter = await env.MIGRATION_DB.prepare(
      'SELECT f.id AS family_id, f.name, f.family_calendar_id, f.owner_user_id, e.id AS event_meta_id, e.event_id, e.items_json FROM families f JOIN event_meta e ON e.family_id = f.id WHERE f.id = ?',
    )
      .bind('tasks_migration_family')
      .first<Record<string, unknown>>();
    expect(oldRowsAfter).toEqual(oldRowsBefore);
    for (const [table, columns] of existingSchemasBefore) {
      const result = await env.MIGRATION_DB.prepare(`PRAGMA table_info(${table})`).all<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>();
      expect(result.results).toEqual(columns);
    }

    const taskColumns = await env.MIGRATION_DB.prepare('PRAGMA table_info(tasks)').all<{
      name: string;
    }>();
    expect(taskColumns.results.map(({ name }) => name)).toEqual([
      'id',
      'family_id',
      'title',
      'due_at',
      'due_kind',
      'done_at',
      'assignee_member_id',
      'event_meta_id',
      'source',
      'source_ref',
      'created_at',
      'updated_at',
    ]);
    const indexes = await env.MIGRATION_DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
    ).all<{ name: string; sql: string | null }>();
    expect(indexes.results.map(({ name }) => name)).toEqual([
      'tasks_event_meta_id_idx',
      'tasks_family_id_done_at_idx',
      'tasks_items_event_meta_unique',
      'tasks_manual_source_ref_unique',
    ]);
    expect(
      indexes.results.find(({ name }) => name === 'tasks_items_event_meta_unique')?.sql,
    ).toContain("WHERE source = 'items'");
    expect(
      indexes.results.find(({ name }) => name === 'tasks_manual_source_ref_unique')?.sql,
    ).toContain("source = 'manual' AND source_ref IS NOT NULL");

    const taskInsert = env.MIGRATION_DB.prepare(
      'INSERT INTO tasks (id, family_id, title, due_at, due_kind, assignee_member_id, event_meta_id, source, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    await taskInsert
      .bind(
        'tasks_migration_manual_1',
        'tasks_migration_family',
        '手動タスク1',
        null,
        'none',
        'tasks_migration_member',
        'tasks_migration_meta',
        'manual',
        '8e900000-0000-4000-8000-000000000001',
      )
      .run();
    await taskInsert
      .bind(
        'tasks_migration_manual_2',
        'tasks_migration_family',
        '手動タスク2',
        null,
        'none',
        null,
        'tasks_migration_meta',
        'manual',
        '8e900000-0000-4000-8000-000000000002',
      )
      .run();
    await taskInsert
      .bind(
        'tasks_migration_auto',
        'tasks_migration_family',
        '持ち物を準備',
        null,
        'none',
        null,
        'tasks_migration_meta',
        'items',
        null,
      )
      .run();
    await expect(
      taskInsert
        .bind(
          'tasks_migration_auto_duplicate',
          'tasks_migration_family',
          '持ち物を準備',
          null,
          'none',
          null,
          'tasks_migration_meta',
          'items',
          null,
        )
        .run(),
    ).rejects.toThrow(/UNIQUE/i);

    const manualCount = await env.MIGRATION_DB.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE event_meta_id = ? AND source = 'manual'",
    )
      .bind('tasks_migration_meta')
      .first<{ count: number }>();
    expect(manualCount?.count).toBe(2);

    await env.MIGRATION_DB.prepare('DELETE FROM members WHERE id = ?')
      .bind('tasks_migration_member')
      .run();
    const clearedAssignee = await env.MIGRATION_DB.prepare(
      'SELECT assignee_member_id FROM tasks WHERE id = ?',
    )
      .bind('tasks_migration_manual_1')
      .first<{ assignee_member_id: string | null }>();
    expect(clearedAssignee?.assignee_member_id).toBeNull();

    await env.MIGRATION_DB.prepare('DELETE FROM event_meta WHERE id = ?')
      .bind('tasks_migration_meta')
      .run();
    const detachedTasks = await env.MIGRATION_DB.prepare(
      'SELECT event_meta_id FROM tasks WHERE family_id = ? ORDER BY id',
    )
      .bind('tasks_migration_family')
      .all<{ event_meta_id: string | null }>();
    expect(detachedTasks.results).toEqual([
      { event_meta_id: null },
      { event_meta_id: null },
      { event_meta_id: null },
    ]);

    await env.MIGRATION_DB.prepare('DELETE FROM families WHERE id = ?')
      .bind('tasks_migration_family')
      .run();
    const cascadedTasks = await env.MIGRATION_DB.prepare('SELECT id FROM tasks WHERE id LIKE ?')
      .bind('tasks_migration_%')
      .all<{ id: string }>();
    expect(cascadedTasks.results).toEqual([]);
  });
});
