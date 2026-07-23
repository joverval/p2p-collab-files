// app.ts — composition root v1.3
// Wires shell controllers + MarkdownFeature

import './style.css';
import { $ } from './shared/dom';
import { ChatController } from './shell/chat/chat-controller';
import { ParticipantsController } from './shell/participants/participants-controller';
import { PanelController } from './shell/panels/panel-controller';
import { SessionController } from './shell/session-controller';
import { MarkdownFeature } from './features/markdown/markdown-feature';
import { exposeTestAPI } from './test-api';

declare const __BUILD_TIME__: string;
console.log('p2p-collab-files — built', __BUILD_TIME__ || 'dev');

export function createApplication() {
  const chat = new ChatController();
  const participants = new ParticipantsController();
  let isHost = false;
  const session = new SessionController();
  let p2pConnected = false;
  const panel = new PanelController(chat, participants, () => isHost, () => p2pConnected);
  const feature = new MarkdownFeature();

  let email = '';
  let editorReady = false;

  // ── P2P connected state (real WebRTC, not relay-approved) ──
  session.setConnected = (v) => {
    p2pConnected = v;
    if (v) ensureEditorVisible();
  };

  // ── Helper for hidden diagnostic spans ──
  function setTextContent(id: string, text: string) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ── Chat send wiring ──
  panel.setSendChat((text: string) => {
    chat.addLog(isHost ? 'host' : 'peer', text, email);
    session.sendChatMessage(text);
  });

  function updateTopBar() {
    $('topbar').style.display = 'flex';
    ($('user-count') as HTMLElement).textContent = String(participants.userCount());
  }

  function updateRoleAwareUI() {
    updateTopBar();
    panel.refresh();
  }

  function applyRoleState(host: boolean, hostEmail: string) {
    isHost = host;
    participants.allUsers = participants.allUsers.map(u => ({ ...u, isHost: u.email === hostEmail }));

    // Host-only controls
    ($('open-file-btn') as HTMLButtonElement).style.display = host ? '' : 'none';
    ($('copy-invite-btn') as HTMLButtonElement).style.display = host ? '' : 'none';
    ($('manual-answer-input') as HTMLInputElement).style.display = host ? '' : 'none';
    ($('manual-answer-btn') as HTMLButtonElement).style.display = host ? '' : 'none';

    // Peer-only controls
    ($('sync-btn') as HTMLButtonElement).style.display = host ? 'none' : '';

    // Both roles can save
    ($('save-file-btn') as HTMLButtonElement).disabled = false;

    // Hide initial setup controls once room exists
    ($('create-room-btn') as HTMLButtonElement).style.display = 'none';
    ($('email-input') as HTMLInputElement).disabled = true;

    // Role label in top bar
    setTextContent('topbar-role', host ? '👑 Host' : '👤 Peer');

    updateTopBar();
    panel.refresh();
    ensureEditorVisible();
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
      isConnected: () => p2pConnected,
      sendFeatureData: (data) => session.sendFeature(data),
      sendFeatureDataToPeer: (peerId, data) => session.sendFeatureDataToPeer(peerId, data),
      sendControlMessage: (msg) => session.sendControl(msg),
      reportStatus: (msg) => chat.addLog('system', msg),
    });
    feature.onConnected();
  }

  // ── Wire session → controllers ──
  session.onLog = (type, text) => chat.addLog(type as 'host' | 'peer' | 'system', text);

  session.onPendingRequest = (req) => {
    participants.pendingPeerEmail = req.email;
    ($('toast-msg') as HTMLElement).textContent = `🔔 ${req.email}`;
    $('toast').style.display = 'flex';
    ($('toast-approve') as HTMLButtonElement).onclick = () => {
      session.approvePeer({ email: req.email, token: req.token, offerId: req.offerId, answerB64: req.answerB64 });
      $('toast').style.display = 'none';
      chat.addLog('system', `✅ Approved ${req.email}`);
    };
    ($('toast-reject') as HTMLButtonElement).onclick = () => {
      session.rejectPeer(req.token);
      $('toast').style.display = 'none';
    };
  };

  session.onPeerJoin = (peerId, peerEmail) => {
    participants.allUsers = [...participants.allUsers, {
      email: peerEmail,
      isHost: false,
      participantId: peerId,
      connected: true,
      joinOrder: participants.allUsers.length + 1,
    }];
    feature.onPeerJoined?.(peerId);
    updateTopBar();
    session.broadcastRoomState(participants.allUsers);
  };
  session.onPeerLeave = (peerEmail) => {
    participants.allUsers = participants.allUsers.filter(u => u.email !== peerEmail);
    updateTopBar();
    session.broadcastRoomState(participants.allUsers);
  };
  session.onConnected = (route) => {
    chat.addLog('system', `📡 Connected — ${route}`);
    setTextContent('connection-route', route);
    setTextContent('connection-state', 'connected');
    ensureEditorVisible();
  };
  session.onRoleChanged = (host, hostEmail) => {
    applyRoleState(host, hostEmail);
    session.broadcastRoomState(participants.allUsers);
  };
  session.onFeatureData = (data, peerId) => feature.handleFeatureData(data, peerId);
  session.onControlMessage = (text) => feature.handleControlMessage(text);
  session.onChatMessage = (sender, text, senderRole) => {
    const role: 'host' | 'peer' | 'system' = (senderRole === 'host' || senderRole === 'peer' || senderRole === 'system') ? senderRole : 'peer';
    chat.addLog(role, text, sender);
  };
  session.onRoomState = (peers) => { participants.replaceSnapshot(peers); updateRoleAwareUI(); };
  
  session.getEmail = () => email;

  // ── Promote button ──
  participants.onPromote = async (targetEmail) => {
    await session.promotePeer(targetEmail);
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
    if (isHost && p2pConnected) {
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
    participants.allUsers = [{ email, isHost: true, participantId: 'host', connected: true, joinOrder: 1 }];
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
        session.manualAcceptAnswer(session.currentOfferId, ($('manual-answer-input') as HTMLInputElement).value.trim());
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
      participants.allUsers = [{ email, isHost: false, participantId: 'self', connected: false, joinOrder: 0 }];
      await session.peerAutoJoin(parsed, email);
      ($('save-file-btn') as HTMLButtonElement).disabled = false;
      ($('open-file-btn') as HTMLButtonElement).style.display = 'none';
    });
  }

  // ── Expose E2E test API (gated by VITE_P2P_TEST_API) ──
  exposeTestAPI({ feature, session, isHost: () => isHost });
}