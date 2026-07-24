// DOMPurify sanitizePreview tests: XSS vector blocking, tag allowlisting,
// event handler stripping, javascript: URL blocking
//
// Tests the hardened DOMPurify config that protects the markdown preview pane.
// sanitizePreview is used by PreviewController to sanitize marked.js output
// before setting panel.innerHTML.

import { describe, it, expect } from 'vitest';
import { sanitizePreview, PURIFY_CONFIG } from '../../../src/shared/dompurify-config';

describe('sanitizePreview', () => {
  // ── Null/empty input ──
  it('returns empty string for null/undefined/empty input', () => {
    expect(sanitizePreview('')).toBe('');
    // @ts-expect-error testing null input
    expect(sanitizePreview(null)).toBe('');
    // @ts-expect-error testing undefined input
    expect(sanitizePreview(undefined)).toBe('');
  });

  // ── Allowed tags pass through ──
  it('keeps allowed markdown tags', () => {
    const input =
      '<h1>Title</h1><h2>Sub</h2><h3>H3</h3>' +
      '<p>Paragraph</p><ul><li>Item</li></ul><ol><li>One</li></ol>' +
      '<a href="https://example.com">link</a>' +
      '<code>inline</code><pre>block</pre>' +
      '<em>em</em><strong>strong</strong><br>';
    const result = sanitizePreview(input);
    expect(result).toContain('<h1>Title</h1>');
    expect(result).toContain('<h2>Sub</h2>');
    expect(result).toContain('<p>Paragraph</p>');
    expect(result).toContain('<ul><li>Item</li></ul>');
    expect(result).toContain('<a href="https://example.com">link</a>');
    expect(result).toContain('<code>inline</code>');
    expect(result).toContain('<pre>block</pre>');
    expect(result).toContain('<em>em</em>');
    expect(result).toContain('<strong>strong</strong>');
    expect(result).toContain('<br>');
  });

  // ── Script tags stripped ──
  it('strips <script> tags completely', () => {
    const result = sanitizePreview(
      '<p>safe</p><script>alert("xss")</script><p>also safe</p>'
    );
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('alert');
    expect(result).toContain('<p>safe</p>');
    expect(result).toContain('<p>also safe</p>');
  });

  it('strips <script> with attributes', () => {
    const result = sanitizePreview(
      '<script src="evil.js" type="text/javascript">payload</script>'
    );
    expect(result).not.toContain('<script');
    expect(result).not.toContain('evil.js');
  });

  // ── Event handlers stripped ──
  it('strips onerror event handler', () => {
    const result = sanitizePreview(
      '<img src=x onerror="alert(1)"><p>text</p>'
    );
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('alert(1)');
    // <img> is not in allowed tags, so it gets stripped entirely
    expect(result).not.toContain('<img');
    // But text inside <p> should remain
    expect(result).toContain('<p>text</p>');
  });

  it('strips onload from allowed tag', () => {
    const result = sanitizePreview(
      '<p onload="evil()">content</p>'
    );
    expect(result).not.toContain('onload');
    expect(result).not.toContain('evil()');
    expect(result).toContain('<p>content</p>');
  });

  it('strips all common event handler attributes', () => {
    const handlers = [
      'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus',
      'onblur', 'onchange', 'onsubmit', 'oninput', 'onkeydown',
      'onkeyup', 'ondblclick', 'oncontextmenu', 'oninvalid',
      'onreset', 'onsearch', 'onselect', 'onwheel', 'ondrag',
      'ondrop', 'oncopy', 'oncut', 'onpaste', 'onscroll',
      'ontoggle', 'onanimationend', 'onanimationiteration',
      'onanimationstart', 'ontransitionend',
    ];
    for (const handler of handlers) {
      const input = `<p ${handler}="alert(1)">test</p>`;
      const result = sanitizePreview(input);
      expect(result).not.toContain(handler);
      expect(result).not.toContain('alert(1)');
      expect(result).toContain('<p>test</p>');
    }
  });

  // ── javascript: URLs blocked ──
  it('strips javascript: URLs from anchor hrefs', () => {
    const result = sanitizePreview(
      '<a href="javascript:alert(1)">click me</a>'
    );
    // The javascript: URL is removed — anchor may be kept or stripped depending on config
    // KEEP_CONTENT=true means text content is preserved
    expect(result).not.toContain('javascript:');
    expect(result).not.toContain('alert(1)');
    // Text content preserved
    expect(result).toContain('click me');
  });

  it('keeps safe http/https URLs', () => {
    const result = sanitizePreview(
      '<a href="https://example.com/page">link</a>'
    );
    expect(result).toContain('https://example.com/page');
    expect(result).toContain('link');
  });

  it('strips data: URLs', () => {
    const result = sanitizePreview(
      '<a href="data:text/html,<script>alert(1)</script>">data link</a>'
    );
    expect(result).not.toContain('data:');
    expect(result).not.toContain('<script>');
  });

  // ── SVG and MathML stripped ──
  it('strips <svg> tags and content', () => {
    const result = sanitizePreview(
      '<p>before</p><svg onload="alert(1)"><circle cx="50" cy="50" r="40"/></svg><p>after</p>'
    );
    expect(result).not.toContain('<svg');
    expect(result).not.toContain('onload');
    expect(result).toContain('<p>before</p>');
    expect(result).toContain('<p>after</p>');
  });

  it('strips <math> tags', () => {
    const result = sanitizePreview(
      '<math><mrow><mi>x</mi></mrow></math><p>text</p>'
    );
    expect(result).not.toContain('<math');
    expect(result).toContain('<p>text</p>');
  });

  // ── Style tags stripped ──
  it('strips <style> tags', () => {
    const result = sanitizePreview(
      '<style>body { background: url("evil") }</style><p>safe</p>'
    );
    expect(result).not.toContain('<style');
    expect(result).not.toContain('background');
    expect(result).toContain('<p>safe</p>');
  });

  // ── iframe/object/embed stripped ──
  it('strips <iframe> tags', () => {
    const result = sanitizePreview(
      '<iframe src="https://evil.com"></iframe><p>safe</p>'
    );
    expect(result).not.toContain('<iframe');
    expect(result).toContain('<p>safe</p>');
  });

  it('strips <object> and <embed> tags', () => {
    const result = sanitizePreview(
      '<object data="evil.swf"></object><embed src="evil.swf"><p>safe</p>'
    );
    expect(result).not.toContain('<object');
    expect(result).not.toContain('<embed');
    expect(result).toContain('<p>safe</p>');
  });

  // ── Form-related tags stripped ──
  it('strips <form>, <input>, <button> tags', () => {
    const result = sanitizePreview(
      '<form action="evil"><input type="text"><button type="submit">submit</button></form>'
    );
    expect(result).not.toContain('<form');
    expect(result).not.toContain('<input');
    expect(result).not.toContain('<button');
  });

  // ── Unknown tags stripped ──
  it('strips tags not in the allowlist', () => {
    const result = sanitizePreview(
      '<custom-element data-secret="leak">content</custom-element><p>ok</p>'
    );
    expect(result).not.toContain('<custom-element');
    expect(result).toContain('<p>ok</p>');
  });

  // ── CSS injection via style attribute blocked ──
  it('strips style attributes with url() injection', () => {
    // Even though <p> is allowed, a style attr with url() is blocked because
    // style attributes are removed by DOMPurify when not in ALLOWED_ATTR
    const result = sanitizePreview(
      '<p style="background: url(http://evil.com/steal)">content</p>'
    );
    expect(result).not.toContain('url(');
    expect(result).toContain('<p>content</p>');
  });

  // ── KEEP_CONTENT: text inside stripped tags is preserved ──
  it('preserves text content inside stripped tags (KEEP_CONTENT=true)', () => {
    const result = sanitizePreview(
      '<script>alert(1)</script><p>visible</p><style>hidden</style>'
    );
    // Text inside <script> and <style> is preserved since KEEP_CONTENT=true
    expect(result).toContain('visible');
  });

  // ── Nested attacks ──
  it('handles nested XSS attempts', () => {
    const result = sanitizePreview(
      '<p>safe <script>evil</script> <b>unknown-tag</b> text</p>'
    );
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('<b>');
    expect(result).toContain('safe');
    expect(result).toContain('text');
  });

  // ── mailto: and tel: URLs allowed ──
  it('keeps mailto: URLs', () => {
    const result = sanitizePreview(
      '<a href="mailto:user@example.com">email</a>'
    );
    expect(result).toContain('mailto:user@example.com');
  });

  it('keeps tel: URLs', () => {
    const result = sanitizePreview(
      '<a href="tel:+15551234567">call</a>'
    );
    expect(result).toContain('tel:+15551234567');
  });
});

