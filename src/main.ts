import { P2PRoom } from '@joverval/p2p-collab';
import type { Room } from '@joverval/p2p-collab';
import './style.css';

declare const __BUILD_TIME__: string;
console.log('p2p-collab-files — built', __BUILD_TIME__ || 'dev');

import * as Y from 'yjs';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';

// File System Access API types
declare global {
  interface Window {
    showOpenFilePicker(o?: any): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker(o?: any): Promise<FileSystemFileHandle>;
  }
}

// ── DOM Helpers ──

function $(id: string): HTMLElement { return document.getElementById(id)!; }
function el(tag: string, attrs: Record<string, string> = {}, children: (string | Node)[] = []): HTMLElement {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  children.forEach(c => e.append(c));
  return e;
}

function log(type: string, text: string) {
  const logEl = $('chat-log');
  logEl.innerHTML += `<div class="entry ${type}">[${new Date().toLocaleTimeString()}] ${text}</div>`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(cls: string, text: string) {
  const el = $('main-status');
  el.className = `status ${cls}`;
  el.textContent = text;
}

// ── Email validation ──

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

// ── Message encoding (0x00 = chat, 0x01 = Yjs) ──

function encodeChat(text: string): Uint8Array {
  const enc = new TextEncoder().encode(text);
  const msg = new Uint8Array(1 + enc.length);
  msg[0] = 0x00;
  msg.set(enc, 1);
  return msg;
}

function encodeYjs(data: Uint8Array): Uint8Array {
  const msg = new Uint8Array(1 + data.length);
  msg[0] = 0x01;
  msg.set(data, 1);
  return msg;
}

function decodeMessage(data: Uint8Array): { type: 'chat'; text: string } | { type: 'yjs'; update: Uint8Array } {
  if (data.length === 0) return { type: 'chat', text: '' };
  if (data[0] === 0x01) return { type: 'yjs', update: data.slice(1) };
  const start = data[0] === 0x00 ? 1 : 0;
  return { type: 'chat', text: new TextDecoder().decode(data.slice(start)) };
}

// ── WS Relay ──

const WS_URL = `ws://${window.location.hostname}:8083`;
let ws: WebSocket | null = null;

function wsConnect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(WS_URL);
    s.onopen = () => resolve(s);
    s.onerror = () => reject(new Error('WS connection failed'));
    s.onclose = () => { ws = null; };
    ws = s;
  });
}

// ── State ──

let myEmail = '';
let isHost = false;
let room: Room | null = null;
let connected = false;
let connectedUsers: string[] = [];
const peerEmails: Map<string, string> = new Map(); // peerId → email
let _pendingPeerEmail = ''; // email of peer currently connecting
const baseUrl = window.location.href.split('#')[0];

// Yjs
let ydoc: Y.Doc | null = null;
let ytext: Y.Text | null = null;
let editorView: EditorView | null = null;
let isRemoteUpdate = false;

// File
let fileHandle: FileSystemFileHandle | null = null;

// ── Top Bar ──

function updateTopBar() {
  $('topbar').style.display = 'flex';
  $('topbar-filename').textContent = fileHandle ? `📄 ${fileHandle.name}` : '📄 Untitled.md';
  $('user-count').textContent = String(connectedUsers.length);
  // Build dropdown
  const dd = $('user-dropdown');
  dd.innerHTML = '';
  if (isHost) {
    dd.appendChild(el('div', { class: 'user-dropdown-item host' }, [`[Host] ${myEmail}`]));
  }
  for (const u of connectedUsers) {
    dd.appendChild(el('div', { class: 'user-dropdown-item' }, [u]));
  }
}

// ── User dropdown toggle ──
$('user-counter').addEventListener('click', (e) => {
  e.stopPropagation();
  $('user-dropdown').classList.toggle('show');
});
document.addEventListener('click', () => {
  $('user-dropdown').classList.remove('show');
});

