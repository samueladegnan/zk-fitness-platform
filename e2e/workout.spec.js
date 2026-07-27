import { test, expect } from '@playwright/test';

test.describe('Local trial workout flow', () => {
  test('starts local trial and creates an empty workout', async ({ page }) => {
    await page.goto('/index.html');

    // Start the local trial from the auth screen.
    await page.locator('#local-trial-btn').click();

    // Confirm the zero-knowledge security modal.
    const modal = page.locator('#local-modal');
    await modal.waitFor({ state: 'visible' });
    await modal.locator('button:has-text("Try without an account")').click();

    // Wait for the dashboard and start an empty workout.
    await page.locator('#start-empty-workout').waitFor();
    await page.locator('#start-empty-workout').click();

    // The active workout view should appear with the finish button.
    await expect(page.locator('#finish-workout')).toBeVisible();
  });
});
