/**
 * Activity rail — the icon column that replaces the sidebar's text tab strip.
 *
 * Contract under test (docs/plans/2026-09-07-activity-rail.md ▸ Show / hide model):
 *   - rail is always visible; sidebar is open or hidden
 *   - click a destination → open it; click the active one → hide
 *   - hidden content comes back exactly as left (React state + scroll)
 *   - hidden state and active tab persist across reload
 *   - badges are signals only — they never open the sidebar
 *   - the legacy strip is one setting away and the same `data-sidebar-tab`
 *     selectors work against both layouts
 *
 * DOM facts:
 *   - rail: `[data-testid="activity-rail"]`, `data-collapsed="true|false"`
 *   - items: `[data-sidebar-tab="library|tools|debug|settings"]`
 *   - sidebar container: `.sidebar` (display:none while hidden)
 *   - dev hook: `window.__sidebar` (Vite dev server → import.meta.env.DEV)
 */
import { test, expect, type Page } from '@playwright/test';

const RAIL = '[data-testid="activity-rail"]';
const tab = (id: string) => `[data-sidebar-tab="${id}"]`;

async function gotoApp(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect(page.locator(RAIL)).toBeVisible();
}

test.describe('activity rail', () => {
  test.beforeEach(async ({ page }) => {
    // Every test starts from a clean sidebar: open, on Library, rail on.
    // Init scripts re-run on every navigation, including page.reload(), so the
    // wipe is guarded by a sessionStorage flag — otherwise the persistence
    // test would be checking keys this script had just deleted.
    await page.addInitScript(() => {
      if (sessionStorage.getItem('activity-rail-spec-init')) return;
      sessionStorage.setItem('activity-rail-spec-init', '1');
      for (const k of [
        'boardripper-sidebar-collapsed', 'boardripper-sidebar-tab', 'boardripper-sidebar-rail',
        'boardripper-sidebar-side', 'boardripper-sidebar-captions', 'boardripper-settings-active-tab',
      ]) {
        localStorage.removeItem(k);
      }
    });
  });

  test('renders the four destinations plus a hide control, and retires the text strip and the edge arrow', async ({ page }) => {
    await gotoApp(page);
    for (const id of ['library', 'tools', 'debug', 'settings']) {
      await expect(page.locator(`${RAIL} ${tab(id)}`)).toBeVisible();
    }
    await expect(page.getByTestId('rail-toggle')).toBeVisible();
    await expect(page.locator('.sidebar-tabs')).toHaveCount(0);
    await expect(page.locator('.sidebar-toggle.collapsed')).toHaveCount(0);
    // The toolbar ≡ stays: it is the "nothing but the board" control.
    await expect(page.getByTestId('sidebar-area-toggle')).toBeVisible();
    // Library is the default and is marked active.
    await expect(page.locator(`${RAIL} ${tab('library')}`)).toHaveAttribute('aria-selected', 'true');
  });

  test('the rail hide control hides and shows the panel; the rail stays', async ({ page }) => {
    await gotoApp(page);
    await page.getByTestId('rail-toggle').click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator(RAIL)).toBeVisible();
    await expect(page.getByTestId('rail-toggle')).toHaveAttribute('data-title', /Show Library/);
    await page.getByTestId('rail-toggle').click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.getByTestId('rail-toggle')).toHaveAttribute('data-title', 'Hide sidebar');
  });

  test('toolbar ≡ hides panel AND rail — nothing but the board — and the edge arrow or ≡ brings both back', async ({ page }) => {
    await gotoApp(page);
    await page.click(`${RAIL} ${tab('tools')}`);
    await page.getByTestId('sidebar-area-toggle').click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator(RAIL)).toHaveCount(0);
    await expect(page.locator('.sidebar-toggle.collapsed')).toBeVisible();

    // Persists: reload keeps everything hidden.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator(RAIL)).toHaveCount(0);
    await expect(page.locator('.sidebar-toggle.collapsed')).toBeVisible();

    // Edge arrow restores rail + panel, on the tab you left.
    await page.click('.sidebar-toggle.collapsed');
    await expect(page.locator(RAIL)).toBeVisible();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator(`${RAIL} ${tab('tools')}`)).toHaveAttribute('aria-selected', 'true');

    // ≡ again hides both; ≡ once more restores both.
    await page.getByTestId('sidebar-area-toggle').click();
    await expect(page.locator(RAIL)).toHaveCount(0);
    await page.getByTestId('sidebar-area-toggle').click();
    await expect(page.locator(RAIL)).toBeVisible();
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('a deep link (showSidebarTab) brings the rail back when everything is hidden', async ({ page }) => {
    await gotoApp(page);
    await page.getByTestId('sidebar-area-toggle').click();
    await expect(page.locator(RAIL)).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { __sidebar: { show: (t: string) => void } }).__sidebar.show('debug'));
    await expect(page.locator(RAIL)).toBeVisible();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator(`${RAIL} ${tab('debug')}`)).toHaveAttribute('aria-selected', 'true');
  });

  test('Library and Settings strips use the same icon-tab cell: icons stay put, only the open tab is captioned', async ({ page }) => {
    await gotoApp(page);
    // Settings strip.
    await page.click(`${RAIL} ${tab('settings')}`);
    const sTabs = page.locator('.sidebar [data-settings-tab]');
    await expect(sTabs).toHaveCount(6);
    const before = await sTabs.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().x)));
    await page.locator('.sidebar [data-settings-tab="input"]').click();
    const after = await sTabs.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().x)));
    expect(after).toEqual(before);
    await expect(page.locator('.sidebar [data-settings-tab] .icon-tab-caption')).toHaveCount(1);
    await expect(page.locator('.sidebar [data-settings-tab="input"] .icon-tab-caption')).toHaveText('Input');

    // Library strip — same class, same rule.
    await page.click(`${RAIL} ${tab('library')}`);
    const lTabs = page.locator('.sidebar [data-library-tab]');
    await expect(lTabs).toHaveCount(4);
    for (let i = 0; i < 4; i++) await expect(lTabs.nth(i)).toHaveClass(/icon-tab/);
    const lBefore = await lTabs.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().x)));
    await page.locator('.sidebar [data-library-tab="folders"]').click();
    const lAfter = await lTabs.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().x)));
    expect(lAfter).toEqual(lBefore);
    await expect(page.locator('.sidebar [data-library-tab] .icon-tab-caption')).toHaveCount(1);
    await expect(page.locator('.sidebar [data-library-tab="folders"] .icon-tab-caption')).toHaveText('Folders');
  });

  test('click switches; clicking the active item hides; clicking it again shows the same panel', async ({ page }) => {
    await gotoApp(page);
    const rail = page.locator(RAIL);
    const sidebar = page.locator('.sidebar');

    await page.click(`${RAIL} ${tab('tools')}`);
    await expect(page.getByTestId('tools-panel')).toBeVisible();
    await expect(page.locator(`${RAIL} ${tab('tools')}`)).toHaveAttribute('aria-selected', 'true');

    await page.click(`${RAIL} ${tab('tools')}`);
    await expect(sidebar).toBeHidden();
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute('data-collapsed', 'true');
    // The destination stays marked while hidden — it is where you return to.
    await expect(page.locator(`${RAIL} ${tab('tools')}`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`${RAIL} ${tab('tools')}`)).toHaveAttribute('data-title', /click to show/);

    await page.click(`${RAIL} ${tab('tools')}`);
    await expect(sidebar).toBeVisible();
    await expect(page.getByTestId('tools-panel')).toBeVisible();
    await expect(rail).toHaveAttribute('data-collapsed', 'false');
    await expect(page.locator(`${RAIL} ${tab('tools')}`)).toHaveAttribute('data-title', /click to hide/);
  });

  test('clicking a different item while hidden opens that item directly', async ({ page }) => {
    await gotoApp(page);
    await page.click(`${RAIL} ${tab('library')}`);           // hide (library is active)
    await expect(page.locator('.sidebar')).toBeHidden();
    await page.click(`${RAIL} ${tab('settings')}`);
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator(`${RAIL} ${tab('settings')}`)).toHaveAttribute('aria-selected', 'true');
  });

  test('hidden content comes back exactly as left — drill-down state and scroll offset', async ({ page }) => {
    await gotoApp(page);

    // React state: drill into a Tools calculator.
    await page.click(`${RAIL} ${tab('tools')}`);
    await page.getByTestId('tools-entry-resistor').click();
    await expect(page.getByTestId('tools-back')).toBeVisible();

    // Scroll offset: Settings ▸ Theme is long. Rather than guess which element
    // owns the scrollbar, scroll the panel's last heading into view and walk
    // up to whichever ancestor actually moved — that is the scroller. Tag it.
    await page.click(`${RAIL} ${tab('settings')}`);
    await page.locator('.sidebar').getByRole('button', { name: 'Theme' }).click();
    const scrolled = await page.evaluate(() => {
      const side = document.querySelector<HTMLElement>('.sidebar');
      if (!side) return -1;
      const leaves = Array.from(side.querySelectorAll<HTMLElement>('label, p, div'))
        .filter(el => el.offsetParent !== null && el.children.length === 0 && el.textContent?.trim());
      const target = leaves[leaves.length - 1];
      if (!target) return -1;
      target.scrollIntoView({ block: 'end' });
      let el: HTMLElement | null = target;
      while (el && el !== side) {
        if (el.scrollTop > 0) {
          el.setAttribute('data-rail-test-scroller', '1');
          return el.scrollTop;
        }
        el = el.parentElement;
      }
      return -1;
    });
    expect(scrolled).toBeGreaterThan(0);

    // Hide via the active item, then show again.
    await page.click(`${RAIL} ${tab('settings')}`);
    await expect(page.locator('.sidebar')).toBeHidden();
    await page.click(`${RAIL} ${tab('settings')}`);
    await expect(page.locator('.sidebar')).toBeVisible();

    const after = await page.evaluate(() =>
      document.querySelector<HTMLElement>('[data-rail-test-scroller]')?.scrollTop ?? -1,
    );
    expect(after).toBe(scrolled);

    // And the Tools drill-down is still where we left it.
    await page.click(`${RAIL} ${tab('tools')}`);
    await expect(page.getByTestId('tools-back')).toBeVisible();
  });

  test('hidden state and active tab persist across reload', async ({ page }) => {
    await gotoApp(page);
    await page.click(`${RAIL} ${tab('debug')}`);
    await page.click(`${RAIL} ${tab('debug')}`);               // hide
    await expect(page.locator('.sidebar')).toBeHidden();

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator(RAIL)).toHaveAttribute('data-collapsed', 'true');
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator(`${RAIL} ${tab('debug')}`)).toHaveAttribute('aria-selected', 'true');

    // Show again, reload → still open on Debug.
    await page.click(`${RAIL} ${tab('debug')}`);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator(`${RAIL} ${tab('debug')}`)).toHaveAttribute('aria-selected', 'true');
  });

  test('a fresh profile still opens on Library, exactly as before the rail', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator(`${RAIL} ${tab('library')}`)).toHaveAttribute('aria-selected', 'true');
  });

  test('right-click menu moves the rail and sidebar to the other side', async ({ page }) => {
    await gotoApp(page);
    await page.click(RAIL, { button: 'right' });
    const menu = page.getByTestId('activity-rail-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Move sidebar to right' }).click();
    await expect(menu).toBeHidden();

    const rail = page.locator(RAIL);
    await expect(rail).toHaveClass(/activity-rail-right/);
    const railBox = await rail.boundingBox();
    const dockBox = await page.locator('.dockview-container').boundingBox();
    expect(railBox && dockBox && railBox.x > dockBox.x).toBeTruthy();

    // Escape closes the menu without acting.
    await page.click(RAIL, { button: 'right' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('keyboard: arrows move focus along the rail, Enter activates', async ({ page }) => {
    await gotoApp(page);
    await page.focus(`${RAIL} ${tab('library')}`);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator(`${RAIL} ${tab('tools')}`)).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.locator(`${RAIL} ${tab('settings')}`)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator(`${RAIL} ${tab('settings')}`)).toHaveAttribute('aria-selected', 'true');
  });

  test('Debug badge counts new errors, never opens the sidebar, and clears when Debug is viewed', async ({ page }) => {
    await gotoApp(page);
    await page.click(`${RAIL} ${tab('library')}`);              // hide
    await expect(page.locator('.sidebar')).toBeHidden();

    // console.error is intercepted by logStore and tagged as an error entry.
    await page.evaluate(() => { console.error('activity-rail badge probe'); });
    const badge = page.getByTestId('rail-badge-debug');
    await expect(badge).toHaveText('1');
    await expect(page.locator('.sidebar')).toBeHidden();          // signal only

    await page.evaluate(() => { console.error('second probe'); });
    await expect(badge).toHaveText('2');

    await page.click(`${RAIL} ${tab('debug')}`);
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(badge).toHaveCount(0);

    // Errors that arrive while Debug is open are already "seen".
    await page.evaluate(() => { console.error('while open'); });
    await expect(badge).toHaveCount(0);
  });

  test('Settings ▸ Sidebar navigation switches to the legacy strip and back without losing state', async ({ page }) => {
    await gotoApp(page);
    await page.click(`${RAIL} ${tab('settings')}`);
    // The switch lives on the Theme tab; Settings remembers its last tab.
    await page.locator('.sidebar').getByRole('button', { name: 'Theme' }).click();
    await page.getByTestId('sidebar-nav-strip').click();

    await expect(page.locator(RAIL)).toHaveCount(0);
    await expect(page.locator('.sidebar-tabs')).toBeVisible();
    await expect(page.getByTestId('sidebar-area-toggle')).toBeVisible();
    // Same selector, same active tab, on the strip.
    await expect(page.locator(`.sidebar-tabs ${tab('settings')}`)).toHaveClass(/active/);

    await page.getByTestId('sidebar-nav-rail').click();
    await expect(page.locator(RAIL)).toBeVisible();
    await expect(page.locator(`${RAIL} ${tab('settings')}`)).toHaveAttribute('aria-selected', 'true');
  });

  test('legacy strip mode: ≡ and the edge arrow still hide and show', async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem('boardripper-sidebar-rail', 'false'); });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator(RAIL)).toHaveCount(0);
    await expect(page.locator('.sidebar-tabs')).toBeVisible();

    await page.getByTestId('sidebar-area-toggle').click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.sidebar-toggle.collapsed')).toBeVisible();
    await page.click('.sidebar-toggle.collapsed');
    await expect(page.locator('.sidebar')).toBeVisible();
  });
});
