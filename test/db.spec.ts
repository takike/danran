import { env } from 'cloudflare:test';
import { createDb, users } from '@worker/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

describe('D1 Database & Drizzle Integration', () => {
  const db = createDb(env.DB);

  beforeEach(async () => {
    // Clean up test users to guarantee storage isolation regardless of test ordering
    await db.delete(users);
  });

  it('has applied migrations and created the users table', async () => {
    const tableInfo = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
    ).first<{ name: string }>();

    expect(tableInfo?.name).toBe('users');

    const migrationInfo = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'",
    ).first<{ name: string }>();

    expect(migrationInfo?.name).toBe('d1_migrations');
  });

  it('performs CRUD operations for synthetic users', async () => {
    const synthUser = {
      id: 'usr_synth_01',
      googleSub: 'gsub_synth_001',
      email: 'synthetic.user@example.test',
      displayName: 'Synthetic User',
    };

    // 1. Insert
    await db.insert(users).values(synthUser);

    // 2. Select
    const foundRows = await db.select().from(users).where(eq(users.id, synthUser.id));
    const found = foundRows[0];
    expect(found).toBeDefined();
    expect(found?.id).toBe(synthUser.id);
    expect(found?.googleSub).toBe(synthUser.googleSub);
    expect(found?.email).toBe(synthUser.email);
    expect(found?.displayName).toBe(synthUser.displayName);
    expect(typeof found?.createdAt).toBe('number');

    // 3. Update
    const updatedName = 'Updated Synthetic User';
    await db.update(users).set({ displayName: updatedName }).where(eq(users.id, synthUser.id));

    const afterUpdateRows = await db.select().from(users).where(eq(users.id, synthUser.id));
    expect(afterUpdateRows[0]?.displayName).toBe(updatedName);

    // 4. Delete
    await db.delete(users).where(eq(users.id, synthUser.id));

    const afterDeleteRows = await db.select().from(users).where(eq(users.id, synthUser.id));
    expect(afterDeleteRows.length).toBe(0);
  });

  it('enforces unique constraint on google_sub', async () => {
    await db.insert(users).values({
      id: 'usr_synth_unique_1',
      googleSub: 'gsub_shared_duplicate',
      email: 'unique1@example.test',
      displayName: 'Unique One',
    });

    await expect(
      db.insert(users).values({
        id: 'usr_synth_unique_2',
        googleSub: 'gsub_shared_duplicate',
        email: 'unique2@example.test',
        displayName: 'Unique Two',
      }),
    ).rejects.toThrow();
  });

  it('performs local R2 bucket roundtrip smoke check without remote access', async () => {
    const key = 'smoke/test-object.txt';
    const content = 'danran-r2-smoke-test-payload';

    await env.PHOTOS.put(key, content);

    const retrieved = await env.PHOTOS.get(key);
    expect(retrieved).not.toBeNull();
    const text = await retrieved?.text();
    expect(text).toBe(content);

    await env.PHOTOS.delete(key);
    const afterDelete = await env.PHOTOS.get(key);
    expect(afterDelete).toBeNull();
  });
});