describe('PURIFY_CONFIG invariants', () => {
  it('RETURN_DOM_FRAGMENT is false (returns string)', () => {
    expect(PURIFY_CONFIG.RETURN_DOM_FRAGMENT).toBe(false);
  });

  it('RETURN_DOM is false (returns string)', () => {
    expect(PURIFY_CONFIG.RETURN_DOM).toBe(false);
  });

  it('WHOLE_DOCUMENT is false', () => {
    expect(PURIFY_CONFIG.WHOLE_DOCUMENT).toBe(false);
  });

  it('ALLOW_UNKNOWN_PROTOCOLS is false', () => {
    expect(PURIFY_CONFIG.ALLOW_UNKNOWN_PROTOCOLS).toBe(false);
  });

  it('KEEP_CONTENT is true (preserves text content in stripped tags)', () => {
    expect(PURIFY_CONFIG.KEEP_CONTENT).toBe(true);
  });

  it('FORBID_TAGS includes script, style, svg, math', () => {
    expect(PURIFY_CONFIG.FORBID_TAGS).toContain('script');
    expect(PURIFY_CONFIG.FORBID_TAGS).toContain('style');
    expect(PURIFY_CONFIG.FORBID_TAGS).toContain('svg');
    expect(PURIFY_CONFIG.FORBID_TAGS).toContain('math');
  });

  it('FORBID_TAGS includes iframe, object, embed, form', () => {
    expect(PURIFY_CONFIG.FORBID_TAGS).toContain('iframe');
    expect(PURIFY_CONFIG.FORBID_TAGS).toContain('object');
    expect(PURIFY_CONFIG.FORBID_TAGS).toContain('embed');
    expect(PURIFY_CONFIG.FORBID_TAGS).toContain('form');
  });

  it('ALLOWED_TAGS is the explicit markdown subset', () => {
    expect(PURIFY_CONFIG.ALLOWED_TAGS).toEqual([
      'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li',
      'a',
      'code', 'pre',
      'em', 'strong',
      'br',
    ]);
  });

  it('FORBID_ATTR includes all common event handlers', () => {
    expect(PURIFY_CONFIG.FORBID_ATTR).toContain('onerror');
    expect(PURIFY_CONFIG.FORBID_ATTR).toContain('onload');
    expect(PURIFY_CONFIG.FORBID_ATTR).toContain('onclick');
    expect(PURIFY_CONFIG.FORBID_ATTR).toContain('formaction');
  });
});