import { chromium } from 'playwright';

const endpoint = process.env.DITTO_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const browser = await chromium.connectOverCDP(endpoint);
try {
  const context = browser.contexts()[0];
  let page = context.pages().find(page => page.url().includes('/demo.html'));
  if (!page) {
    page = await context.newPage();
    await page.goto('http://127.0.0.1:3217/demo.html');
  }
  await page.bringToFront();
  await page.getByLabel('你的名字').fill('AI on devbox');
  await page.getByRole('button', { name: '更新页面' }).click();
  await page.getByRole('link', { name: '打开第二个演示 Tab' }).scrollIntoViewIfNeeded();
  const newPage = context.waitForEvent('page');
  await page.getByRole('link', { name: '打开第二个演示 Tab' }).click();
  const second = await newPage;
  await second.waitForLoadState('domcontentloaded');
  await second.getByLabel('你的名字').fill('Second tab');
  await second.getByRole('button', { name: '更新页面' }).click();
  console.log('Demo complete: filled a field, clicked, scrolled and opened a second remote tab.');
} finally {
  // For connectOverCDP this disconnects this client, not Browser Service's persistent Chromium.
  await browser.close();
}
