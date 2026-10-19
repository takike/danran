import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Print import migration', () => {
  it('adds only attachments and import_jobs while preserving prior rows and table definitions', async () => {
    const migrationIndex = env.TEST_MIGRATIONS.findIndex((migration) =>
      migration.name.startsWith('0011_'),
    );
    if (migrationIndex < 0) throw new Error('Print import migration is missing');
    const prior = env.TEST_MIGRATIONS.slice(0, migrationIndex);
    const migration = env.TEST_MIGRATIONS[migrationIndex];
    if (!migration) throw new Error('Print import migration is missing');
    await applyD1Migrations(env.MIGRATION_DB, prior);
    await env.MIGRATION_DB.prepare(
      'INSERT INTO users (id, google_sub, email, display_name) VALUES (?, ?, ?, ?)',
    )
      .bind(
        'imports_migration_user',
        'imports-migration-sub',
        'imports@example.test',
        'Migration User',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO families (id, name, family_calendar_id, owner_user_id, creation_status) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(
        'imports_migration_family',
        'Migration Family',
        'migration-cal',
        'imports_migration_user',
        'ready',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO members (id, family_id, user_id, kind, name, color, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'imports_migration_member',
        'imports_migration_family',
        'imports_migration_user',
        'adult',
        'Member',
        'indigo',
        'active',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO tasks (id, family_id, title, due_kind, source) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('imports_migration_task', 'imports_migration_family', '既存タスク', 'none', 'manual')
      .run();

    const tablesBefore = await env.MIGRATION_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    const existingSchema = await Promise.all(
      ['families', 'members', 'tasks', 'users'].map(async (table) => {
        const result = await env.MIGRATION_DB.prepare(`PRAGMA table_info(${table})`).all();
        return [table, result.results] as const;
      }),
    );
    const oldRow = await env.MIGRATION_DB.prepare('SELECT * FROM tasks WHERE id = ?')
      .bind('imports_migration_task')
      .first<Record<string, unknown>>();

    await applyD1Migrations(env.MIGRATION_DB, [migration]);

    const tablesAfter = await env.MIGRATION_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(tablesAfter.results.map(({ name }) => name)).toEqual(
      [...tablesBefore.results.map(({ name }) => name), 'attachments', 'import_jobs'].sort(),
    );
    const existingSchemaAfter = await Promise.all(
      ['families', 'members', 'tasks', 'users'].map(async (table) => {
        const result = await env.MIGRATION_DB.prepare(`PRAGMA table_info(${table})`).all();
        return [table, result.results] as const;
      }),
    );
    expect(existingSchemaAfter).toEqual(existingSchema);
    expect(
      await env.MIGRATION_DB.prepare('SELECT * FROM tasks WHERE id = ?')
        .bind('imports_migration_task')
        .first(),
    ).toEqual(oldRow);
    expect(
      (
        await env.MIGRATION_DB.prepare('PRAGMA table_info(attachments)').all<{ name: string }>()
      ).results.map(({ name }) => name),
    ).toEqual([
      'id',
      'family_id',
      'r2_key',
      'content_type',
      'width',
      'height',
      'byte_size',
      'created_by',
      'created_at',
    ]);
    expect(
      (
        await env.MIGRATION_DB.prepare('PRAGMA table_info(import_jobs)').all<{ name: string }>()
      ).results.map(({ name }) => name),
    ).toEqual([
      'id',
      'family_id',
      'attachment_id',
      'status',
      'result_json',
      'error_code',
      'model',
      'created_by',
      'client_request_id',
      'created_at',
    ]);
    const foreignKeys = await env.MIGRATION_DB.prepare('PRAGMA foreign_key_list(import_jobs)').all<{
      table: string;
      on_delete: string;
    }>();
    expect(
      foreignKeys.results.some(
        ({ table, on_delete }) => table === 'attachments' && on_delete.toUpperCase() === 'CASCADE',
      ),
    ).toBe(true);

    await env.MIGRATION_DB.prepare(
      'INSERT INTO attachments (id, family_id, r2_key, content_type, width, height, byte_size, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'imports_migration_attachment',
        'imports_migration_family',
        'families/imports_migration_family/imports/test.jpg',
        'image/jpeg',
        10,
        10,
        100,
        'imports_migration_member',
      )
      .run();
    await env.MIGRATION_DB.prepare(
      'INSERT INTO import_jobs (id, family_id, attachment_id, status, created_by, client_request_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'imports_migration_job',
        'imports_migration_family',
        'imports_migration_attachment',
        'pending',
        'imports_migration_member',
        'migration-request',
      )
      .run();
    await env.MIGRATION_DB.prepare('DELETE FROM families WHERE id = ?')
      .bind('imports_migration_family')
      .run();
    expect(
      await env.MIGRATION_DB.prepare('SELECT COUNT(*) AS count FROM attachments WHERE id = ?')
        .bind('imports_migration_attachment')
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await env.MIGRATION_DB.prepare('SELECT COUNT(*) AS count FROM import_jobs WHERE id = ?')
        .bind('imports_migration_job')
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });
});
