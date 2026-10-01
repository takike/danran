import { type Request as PlaywrightRequest, expect, test } from '@playwright/test';

test.describe('Task 1-3: Calendar Sharing Spike E2E', () => {
  test.use({
    viewport: { width: 390, height: 844 },
  });

  test('Service Worker controlled navigation to /spike/calendar-sharing returns HTTP 404 when disabled by default', async ({
    page,
  }) => {
    // 1. Visit home page to establish Service Worker registration and controller
    await page.goto('/');

    await page.waitForFunction(
      async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.ready;
        return reg.active?.state === 'activated' && navigator.serviceWorker.controller !== null;
      },
      undefined,
      { timeout: 15_000 },
    );

    // 2. Direct navigation to /spike/calendar-sharing returns HTTP 404 under SW control
    const response = await page.goto('/spike/calendar-sharing');
    expect(response?.status()).toBe(404);
  });

  test.describe('Mocked Spike UI (serviceWorkers: "block")', () => {
    test.use({
      serviceWorkers: 'block',
    });

    const mockUser = {
      id: 'usr_e2e_spike',
      displayName: 'テストユーザーA',
    };

    test('Shows 401 unauthorized message and login link when session is missing', async ({
      page,
    }) => {
      await page.route('**/spike/calendar-sharing', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: await (await fetch('http://127.0.0.1:4173/index.html')).text(),
        });
      });

      await page.route('**/api/spike/calendar-sharing', async (route) => {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unauthorized' }),
        });
      });

      await page.goto('/spike/calendar-sharing');

      const unauthScreen = page.locator('[data-testid="spike-unauthorized-screen"]');
      await expect(unauthScreen).toBeVisible();
      await expect(page.getByRole('heading', { name: 'ログインが必要です' })).toBeVisible();

      // Verify controls are never rendered on 401
      await expect(page.locator('[data-testid="section-account-a"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="section-account-b"]')).toHaveCount(0);
    });

    test('Shows 404 not found message when API reports spike feature disabled', async ({
      page,
    }) => {
      await page.route('**/spike/calendar-sharing', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: await (await fetch('http://127.0.0.1:4173/index.html')).text(),
        });
      });

      await page.route('**/api/spike/calendar-sharing', async (route) => {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Not Found' }),
        });
      });

      await page.goto('/spike/calendar-sharing');

      const disabledScreen = page.locator('[data-testid="spike-disabled-screen"]');
      await expect(disabledScreen).toBeVisible();
      await expect(page.getByRole('heading', { name: 'ページが見つかりません' })).toBeVisible();

      // Verify controls are never rendered on 404
      await expect(page.locator('[data-testid="section-account-a"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="section-account-b"]')).toHaveCount(0);
    });

    test('Enabled UI renders accessible controls, enforces 44px tap targets, handles keyboard focus, and operates independently', async ({
      page,
    }) => {
      await page.route('**/spike/calendar-sharing', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: await (await fetch('http://127.0.0.1:4173/index.html')).text(),
        });
      });

      const createdCalendarId = 'mock_cal_12345@group.calendar.google.com';
      const createdEventId = 'mock_evt_99999';

      await page.route('**/api/spike/calendar-sharing', async (route) => {
        const method = route.request().method();

        if (method === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ user: mockUser }),
          });
          return;
        }

        if (method === 'POST') {
          const body = route.request().postDataJSON();

          if (body.action === 'insertCalendar') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                action: 'insertCalendar',
                calendarId: createdCalendarId,
                receipt: 'mock_signed_receipt_cal',
              }),
            });
            return;
          }

          if (body.action === 'insertAcl') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                action: 'insertAcl',
                calendarId: body.calendarId,
              }),
            });
            return;
          }

          if (body.action === 'insertCalendarList') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: false,
                action: 'insertCalendarList',
                error: 'Google Calendar API request failed',
                code: 'API_ERROR',
                googleStatus: 403,
                reason: 'forbidden',
                outcome: 'failed',
              }),
            });
            return;
          }

          if (body.action === 'listEvents') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                action: 'listEvents',
                calendarId: body.calendarId,
                eventCount: 3,
                hasMore: false,
              }),
            });
            return;
          }

          if (body.action === 'insertEvent') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                action: 'insertEvent',
                calendarId: body.calendarId,
                eventId: createdEventId,
                receipt: 'mock_signed_receipt_evt',
              }),
            });
            return;
          }

          if (body.action === 'deleteEvent') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                action: 'deleteEvent',
                calendarId: body.calendarId,
                eventId: body.eventId,
              }),
            });
            return;
          }

          if (body.action === 'deleteCalendar') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                action: 'deleteCalendar',
                calendarId: body.calendarId,
              }),
            });
            return;
          }
        }

        await route.abort('failed');
      });

      await page.goto('/spike/calendar-sharing');

      // 1. Header and Display Name Check (no internal userId exposed)
      await expect(page.locator('[data-testid="spike-calendar-sharing-screen"]')).toBeVisible();
      await expect(page.locator('[data-testid="current-user-display-name"]')).toHaveText(
        mockUser.displayName,
      );

      // 2. 390px Viewport No Horizontal Overflow Check
      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(hasHorizontalOverflow).toBe(false);

      // 3. Accessibility & 44px tap target size check
      const buttonsToCheck = [
        '[data-testid="btn-insert-calendar"]',
        '[data-testid="btn-insert-calendar-list"]',
        '[data-testid="btn-list-events"]',
        '[data-testid="btn-insert-event"]',
      ];
      for (const selector of buttonsToCheck) {
        const box = await page.locator(selector).boundingBox();
        expect(box).not.toBeNull();
        if (box) {
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.width).toBeGreaterThanOrEqual(44);
        }
      }

      // Check keyboard focus
      const insertCalBtn = page.locator('[data-testid="btn-insert-calendar"]');
      await insertCalBtn.focus();
      await expect(insertCalBtn).toBeFocused();

      // 4. Operation: Insert Calendar
      await insertCalBtn.click();
      await expect(page.locator('[data-testid="created-calendar-info"]')).toBeVisible();
      await expect(page.locator('[data-testid="created-calendar-info"]')).toContainText(
        createdCalendarId,
      );
      await expect(insertCalBtn).toBeDisabled();

      // 5. Operation: Insert ACL
      await page.locator('[data-testid="input-acl-email"]').fill('partner@example.test');
      const insertAclBtn = page.locator('[data-testid="btn-insert-acl"]');
      await expect(insertAclBtn).toBeEnabled();
      await insertAclBtn.click();
      await expect(page.locator('[data-testid="history-list"]')).toContainText('writer権限付与');

      // 6. Operation: CalendarList Insert (simulates 403 Forbidden)
      const calListBtn = page.locator('[data-testid="btn-insert-calendar-list"]');
      await expect(calListBtn).toBeEnabled();
      await calListBtn.click();
      await expect(page.locator('[data-testid="history-list"]')).toContainText('403');
      await expect(page.locator('[data-testid="history-list"]')).toContainText('forbidden');

      // Invariant: calendarList 403 failure MUST NOT disable events list or insert buttons
      const listEventsBtn = page.locator('[data-testid="btn-list-events"]');
      const insertEventBtn = page.locator('[data-testid="btn-insert-event"]');
      await expect(listEventsBtn).toBeEnabled();
      await expect(insertEventBtn).toBeEnabled();

      // 7. Operation: List Events
      await listEventsBtn.click();
      await expect(page.locator('[data-testid="history-list"]')).toContainText('予定件数: 3 件');

      // 8. Operation: Insert Test Event
      await insertEventBtn.click();
      await expect(page.locator('[data-testid="created-event-info"]')).toBeVisible();
      await expect(page.locator('[data-testid="created-event-info"]')).toContainText(
        createdEventId,
      );
      await expect(insertEventBtn).toBeDisabled();

      // 9. Operation: Delete Test Event
      const deleteEventBtn = page.locator('[data-testid="btn-delete-event"]');
      await expect(deleteEventBtn).toBeEnabled();
      await deleteEventBtn.click();
      await expect(page.locator('[data-testid="created-event-info"]')).toHaveCount(0);
      await expect(insertEventBtn).toBeEnabled();

      // 10. Operation: Delete Calendar (in cleanup section)
      const deleteCalBtn = page.locator('[data-testid="btn-delete-calendar"]');
      await expect(deleteCalBtn).toBeEnabled();
      await deleteCalBtn.click();
      await expect(page.locator('[data-testid="created-calendar-info"]')).toHaveCount(0);
      await expect(insertCalBtn).toBeEnabled();
    });

    test('POST 401 response hides controls and transitions to unauthorized gate', async ({
      page,
    }) => {
      await page.route('**/spike/calendar-sharing', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: await (await fetch('http://127.0.0.1:4173/index.html')).text(),
        });
      });

      await page.route('**/api/spike/calendar-sharing', async (route) => {
        const method = route.request().method();
        if (method === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ user: mockUser }),
          });
          return;
        }
        if (method === 'POST') {
          // Session expired on backend
          await route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Unauthorized' }),
          });
          return;
        }
      });

      await page.goto('/spike/calendar-sharing');
      await expect(page.locator('[data-testid="section-account-a"]')).toBeVisible();

      // Trigger operation
      await page.locator('[data-testid="btn-insert-calendar"]').click();

      // Controls should disappear and unauthorized screen should appear
      await expect(page.locator('[data-testid="spike-unauthorized-screen"]')).toBeVisible();
      await expect(page.locator('[data-testid="section-account-a"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="section-account-b"]')).toHaveCount(0);
    });

    test('Malformed server response shows fixed Japanese error message without echoing raw content', async ({
      page,
    }) => {
      await page.route('**/spike/calendar-sharing', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: await (await fetch('http://127.0.0.1:4173/index.html')).text(),
        });
      });

      const sensitiveInternalSnippet = 'SensitiveBackendInternalLeak-12345';

      await page.route('**/api/spike/calendar-sharing', async (route) => {
        const method = route.request().method();
        if (method === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ user: mockUser }),
          });
          return;
        }
        if (method === 'POST') {
          // Send invalid schema with sensitive internal error
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              ok: true,
              invalidKey: sensitiveInternalSnippet,
            }),
          });
          return;
        }
      });

      await page.goto('/spike/calendar-sharing');
      await page.locator('[data-testid="btn-insert-calendar"]').click();

      const historyList = page.locator('[data-testid="history-list"]');
      await expect(historyList).toContainText('サーバー応答の解析に失敗しました。');
      await expect(historyList).toContainText(
        '操作が反映されている可能性があるため、再試行する前に Google カレンダーを確認してください。',
      );

      // Verify raw sensitive string is NOT echoed into DOM
      const pageText = await page.content();
      expect(pageText).not.toContain(sensitiveInternalSnippet);
    });

    test('Mutating target calendar ID preserves original calendarId when deleting event', async ({
      page,
    }) => {
      await page.route('**/spike/calendar-sharing', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: await (await fetch('http://127.0.0.1:4173/index.html')).text(),
        });
      });

      const originalCalId = 'original_cal_id@group.calendar.google.com';
      const capturedDeleteRequests: Array<{
        action: string;
        calendarId: string;
        eventId: string;
        receipt: string;
      }> = [];

      await page.route('**/api/spike/calendar-sharing', async (route) => {
        const method = route.request().method();
        if (method === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ user: mockUser }),
          });
          return;
        }
        if (method === 'POST') {
          const body = route.request().postDataJSON();
          if (body.action === 'insertEvent') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                action: 'insertEvent',
                calendarId: originalCalId,
                eventId: 'evt_to_delete',
                receipt: 'receipt_for_event',
              }),
            });
            return;
          }
          if (body.action === 'deleteEvent') {
            capturedDeleteRequests.push(body);
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                action: 'deleteEvent',
                calendarId: body.calendarId,
                eventId: body.eventId,
              }),
            });
            return;
          }
        }
      });

      await page.goto('/spike/calendar-sharing');

      // 1. Fill target calendar ID with original
      await page.locator('[data-testid="input-target-calendar-id"]').fill(originalCalId);

      // 2. Create event
      await page.locator('[data-testid="btn-insert-event"]').click();
      await expect(page.locator('[data-testid="created-event-info"]')).toBeVisible();

      // 3. User alters target calendar ID input
      await page
        .locator('[data-testid="input-target-calendar-id"]')
        .fill('different_calendar@group.calendar.google.com');

      // 4. User clicks delete event -> verify original calendarId was sent
      await page.locator('[data-testid="btn-delete-event"]').click();
      await expect(page.locator('[data-testid="created-event-info"]')).toHaveCount(0);

      expect(capturedDeleteRequests.length).toBe(1);
      expect(capturedDeleteRequests[0]?.calendarId).toBe(originalCalId);
    });

    test('Calendar deletion clears own event receipt if it belongs to the deleted calendar', async ({
      page,
    }) => {
      await page.route('**/spike/calendar-sharing', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: await (await fetch('http://127.0.0.1:4173/index.html')).text(),
        });
      });

      const calId = 'test_cleanup_cal@group.calendar.google.com';

      await page.route('**/api/spike/calendar-sharing', async (route) => {
        const method = route.request().method();
        if (method === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ user: mockUser }),
          });
          return;
        }
        if (method === 'POST') {
          const body = route.request().postDataJSON();
          if (body.action === 'insertCalendar') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                action: 'insertCalendar',
                calendarId: calId,
                receipt: 'receipt_cal',
              }),
            });
            return;
          }
          if (body.action === 'insertEvent') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                action: 'insertEvent',
                calendarId: calId,
                eventId: 'evt_on_same_cal',
                receipt: 'receipt_evt',
              }),
            });
            return;
          }
          if (body.action === 'deleteCalendar') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                action: 'deleteCalendar',
                calendarId: calId,
              }),
            });
            return;
          }
        }
      });

      await page.goto('/spike/calendar-sharing');

      // 1. Create calendar
      await page.locator('[data-testid="btn-insert-calendar"]').click();
      await expect(page.locator('[data-testid="created-calendar-info"]')).toBeVisible();

      // 2. Create event on that calendar
      await page.locator('[data-testid="btn-insert-event"]').click();
      await expect(page.locator('[data-testid="created-event-info"]')).toBeVisible();

      // 3. Delete calendar via cleanup section
      await page.locator('[data-testid="btn-delete-calendar"]').click();
      await expect(page.locator('[data-testid="created-calendar-info"]')).toHaveCount(0);

      // Event receipt on that deleted calendar should be cleared automatically
      await expect(page.locator('[data-testid="created-event-info"]')).toHaveCount(0);
    });

    test('Rejects mismatched action and mismatched resource ID in successful API response', async ({
      page,
    }) => {
      await page.route('**/spike/calendar-sharing', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: await (await fetch('http://127.0.0.1:4173/index.html')).text(),
        });
      });

      await page.route('**/api/spike/calendar-sharing', async (route) => {
        const method = route.request().method();
        if (method === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ user: mockUser }),
          });
          return;
        }
        if (method === 'POST') {
          const body = route.request().postDataJSON();
          if (body.action === 'listEvents') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                action: 'listEvents',
                calendarId: 'different_cal_id',
                eventCount: 3,
                hasMore: false,
              }),
            });
            return;
          }
        }
      });

      await page.goto('/spike/calendar-sharing');
      await page.locator('[data-testid="input-target-calendar-id"]').fill('expected_cal_id');
      await page.locator('[data-testid="btn-list-events"]').click();

      const histItem = page.locator('[data-testid="history-item"]').first();
      await expect(histItem).toBeVisible();
      await expect(histItem).toContainText('INVALID_RESPONSE');
      await expect(histItem).toContainText('サーバー応答のリソースIDが一致しません。');
    });

    test('Detected user change clears aclEmail, targetCalendarId, and receipts', async ({
      page,
    }) => {
      let currentUser = mockUser;

      await page.route('**/spike/calendar-sharing', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: await (await fetch('http://127.0.0.1:4173/index.html')).text(),
        });
      });

      await page.route('**/api/spike/calendar-sharing', async (route) => {
        const method = route.request().method();
        if (method === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ user: currentUser }),
          });
          return;
        }
        if (method === 'POST') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              ok: true,
              action: 'insertCalendar',
              calendarId: 'cal_user_a',
              receipt: 'receipt_user_a',
            }),
          });
          return;
        }
      });

      await page.goto('/spike/calendar-sharing');
      await page.locator('[data-testid="btn-insert-calendar"]').click();
      await expect(page.locator('[data-testid="created-calendar-info"]')).toBeVisible();

      await page.locator('[data-testid="input-acl-email"]').fill('account-b@example.test');
      await page.locator('[data-testid="input-target-calendar-id"]').fill('cal_user_a');

      // Switch active user
      currentUser = {
        id: 'usr_e2e_spike_switched_b',
        displayName: 'テストユーザーB',
      };

      // Trigger visibilitychange to refetch session
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          writable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // User displayName should update to user B
      await expect(page.getByText('ログイン中: テストユーザーB')).toBeVisible();

      // Inputs and receipts should be reset to avoid leaking user A data into user B
      await expect(page.locator('[data-testid="input-acl-email"]')).toHaveValue('');
      await expect(page.locator('[data-testid="input-target-calendar-id"]')).toHaveValue('');
      await expect(page.locator('[data-testid="created-calendar-info"]')).toHaveCount(0);
    });

    test('Pending stale metadata response cannot restore ready state after POST 404 denial', async ({
      page,
    }) => {
      let getCount = 0;
      let resolveSecondGetGate: () => void = () => {};
      const secondGetGate = new Promise<void>((resolve) => {
        resolveSecondGetGate = resolve;
      });

      let resolveSecondGetEntered: () => void = () => {};
      const secondGetEntered = new Promise<void>((resolve) => {
        resolveSecondGetEntered = resolve;
      });

      let capturedSecondRequest: PlaywrightRequest | null = null;

      await page.route('**/spike/calendar-sharing', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: await (await fetch('http://127.0.0.1:4173/index.html')).text(),
        });
      });

      await page.route('**/api/spike/calendar-sharing', async (route) => {
        const method = route.request().method();
        if (method === 'GET') {
          getCount += 1;
          if (getCount === 1) {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ user: mockUser }),
            });
            return;
          }
          if (getCount === 2) {
            capturedSecondRequest = route.request();
            resolveSecondGetEntered();
            await secondGetGate;
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ user: mockUser }),
            });
            return;
          }
        }

        if (method === 'POST') {
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Not Found' }),
          });
          return;
        }
      });

      try {
        // 1. Initial load reaches ready state
        await page.goto('/spike/calendar-sharing');
        await expect(page.locator('[data-testid="section-account-a"]')).toBeVisible();

        // 2. Trigger visibilitychange to initiate the second GET
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', {
            value: 'visible',
            writable: true,
          });
          document.dispatchEvent(new Event('visibilitychange'));
        });

        // 3. Await proof that second GET route handler was entered before clicking POST
        await secondGetEntered;

        // 4. Trigger POST that returns 404 while second GET is still pending on the gate
        await page.locator('[data-testid="btn-insert-calendar"]').click();

        // 5. UI immediately transitions to disabled screen
        await expect(page.locator('[data-testid="spike-disabled-screen"]')).toBeVisible();
        await expect(page.locator('[data-testid="section-account-a"]')).toHaveCount(0);

        // 6. Set up listener for the second request finishing BEFORE releasing the gate
        const secondRequestFinishedPromise = page.waitForEvent('requestfinished', {
          predicate: (req: PlaywrightRequest) => req === capturedSecondRequest,
        });

        // 7. Release pending stale GET gate
        resolveSecondGetGate();

        // 8. Await the actual delivery of the stale GET response
        const finishedReq = await secondRequestFinishedPromise;
        const staleResponse = await finishedReq.response();
        expect(staleResponse?.status()).toBe(200);

        // 9. Allow React render opportunities (two animation frame turns, not fixed millisecond sleep)
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => resolve());
              });
            }),
        );

        // 10. Assert getCount is exactly 2, gate remains disabled, and controls remain absent
        expect(getCount).toBe(2);
        await expect(page.locator('[data-testid="spike-disabled-screen"]')).toBeVisible();
        await expect(page.locator('[data-testid="section-account-a"]')).toHaveCount(0);
      } finally {
        resolveSecondGetGate();
      }
    });
  });
});
