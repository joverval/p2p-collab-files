import { P2PRoom } from '@joverval/p2p-collab';
import type { Room } from '@joverval/p2p-collab';
import './style.css';

declare const __BUILD_TIME__: string;
console.log('p2p-collab-files — built', __BUILD_TIME__ || 'dev');

import * as Y from 'yjs';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';

declare global { interface Window { showOpenFilePicker(o?:any): Promise<FileSystemFileHandle[]>; showSaveFilePicker(o?:any): Promise<FileSystemFileHandle>; } }

// ── DOM Helpers ──
function $(id: string): HTMLElement { return document.getElementById(id)!; }
function el(tag: string, attrs: Record<string,string>={}, kids:(string|Node)[]=[]): HTMLElement {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v));
  kids.forEach(c=>e.append(c));
  return e;
}

// ── Right Panel ──
let _currentPanel = '';
function openPanel(name: string) {
  if (_currentPanel === name) { closePanel(); return; }
  _currentPanel = name;
  const panel = $('right-panel');
  panel.classList.remove('panel-hidden');
  $('panel-title').textContent = name === 'chat' ? '💬 Chat' : name === 'users' ? '👤 Users' : '📖 How it works';
  const body = $('panel-body');
  body.innerHTML = '';

  if (name === 'users') renderUserPanel(body);
  else if (name === 'info') renderInfoPanel(body);
  else if (name === 'chat') renderChatPanel(body);

  // Update active button
  document.querySelectorAll('.panel-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector(`[data-panel="${name}"]`)?.classList.add('active');
  // Clear chat notif
  if (name === 'chat') { _unread = 0; updateNotif(); }
}
function closePanel() {
  _currentPanel = '';
  $('right-panel').classList.add('panel-hidden');
  document.querySelectorAll('.panel-btn').forEach(b=>b.classList.remove('active'));
}
$('panel-close').addEventListener('click', closePanel);
document.querySelectorAll('.panel-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>openPanel((btn as HTMLElement).dataset.panel!));
});

function renderUserPanel(body: HTMLElement) {
  for (const u of allUsers) {
    const role = u.isHost ? 'Host' : `Peer ${allUsers.filter(x=>!x.isHost).indexOf(u)+1}`;
    body.appendChild(el('div',{class:'user-panel-item'+(u.isHost?' host':'')},[
      el('span',{},[u.email]),
      el('span',{class:'role'},[` — ${role}`]),
    ]));
  }
}

function renderInfoPanel(body: HTMLElement) {
  body.innerHTML = `<div class="info-section">
<h3>🖥️ Host</h3>
<p>1. Enter email & click <b>Create Room</b></p>
<p>2. Click <b>📋 Copy invite</b> and share</p>
<p>3. Approve or reject peers</p>
<p>4. If manual: paste answer URL</p>
<hr>
<h3>👤 Peer</h3>
<p>1. Open invite link from host</p>
<p>2. Enter email & click <b>Join Room</b></p>
<p>3. Wait for host approval</p>
<p>4. If manual: click copy & send answer</p>
<hr>
<h3>📝 Editing</h3>
<p>• <b>📂 Open</b> (host) — load .md file</p>
<p>• <b>💾 Save</b> — save local copy</p>
<p>• <b>👤 Users</b> — see connected peers</p>
<p>• <b>💬 Chat</b> — open chat</p>
</div>`;
}

function renderChatPanel(body: HTMLElement) {
  body.innerHTML = `<div id="chat-log"></div>
<div class="chat-input-row"><input id="chat-input" placeholder="Type..." disabled><button id="chat-send-btn" disabled>Send</button></div>`;
  // Restore chat log
  const logEl = body.querySelector('#chat-log')!;
  logEl.innerHTML = _chatLogHTML;
  // Bind send
  const input = body.querySelector('#chat-input') as HTMLInputElement;
  const sendBtn = body.querySelector('#chat-send-btn') as HTMLButtonElement;
  if (connected) { input.disabled = false; sendBtn.disabled = false; }
  sendBtn.addEventListener('click', sendChat);
  input.addEventListener('keydown', e=>{ if(e.key==='Enter') sendChat(); });
}

