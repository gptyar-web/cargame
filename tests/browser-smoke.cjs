/* Optional end-to-end test. No real accounts or database are touched. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');

async function waitUntil(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const { createApplication } = await import(pathToFileURL(path.join(root, 'server/app.js')));
  const { openDatabase } = await import(pathToFileURL(path.join(root, 'server/database.js')));
  const { hashPassword } = await import(pathToFileURL(path.join(root, 'server/passwords.js')));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cargame-browser-'));
  const databasePath = path.join(directory, 'game.sqlite');
  const password = randomBytes(18).toString('base64url');
  const database = openDatabase(databasePath);
  database.prepare('INSERT INTO admins (username,password_hash,created_at) VALUES (?,?,?)').run('smokeadmin', await hashPassword(password), Date.now());
  database.close();
  const application = createApplication({ publicDirectory: root, databasePath });
  let browser;
  try {
    await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${application.server.address().port}`;
    let executablePath = process.env.CHROMIUM_PATH;
    if (!executablePath) {
      try { await fs.access('/usr/bin/chromium'); executablePath = '/usr/bin/chromium'; }
      catch { /* Playwright can use its downloaded Chromium on other platforms. */ }
    }
    browser = await playwright.chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    const failedResponses = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 500) failedResponses.push(response.url()); });
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.carGame), null, { timeout: 60000 });
    if (process.env.SCREENSHOT_DIR) {
      await fs.mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'garage-desktop.png'), fullPage: true });
    }
    assert.equal(await page.evaluate(() => window.carGame.getState().started), false, 'initial menu must pause driving');
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.carGame.getState().started), false, 'Space in menu must not start driving');
    assert.equal(await page.locator('[data-car-id]').count(), 6, 'six selectable cars');
    await page.locator('[data-car-id="sport"]').click();
    assert.equal(await page.locator('[data-car-id="sport"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#helpButton').click();
    assert.equal(await page.locator('#helpDialog').evaluate(dialog => dialog.open), true);
    await page.locator('#helpDialog [data-close]').first().click();
    await page.locator('#accountButton').click();
    await page.locator('#registerTab').click();
    for (const [name, value] of Object.entries({ firstName: 'آرش', lastName: 'آزمایش', mobile: '۰۹۱۲۳۴۵۶۷۸۹', nickname: 'رانندهٔ آزمایشی', password })) {
      await page.locator(`#registerForm [name="${name}"]`).fill(value);
    }
    await page.locator('#registerForm [name="gender"]').selectOption('مرد');
    await page.locator('#registerForm button[type="submit"]').click();
    await waitUntil(() => page.evaluate(async () => (await (await fetch('/api/me')).json()).user?.nickname === 'رانندهٔ آزمایشی'), 'registration creates session');
    await page.waitForFunction(() => !document.querySelector('#accountDialog').open);
    await page.locator('#startButton').click();
    await page.waitForFunction(() => window.carGame.getState().started);
    await page.keyboard.down('ArrowUp');
    await page.waitForFunction(() => Math.abs(window.carGame.getState().speed) > 1);
    await page.keyboard.up('ArrowUp');
    const driving = await page.evaluate(() => window.carGame.getState());
    assert.equal(driving.carId, 'sport');
    assert.equal(driving.maxSpeed, 300);
    assert.equal(await page.locator('#helpButton').isVisible(), false, 'help belongs only to menu');
    assert.ok(driving.fuel < 100, 'driving consumes fuel');
    assert.equal(await page.locator('#autoDriveButton').getAttribute('aria-pressed'), 'false');
    await page.locator('#autoDriveButton').click();
    assert.equal(await page.evaluate(() => window.carGame.getState().autoDriving), true);
    assert.equal(await page.locator('#autoDriveButton').getAttribute('aria-pressed'), 'true');
    await page.keyboard.down('ArrowUp');
    assert.equal(await page.evaluate(() => window.carGame.getState().autoDriving), false, 'manual driving immediately cancels auto-drive');
    await page.keyboard.up('ArrowUp');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'driving-desktop.png') });
    await page.keyboard.press('KeyQ');
    assert.equal(await page.evaluate(() => window.carGame.getState().signal), 'left');
    await page.keyboard.press('KeyE');
    assert.equal(await page.evaluate(() => window.carGame.getState().signal), 'right');
    await page.keyboard.press('KeyH');
    await page.keyboard.press('KeyL');
    assert.equal(await page.evaluate(() => window.carGame.getState().lights), false);
    await page.locator('#soundButton').click();
    assert.equal(await page.evaluate(() => window.carGame.getState().muted), true);
    await page.locator('#cameraButton').click();
    assert.equal(await page.evaluate(() => window.carGame.getState().cameraMode), 1);
    await page.locator('#resetButton').click();
    await page.keyboard.down('ArrowUp');
    await page.keyboard.down('ArrowRight');
    await page.waitForFunction(() => {
      const state = window.carGame.getState();
      return Math.hypot(state.position.x - state.stations[0].x, state.position.z - state.stations[0].z) < 9;
    }, null, { timeout: 15000 });
    await page.keyboard.up('ArrowRight');
    await page.keyboard.up('ArrowUp');
    await page.keyboard.down('Space');
    await page.waitForFunction(() => window.carGame.getState().speed === 0);
    await page.keyboard.up('Space');
    assert.equal(await page.evaluate(() => window.carGame.getState().refuelAvailable), true, 'gas station is reachable by driving');
    assert.ok(await page.evaluate(() => window.carGame.getState().fuel < 100));
    await page.locator('#refuelButton').click();
    await page.waitForFunction(() => window.carGame.getState().fuel === 100);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.carGame.getState().started);
    const position = await page.evaluate(() => window.carGame.getState().position);
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowUp');
    assert.deepEqual(await page.evaluate(() => window.carGame.getState().position), position, 'paused car remains stationary');
    // Exercise the UI's public progress event contract, then verify server persistence.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('game-progress', { detail: { coinsDelta: 2, scoreDelta: 200 } })));
    await waitUntil(() => page.evaluate(async () => { const {user} = await (await fetch('/api/me')).json(); return user?.coins >= 2 && user.score >= 200; }), 'progress reaches server');
    const persisted = await page.evaluate(async () => (await (await fetch('/api/me')).json()).user);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.carGame));
    assert.equal((await page.evaluate(async () => (await (await fetch('/api/me')).json()).user)).coins, persisted.coins);
    await page.locator('#accountButton').click();
    await page.locator('#logoutButton').click();
    await waitUntil(() => page.evaluate(async () => (await (await fetch('/api/me')).json()).user === null), 'logout invalidates session');
    await page.waitForFunction(() => !document.querySelector('#accountDialog').open);
    await page.locator('#accountButton').click();
    await page.locator('#loginTab').click();
    await page.locator('#loginForm [name="mobile"]').fill('09123456789');
    await page.locator('#loginForm [name="password"]').fill('wrong-password');
    await page.locator('#loginForm button[type="submit"]').click();
    await page.locator('#loginError').waitFor({ state: 'visible' });
    await page.locator('#loginForm [name="password"]').fill(password);
    await page.locator('#loginForm button[type="submit"]').click();
    await waitUntil(() => page.evaluate(async () => Boolean((await (await fetch('/api/me')).json()).user)), 'login creates session');
    await page.waitForFunction(() => !document.querySelector('#accountDialog').open);

    // Tabs share cookies and storage. Concurrent offline queues must retain both receipts.
    const secondTab = await context.newPage();
    secondTab.on('pageerror', error => errors.push(error.message));
    await secondTab.goto(origin, { waitUntil: 'networkidle' });
    const beforeTabs = await page.evaluate(async () => (await (await fetch('/api/me')).json()).user);
    let offlineProgress = true;
    await context.route('**/api/progress', route => offlineProgress ? route.abort('failed') : route.continue());
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('game-progress', { detail: { coinsDelta: 1, scoreDelta: 100 } })));
    await secondTab.evaluate(() => window.dispatchEvent(new CustomEvent('game-progress', { detail: { coinsDelta: 3, scoreDelta: 300 } })));
    const queueKeys = await page.evaluate(id => Object.keys(localStorage).filter(key => key.startsWith(`cargame.v2.pending.${id}.`)), beforeTabs.id);
    assert.equal(queueKeys.length, 2, 'each tab retains its own immutable receipt');
    await page.waitForTimeout(900);
    offlineProgress = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await secondTab.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntil(() => page.evaluate(async expected => (await (await fetch('/api/me')).json()).user.coins === expected, beforeTabs.coins + 4), 'both offline receipts reach the server exactly once');
    await waitUntil(() => page.evaluate(id => Object.keys(localStorage).every(key => !key.startsWith(`cargame.v2.pending.${id}.`)), beforeTabs.id), 'acknowledged receipts leave storage');

    // Logging in elsewhere must never redirect this tab's pending coins into that account.
    const changed = await secondTab.evaluate(async password => {
      const response = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: 'سارا', lastName: 'آزمایش', mobile: '09123456780', gender: 'زن', nickname: 'راننده دوم', password }) });
      return { status: response.status, ...(await response.json()) };
    }, password);
    assert.equal(changed.status, 201);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('game-progress', { detail: { coinsDelta: 7, scoreDelta: 700 } })));
    await waitUntil(() => page.locator('#profileLabel').textContent().then(text => text === 'راننده دوم'), 'tab refreshes its changed session');
    assert.equal((await page.evaluate(async () => (await (await fetch('/api/me')).json()).user)).coins, 0, 'new account receives none of the old account progress');
    assert.equal(await page.evaluate(id => Object.keys(localStorage).some(key => key.startsWith(`cargame.v2.pending.${id}.`)), beforeTabs.id), true, 'old account progress remains recoverable');
    await page.evaluate(async password => { await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: '09123456789', password }) }); }, password);
    await page.reload({ waitUntil: 'networkidle' });
    await waitUntil(() => page.evaluate(async expected => (await (await fetch('/api/me')).json()).user.coins === expected, beforeTabs.coins + 11), 'old pending progress resumes for its owner');
    await secondTab.close();
    await context.unroute('**/api/progress');

    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    admin.on('pageerror', error => errors.push(error.message));
    await admin.goto(origin + '/admin', { waitUntil: 'networkidle' });
    assert.equal(await admin.locator('#adminDashboard').isVisible(), false);
    await admin.locator('#adminLoginForm [name="username"]').fill('smokeadmin');
    await admin.locator('#adminLoginForm [name="password"]').fill(password);
    await admin.locator('#adminLoginForm button[type="submit"]').click();
    await admin.locator('#adminDashboard').waitFor({ state: 'visible' });
    await admin.locator('#adminUsersBody tr').first().waitFor();
    assert.ok((await admin.locator('#adminUsersBody').textContent()).includes('رانندهٔ آزمایشی'));
    await admin.locator('#adminLogoutButton').click();
    await admin.locator('#adminLoginPanel').waitFor({ state: 'visible' });
    await adminContext.close();
    for (const [id, maxSpeed] of Object.entries({ compact: 100, sedan: 160, suv: 220, sport: 300, super: 400, hyper: 500 })) {
      await page.locator(`[data-car-id="${id}"]`).click();
      await page.locator('#startButton').click();
      assert.equal(await page.evaluate(() => window.carGame.getState().maxSpeed), maxSpeed);
      assert.equal(await page.locator('#speedMax').textContent(), String(maxSpeed));
      await page.locator('#menuButton').click();
    }
    await page.locator('[data-car-id="sport"]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, 'mobile menu must fit viewport');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'garage-mobile.png'), fullPage: true });
    await page.locator('#startButton').click();
    for (const selector of ['#autoDriveButton', '#menuButton', '#hornButton', '#refuelButton', '#leftSignalButton', '#rightSignalButton', '[data-control="up"]', '[data-control="down"]', '[data-control="left"]', '[data-control="right"]']) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 391 && box.y + box.height <= 845, `${selector} remains inside mobile viewport`);
    }
    const gas = await page.locator('[data-control="up"]').boundingBox();
    await page.mouse.move(gas.x + gas.width / 2, gas.y + gas.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => window.carGame.getState().speed > 1);
    await page.mouse.up();
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'driving-mobile.png') });
    await page.locator('#menuButton').click();
    assert.deepEqual(errors, [], 'no browser errors');
    assert.deepEqual(failedResponses, [], 'no failed server requests');
    console.log('Browser smoke passed: six cars, help, registration/login/logout, saved progress, offline concurrent tabs and owner changes, admin users/role, driving/refueling/controls, pause, mobile layout/held controls.');
  } finally {
    await browser?.close();
    await application.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
