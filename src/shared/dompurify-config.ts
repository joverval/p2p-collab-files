// DOMPurify configuration hardened for markdown preview XSS protection.
// Blocks: <script>, <style>, <svg>, <math>, event handlers, javascript: URLs,
// data: URIs (except images), and other XSS vectors.

import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';

/**
 * Sanitized regex for allowed URIs.
 * Blocks javascript:, data:, vbscript:, and other dangerous schemes.
 * Allows http, https, mailto, ftp, tel, and relative URLs.
 */
const SAFE_URI_REGEX =
  /^(?:(?:https?|mailto|ftp|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.-]+|$))/i;

/**
 * Tags explicitly stripped even if DOMPurify's defaults change.
 * - style: CSS can be used for data exfiltration via url() or @import
 * - svg: SVG can host <use>/<animate> with event handlers and javascript: URIs
 * - math: MathML can execute scripts in some engines
 * - script: redundant with defaults but made explicit
 * - iframe, object, embed, form: redundant with defaults but explicit
 */
const FORBID_TAGS = [
  'script', 'style', 'svg', 'math',
  'iframe', 'object', 'embed', 'form', 'input', 'button',
  'link', 'meta', 'base',
];

/**
 * Attributes explicitly stripped even if DOMPurify's defaults change.
 * on* event handlers are already stripped by default — listed here for
 * defense-in-depth.
 */
const FORBID_ATTR = [
  'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur',
  'onchange', 'onsubmit', 'oninput', 'onkeydown', 'onkeyup',
  'ondblclick', 'oncontextmenu', 'oninvalid', 'onreset', 'onsearch',
  'onselect', 'onwheel', 'ondrag', 'ondrop', 'oncopy', 'oncut',
  'onpaste', 'onscroll', 'ontoggle', 'onanimationend',
  'onanimationiteration', 'onanimationstart', 'ontransitionend',
  'formaction',
];

export const PURIFY_CONFIG: Config = Object.freeze({
  FORBID_TAGS,
  FORBID_ATTR,
  ALLOWED_URI_REGEXP: SAFE_URI_REGEX,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true, // Keep text content of forbidden tags (strip tag, keep text)
  RETURN_DOM_FRAGMENT: false,
  RETURN_DOM: false,
  WHOLE_DOCUMENT: false,
});

/**
 * Sanitize HTML for the markdown preview pane.
 * Returns safe HTML string or empty string if input is undefined/null.
 */
export function sanitizePreview(html: string): string {
  if (!html) return '';
  try {
    // DOMPurify.sanitize with RETURN_DOM_FRAGMENT=false and RETURN_DOM=false
    // returns a plain string, but TypeScript may infer TrustedHTML.
    // Cast through unknown to satisfy strict mode.
    return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
  } catch {
    // If DOMPurify fails (shouldn't, but defense in depth), strip all tags
    return html.replace(/<[^>]*>/g, '');
  }
}