// ── Chat log (persisted HTML across panel opens) ──
let _chatLogHTML = '';
let _unread = 0;

function addChatLog(type: string, text: string) {
  // Filter out internal protocol messages
  if(text.startsWith('[CHKSUM]') || text.includes('[CHKSUM]')) return;
  const t = new Date().toLocaleTimeString();
  _chatLogHTML += `<div class="log-entry ${type}">[${t}] ${text}</div>`;
  // Update if panel is open
  const cl = document.querySelector('#chat-log');
  if (cl) {
    cl.innerHTML = _chatLogHTML;
    cl.scrollTop = cl.scrollHeight;
  }
  if (_currentPanel !== 'chat') {
    _unread++;
    updateNotif();
  }
}
function updateNotif() {
  ($('chat-notif') as HTMLElement).classList.toggle('show', _unread > 0);
}

// ── Message encoding ──
function encodeChat(text: string): Uint8Array { const e=new TextEncoder().encode(text); const m=new Uint8Array(1+e.length); m[0]=0x00; m.set(e,1); return m; }
function encodeYjs(data: Uint8Array, seq?: number): Uint8Array {
  if(seq===undefined) return encodeYjs(data,0);
  const m=new Uint8Array(3+data.length); m[0]=0x01; m[1]=(seq>>8)&0xFF; m[2]=seq&0xFF; m.set(data,3); return m;
}
function decodeMessage(data: Uint8Array): {type:'chat',text:string}|{type:'yjs',update:Uint8Array,seq:number} {
  if(data.length===0) return {type:'chat',text:''};
  if(data[0]===0x01) return {type:'yjs',update:data.slice(3),seq:(data[1]<<8)|data[2]};
  const s=data[0]===0x00?1:0;
  return {type:'chat',text:new TextDecoder().decode(data.slice(s))};
}

// ── Sequence + Checksum ──
let _hostSeq = 0;
let _peerSeq = 0;
let _updateCount = 0;
const CHECKSUM_INTERVAL = 10;
async function getChecksum(): Promise<string> {
  const text = ytext?.toString() || '';
  const enc = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ── Email ──
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(e: string) { return EMAIL_RE.test(e); }

// ── WS Relay ──
const WS_URL = 'wss://relay.joverval.cl';
let ws: WebSocket|null = null;
function wsConnect(): Promise<WebSocket> {
  return new Promise((resolve,reject)=>{
    const s=new WebSocket(WS_URL);
    s.onopen=()=>resolve(s);
    s.onerror=()=>reject(new Error('WS connection failed'));
    s.onclose=()=>{ws=null;};
    ws=s;
  });
}

// ── State ──
let myEmail = '', isHost = false, connected = false;
let room: Room|null = null;
let allUsers: {email:string,isHost:boolean}[] = [];
let peerEmails: Map<string,string> = new Map();
let _pendingPeerEmail = '';
const baseUrl = window.location.href.split('#')[0];

// Yjs
let ydoc: Y.Doc|null = null, ytext: Y.Text|null = null, editorView: EditorView|null = null;
let isRemoteUpdate = false;

// File
let fileHandle: FileSystemFileHandle|null = null;

// ── Top Bar / Filename ──
function updateTopBar() {
  $('topbar').style.display = 'flex';
  $('user-count').textContent = String(allUsers.length);
}
// Sync filename to fileHandle when changed
$('topbar-filename').addEventListener('input', ()=>{
  const name = ($('topbar-filename') as HTMLElement).textContent || 'Untitled.md';
  if(isHost && room && connected) {
    room.send(encodeChat(`[FILENAME]${name}`));
  }
});

function broadcastUserList() {
  if(!isHost||!room||!connected) return;
  room.send(encodeChat(`[USERS]${JSON.stringify({type:'users',users:allUsers})}`));
}

let _emailSent = false;

// ── File dropdown toggle ──
$('file-menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('file-dropdown').classList.toggle('show');
});
document.addEventListener('click', () => $('file-dropdown').classList.remove('show'));

