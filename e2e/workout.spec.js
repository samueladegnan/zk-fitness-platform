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
});
