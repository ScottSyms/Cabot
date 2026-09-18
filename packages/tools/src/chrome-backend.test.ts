import { describe, expect, it } from 'vitest';
import { isReadableWebUrl } from './chrome-backend.js';

describe('readable web url policy', () => {
  it('accepts ordinary web pages', () => {
    expect(isReadableWebUrl('https://example.com/news')).toBe(true);
    expect(isReadableWebUrl('http://example.com')).toBe(true);
  });

  it('rejects the extension UI, browser internals, and non-web schemes', () => {
    expect(isReadableWebUrl('chrome-extension://abc/dist/workspace.html')).toBe(false);
    expect(isReadableWebUrl('chrome://extensions')).toBe(false);
    expect(isReadableWebUrl('edge://settings')).toBe(false);
    expect(isReadableWebUrl('about:blank')).toBe(false);
    expect(isReadableWebUrl('file:///etc/hosts')).toBe(false);
    expect(isReadableWebUrl('javascript:alert(1)')).toBe(false);
    expect(isReadableWebUrl(undefined)).toBe(false);
  });
});