// ── Sync from host ──
$('sync-btn').addEventListener('click', () => {
  if(!isHost && room) {
    room.send(encodeChat('[SYNC]'));
    addChatLog('system','🔄 Requested sync from host');
  }
});
function initEditor() {
  addChatLog('system','📝 Editor ready');
  $('editor-section').style.display = 'flex';
  ydoc = new Y.Doc();
  ytext = ydoc.getText('markdown');
  editorView = new EditorView({
    doc: '',
    extensions: [
      basicSetup, markdown(),
      EditorView.updateListener.of((update)=>{
        if(update.docChanged && !isRemoteUpdate) {
          const v = update.state.doc.toString();
          ydoc!.transact(()=>{ ytext!.delete(0,ytext!.length); ytext!.insert(0,v); });
        }
      }),
      EditorView.theme({
        '&':{backgroundColor:'#0d1117'},
        '.cm-gutters':{backgroundColor:'#0d1117',borderRight:'1px solid #21262d',color:'#484f58'},
        '.cm-activeLineGutter':{backgroundColor:'#161b22'},
      }),
    ],
    parent: $('editor'),
  });
  ydoc.on('update',(update:Uint8Array)=>{
    if(isRemoteUpdate) return;
    if(room && connected) {
      _hostSeq++;
      _updateCount++;
      room.send(encodeYjs(update, _hostSeq));
      // Send checksum every CHECKSUM_INTERVAL updates
      if(_updateCount >= CHECKSUM_INTERVAL) {
        _updateCount = 0;
        getChecksum().then(hash => {
          if(room && connected) room.send(encodeChat(`[CHKSUM]${_hostSeq}:${hash}`));
        });
      }
    }
  });
}

// ── File System ──
$('open-file-btn').addEventListener('click', async ()=>{
  if(!isHost||!ydoc) return;
  try {
    let name:string, c:string;
    if(hasFileSystemAPI()){
      const [h]=await window.showOpenFilePicker({types:[{description:'Markdown',accept:{'text/markdown':['.md']}}]});
      fileHandle = h; name = h.name; c = await (await h.getFile()).text();
    } else {
      const r = await fallbackOpenFile(); name = r.name; c = r.content;
    }
    ydoc.transact(()=>{ ytext!.delete(0,ytext!.length); ytext!.insert(0,c); });
    if(editorView) editorView.dispatch({changes:{from:0,to:editorView.state.doc.length,insert:c}});
    ($('topbar-filename') as HTMLElement).textContent = name;
    if(room && connected) room.send(encodeChat(`[FILENAME]${name}`));
    addChatLog('system',`📂 Opened: ${name}`);
  } catch(err:any){ if(err.name!=='AbortError') addChatLog('system',`ERROR: ${err.message}`); }
});

$('save-file-btn').addEventListener('click', async ()=>{
  if(!ytext) return;
  const content = ytext.toString();
  const name = ($('topbar-filename') as HTMLElement).textContent || 'document.md';
  if(hasFileSystemAPI()){
    if(isHost && fileHandle){
      try { const w=await fileHandle.createWritable(); await w.write(content); await w.close(); addChatLog('system',`💾 Saved: ${fileHandle.name}`); return; }
      catch(err:any){ addChatLog('system',`ERROR: ${err.message}`); }
    }
    try {
      const h=await window.showSaveFilePicker({suggestedName:name,types:[{description:'Markdown',accept:{'text/markdown':['.md']}}]});
      const w=await h.createWritable(); await w.write(content); await w.close();
      if(isHost){ fileHandle=h; ($('topbar-filename') as HTMLElement).textContent=h.name; if(room&&connected) room.send(encodeChat(`[FILENAME]${h.name}`)); }
      addChatLog('system',`💾 Saved: ${h.name}`);
    } catch(err:any){ if(err.name!=='AbortError') addChatLog('system',`ERROR: ${err.message}`); }
  } else {
    fallbackSaveFile(content, name);
    addChatLog('system',`💾 Downloaded: ${name}`);
  }
});