// ── Chat sidebar toggle ──
let _chatVisible = false;
function toggleChat() {
  _chatVisible = !_chatVisible;
  const sidebar = $('chat-sidebar');
  const btn = $('chat-toggle') as HTMLButtonElement;
  if (_chatVisible) {
    sidebar.classList.remove('chat-sidebar-hidden');
    btn.classList.add('active');
  } else {
    sidebar.classList.add('chat-sidebar-hidden');
    btn.classList.remove('active');
  }
}
($('chat-toggle') as HTMLButtonElement).addEventListener('click', toggleChat);
($('chat-close') as HTMLButtonElement).addEventListener('click', toggleChat);

// ── Info modal ──
($('info-btn') as HTMLButtonElement).addEventListener('click', () => {
  ($('info-modal') as HTMLElement).style.display = 'flex';
});
($('info-close') as HTMLButtonElement).addEventListener('click', () => {
  ($('info-modal') as HTMLElement).style.display = 'none';
});
($('info-modal') as HTMLElement).querySelector('.info-overlay')!.addEventListener('click', () => {
  ($('info-modal') as HTMLElement).style.display = 'none';
});

// ── Pending Requests ──

function addPendingRequest(email: string, offerId: string) {
  try {
    $('pending-section').style.display = 'block';
    const list = $('pending-list');

    const item = el('div', { class: 'pending-item' }, [
      el('span', {}, [`🔔 ${email} wants to join`]),
      el('div', { class: 'btn-row' }, [
        el('button', {}, ['Approve']),
        el('button', { class: 'reject-btn' }, ['Reject']),
      ]),
    ]);

    const [approveBtn, rejectBtn] = item.querySelectorAll('button');

    approveBtn.addEventListener('click', () => {
      if (!ws) { log('system', 'ERROR: WS disconnected'); return; }
      ws.send(JSON.stringify({ type: 'host-approve', email, offerId }));
      item.remove();
      if ($('pending-list').children.length === 0) {
        $('pending-section').style.display = 'none';
      }
    });

    rejectBtn.addEventListener('click', () => {
      if (!ws) { log('system', 'ERROR: WS disconnected'); return; }
      ws.send(JSON.stringify({ type: 'host-reject', email }));
      item.remove();
      if ($('pending-list').children.length === 0) {
        $('pending-section').style.display = 'none';
      }
    });

    list.appendChild(item);
  } catch (e: any) {
    log('system', `ERROR showing pending request: ${e?.message || e}`);
  }
}

// ── CodeMirror editor ──

function initEditor() {
  log('system', 'initEditor called');
  const editorEl = $('editor');
  $('editor-section').style.display = 'flex';

  ydoc = new Y.Doc();
  ytext = ydoc.getText('markdown');

  editorView = new EditorView({
    doc: '',
    extensions: [
      basicSetup,
      markdown(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !isRemoteUpdate) {
          // Local edit → Yjs
          const value = update.state.doc.toString();
          ydoc!.transact(() => {
            ytext!.delete(0, ytext!.length);
            ytext!.insert(0, value);
          });
        }
      }),
      EditorView.theme({
        '&': { backgroundColor: '#0d1117' },
        '.cm-gutters': { backgroundColor: '#0d1117', borderRight: '1px solid #21262d', color: '#484f58' },
        '.cm-activeLineGutter': { backgroundColor: '#161b22' },
      }),
    ],
    parent: editorEl,
  });

  // Yjs update → send to peers
  ydoc.on('update', (update: Uint8Array) => {
    if (isRemoteUpdate) return;
    if (room && connected) room.send(encodeYjs(update));
  });

  ($('chat-input') as HTMLInputElement).disabled = false;
  ($('chat-send-btn') as HTMLButtonElement).disabled = false;
}

// ── HOST ──

