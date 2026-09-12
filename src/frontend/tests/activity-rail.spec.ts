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
        'boardripper-sidebar-rail-hidden', 'boardripper-statusbar-hidden', 'boardripper-sidebar-autohide',
        'boardripper-sidebar-side', 'boardripper-sidebar-captions', 'boardripper-settings-active-tab',
      ]) {
        localStorage.removeItem(k);
      }
    });
  });

  test('renders the four destinations plus the status-bar toggle, and retires the text strip and the edge arrow', async ({ page }) => {
    await gotoApp(page);
    for (const id of ['library', 'tools', 'debug', 'settings']) {
      await expect(page.locator(`${RAIL} ${tab(id)}`)).toBeVisible();
    }
    await expect(page.getByTestId('rail-status-toggle')).toBeVisible();
    // No separate "hide panel" button: clicking the active destination is the gesture.
    await expect(page.getByTestId('rail-toggle')).toHaveCount(0);
    await expect(page.locator('.sidebar-tabs')).toHaveCount(0);
    await expect(page.locator('.sidebar-toggle.collapsed')).toHaveCount(0);
    // The toolbar ≡ stays: it is the "nothing but the board" control.
    await expect(page.getByTestId('sidebar-area-toggle')).toBeVisible();
    // Library is the default and is marked active.
    await expect(page.locator(`${RAIL} ${tab('library')}`)).toHaveAttribute('aria-selected', 'true');
  });

  test('clicking the active icon hides only the panel — the status bar is not touched', async ({ page }) => {
    await gotoApp(page);
    await page.click(`${RAIL} ${tab('library')}`);
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.statusbar')).toBeVisible();
  });

  test('the foot-of-rail control toggles the status bar alone and persists', async ({ page }) => {
    await gotoApp(page);
    const st = page.getByTestId('rail-status-toggle');
    await expect(st).toHaveAttribute('aria-pressed', 'true');
    // The toggle lives in the status bar's own row: same top, same height.
    const [tb, sb] = await Promise.all([st.boundingBox(), page.locator('.statusbar').boundingBox()]);
    expect(tb && sb && Math.abs(tb.y - sb.y) <= 1 && Math.abs(tb.height - sb.height) <= 1).toBeTruthy();
    await st.click();
    await expect(page.locator('.statusbar')).toHaveCount(0);
    await expect(page.locator('.sidebar')).toBeVisible();           // panel unaffected
    await expect(st).toHaveAttribute('aria-pressed', 'false');

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.statusbar')).toHaveCount(0);
    await page.getByTestId('rail-status-toggle').click();
    await expect(page.locator('.statusbar')).toBeVisible();
  });

  test('toolbar ≡ cycles open → icons only → nothing but the board → open, on the tab you had', async ({ page }) => {
    await gotoApp(page);
    const cyc = page.getByTestId('sidebar-area-toggle');
    await page.click(`${RAIL} ${tab('tools')}`);
    await expect(cyc).toHaveAttribute('data-sidebar-stage', 'open');

    // 1: icons only — rail and status bar stay, panel goes.
    await cyc.click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator(RAIL)).toBeVisible();
    await expect(page.locator('.statusbar')).toBeVisible();
    await expect(cyc).toHaveAttribute('data-sidebar-stage', 'icons');

    // 2: nothing but the board — rail and status bar go too, edge arrow appears.
    await cyc.click();
    await expect(page.locator(RAIL)).toHaveCount(0);
    await expect(page.locator('.statusbar')).toHaveCount(0);
    await expect(page.locator('.sidebar-toggle.collapsed')).toBeVisible();
    await expect(cyc).toHaveAttribute('data-sidebar-stage', 'hidden');

    // Persists: reload keeps everything hidden.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator(RAIL)).toHaveCount(0);
    await expect(page.locator('.statusbar')).toHaveCount(0);

    // 3: back to open, on Tools, status bar back (its own preference was never touched).
    await page.getByTestId('sidebar-area-toggle').click();
    await expect(page.locator(RAIL)).toBeVisible();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.statusbar')).toBeVisible();
    await expect(page.locator(`${RAIL} ${tab('tools')}`)).toHaveAttribute('aria-selected', 'true');
  });

  test('edge arrow jumps straight from nothing-but-the-board back to open', async ({ page }) => {
    await gotoApp(page);
    const cyc = page.getByTestId('sidebar-area-toggle');
    await cyc.click(); await cyc.click();
    await expect(page.locator(RAIL)).toHaveCount(0);
    await page.click('.sidebar-toggle.collapsed');
    await expect(page.locator(RAIL)).toBeVisible();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.statusbar')).toBeVisible();
  });

  test('nothing-but-the-board hides the status bar without clobbering the foot toggle preference', async ({ page }) => {
    await gotoApp(page);
    const cyc = page.getByTestId('sidebar-area-toggle');
    // Explicitly hide the status bar first.
    await page.getByTestId('rail-status-toggle').click();
    await expect(page.locator('.statusbar')).toHaveCount(0);
    await cyc.click(); await cyc.click(); await cyc.click();     // full cycle back to open
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.statusbar')).toHaveCount(0);      // still hidden: the preference survived
    await expect(page.getByTestId('rail-status-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  test('auto-hide: panel overlays the board without moving it, and any click into the board hides it', async ({ page }) => {
    await gotoApp(page);
    const dock = page.locator('.dockview-container');
    // Width of the board area with the panel HIDDEN is the reference.
    await page.click(`${RAIL} ${tab('library')}`);
    await expect(page.locator('.sidebar')).toBeHidden();
    const hiddenBox = await dock.boundingBox();

    // Turn auto-hide on from the rail menu. Starts hidden.
    await page.click(RAIL, { button: 'right' });
    await page.getByTestId('rail-menu-autohide').click();
    await expect(page.locator('.sidebar')).toBeHidden();

    // Open Library: the panel appears as an overlay, the board area does not shrink.
    await page.click(`${RAIL} ${tab('library')}`);
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.sidebar')).toHaveClass(/sidebar-overlay/);
    const openBox = await dock.boundingBox();
    expect(openBox && hiddenBox && Math.abs(openBox.width - hiddenBox.width) <= 1 && Math.abs(openBox.x - hiddenBox.x) <= 1).toBeTruthy();

    // A click on the toolbar does NOT hide it; a click into the board area does.
    await page.mouse.click(700, 22);                                // toolbar row
    await expect(page.locator('.sidebar')).toBeVisible();
    const b = (await dock.boundingBox())!;
    await page.mouse.click(b.x + b.width - 40, b.y + b.height - 40); // far corner of the board area, clear of the overlay
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator(RAIL)).toBeVisible();

    // Reload with auto-hide on starts hidden even though the tab is remembered.
    await page.click(`${RAIL} ${tab('library')}`);
    await expect(page.locator('.sidebar')).toBeVisible();
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator(`${RAIL} ${tab('library')}`)).toHaveAttribute('aria-selected', 'true');

    // Off again: back to pushing layout.
    await page.click(RAIL, { button: 'right' });
    await page.getByTestId('rail-menu-autohide').click();
    await page.click(`${RAIL} ${tab('library')}`);
    await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-overlay/);
  });

  test('a deep link (showSidebarTab) brings the rail back when everything is hidden', async ({ page }) => {
    await gotoApp(page);
    await page.getByTestId('sidebar-area-toggle').click();
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

  test('Debug badge still counts when Debug is the active tab but the panel is hidden', async ({ page }) => {
    await gotoApp(page);
    await page.click(`${RAIL} ${tab('debug')}`);              // open Debug
    await page.click(`${RAIL} ${tab('debug')}`);              // hide it — Debug stays the active tab
    await expect(page.locator('.sidebar')).toBeHidden();
    await page.evaluate(() => { console.error('hidden-debug probe'); });
    await expect(page.getByTestId('rail-badge-debug')).toHaveText('1');
    await page.click(`${RAIL} ${tab('debug')}`);              // look at it → seen
    await expect(page.getByTestId('rail-badge-debug')).toHaveCount(0);
  });

  test('hovering an inactive icon tab previews its name; the active tab shows its caption instead', async ({ page }) => {
    await gotoApp(page);
    await page.click(`${RAIL} ${tab('settings')}`);
    const input = page.locator('.sidebar [data-settings-tab="input"]');
    await expect(input).toHaveAttribute('data-title', 'Input');
    await expect(input).not.toHaveAttribute('title', /.+/);            // one tooltip, not two
    await input.hover();
    await page.waitForTimeout(500);                                     // past the 300ms reveal delay
    const shown = await input.evaluate(el => {
      const cs = getComputedStyle(el, '::after');
      return { opacity: cs.opacity, content: cs.content };
    });
    expect(shown.opacity).toBe('1');
    expect(shown.content).toContain('Input');
    // Active tab: caption drawn, no hover label.
    await input.click();
    await expect(page.locator('.sidebar [data-settings-tab="input"] .icon-tab-caption')).toHaveText('Input');
    const active = await input.evaluate(el => getComputedStyle(el, '::after').content);
    expect(active === 'none' || active === '').toBeTruthy();
  });

  test('Settings ▸ Sidebar navigation also exposes side and auto-hide (touch has no right-click)', async ({ page }) => {
    await gotoApp(page);
    await page.click(`${RAIL} ${tab('settings')}`);
    await page.locator('.sidebar').getByRole('button', { name: 'Theme' }).click();
    await page.getByTestId('sidebar-nav-side-right').click();
    await expect(page.locator(RAIL)).toHaveClass(/activity-rail-right/);
    await page.getByTestId('sidebar-nav-side-left').click();
    await expect(page.locator(RAIL)).toHaveClass(/activity-rail-left/);
    await page.getByTestId('sidebar-nav-autohide').check();
    // Switching auto-hide on starts hidden, like boot.
    await expect(page.locator('.sidebar')).toBeHidden();
    await page.click(`${RAIL} ${tab('settings')}`);
    await expect(page.locator('.sidebar')).toHaveClass(/sidebar-overlay/);
    await page.getByTestId('sidebar-nav-autohide').uncheck();
    await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-overlay/);
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

  test('legacy strip mode: ≡ and the edge arrow still hide and show; status bar always present', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('boardripper-sidebar-rail', 'false');
      localStorage.setItem('boardripper-statusbar-hidden', 'true'); // must be ignored without a rail to un-hide it
      localStorage.setItem('boardripper-sidebar-autohide', 'true');  // rail-only too: must not force the strip to boot hidden
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator(RAIL)).toHaveCount(0);
    await expect(page.locator('.sidebar-tabs')).toBeVisible();
    await expect(page.locator('.statusbar')).toBeVisible();

    await page.getByTestId('sidebar-area-toggle').click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.statusbar')).toBeVisible();
    await expect(page.locator('.sidebar-toggle.collapsed')).toBeVisible();
    await page.click('.sidebar-toggle.collapsed');
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('the auto-hide switch is on the rail, toggles the mode, and agrees with the menu', async ({ page }) => {
    await gotoApp(page);
    const rail = page.getByTestId('activity-rail');
    const pin = page.getByTestId('rail-autohide-toggle');
    await expect(pin).toBeVisible();
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    await expect(pin).toHaveAttribute('data-title', 'Auto-hide · off');

    // Turning it on from the rail puts the panel in overlay mode.
    await pin.click();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await expect(await page.evaluate(() => (window as unknown as { __sidebar: { autoHide: () => boolean } }).__sidebar.autoHide())).toBe(true);

    // The hover label states the mode's value; it must never read as the
    // opposite of what is set, which is what an action label did here.
    await expect(pin).toHaveAttribute('data-title', 'Auto-hide · on');
    await expect(page.getByTestId('rail-status-toggle')).toHaveAttribute('data-title', /^Status bar · (on|off)$/);

    // The right-click menu shows the same state, and switching it there
    // switches the button — one mode, two controls.
    await rail.click({ button: 'right' });
    const item = page.getByTestId('rail-menu-autohide');
    await expect(item).toHaveAttribute('aria-checked', 'true');
    await item.click();
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    await expect(await page.evaluate(() => (window as unknown as { __sidebar: { autoHide: () => boolean } }).__sidebar.autoHide())).toBe(false);
  });
});