function hasFileSystemAPI(){ return typeof window.showOpenFilePicker === 'function'; }
let _fileInput: HTMLInputElement|null = null;
function getFileInput(){ if(!_fileInput){ _fileInput=el('input',{type:'file',accept:'.md'}) as HTMLInputElement; _fileInput.style.display='none'; document.body.appendChild(_fileInput); } return _fileInput; }
function fallbackOpenFile(): Promise<{name:string,content:string}> {
  return new Promise((resolve,reject)=>{
    const i=getFileInput();
    i.onchange=async()=>{ const f=i.files?.[0]; if(!f) return reject(new Error('No file')); resolve({name:f.name,content:await f.text()}); };
    i.click();
  });
}
function fallbackSaveFile(content:string,name:string){
  const b=new Blob([content],{type:'text/markdown'});
  const a=el('a',{href:URL.createObjectURL(b),download:name}); a.click();
}

// ── Chat ──
function sendChat() {
  const input = document.querySelector('#chat-input') as HTMLInputElement;
  if(!input) return;
  const text = input.value.trim();
  if(!text||!room||!connected) return;
  const prefix = isHost ? `[Host] ${myEmail}` : myEmail;
  room.send(encodeChat(`${prefix}: ${text}`));
  addChatLog('sent', isHost ? `[Host]: ${text}` : text);
  input.value = '';
}