async function createRoom() {
  // Disable immediately to prevent double-clicks / HMR duplicate listeners
  const btn = $('create-room-btn') as HTMLButtonElement;
  if (btn.disabled) return;
  btn.disabled = true;

  const email = ($('email-input') as HTMLInputElement).value.trim();
  if (!validateEmail(email)) {
    log('system', 'ERROR: Please enter a valid email');
    btn.disabled = false;
    return;
  }
  myEmail = email;
  isHost = true;
  ($('email-input') as HTMLInputElement).disabled = true;

  log('system', 'Creating room...');
  setStatus('connecting', 'connecting to relay');

  try {
    // Try WS relay — fall back to manual if unavailable
    let useRelay = false;
    try {
      await Promise.race([
        wsConnect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      useRelay = true;
    } catch {
      log('system', '⚠️ Relay unavailable — using manual copy-paste mode');
    }

    let roomId = '';
    if (useRelay) {
      roomId = await new Promise<string>((resolve) => {
        ws!.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'registered') resolve(msg.room);
        };
        ws!.send(JSON.stringify({ type: 'host-register' }));
      });
      log('system', `Room registered: ${roomId}`);
    }

    // Create WebRTC offer
    log('system', 'Generating WebRTC offer...');

        // Use P2PRoom directly (createRoom wrapper is broken by Vite module transform)
        const r = new P2PRoom(true, baseUrl, {
          onError: (err: Error) => log('system', `ERROR: ${err.message}`),
        });
        const { url, offerId } = await r.offerUrl();
        _currentOfferId = offerId;
        room = r;

    const sdpB64 = url.match(/#sdp=(.*)/)?.[1] || '';
    const shareUrl = useRelay
      ? `${baseUrl}#room=${roomId}&offer=${offerId}&sdp=${encodeURIComponent(sdpB64)}`
      : `${baseUrl}#offer=${offerId}&sdp=${encodeURIComponent(sdpB64)}`;

    // Show simplified handshake: copy button
    $('handshake-section').style.display = 'block';
    ($('copy-invite-btn') as HTMLButtonElement).style.display = 'inline-block';
    ($('copy-invite-btn') as HTMLButtonElement).onclick = () => {
      navigator.clipboard.writeText(shareUrl).then(() => {
        ($('invite-copied') as HTMLElement).style.display = 'inline';
        setTimeout(() => ($('invite-copied') as HTMLElement).style.display = 'none', 2000);
      }).catch(() => log('system', '⚠️ Could not copy'));
    };

    setStatus('connecting', 'waiting for peer');
    log('system', '📋 Copy the invite link and share with a peer');

    // Host can start working immediately
    initEditor();
    log('system', '📝 Editor ready');

    // Enable file buttons
    ($('open-file-btn') as HTMLButtonElement).disabled = false;
    ($('save-file-btn') as HTMLButtonElement).disabled = false;

    if (useRelay) {
      // WS relay mode: handle pending requests and answer forwarding
      ws!.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'peer-request') {
          log('system', `📩 ${msg.email} wants to join`);
          addPendingRequest(msg.email, msg.offerId || '');
        } else if (msg.type === 'answer') {
          log('system', `✅ ${msg.email || 'Peer'} approved — applying answer...`);
          _pendingPeerEmail = msg.email || '';
          room!.acceptAnswer(msg.offerId || '', `#sdp=${msg.answerB64}`);
          log('system', 'Answer applied, waiting for connection...');
        }
      };
    } else {
      // Manual mode: show answer input for host to paste peer's answer
      function setupManualAnswer() {
        $('manual-answer-row').style.display = 'block';
        ($('manual-answer-btn') as HTMLButtonElement).onclick = () => {
          const raw = ($('manual-answer-input') as HTMLInputElement).value.trim();
          if (!raw || !room) return;
          const match = raw.match(/#sdp=(.*)/);
          const answerB64 = match ? decodeURIComponent(match[1]) : raw;
          log('system', `Applying answer for offer ${_currentOfferId}...`);
          room.acceptAnswer(_currentOfferId, `#sdp=${answerB64}`);
          log('system', 'Manual answer applied, waiting for connection...');
          ($('manual-answer-input') as HTMLInputElement).value = '';
        };
      }
      setupManualAnswer();
    }

    // Set up room message handling — host broadcasts everything to all peers
    r.onMessage((data: string | Uint8Array, peerId: string) => {
      if (!(data instanceof Uint8Array)) return;
      const decoded = decodeMessage(data);
      if (decoded.type === 'yjs') {
        if (ydoc) {
          isRemoteUpdate = true;
          Y.applyUpdate(ydoc, decoded.update);
          isRemoteUpdate = false;
          if (editorView) {
            editorView.dispatch({
              changes: { from: 0, to: editorView.state.doc.length, insert: ytext!.toString() },
            });
          }
        }
        // Forward to all peers (Yjs handles duplicates gracefully)
        room!.send(data);
      } else {
        const senderEmail = peerEmails.get(peerId) || peerId;
        log('received', `${senderEmail}: ${decoded.text}`);
        // Relay to all peers with sender email prefix
        const relayText = encodeChat(`${senderEmail}: ${decoded.text}`);
        room!.send(relayText);
      }
    });

    r.onPeerJoin(async (peerId: string) => {
      connected = true;
      const peerEmail = _pendingPeerEmail || peerId;
      peerEmails.set(peerId, peerEmail);
      connectedUsers.push(peerEmail);
      _pendingPeerEmail = '';
      setStatus('connected', `connected (${connectedUsers.length} peer(s))`);
      updateTopBar();
      log('system', `🎉 ${peerEmail} connected!`);
      // Send current document state to newly connected peer
      if (ydoc) {
        const state = Y.encodeStateAsUpdate(ydoc);
        room!.send(encodeYjs(state));
        log('system', `Sent initial state (${state.length} bytes)`);
      }
      // Generate new invite link for next peer
      try {
        const { url: newUrl, offerId: newOfferId } = await r.offerUrl();
        _currentOfferId = newOfferId;
        const newSdpB64 = newUrl.match(/#sdp=(.*)/)?.[1] || '';
        const newShareUrl = useRelay
          ? `${baseUrl}#room=${roomId}&offer=${newOfferId}&sdp=${encodeURIComponent(newSdpB64)}`
          : `${baseUrl}#offer=${newOfferId}&sdp=${encodeURIComponent(newSdpB64)}`;
        // Update copy button with new invite link
        ($('copy-invite-btn') as HTMLButtonElement).onclick = () => {
          navigator.clipboard.writeText(newShareUrl).then(() => {
            ($('invite-copied') as HTMLElement).style.display = 'inline';
            setTimeout(() => ($('invite-copied') as HTMLElement).style.display = 'none', 2000);
          }).catch(() => {});
        };
        log('system', 'New invite link ready for next peer');
        // In manual mode, show answer input again for next peer
        if (!useRelay) {
          $('manual-answer-row').style.display = 'block';
        }
      } catch (err: any) {
        log('system', `ERROR generating new offer: ${err.message}`);
      }
    });

  } catch (err: any) {
    setStatus('error', 'error');
    log('system', `ERROR: ${err.message}`);
    ($('create-room-btn') as HTMLButtonElement).disabled = false;
    ($('email-input') as HTMLInputElement).disabled = false;
  }
}

let _currentOfferId = '';  // current pending offer ID for manual mode

// ── PEER ──

function parseRoomFromUrl(): { roomId: string; offerId: string; offer: string } | null {
  const hash = window.location.hash;
  if (!hash) return null;
  // Relay mode: #room=<id>&offer=<id>&sdp=<b64>
  const m1 = hash.match(/^#room=([^&]+)&offer=([^&]+)&sdp=(.+)$/);
  if (m1) return { roomId: m1[1], offerId: m1[2], offer: decodeURIComponent(m1[3]) };
  // Manual mode: #offer=<id>&sdp=<b64>
  const m2 = hash.match(/^#offer=([^&]+)&sdp=(.+)$/);
  if (m2) return { roomId: '', offerId: m2[1], offer: decodeURIComponent(m2[2]) };
  return null;
}

async function peerAutoJoin(roomId: string, offerId: string, offerB64: string) {
  const btn = $('create-room-btn') as HTMLButtonElement;
  if (btn.disabled) return;
  btn.disabled = true;

  const email = ($('email-input') as HTMLInputElement).value.trim();
  if (!validateEmail(email)) {
    log('system', 'ERROR: Please enter a valid email to join');
    return;
  }
  myEmail = email;
  ($('email-input') as HTMLInputElement).disabled = true;
  ($('create-room-btn') as HTMLButtonElement).disabled = true;

  log('system', `Joining room ${roomId || '(manual)'} as ${email}...`);
  setStatus('connecting', roomId ? 'connecting to relay' : 'connecting (manual)');

  try {
    // Try WS relay if available
    let useRelay = false;
    if (roomId) {
      try {
        await Promise.race([
          wsConnect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]);
        useRelay = true;
      } catch {
        log('system', '⚠️ Relay unavailable — using manual mode');
      }
    }

    // Join room (use P2PRoom directly — joinRoom wrapper broken by Vite)
    const peer = new P2PRoom(false, baseUrl, {
      onError: (err: Error) => log('system', `ERROR: ${err.message}`),
    });
    const answerUrl = await peer.connectToHost(`${baseUrl}#sdp=${offerB64}`);
    log('system', `Connected, answer: ${answerUrl.substring(0, 40)}...`);
    room = peer;

    const match = answerUrl.match(/#sdp=(.*)/);
    const answerB64 = match ? match[1] : '';
    if (!answerB64) throw new Error('Could not extract answer');

    if (useRelay) {
      // Send join request via WS relay
      ws!.send(JSON.stringify({
        type: 'peer-join-request',
        room: roomId,
        offerId,
        email,
        answerB64,
      }));

      log('system', 'Join request sent — waiting for host approval...');
      setStatus('connecting', 'awaiting approval');

      ws!.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'approved') {
        setStatus('connected', 'connected');
        connected = true;
        connectedUsers.push('[Host]');
        updateTopBar();
        // Peer: hide open button, enable save
        ($('open-file-btn') as HTMLButtonElement).style.display = 'none';
        ($('save-file-btn') as HTMLButtonElement).disabled = false;
        initEditor();
      } else if (msg.type === 'rejected') {
        setStatus('error', 'rejected');
        log('system', `❌ Rejected: ${msg.message}`);
      }
    };
    } else {
      // Manual mode: show copy button for answer URL
      const answerFullUrl = `${baseUrl}#sdp=${encodeURIComponent(answerB64)}`;
      $('handshake-section').style.display = 'block';
      ($('copy-invite-btn') as HTMLButtonElement).textContent = '📋 Copy answer link';
      ($('copy-invite-btn') as HTMLButtonElement).style.display = 'inline-block';
      ($('copy-invite-btn') as HTMLButtonElement).onclick = () => {
        navigator.clipboard.writeText(answerFullUrl).then(() => {
          ($('invite-copied') as HTMLElement).style.display = 'inline';
          setTimeout(() => ($('invite-copied') as HTMLElement).style.display = 'none', 2000);
        }).catch(() => {});
      };
      setStatus('connected', 'connected — waiting for host to apply answer');
      connected = true;
      connectedUsers.push('[Host]');
      updateTopBar();
      ($('open-file-btn') as HTMLButtonElement).style.display = 'none';
      ($('save-file-btn') as HTMLButtonElement).disabled = false;
      initEditor();
      log('system', '📋 Copy the Answer URL above and send it to the host');
    }

    // Room message handling
    room!.onMessage((data: string | Uint8Array, peerId: string) => {
      if (!(data instanceof Uint8Array)) return;
      const decoded = decodeMessage(data);
      if (decoded.type === 'yjs') {
        if (ydoc) {
          isRemoteUpdate = true;
          Y.applyUpdate(ydoc, decoded.update);
          if (editorView) {
            editorView.dispatch({
              changes: { from: 0, to: editorView.state.doc.length, insert: ytext!.toString() },
            });
          }
          isRemoteUpdate = false;
        }
      } else {
        log('received', decoded.text);
      }
    });

  } catch (err: any) {
    setStatus('error', 'error');
    log('system', `ERROR: ${err.message}`);
    ($('create-room-btn') as HTMLButtonElement).disabled = false;
    ($('email-input') as HTMLInputElement).disabled = false;
  }
}

// ── Chat ──

function sendChat() {
  const input = $('chat-input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !room || !connected) return;
  const prefix = isHost ? `[Host] ${myEmail}` : myEmail;
  const fullText = `${prefix}: ${text}`;
  room.send(encodeChat(fullText));
  log('sent', isHost ? `[Host]: ${text}` : text);
  input.value = '';
}

// ── File System Access (with fallback for non-secure contexts) ──

function hasFileSystemAPI(): boolean {
  return typeof window.showOpenFilePicker === 'function';
}

// Hidden file input for fallback
let _fileInput: HTMLInputElement | null = null;

function getFileInput(): HTMLInputElement {
  if (!_fileInput) {
    _fileInput = document.createElement('input');
    _fileInput.type = 'file';
    _fileInput.accept = '.md';
    _fileInput.style.display = 'none';
    document.body.appendChild(_fileInput);
  }
  return _fileInput;
}

function fallbackOpenFile(): Promise<{ name: string; content: string }> {
  return new Promise((resolve, reject) => {
    const input = getFileInput();
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('No file selected'));
      resolve({ name: file.name, content: await file.text() });
    };
    input.click();
  });
}

function fallbackSaveFile(content: string, name: string): void {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'document.md';
  a.click();
  URL.revokeObjectURL(url);
}

// Open file — host only
($('open-file-btn') as HTMLButtonElement).addEventListener('click', async () => {
  if (!isHost || !ydoc) return;
  try {
    let name: string, content: string;
    if (hasFileSystemAPI()) {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
      });
      fileHandle = handle;
      name = handle.name;
      content = await (await handle.getFile()).text();
    } else {
      const result = await fallbackOpenFile();
      name = result.name;
      content = result.content;
    }
    ydoc!.transact(() => { ytext!.delete(0, ytext!.length); ytext!.insert(0, content); });
    if (editorView) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: content },
      });
    }
    updateTopBar();
    log('system', `📂 Opened: ${name}`);
  } catch (err: any) {
    if (err.name !== 'AbortError') log('system', `ERROR: ${err.message}`);
  }
});

