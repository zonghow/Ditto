import test from 'node:test';
import assert from 'node:assert/strict';
import { reopenUrl } from '../public/tab-url.js';

test('reopens a protected same-origin destination from a stale sign-in page', () => {
  assert.equal(reopenUrl('https://app.example.com/sign-in?redirect=%2Fusage-logs%2Fcommon'),
    'https://app.example.com/usage-logs/common');
});

test('does not follow login redirects to other origins or unsafe protocols', () => {
  for (const redirect of ['https://evil.test', '//evil.test', 'javascript:alert(1)', 'https://user:pass@example.com/', 'http://example.com/']) {
    const url = `https://example.com/login?redirect=${encodeURIComponent(redirect)}`;
    assert.equal(reopenUrl(url), url);
  }
  assert.equal(reopenUrl('chrome://settings'), null);
  assert.equal(reopenUrl('file:///secret'), null);
  assert.equal(reopenUrl('https://user:pass@example.com/'), null);
  assert.equal(reopenUrl(undefined), null);
});

test('ordinary pages keep their original URL and do not interpret redirect parameters', () => {
  const url = 'https://example.com/report?redirect=%2Fother#section';
  assert.equal(reopenUrl(url), url);
});