// ── HOST ──
async function createRoom() {
  const btn = $('create-room-btn') as HTMLButtonElement;
  if(btn.disabled) return; btn.disabled = true;
  const email = ($('email-input') as HTMLInputElement).value.trim();
  if(!validateEmail(email)){ addChatLog('system','ERROR: Please enter a valid email'); btn.disabled=false; return; }
  myEmail = email; isHost = true;
  allUsers = [{email:myEmail,isHost:true}];
  ($('email-input') as HTMLInputElement).disabled = true;
  updateTopBar();

  addChatLog('system','Creating room...');
  let useRelay = false;
  try {
    await Promise.race([wsConnect(),new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),3000))]);
    useRelay = true;
  } catch { addChatLog('system','⚠️ Relay unavailable — manual mode'); }

  let roomId = '';
  if(useRelay){ roomId = await new Promise<string>(r=>{ ws!.onmessage=e=>{ const m=JSON.parse(e.data); if(m.type==='registered') r(m.room); }; ws!.send(JSON.stringify({type:'host-register'})); }); addChatLog('system',`Room: ${roomId}`); }

  const r = new P2PRoom(true, baseUrl, {
    onError:e=>addChatLog('system',`ERROR: ${e.message}`),
    onPeerLeave: (peerId: string) => {
      const email = peerEmails.get(peerId) || peerId;
      allUsers = allUsers.filter(u => u.email !== email);
      peerEmails.delete(peerId);
      updateTopBar(); broadcastUserList();
      addChatLog('system', `👋 ${email} disconnected`);
      r.offerUrl().then(({url:nu,offerId:noi})=>{
        _currentOfferId = noi;
        _shareUrl = `${baseUrl}#offer=${noi}&sdp=${encodeURIComponent(nu.match(/#sdp=(.*)/)?.[1]||'')}`;
        ($('copy-invite-btn') as HTMLButtonElement).onclick = ()=>{ navigator.clipboard.writeText(_shareUrl).then(()=>{ ($('invite-copied') as HTMLElement).style.display='inline'; setTimeout(()=>($('invite-copied') as HTMLElement).style.display='none',2000); }).catch(()=>{}); };
      }).catch(()=>{});
    },
  });
  const {url,offerId} = await r.offerUrl();
  _currentOfferId = offerId;
  room = r;

  const sdpB64 = url.match(/#sdp=(.*)/)?.[1]||'';
  const shareUrl = useRelay ? `${baseUrl}#room=${roomId}&offer=${offerId}&sdp=${encodeURIComponent(sdpB64)}` : `${baseUrl}#offer=${offerId}&sdp=${encodeURIComponent(sdpB64)}`;
  _shareUrl = shareUrl;

  ($('copy-invite-btn') as HTMLButtonElement).style.display = '';
  ($('copy-invite-btn') as HTMLButtonElement).onclick = ()=>{ navigator.clipboard.writeText(shareUrl).then(()=>{ ($('invite-copied') as HTMLElement).style.display='inline'; setTimeout(()=>($('invite-copied') as HTMLElement).style.display='none',2000); }).catch(()=>{}); };

  ($('open-file-btn') as HTMLButtonElement).disabled = false;
  ($('save-file-btn') as HTMLButtonElement).disabled = false;
  initEditor();

  if(useRelay){
    ws!.onmessage = e=>{
      const m=JSON.parse(e.data);
      if(m.type==='peer-request'){ addChatLog('system',`📩 ${m.email} wants to join`); addPendingRequest(m.email,m.offerId||''); }
      else if(m.type==='answer'){ _pendingPeerEmail=m.email||''; room!.acceptAnswer(m.offerId||'',`#sdp=${m.answerB64}`); addChatLog('system','Answer applied...'); }
    };
  } else {
    ($('manual-answer-input') as HTMLInputElement).style.display = '';
    ($('manual-answer-btn') as HTMLButtonElement).style.display = '';
    ($('manual-answer-btn') as HTMLButtonElement).onclick = ()=>{
      const raw = ($('manual-answer-input') as HTMLInputElement).value.trim();
      if(!raw||!room) return;
      const m=raw.match(/#sdp=(.*)/);
      room.acceptAnswer(_currentOfferId,`#sdp=${m?decodeURIComponent(m[1]):raw}`);
      addChatLog('system','Answer applied...');
      ($('manual-answer-input') as HTMLInputElement).value = '';
    };
  }

  r.onMessage((data,peerId)=>{
    if(!(data instanceof Uint8Array)) return;
    const d=decodeMessage(data);
    if(d.type==='yjs'){
      if(ydoc){
        isRemoteUpdate=true;
        Y.applyUpdate(ydoc,d.update);
        const newText = ytext!.toString();
        if(editorView && editorView.state.doc.toString() !== newText) {
          editorView.dispatch({changes:{from:0,to:editorView.state.doc.length,insert:newText}});
        }
        isRemoteUpdate=false;
      }
      // Forward to other peers (not back to sender)
      room!.send(data);
    } else {
      const sender = peerEmails.get(peerId)||peerId;
      // Internal protocol messages — handle silently
      if(d.text.startsWith('[EMAIL]')){
        const peerEmail = d.text.slice(7);
        peerEmails.set(peerId, peerEmail);
        // Update user list entry
        const idx = allUsers.findIndex(u=>!u.isHost && u.email === peerId);
        if(idx>=0) allUsers[idx] = {email:peerEmail, isHost:false};
        updateTopBar(); broadcastUserList();
      } else if(d.text.startsWith('[SYNC]')){
        if(ydoc){
          room!.send(encodeYjs(Y.encodeStateAsUpdate(ydoc), _hostSeq));
        }
      } else if(d.text.startsWith('[CHKSUM]')){
        // background checksum — ignore
      } else if(d.text.startsWith('[FILENAME]')){
        ($('topbar-filename') as HTMLElement).textContent = d.text.slice(10);
        room!.send(encodeChat(d.text)); // forward to other peers
      } else {
        addChatLog('received',`${sender}: ${d.text}`);
        room!.send(encodeChat(`${sender}: ${d.text}`));
      }
    }
  });

  r.onPeerJoin(async peerId=>{
    connected = true;
    const peerEmail = _pendingPeerEmail||peerId;
    peerEmails.set(peerId,peerEmail);
    allUsers.push({email:peerEmail,isHost:false});
    _pendingPeerEmail = '';
    updateTopBar(); broadcastUserList();
    addChatLog('system',`🎉 ${peerEmail} connected`);
    if(ydoc){ const s=Y.encodeStateAsUpdate(ydoc); room!.send(encodeYjs(s, _hostSeq)); }
    // Generate new offer for next peer
    try {
      const {url:nu,offerId:noi}=await r.offerUrl();
      _currentOfferId = noi;
      _shareUrl = useRelay ? `${baseUrl}#room=${roomId}&offer=${noi}&sdp=${encodeURIComponent(nu.match(/#sdp=(.*)/)?.[1]||'')}` : `${baseUrl}#offer=${noi}&sdp=${encodeURIComponent(nu.match(/#sdp=(.*)/)?.[1]||'')}`;
      ($('copy-invite-btn') as HTMLButtonElement).onclick = ()=>{ navigator.clipboard.writeText(_shareUrl).then(()=>{ ($('invite-copied') as HTMLElement).style.display='inline'; setTimeout(()=>($('invite-copied') as HTMLElement).style.display='none',2000); }).catch(()=>{}); };
      if(!useRelay){ ($('manual-answer-input') as HTMLInputElement).style.display = ''; ($('manual-answer-btn') as HTMLButtonElement).style.display = ''; }
    } catch(err:any){ addChatLog('system',`ERROR: ${err.message}`); }
  });

}

let _currentOfferId = '';
let _shareUrl = '';

function addPendingRequest(email:string, offerId:string){
  $('pending-section').style.display = '';
  const item = el('div',{class:'pending-inline'},[
    el('span',{},[`🔔 ${email} wants to join`]),
    el('div',{class:'btn-row'},[
      el('button',{},['Approve']),
      el('button',{class:'reject-btn'},['Reject']),
    ]),
  ]);
  const [app,rej]=item.querySelectorAll('button');
  app.addEventListener('click',()=>{ ws!.send(JSON.stringify({type:'host-approve',email,offerId})); item.remove(); if(!$('pending-list').children.length) $('pending-section').style.display='none'; });
  rej.addEventListener('click',()=>{ ws!.send(JSON.stringify({type:'host-reject',email})); item.remove(); if(!$('pending-list').children.length) $('pending-section').style.display='none'; });
  $('pending-list').appendChild(item);
}

// ── PEER ──
function parseRoomFromUrl(){ const h=window.location.hash; if(!h) return null; const m1=h.match(/^#room=([^&]+)&offer=([^&]+)&sdp=(.+)$/); if(m1) return {roomId:m1[1],offerId:m1[2],offer:decodeURIComponent(m1[3])}; const m2=h.match(/^#offer=([^&]+)&sdp=(.+)$/); if(m2) return {roomId:'',offerId:m2[1],offer:decodeURIComponent(m2[2])}; return null; }

async function peerAutoJoin(roomId:string, offerId:string, offerB64:string){
  const btn=$('create-room-btn') as HTMLButtonElement;
  if(btn.disabled) return; btn.disabled=true;
  const email=($('email-input') as HTMLInputElement).value.trim();
  if(!validateEmail(email)){ addChatLog('system','ERROR: Please enter a valid email'); btn.disabled=false; return; }
  myEmail=email; ($('email-input') as HTMLInputElement).disabled=true;

  addChatLog('system',`Joining ${roomId||'(manual)'}...`);
  let useRelay=false;
  if(roomId){ try{ await Promise.race([wsConnect(),new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),3000))]); useRelay=true; } catch { addChatLog('system','⚠️ Relay unavailable — manual mode'); } }

  const peer = new P2PRoom(false, baseUrl, {onError:e=>addChatLog('system',`ERROR: ${e.message}`)});
  const answerUrl = await peer.connectToHost(`${baseUrl}#sdp=${offerB64}`);
  room = peer;
  const answerB64 = answerUrl.match(/#sdp=(.*)/)?.[1]||'';

  if(useRelay){
    ws!.send(JSON.stringify({type:'peer-join-request',room:roomId,offerId,email,answerB64}));
    addChatLog('system','Waiting for host approval...');
    ws!.onmessage=e=>{
      const m=JSON.parse(e.data);
      if(m.type==='approved'){
        allUsers=[{email:'Host',isHost:true},{email:myEmail,isHost:false}];
        connected=true; updateTopBar();
        ($('open-file-btn') as HTMLButtonElement).style.display='none';
        ($('save-file-btn') as HTMLButtonElement).disabled=false;
        ($('sync-btn') as HTMLButtonElement).style.display='';
        initEditor();
      } else if(m.type==='rejected') addChatLog('system',`❌ Rejected: ${m.message}`);
    };
  } else {
    const answerFullUrl = `${baseUrl}#sdp=${encodeURIComponent(answerB64)}`;
    ($('copy-invite-btn') as HTMLButtonElement).style.display = '';
    ($('copy-invite-btn') as HTMLButtonElement).textContent = '📋 Copy answer';
    ($('copy-invite-btn') as HTMLButtonElement).onclick = ()=>{ navigator.clipboard.writeText(answerFullUrl).then(()=>{ ($('invite-copied') as HTMLElement).style.display='inline'; setTimeout(()=>($('invite-copied') as HTMLElement).style.display='none',2000); }).catch(()=>{}); };
    allUsers=[{email:'Host',isHost:true},{email:myEmail,isHost:false}];
    connected=true; updateTopBar();
    ($('open-file-btn') as HTMLButtonElement).style.display='none';
    ($('save-file-btn') as HTMLButtonElement).disabled=false;
    initEditor();
    addChatLog('system','📋 Copy the answer link & send to host');
  }

  room.onMessage((data,peerId)=>{
    if(!(data instanceof Uint8Array)) return;
    const d=decodeMessage(data);
    if(d.type==='yjs'){
      // First Yjs update means connection is live — announce email
      if(!_emailSent && myEmail && !isHost) {
        _emailSent = true;
        room!.send(encodeChat(`[EMAIL]${myEmail}`));
      }
      // Sequence validation
      const expectedSeq = _peerSeq + 1;
      if(d.seq !== 0 && d.seq !== expectedSeq) {
        // Out of sync — highlight sync button
        ($('sync-btn') as HTMLButtonElement).style.background = '#da3633';
        ($('sync-btn') as HTMLButtonElement).style.color = '#fff';
      }
      _peerSeq = d.seq || _peerSeq;
      if(ydoc){
        isRemoteUpdate=true; Y.applyUpdate(ydoc,d.update);
        const newText = ytext!.toString();
        if(editorView && editorView.state.doc.toString() !== newText) {
          editorView.dispatch({changes:{from:0,to:editorView.state.doc.length,insert:newText}});
        }
        isRemoteUpdate=false;
      }
    } else {
      if(d.text.startsWith('[USERS]')){
        try { const ud=JSON.parse(d.text.slice(7)); if(ud.type==='users'){ allUsers=ud.users; updateTopBar(); } } catch {}
      } else if(d.text.startsWith('[FILENAME]')){
        ($('topbar-filename') as HTMLElement).textContent = d.text.slice(10);
      } else if(d.text.startsWith('[CHKSUM]')){
        const [seqStr, hash] = d.text.slice(8).split(':');
        if(parseInt(seqStr) !== _peerSeq) {
          // Seq mismatch — highlight sync
          ($('sync-btn') as HTMLButtonElement).style.background = '#da3633';
          ($('sync-btn') as HTMLButtonElement).style.color = '#fff';
        }
        // Verify checksum
        getChecksum().then(localHash => {
          if(localHash !== hash) {
            // Checksum mismatch — auto-sync
            addChatLog('system','⚠️ Checksum mismatch — auto-syncing...');
            room!.send(encodeChat('[SYNC]'));
          }
        });
      } else addChatLog('received',d.text);
    }
  });
}

// ── Bindings ──
document.addEventListener('DOMContentLoaded', () => {
if(!(window as any).__p2pBound){
  (window as any).__p2pBound = true;
  ($('create-room-btn') as HTMLButtonElement).addEventListener('click', createRoom);

  const parsed = parseRoomFromUrl();
  if(parsed){
    ($('create-room-btn') as HTMLButtonElement).textContent = 'Join Room';
    ($('create-room-btn') as HTMLButtonElement).replaceWith(($('create-room-btn') as HTMLButtonElement).cloneNode(true));
    ($('create-room-btn') as HTMLButtonElement).addEventListener('click',()=>peerAutoJoin(parsed.roomId,parsed.offerId,parsed.offer));
  }
}});