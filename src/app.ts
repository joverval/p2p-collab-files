// app.ts — composition root v1.2
// Wires shell controllers + MarkdownFeature

import './style.css';
import { $ } from './shared/dom';
import { ChatController } from './shell/chat/chat-controller';
import { ParticipantsController } from './shell/participants/participants-controller';
import { PanelController } from './shell/panels/panel-controller';
import { SessionController } from './shell/session-controller';
import { MarkdownFeature } from './features/markdown/markdown-feature';
import { encodeChat } from './shell/protocol/message-envelope';

declare const __BUILD_TIME__: string;
console.log('p2p-collab-files — built', __BUILD_TIME__ || 'dev');

export function createApplication() {
  const chat = new ChatController();
  const participants = new ParticipantsController();
  let isHost = false;
  const session = new SessionController();
  const panel = new PanelController(chat, participants, () => isHost, () => session.isConnected);
  const feature = new MarkdownFeature();

  let email = '';
  let editorReady = false;

  // ── Chat send wiring ──
  panel.setSendChat((text: string) => {
    chat.addLog('sent', isHost ? `[Host]: ${text}` : text);
    session.sendChatMessage(text);
  });

  function updateTopBar() {
    $('topbar').style.display = 'flex';
    ($('user-count') as HTMLElement).textContent = String(participants.userCount());
  }

  function ensureEditorVisible() {
    if (editorReady) return;
    editorReady = true;
    $('editor-section').style.display = 'flex';
    if (!isHost) {
      ($('open-file-btn') as HTMLButtonElement).style.display = 'none';
      ($('sync-btn') as HTMLButtonElement).style.display = '';
    }
    chat.addLog('system', '📝 Editor ready');

    feature.start({
      isHost: () => isHost,
      isConnected: () => session.isConnected,
      sendFeatureData: (data) => session.sendFeature(data),
      sendControlMessage: (msg) => session.sendControl(msg),
      reportStatus: (msg) => chat.addLog('system', msg),
    });
  }

  // ── Wire session → controllers ──
  session.onLog = (type, text) => chat.addLog(type, text);

  session.onPendingRequest = (pEmail, token, offerId, answerB64) => {
    participants.pendingPeerEmail = pEmail;
    ($('toast-msg') as HTMLElement).textContent = `🔔 ${pEmail}`;
    $('toast').style.display = 'flex';
    ($('toast-approve') as HTMLButtonElement).onclick = () => {
      if (offerId && answerB64) {
        session.pendingPeerEmail = pEmail;
        session.acceptAnswer(`#sdp=${answerB64}`, offerId);
      }
      session.approvePeer(token);
      $('toast').style.display = 'none';
      chat.addLog('system', `✅ Approved ${pEmail}`);
    };
    ($('toast-reject') as HTMLButtonElement).onclick = () => {
      session.rejectPeer(token);
      $('toast').style.display = 'none';
    };
  };

  session.onPeerJoin = (peerEmail) => {
    participants.allUsers = [...participants.allUsers, { email: peerEmail, isHost: false }];
    updateTopBar();
  };
  session.onPeerLeave = (peerEmail) => {
    participants.allUsers = participants.allUsers.filter(u => u.email !== peerEmail);
    updateTopBar();
  };
  session.onConnected = (route) => {
    chat.addLog('system', `📡 Connected — ${route}`);
    ensureEditorVisible();
  };
  session.onRoleChanged = (host, hostEmail) => {
    isHost = host;
    participants.allUsers = participants.allUsers.map(u => ({ ...u, isHost: u.email === hostEmail }));
    updateTopBar();
  };
  session.onFeatureData = (data, peerId) => feature.handleFeatureData(data, peerId);
  session.onControlMessage = (text) => feature.handleControlMessage(text);
  session.onChatMessage = (sender, text) => chat.addLog('received', `${sender}: ${text}`);
  session.onRoomState = (peers) => { participants.allUsers = peers; updateTopBar(); };
  session.setConnected = (v) => { /* data channel state tracked internally */ };
  session.getEmail = () => email;

  // ── Promote button ──
  participants.onPromote = async (targetEmail) => {
    const rtcConfig = (window as any).__rtcConfig;
    await session.promotePeer(targetEmail, participants.allUsers, rtcConfig, () => feature.doc, () => feature.text);
  };

  // ── UI bindings ──
  // Open file
  ($('open-file-btn') as HTMLButtonElement).addEventListener('click', () => {
    if (feature.doc && feature.text && feature.editor) feature.file?.openFile(feature.doc, feature.text, feature.editor);
  });
  // Save file
  ($('save-file-btn') as HTMLButtonElement).addEventListener('click', () => {
    if (feature.text) feature.file?.saveFile(feature.text.toString());
  });

  // Panel open/close
  $('panel-close').addEventListener('click', () => panel.close());
  document.querySelectorAll('.panel-btn').forEach(btn => btn.addEventListener('click', () => panel.open((btn as HTMLElement).dataset.panel!)));

  // File dropdown
  ($('file-menu-btn') as HTMLElement)?.addEventListener('click', (e) => {
    e.stopPropagation();
    ($('file-dropdown') as HTMLElement)?.classList.toggle('show');
  });
  document.addEventListener('click', () => ($('file-dropdown') as HTMLElement)?.classList.remove('show'));

  // Sync
  ($('sync-btn') as HTMLButtonElement)?.addEventListener('click', () => session.sendControl('[SYNC]'));

  // Filename input → broadcast
  $('topbar-filename').addEventListener('input', () => {
    const name = ($('topbar-filename') as HTMLElement).textContent || 'Untitled.md';
    if (isHost && session.isConnected) {
      session.sendControl(`[FILENAME]${name}`);
    }
  });

  // Mobile toggle
  ($('show-editor-btn') as HTMLButtonElement)?.addEventListener('click', () => {
    ($('show-editor-btn') as HTMLButtonElement).classList.add('active');
    ($('show-preview-btn') as HTMLButtonElement).classList.remove('active');
    $('editor').classList.remove('view-hidden');
    $('preview').classList.add('view-hidden');
  });
  ($('show-preview-btn') as HTMLButtonElement)?.addEventListener('click', () => {
    ($('show-preview-btn') as HTMLButtonElement).classList.add('active');
    ($('show-editor-btn') as HTMLButtonElement).classList.remove('active');
    $('preview').classList.remove('view-hidden');
    $('editor').classList.add('view-hidden');
  });

  // ── Create Room ──
  ($('create-room-btn') as HTMLButtonElement).addEventListener('click', async () => {
    email = ($('email-input') as HTMLInputElement).value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { chat.addLog('system', 'ERROR: Please enter a valid email'); return; }
    isHost = true;
    participants.allUsers = [{ email, isHost: true }];
    updateTopBar();
    ($('email-input') as HTMLInputElement).disabled = true;

    const useRelay = await session.createRoom(email);
    ($('copy-invite-btn') as HTMLButtonElement).style.display = '';
    ($('copy-invite-btn') as HTMLButtonElement).onclick = () => {
      navigator.clipboard.writeText(session.shareUrl).then(() => { ($('invite-copied') as HTMLElement).style.display = 'inline'; setTimeout(() => ($('invite-copied') as HTMLElement).style.display = 'none', 2000); });
    };
    ($('open-file-btn') as HTMLButtonElement).disabled = false;
    ($('save-file-btn') as HTMLButtonElement).disabled = false;

    ensureEditorVisible();

    if (!useRelay) {
      ($('manual-answer-input') as HTMLInputElement).style.display = '';
      ($('manual-answer-btn') as HTMLButtonElement).style.display = '';
      ($('manual-answer-btn') as HTMLButtonElement).onclick = () => {
        session.acceptAnswer(($('manual-answer-input') as HTMLInputElement).value.trim());
      };
    }
  });

  // ── Join Room ──
  const parsed = session.parseRoomFromUrl();
  if (parsed) {
    ($('create-room-btn') as HTMLButtonElement).textContent = 'Join Room';
    ($('create-room-btn') as HTMLButtonElement).replaceWith(($('create-room-btn') as HTMLButtonElement).cloneNode(true));
    ($('create-room-btn') as HTMLButtonElement).addEventListener('click', async () => {
      email = ($('email-input') as HTMLInputElement).value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { chat.addLog('system', 'ERROR: Please enter a valid email'); return; }
      ($('email-input') as HTMLInputElement).disabled = true;
      participants.allUsers = [{ email, isHost: false }];
      await session.peerAutoJoin(parsed, email);
      ($('save-file-btn') as HTMLButtonElement).disabled = false;
      ($('open-file-btn') as HTMLButtonElement).style.display = 'none';
    });
  }
}