// Save — available for everyone
($('save-file-btn') as HTMLButtonElement).addEventListener('click', async () => {
  if (!ytext) return;
  const content = ytext.toString();
  if (hasFileSystemAPI()) {
    if (isHost && fileHandle) {
      try {
        const w = await fileHandle.createWritable();
        await w.write(content);
        await w.close();
        log('system', `💾 Saved: ${fileHandle.name}`);
        return;
      } catch (err: any) {
        log('system', `ERROR saving: ${err.message}`);
      }
    }
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileHandle?.name || 'document.md',
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
      });
      const w = await handle.createWritable();
      await w.write(content);
      await w.close();
      if (isHost) { fileHandle = handle; updateTopBar(); }
      log('system', `💾 Saved as: ${handle.name}`);
    } catch (err: any) {
      if (err.name !== 'AbortError') log('system', `ERROR: ${err.message}`);
    }
  } else {
    // Fallback: download as file
    fallbackSaveFile(content, fileHandle?.name || 'document.md');
    log('system', `💾 Downloaded: ${fileHandle?.name || 'document.md'}`);
  }
});

// ── Event Bindings (HMR-safe via window flag) ──

if (!(window as any).__p2pBound) {
  (window as any).__p2pBound = true;

  ($('create-room-btn') as HTMLButtonElement).addEventListener('click', createRoom);
  ($('chat-send-btn') as HTMLButtonElement).addEventListener('click', sendChat);
  ($('chat-input') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // ── Auto-detect peer mode ──

  const parsed = parseRoomFromUrl();
  if (parsed) {
    ($('create-room-btn') as HTMLButtonElement).textContent = 'Join Room';
    ($('create-room-btn') as HTMLButtonElement).replaceWith(
      ($('create-room-btn') as HTMLButtonElement).cloneNode(true)
    );
    ($('create-room-btn') as HTMLButtonElement).addEventListener('click', () => {
      peerAutoJoin(parsed.roomId, parsed.offerId, parsed.offer);
    });
    ($('handshake-section') as HTMLElement).style.display = 'none';
  }
}