/**
 * Shared test fixtures — emails, markdown content, and other
 * data that E2E tests use repeatedly.
 */

// ── Test emails ──

export const TEST_EMAILS = {
  host: 'host@test.com',
  peer: 'peer@test.com',
  peer2: 'peer2@test.com',
  peer3: 'peer3@test.com',
} as const;

// ── Markdown content ──

export const INITIAL_CONTENT = '# Hello World\n\nInitial content.';

export const HOST_EDIT = '# Hello World\n\nHost edited this line.';

export const PEER_EDIT = '# Hello World\n\nPeer edited this line.';

export const CONCURRENT_A =
  '# Concurrent Test\n\nEdit from peer A.\n\n---\n\nCommon footer.';

export const CONCURRENT_B =
  '# Concurrent Test\n\nEdit from peer B.\n\n---\n\nCommon footer.';

export const CONCURRENT_CONVERGED =
  '# Concurrent Test\n\nEdit from peer A.\n\nEdit from peer B.\n\n---\n\nCommon footer.';

export const LONG_DOCUMENT = `# Long Document

${Array.from({ length: 20 }, (_, i) => `## Section ${i + 1}\n\nThis is the content of section ${i + 1}. It has some text to make the document larger.\n`).join('\n')}

## Final Section

This is the end of the long document.`;