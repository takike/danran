import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Family schema migration & FK integrity', () => {
  it('fails applying new migration when orphan closure_days exists in legacy schema', async () => {
    expect(env.TEST_MIGRATIONS.length).toBeGreaterThanOrEqual(4);

    const oldMigrations = env.TEST_MIGRATIONS.slice(0, 3);
    const newMigrations = env.TEST_MIGRATIONS.slice(3);
    expect(newMigrations.length).toBeGreaterThanOrEqual(1);

    // 1. Apply the 3 legacy migrations to isolated MIGRATION_DB
    await applyD1Migrations(env.MIGRATION_DB, oldMigrations);

    // 2. Insert orphan closure_days record allowed by legacy schema
    await env.MIGRATION_DB.prepare(
      'INSERT INTO closure_days (id, family_id, date, label, member_ids) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('cls_orphan', 'fam_missing', '2026-10-01', 'Orphan Holiday', '[]')
      .run();

    // Verify orphan was successfully written under legacy schema
    const orphanBefore = await env.MIGRATION_DB.prepare(
      'SELECT id, family_id, date, label, member_ids FROM closure_days WHERE id = ?',
    )
      .bind('cls_orphan')
      .first<{ id: string; family_id: string; date: string; label: string; member_ids: string }>();
    expect(orphanBefore).toEqual({
      id: 'cls_orphan',
      family_id: 'fam_missing',
      date: '2026-10-01',
      label: 'Orphan Holiday',
      member_ids: '[]',
    });

    // 3. Applying new migration with FK constraint on families(id) must fail unconditionally
    await expect(applyD1Migrations(env.MIGRATION_DB, newMigrations)).rejects.toThrow(
      /FOREIGN KEY/i,
    );

    // 4. Assert old orphan data remains intact (not silently deleted) - full row equality
    const orphanAfter = await env.MIGRATION_DB.prepare(
      'SELECT id, family_id, date, label, member_ids FROM closure_days WHERE id = ?',
    )
      .bind('cls_orphan')
      .first<{ id: string; family_id: string; date: string; label: string; member_ids: string }>();
    expect(orphanAfter).toEqual(orphanBefore);

    // 5. Assert legacy index remains intact
    const indexRow = await env.MIGRATION_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'closure_days_family_id_date_idx'",
    ).first();
    expect(indexRow).not.toBeNull();

    // 6. Assert temporary table __new_closure_days and uncommitted families table are absent after rollback
    const tempTable = await env.MIGRATION_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__new_closure_days'",
    ).first();
    expect(tempTable).toBeNull();

    const familiesTable = await env.MIGRATION_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'families'",
    ).first();
    expect(familiesTable).toBeNull();

    // 7. Assert failed migration was not recorded in d1_migrations
    const migrationsRecorded = await env.MIGRATION_DB.prepare(
      'SELECT name FROM d1_migrations',
    ).all<{ name: string }>();
    expect(migrationsRecorded.results).toHaveLength(3);
    const migrationNames = migrationsRecorded.results.map((r) => r.name);
    for (const m of newMigrations) {
      expect(migrationNames).not.toContain(m.name);
    }
  });

  it('verifies clean schema passes PRAGMA foreign_key_check and rejects invalid foreign keys', async () => {
    // env.DB has all migrations applied via test/setup.ts
    const fkCheck = await env.DB.prepare('PRAGMA foreign_key_check').all();
    expect(fkCheck.results).toEqual([]);

    // Attempting to insert an orphan closure day referencing non-existent family must reject
    await expect(
      env.DB.prepare(
        'INSERT INTO closure_days (id, family_id, date, label, member_ids) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('cls_bad_fk', 'fam_non_existent', '2026-10-01', 'Bad FK Day', '[]')
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});
