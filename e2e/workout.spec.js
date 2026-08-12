import { test, expect } from '@playwright/test';

test.describe('Local trial workout flow', () => {
  async function startLocalTrial(page) {
    await page.goto('/index.html');
    await page.locator('#local-trial-btn').click();

    const modal = page.locator('#local-modal');
    await modal.waitFor({ state: 'visible' });
    await modal.locator('button:has-text("Try without an account")').click();
    await page.locator('#start-empty-workout').waitFor();
  }

  test('starts local trial and creates an empty workout', async ({ page }) => {
    await startLocalTrial(page);
    await page.locator('#start-empty-workout').click();

    await expect(page.locator('#finish-workout')).toBeVisible();
  });

  test('returns to the active workout after adding from an exercise detail card', async ({ page }) => {
    await startLocalTrial(page);
    await page.locator('#start-empty-workout').click();
    await page.getByRole('button', { name: '+ Add Exercise', exact: true }).click();

    await page.getByRole('heading', { name: 'Squat', exact: true }).click();
    const detailModal = page.locator('#exercise-detail-modal');
    await expect(detailModal).toBeVisible();
    await detailModal.locator('#exercise-detail-add-to-workout').click();

    await expect(detailModal).toBeHidden();
    await expect(page.locator('#workout-view')).toBeVisible();
    await expect(page.locator('#workout-view .active-exercise h3')).toHaveCount(1);
    await expect(page.locator('#workout-view .active-exercise h3')).toContainText('Squat');
  });

  test('keeps the direct exercise-menu add flow working', async ({ page }) => {
    await startLocalTrial(page);
    await page.locator('#start-empty-workout').click();
    await page.getByRole('button', { name: '+ Add Exercise', exact: true }).click();
    await page.getByRole('button', { name: 'Add to Workout', exact: true }).first().click();

    await expect(page.locator('#workout-view')).toBeVisible();
    await expect(page.locator('#exercises-view')).toBeHidden();
    await expect(page.locator('#workout-view .active-exercise')).toHaveCount(1);
  });

  test('returns to the plan editor after adding from an exercise detail card', async ({ page }) => {
    await startLocalTrial(page);
    await page.locator('#nav-plans').click();
    await page.locator('#create-plan-btn').click();
    await page.locator('#add-exercise-to-plan').click();

    await page.getByRole('heading', { name: 'Squat', exact: true }).click();
    const detailModal = page.locator('#exercise-detail-modal');
    await expect(detailModal).toBeVisible();
    await expect(detailModal.locator('#exercise-detail-add-to-workout')).toHaveText('Add to Plan');
    await detailModal.locator('#exercise-detail-add-to-workout').click();

    await expect(detailModal).toBeHidden();
    await expect(page.locator('#plan-editor-view')).toBeVisible();
    await expect(page.locator('#plan-exercises-list .plan-exercise-row')).toHaveCount(1);
    await expect(page.locator('#plan-exercises-list')).toContainText('Squat');
  });

  test('cloud login reaches the API without requiring the Node Buffer global', async ({ page }) => {
    test.setTimeout(120_000);
    let loginCalls = 0;

    await page.route('**/api/auth/login', async (route) => {
      loginCalls += 1;
      const body = route.request().postDataJSON() || {};
      if (!body.signature) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ nonce: 'synthetic-login-nonce' }),
        });
        return;
      }
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'synthetic login stop' }),
      });
    });

    await page.goto('/index.html');
    await page.getByRole('button', { name: /Already have an account/ }).click();
    await page.locator('#username').fill('browser-test-user');
    await page.locator('#password').fill('NotARealPassword!123');
    await page.locator('#auth-btn').click();

    await expect(page.locator('#auth-error')).toHaveText('synthetic login stop', { timeout: 120_000 });
    expect(loginCalls).toBe(2);
  });
});
