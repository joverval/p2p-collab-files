// app.ts — composition root
// Wires together shell controllers + MarkdownFeature

import './style.css';

import { $ } from './shared/dom';
import { ChatController } from './shell/chat/chat-controller';
import { ParticipantsController } from './shell/participants/participants-controller';
import { PanelController } from './shell/panels/panel-controller';
import { SessionController } from './shell/session-controller';
import { MarkdownFeature } from './features/markdown/markdown-feature';
import { encodeChat, decodeMessage } from './shell/protocol/message-envelope';

export function createApplication() {
  // ── Controllers ──
  const chat = new ChatController();
  const participants = new ParticipantsController();
  let isHost = false;
  const panel = new PanelController(chat, participants, () => isHost);
  const session = new SessionController();
  const feature = new MarkdownFeature();

  let email = '';

  // ── Wire session → controllers ──
  session.onLog = (type, text) => chat.addLog(type, text);
  session.onPendingRequest = (pEmail, token, offerId, answerB64) => {
    // Show toast + return approve function
    ($('pending-section') as HTMLElement).style.display = '';
    ($('toast-msg') as HTMLElement).textContent = `🔔 ${pEmail} wants to join`;
    $('toast').style.display = 'flex';
    return () => {
      session.approvePeer(token);
      if (offerId && answerB64) {
        participants.pendingPeerEmail = pEmail;
        session.acceptAnswer(`#sdp=${answerB64}`);
      }
      $('toast').style.display = 'none';
      $('pending-section').style.display = 'none';
    };
  };
  session.onPeerJoin = (peerEmail) => {
    participants.allUsers = [...participants.allUsers, { email: peerEmail, isHost: false }];
    updateTopBar();
    // Broadcast user list
    const list = JSON.stringify({ type: 'users', users: participants.allUsers });
    session.sendControl(`[USERS]${list}`);
  };
  session.onPeerLeave = (peerEmail) => {
    participants.allUsers = participants.allUsers.filter(u => u.email !== peerEmail);
    updateTopBar();
  };
  session.onConnected = (route) => {
    chat.addLog('system', `📡 Connected — ${route}`);
    feature.onConnected();
  };
  session.getEmail = () => email;
  session.getIsHost = () => isHost;

  // ── Feature context ──
  feature.start({
    isHost: () => isHost,
    isConnected: () => session.roomRef !== null,
    sendFeatureData: (data) => session.sendFeature(data),
    sendControlMessage: (msg) => session.sendControl(msg),
    reportStatus: (msg) => chat.addLog('system', msg),
  });

  // ── UI bindings ──
  function updateTopBar() {
    $('topbar').style.display = 'flex';
    ($('user-count') as HTMLElement).textContent = String(participants.userCount());
  }

  // File buttons
  ($('open-file-btn') as HTMLButtonElement).addEventListener('click', () => {
    if (feature.doc && feature.text && feature.editor) {
      feature.file?.openFile(feature.doc, feature.text, feature.editor);
    }
  });
  ($('save-file-btn') as HTMLButtonElement).addEventListener('click', () => {
    if (feature.text) feature.file?.saveFile(feature.text.toString());
  });

  // Panel toggle
  $('panel-close').addEventListener('click', () => panel.close());
  document.querySelectorAll('.panel-btn').forEach(btn => {
    btn.addEventListener('click', () => panel.open((btn as HTMLElement).dataset.panel!));
  });

  // User dropdown toggle
  $('user-counter')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('user-dropdown')?.classList.toggle('show');
  });

  // RoundRobin sync button
  $('sync-btn')?.addEventListener('click', () => {
    if (!isHost) session.sendControl('[SYNC]');
  });

  // Mobile toggle
  $('show-editor-btn')?.addEventListener('click', () => {
    ($('show-editor-btn') as HTMLButtonElement).classList.add('active');
    ($('show-preview-btn') as HTMLButtonElement).classList.remove('active');
    $('editor').classList.remove('view-hidden');
    $('preview').classList.add('view-hidden');
  });
  $('show-preview-btn')?.addEventListener('click', () => {
    ($('show-preview-btn') as HTMLButtonElement).classList.add('active');
    ($('show-editor-btn') as HTMLButtonElement).classList.remove('active');
    $('preview').classList.remove('view-hidden');
    $('editor').classList.add('view-hidden');
  });

  // Chat send
  ($('chat-send-btn') as HTMLButtonElement)?.addEventListener('click', () => {
    const input = document.querySelector('#chat-input') as HTMLInputElement;
    if (input) {
      const prefix = isHost ? `[Host] ${email}` : email;
      chat.sendChat(input.value.trim(), prefix, (data) => session.sendFeature(encodeChat(`${prefix}: ${input.value.trim()}`)));
    }
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
      navigator.clipboard.writeText(session.shareUrl).then(() => {
        ($('invite-copied') as HTMLElement).style.display = 'inline';
        setTimeout(() => ($('invite-copied') as HTMLElement).style.display = 'none', 2000);
      });
    };
    ($('open-file-btn') as HTMLButtonElement).disabled = false;
    ($('save-file-btn') as HTMLButtonElement).disabled = false;
    $('editor-section').style.display = 'flex';
    chat.addLog('system', '📝 Editor ready');

    if (!useRelay) {
      ($('manual-answer-input') as HTMLInputElement).style.display = '';
      ($('manual-answer-btn') as HTMLButtonElement).style.display = '';
      ($('manual-answer-btn') as HTMLButtonElement).onclick = () => {
        const raw = ($('manual-answer-input') as HTMLInputElement).value.trim();
        if (raw) session.acceptAnswer(raw);
      };
    }
  });

  // ── Join Room (URL has token) ──
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
      ($('open-file-btn') as HTMLButtonElement).style.display = 'none';
      ($('save-file-btn') as HTMLButtonElement).disabled = false;
    });
  }
}