import { expect, test } from '@playwright/test';

test.describe('Dev UI Component Showcase (/dev/ui)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/ui');
    // Wait for the lazy route chunk to finish mounting before executing checks
    await expect(page.getByRole('heading', { name: '部品一覧' })).toBeVisible();
  });

  test('Dev showcase renders all six components and their variants', async ({ page }) => {
    // 1. Card
    const card = page.getByTestId('showcase-card');
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { name: '家族の予定' })).toBeVisible();

    // 2. Chip variants
    await expect(page.getByText('ルーティン')).toBeVisible();
    await expect(page.getByText('週末の予定')).toBeVisible();
    await expect(page.getByText('締切 10/10')).toBeVisible();
    await expect(page.getByText('候補')).toBeVisible();

    // 3. MemberDot palette
    const memberDotShowcase = page.locator('section[aria-labelledby="heading-member-dot"]');
    for (const colorName of ['藍', '深緑', '黄土', '紫', '珊瑚', '青緑', '薔薇', '石板']) {
      await expect(memberDotShowcase.getByText(colorName)).toBeVisible();
    }

    // 4. Segmented group
    await expect(page.getByRole('group', { name: 'やることの表示順切り替え' })).toBeVisible();

    // 5. IconButton variants
    await expect(page.getByRole('button', { name: 'カレンダーを開く' })).toBeVisible();
    await expect(page.getByRole('button', { name: '予定を追加' })).toBeVisible();
    await expect(page.getByRole('button', { name: '設定' })).toBeVisible();
    await expect(page.getByRole('button', { name: '削除（無効）' })).toBeVisible();

    // 6. TabBar
    await expect(page.getByRole('navigation', { name: 'メインナビゲーション' })).toBeVisible();
    await expect(page.getByRole('link', { name: '週' })).toBeVisible();
    await expect(page.getByRole('link', { name: '繰り返し' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'プリントを撮影' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'やること' })).toBeVisible();
    await expect(page.getByRole('link', { name: '家族' })).toBeVisible();
  });

  test('Segmented changes selection via visible label click, handles keyboard navigation with wraparound, and prevents disabled activation', async ({
    page,
  }) => {
    const status = page.getByTestId('segment-status');
    await expect(status).toHaveText('選択中: 予定ごと');

    // 1. Click visible option label to change selection
    const dueOptionRadio = page.getByRole('radio', { name: '期限順' });
    const dueOptionLabel = page.locator('label').filter({ has: dueOptionRadio });
    await dueOptionLabel.click();
    await expect(status).toHaveText('選択中: 期限順');
    await expect(dueOptionRadio).toBeChecked();

    // 2. Keyboard navigation to next option
    await dueOptionRadio.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: '自分の担当' })).toBeChecked();
    await expect(status).toHaveText('選択中: 自分の担当');

    // 3. Keyboard navigation skips disabled option ('無効') and wraps around to '予定ごと'
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: '予定ごと' })).toBeChecked();
    await expect(status).toHaveText('選択中: 予定ごと');

    // 4. Disabled option verification: check toBeDisabled and click visible label directly
    const disabledRadio = page.getByRole('radio', { name: '無効' });
    await expect(disabledRadio).toBeDisabled();
    const disabledLabel = page.locator('label').filter({ has: disabledRadio });
    await disabledLabel.click({ force: true });
    await expect(disabledRadio).not.toBeChecked();
    await expect(status).toHaveText('選択中: 予定ごと');
  });

  test('IconButton provides accessible labels, triggers callbacks on click, and disabled button does not fire', async ({
    page,
  }) => {
    const status = page.getByTestId('icon-click-status');
    await expect(status).toHaveText('操作結果: 未選択');

    // Click enabled button
    await page.getByRole('button', { name: 'カレンダーを開く' }).click();
    await expect(status).toHaveText('操作結果: カレンダーを開きました');

    await page.getByRole('button', { name: '予定を追加' }).click();
    await expect(status).toHaveText('操作結果: 予定追加を開きました');

    // Disabled button verification without silencing errors
    const disabledButton = page.getByRole('button', { name: '削除（無効）' });
    await expect(disabledButton).toBeDisabled();
    await disabledButton.click({ force: true });
    await expect(status).toHaveText('操作結果: 予定追加を開きました');
  });

  test('TabBar contains 5 positions, accessible capture button callback, and anchor navigation updates active tab', async ({
    page,
  }) => {
    const captureStatus = page.getByTestId('capture-status');
    await expect(captureStatus).toHaveText('撮影ステータス: 未撮影');

    // Capture button
    const captureButton = page.getByRole('button', { name: 'プリントを撮影' });
    await expect(captureButton).toBeVisible();
    await captureButton.click();
    await expect(captureStatus).toHaveText('撮影ステータス: プリント撮影が要求されました');

    // Navigation item click updates URL query param and aria-current
    const weekLink = page.getByRole('link', { name: '週' });
    await expect(weekLink).toHaveAttribute('aria-current', 'page');

    const routinesLink = page.getByRole('link', { name: '繰り返し' });
    await expect(routinesLink).not.toHaveAttribute('aria-current', 'page');

    await routinesLink.click();
    await expect(page).toHaveURL(/.*tab=routines/);
    await expect(routinesLink).toHaveAttribute('aria-current', 'page');
    await expect(weekLink).not.toHaveAttribute('aria-current', 'page');
  });

  test('All interactive tap targets meet or exceed 44px minimum sizing and text remains inside labels', async ({
    page,
  }) => {
    // Segmented option labels (all 4 options)
    const segmentedLabels = page.locator('fieldset[aria-label="やることの表示順切り替え"] label');
    const segmentCount = await segmentedLabels.count();
    expect(segmentCount).toBe(4);
    for (let i = 0; i < segmentCount; i++) {
      const label = segmentedLabels.nth(i);
      const box = await label.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }

      // Confirm text bounds remain inside the label without bleeding
      const textBox = await label.locator('span').boundingBox();
      expect(textBox).not.toBeNull();
      if (box && textBox) {
        expect(textBox.width).toBeLessThanOrEqual(box.width);
      }
    }

    // Icon buttons
    const iconButtons = [
      page.getByRole('button', { name: 'カレンダーを開く' }),
      page.getByRole('button', { name: '予定を追加' }),
      page.getByRole('button', { name: '設定' }),
      page.getByRole('button', { name: '削除（無効）' }),
    ];
    for (const btn of iconButtons) {
      const box = await btn.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }

    // TabBar navigation links and capture button
    const tabLinks = [
      page.getByRole('link', { name: '週' }),
      page.getByRole('link', { name: '繰り返し' }),
      page.getByRole('link', { name: 'やること' }),
      page.getByRole('link', { name: '家族' }),
    ];
    for (const link of tabLinks) {
      const box = await link.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }

    const captureBox = await page.getByRole('button', { name: 'プリントを撮影' }).boundingBox();
    expect(captureBox).not.toBeNull();
    if (captureBox) {
      expect(captureBox.width).toBeGreaterThanOrEqual(56);
      expect(captureBox.height).toBeGreaterThanOrEqual(56);
    }
  });

  test('Viewport 390px maintains responsive layout without horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const hasOverflow = await page.evaluate(() => {
      const docWidth = document.documentElement.scrollWidth;
      const winWidth = window.innerWidth;
      return docWidth > winWidth;
    });
    expect(hasOverflow).toBe(false);
  });

  test('Changing CSS tokens (--accent, Card spacing/radius) dynamically updates computed styles', async ({
    page,
  }) => {
    // 1. Accent color override (auto-retrying assertion across CSS transitions)
    const captureBtn = page.getByRole('button', { name: 'プリントを撮影' });
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--accent', '#00aa55');
    });
    await expect(captureBtn).toHaveCSS('background-color', 'rgb(0, 170, 85)');

    // 2. Card spacing and radius override
    const card = page.getByTestId('showcase-card');
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--radius-md', '26px');
      document.documentElement.style.setProperty('--spacing-md', '30px');
    });
    await expect(card).toHaveCSS('border-radius', '26px');
    await expect(card).toHaveCSS('padding-top', '30px');
  });
});
