// ===== Version tag for debug =====
console.log('INDEX.JS v2025-09-20-shared-playlists');

import { auth as sharedAuth, db as sharedDb, firebaseConfig } from './firebase.js';

// Χρησιμοποίησε ακριβώς το ίδιο instance με το login
window.appId = firebaseConfig.projectId;
window.db    = sharedDb;
window.auth  = sharedAuth;

console.log('[index] Firebase projectId:', window.appId);
console.log('[index] currentUser at start:', window.auth?.currentUser || null);



import { searchLocalSongs, renderLocalResults } from './local-files-search.js?v=2025-09-19';

// ===== Configurable =====
const CONTROLS_TIMEOUT_MS = 6000;


// ===== Firebase handles / flags =====
window.userId = null;
window.isAuthReady = false;

// ===== LIVE SESSION =====
let isAdmin = false;
let liveSessionRef = null;

// ===== UI state =====
let loadingOverlay, messageBox, messageText, messageBoxCloseButton;
let songSelection;
let playlistSongSelector;

// NOTE: playlists now use a composite key "ownerUid__playlistId"
let currentPlaylistKey = null;    // e.g. "abc123__default"
let currentSongId = null;

const loadedSongs = new Map();         // songId -> {id,title,content,_scope}
const loadedPlaylists = new Map();     // plKey -> {id,key,name,ownerUid,shared,sharedRole,notes?}

let currentEntries = [];               // [{songId, order, transpose}]
let currentPlaylistSongs = [];         // array of song objects in order
const transposeBySongId = new Map();   // songId -> transpose semitones

// --- Add Song additions: state for local-file "Add" flow ---
let lastLocalMeta = null;
let lastLocalText = '';
let addLocalSongButton = null;
function hideAddLocalButton() {
  if (addLocalSongButton) addLocalSongButton.style.display = 'none';
  lastLocalMeta = null;
  lastLocalText = '';
}

// ===== Controls auto-hide =====
let controlsHideTimer = null;
function showMenuBar(show) { if (!songSelection) return; songSelection.style.display = show ? 'flex' : 'none'; }
function showControls() {
  document.body.classList.remove('controls-hidden');
  showMenuBar(true);
  clearTimeout(controlsHideTimer);
  controlsHideTimer = setTimeout(() => {
    document.body.classList.add('controls-hidden'); showMenuBar(false);
  }, CONTROLS_TIMEOUT_MS);
}
function primeAutoHide() {
  clearTimeout(controlsHideTimer);
  controlsHideTimer = setTimeout(() => {
    document.body.classList.add('controls-hidden'); showMenuBar(false);
  }, CONTROLS_TIMEOUT_MS);
}

// ===== Toasts & net popups =====
const TOAST_Z = 9000;
let __toastBox, __lastToast = { msg:'', at:0 };
function toast(msg, type='info', ms=2000) {
  const now = Date.now();
  if (__lastToast.msg === msg && now - __lastToast.at < 800) return;
  __lastToast = { msg, at: now };
  if (!__toastBox) {
    __toastBox = document.createElement('div');
    __toastBox.id = 'toastBox';
    __toastBox.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:'+TOAST_Z+';display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none';
    document.body.appendChild(__toastBox);
  }
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'max-width:90vw;padding:10px 14px;border-radius:10px;color:#fff;background:#111a;backdrop-filter:blur(4px);font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:auto;transition:opacity .25s';
  if (type==='success') el.style.background = '#16a34a';
  else if (type==='error') el.style.background = '#dc2626';
  else if (type==='warn') el.style.background = '#f59e0b';
  __toastBox.appendChild(el);
  const t = setTimeout(()=>{ el.style.opacity='0'; setTimeout(()=>el.remove(),250); }, ms);
  el.addEventListener('click', ()=>{ clearTimeout(t); el.remove(); });
}
window.toast = toast;

let __netToastAt=0;
function showNetToast(text='',ms=2000){ const now=Date.now(); if (now-__netToastAt<500) return; __netToastAt=now; toast(text,'warn',ms); }
window.addEventListener('online',  ()=>showNetToast('Back online ✓',2000));
window.addEventListener('offline', ()=>showNetToast('Offline mode: saves will sync later',2000));

// ===== Utils =====
function showLoadingOverlay(){ if (loadingOverlay) loadingOverlay.style.display='flex'; }
function hideLoadingOverlay(){ if (loadingOverlay) loadingOverlay.style.display='none'; }
function bindClickLike(el, fn){
  if (!el) return;
  let last=0;
  function runOnce(e){ const now=Date.now(); if (now-last<350) return; last=now; e.preventDefault(); Promise.resolve().then(fn); }
  el.addEventListener('click', runOnce, {passive:false});
  el.addEventListener('touchend', runOnce, {passive:false});
}

// Message box
function showMessage(message, type='info', duration=null){
  if (!messageBox) {
    messageBox = document.getElementById('messageBox');
    messageText = document.getElementById('messageText');
    messageBoxCloseButton = document.getElementById('messageBoxCloseButton');
    if (messageBoxCloseButton) messageBoxCloseButton.addEventListener('click', hideMessageBox);
  }
  if (!messageBox || !messageText) return;
  messageText.textContent = message;
  messageBox.className = `message-box ${type}`;
  messageBox.style.display = 'block';
  if (duration) setTimeout(()=>hideMessageBox(), duration);
}
function hideMessageBox(){ if (messageBox) messageBox.style.display='none'; }

// ===== Chords / transpose =====
const sharps = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const flats  = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
const toSharps = {"Db":"C#","Eb":"D#","Gb":"F#","Ab":"G#","Bb":"A#"};
const chordRegex=/([CDEFGAB][b#]?(?:maj|min|m|M|sus|add|dim|°|aug|dom|6|7|9|11|13|b5|#5|\/|\d)*)/g;
let originalProcessedHtml="", currentTransposition=0;

function getTransposedChord(originalChord, semitones){
  const m = originalChord.match(/^([CDEFGAB][b#]?)(.*)$/i);
  if (!m) {
    const slash = originalChord.indexOf('/');
    if (slash !== -1) {
      const a = originalChord.slice(0,slash), b=originalChord.slice(slash+1);
      return `${getTransposedChord(a,semitones)}/${getTransposedChord(b,semitones)}`;
    }
    return originalChord;
  }
  let base = m[1], suf = m[2]||'';
  let norm = toSharps[base] || base;
  let idx = sharps.indexOf(norm);
  if (idx===-1) return originalChord;
  let nidx = (idx + semitones + sharps.length) % sharps.length;
  let out = sharps[nidx];
  if (base.includes('b') && flats[nidx] && !['C','F'].includes(sharps[nidx])) out = flats[nidx];
  return out + suf;
}
function applyTranspositionToDisplay(){
  const songDisplay = document.getElementById('songDisplay');
  const html = originalProcessedHtml.replace(/<span class="chord">(.*?)<\/span>/g, (_,ch) =>
    `<span class="chord">${getTransposedChord(ch, currentTransposition)}</span>`);
  songDisplay.innerHTML = html;
  setTimeout(adjustFontSize, 0);
  // === LIVE SYNC: Admin broadcasts transpose changes ===
  if (isAdmin && liveSessionRef && currentSongId && loadedSongs.has(currentSongId)) {
    const s = loadedSongs.get(currentSongId);
    liveSessionRef.set({
      isActive: true,
      currentSongId,
      currentSongTitle: s.title,
      currentSongContent: s.content,
      transpose: currentTransposition
    }, { merge: true });
  }
}
function toggleEditMode() {
  const songDisplay = document.getElementById('songDisplay');
  const songViewer  = document.querySelector('.song-viewer');
  const inEdit = songDisplay?.isContentEditable;
  if (!songDisplay || !songViewer) return;

  if (inEdit) {
    songViewer.classList.remove('editing');
    songDisplay.setAttribute('contenteditable', 'false');

    const txt = songDisplay.innerText || "";
    const lines = txt.split('\n');
    const title = (lines[0] || '').trim() || "Untitled";
    const body  = lines.length > 1 ? lines.slice(1).join('\n').trim() : "";
    processInput(body, title);

    showControls();
  } else {
    songViewer.classList.add('editing');
    songDisplay.setAttribute('contenteditable', 'true');
    songDisplay.focus();

    document.body.classList.remove('controls-hidden');
    showMenuBar(true);
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
}

// ===== Font sizing & zoom =====
const FONT_DELTA_KEY = 'lyrics.fontDeltaPx';
let userFontDelta = parseInt(localStorage.getItem(FONT_DELTA_KEY) || '0', 10);
let manualZoom = false;

function setUserFontDelta(px) {
  userFontDelta = Math.max(-8, Math.min(24, px));
  localStorage.setItem(FONT_DELTA_KEY, String(userFontDelta));
  manualZoom = true;
  adjustFontSize();
}
function adjustFontSize(){
  const songDisplay = document.getElementById('songDisplay');
  const songViewer  = document.querySelector('.song-viewer');
  if (!songDisplay || !songViewer) return;

  const viewerStyle = window.getComputedStyle(songViewer);
  const vPadX = parseFloat(viewerStyle.paddingLeft) + parseFloat(viewerStyle.paddingRight);
  const vPadY = parseFloat(viewerStyle.paddingTop) + parseFloat(viewerStyle.paddingBottom);
  const availW = songViewer.clientWidth - vPadX;
  const availH = songViewer.clientHeight - vPadY;
  if (availW <= 0 || availH <= 0) return;

  const base = Math.max(12, 32 + userFontDelta);
  songDisplay.style.fontSize = base + 'px';
  songDisplay.style.transform = 'scale(1)';
  songDisplay.style.transformOrigin = 'top left';

  if (manualZoom) {
    songViewer.style.overflowY = 'auto';
    songViewer.style.overflowX = 'auto';
    songViewer.style.webkitOverflowScrolling = 'touch';
    return;
  }

  let currentFontSize = parseFloat(songDisplay.style.fontSize);
  const minFontSize = 12;
  let attempts = 0, maxAttempts = 60;

  while ((songDisplay.scrollHeight > availH || songDisplay.scrollWidth > availW) &&
          currentFontSize > minFontSize && attempts < maxAttempts) {
    currentFontSize -= 0.5;
    songDisplay.style.fontSize = `${Math.max(currentFontSize, minFontSize)}px`;
    attempts++;
  }

  let trySize = currentFontSize; attempts = 0;
  while (attempts < maxAttempts) {
    const next = trySize + 0.5;
    songDisplay.style.fontSize = `${next}px`;
    if (songDisplay.scrollHeight <= availH && songDisplay.scrollWidth <= availW) {
      trySize = next;
    } else {
      songDisplay.style.fontSize = `${currentFontSize}px`;
      break;
    }
    currentFontSize = trySize; attempts++;
  }

  const cW = songDisplay.scrollWidth, cH = songDisplay.scrollHeight;
  if (cW > 0 && cH > 0) {
    const sX = availW / cW, sY = availH / cH;
    const scale = Math.min(sX, sY, 1);
    songDisplay.style.transform = scale > 0.98 && (cW < availW || cH < availH) ? `scale(${scale})` : 'scale(1)';
  }

  songViewer.style.overflowY = 'hidden';
  songViewer.style.overflowX = 'hidden';
}

// ===== Song rendering =====
function processInput(rawText, songTitle="Untitled Song"){
  const songDisplay = document.getElementById('songDisplay');
  const title = (typeof songTitle==='string'?songTitle:'Untitled').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const text  = (typeof rawText==='string'?rawText:'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const titleHtml = `<span class="song-title">${title}</span>`;
  const contentWithChords = text.replace(chordRegex, m => /^[CDEFGAB][b#]?/.test(m) ? `<span class="chord">${m}</span>` : m);
  const full = titleHtml + contentWithChords.replace(/\n/g,'<br>');

  songDisplay.innerHTML = full;
  originalProcessedHtml = songDisplay.innerHTML;

  setTimeout(adjustFontSize, 0);
}

// ===== Firestore helpers (owner-aware) =====
function userSongsColl(uid = window.userId){
  if (!window.db || !window.appId || !uid) throw new Error('Login required');
  return window.db.collection(`artifacts/${window.appId}/users/${uid}/songs`);
}
function publicSongsColl(){
  if (!window.db || !window.appId) throw new Error('App not ready');
  return window.db.collection(`artifacts/${window.appId}/public/data/songs`);
}
function userPlaylistsColl(uid = window.userId){
  if (!window.db || !window.appId || !uid) throw new Error('Login required');
  return window.db.collection(`artifacts/${window.appId}/users/${uid}/playlists`);
}
function playlistEntriesColl(playlistId, ownerUid = window.userId){
  if (!window.db || !window.appId || !ownerUid || !playlistId) throw new Error('Missing context');
  return window.db.collection(`artifacts/${window.appId}/users/${ownerUid}/playlists/${playlistId}/entries`);
}
function myInboxColl(){
  if (!window.db || !window.appId || !window.userId) throw new Error('Login required');
  return window.db.collection(`artifacts/${window.appId}/users/${window.userId}/inboxShared`);
}
function mySongsColl(){
  if (!window.db || !window.appId || !window.userId) throw new Error('Login required');
  return window.db.collection(`artifacts/${window.appId}/users/${window.userId}/songs`);
}
function myPlaylistsColl(){
  if (!window.db || !window.appId || !window.userId) throw new Error('Login required');
  return window.db.collection(`artifacts/${window.appId}/users/${window.userId}/playlists`);
}
function myPlaylistEntriesColl(pid){
  if (!window.db || !window.appId || !window.userId || !pid) throw new Error('Missing context');
  return window.db.collection(`artifacts/${window.appId}/users/${window.userId}/playlists/${pid}/entries`);
}
function inboxSharedColl(){
  if (!window.db || !window.appId || !window.userId) throw new Error('Login required');
  return window.db.collection(`artifacts/${window.appId}/users/${window.userId}/inboxShared`);
}
function myGrantsColl(){
  if (!window.db || !window.appId || !window.userId) throw new Error('Login required');
  return window.db.collection(`artifacts/${window.appId}/users/${window.userId}/grants`);
}

// Slug helper (for playlist ids)
function slugifyName(s=''){
  return String(s).toLowerCase().trim().replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,'').slice(0,60) || 'shared';
}

// ===== Import helpers (idempotent + clear inbox) =====
async function processShareInboxOnce(){
  const snap = await myInboxColl().where('processed','==',false).get();
  if (snap.empty) return;

  for (const doc of snap.docs){
    try {
      await importInboxItem(doc);
    } catch (e) {
      console.warn('processShareInboxOnce import failed for', doc.id, e);
    }
  }
}

async function importInboxItem(docSnap){
  const data = docSnap.data() || {};
  const items = Array.isArray(data.items) ? data.items : [];

  // Target playlist (stable ID -> prevents duplicates)
  const baseName = (data.playlistName || 'Shared').toString().trim() || 'Shared';
  const targetId  = `shared-${docSnap.id}`;      // stable, collision-free
  const targetRef = userPlaylistsColl().doc(targetId);

  // If playlist already exists, just clear inbox doc and bail (prevents re-import)
  const already = await targetRef.get();
  if (already.exists) {
    try { await docSnap.ref.delete(); } catch (e) {
      // fallback: mark processed true so the watcher stops
      await docSnap.ref.set({ processed: true, processedAt: Date.now() }, { merge: true }).catch(()=>{});
    }
    return;
  }

  if (!items.length) {
    try { await docSnap.ref.delete(); } catch {
      await docSnap.ref.set({ processed: true, processedAt: Date.now() }, { merge: true }).catch(()=>{});
    }
    return;
  }

  // 1) create/merge playlist doc with notes + provenance
  await targetRef.set(
    {
      name: baseName,
      notes: typeof data.notes === 'string' ? data.notes : '',
      from: {
        uid: data.fromUid || null,
        email: data.fromEmail || '',
        displayName: data.fromDisplayName || ''
      },
      createdByShare: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  // 2) create songs + entries in order (songs stay in the user's library; we never delete them on playlist delete)
  let order = 10;
  for (const it of items) {
    const title = (it && it.title) ? String(it.title) : 'Untitled';
    const content = (it && typeof it.content === 'string') ? it.content : '';
    const transpose = (it && typeof it.transpose === 'number') ? it.transpose : 0;

    const songPayload = {
      title,
      content,
      timestamp: Date.now(),
      userId: window.userId,
      _source: 'inboxShared',
      _fromUid: data.fromUid || null
    };
    const sref = await userSongsColl().add(songPayload);
    await playlistEntriesColl(targetId).doc(sref.id)
      .set({ order, transpose }, { merge: true });
    order += 10;
  }

  // 3) clear inbox doc (delete preferred; falls back to processed:true)
  try {
    await docSnap.ref.delete();
  } catch (e) {
    await docSnap.ref.set({ processed: true, processedAt: Date.now() }, { merge: true }).catch(()=>{});
  }

  // Refresh UI + toast
  await populatePlaylistsAndSongs();
  try {
    const sel = document.getElementById('playlistSongSelector');
    if (sel) {
      sel.value = targetId;
      window.currentPlaylistId = targetId;
      await (window.loadEntriesForCurrentPlaylist ? loadEntriesForCurrentPlaylist() : Promise.resolve());
    }
  } catch {}
  toast(`Imported “${baseName}” from inbox.`, 'success', 2200);
}

// === Live watcher (start/stop) ===
let __stopInboxWatch = null;
function stopInboxWatcher(){
  try { __stopInboxWatch && __stopInboxWatch(); } catch {}
  __stopInboxWatch = null;
}
function startInboxWatcher(){
  stopInboxWatcher();
  __stopInboxWatch = inboxSharedColl()
    .where('processed','==',false)
    .onSnapshot(async (snap) => {
      if (!snap.empty) {
        for (const docSnap of snap.docs) {
          try { await importInboxItem(docSnap); }
          catch (e) {
            console.warn('Inbox import failed for', docSnap.id, e);
            toast('Import failed: ' + (e?.message || e), 'error', 3000);
          }
        }
      }
    }, (err) => {
      console.warn('Inbox watcher error:', err);
      toast('Inbox listener error: ' + (err?.message || err), 'error', 3000);
    });
}

// ===== Loaders =====
function loadSelectedSong(songId) {
  hideAddLocalButton();
  if (songId && loadedSongs.has(songId)) {
    const s = loadedSongs.get(songId);
    const saved = transposeBySongId.get(songId);
    currentTransposition = (typeof saved === 'number') ? saved : 0;

    processInput(s.content || '', s.title || s.id || 'Untitled');
    applyTranspositionToDisplay();

    currentSongId = songId;

    const songDisplay = document.getElementById('songDisplay');
    if (songDisplay) songDisplay.setAttribute('contenteditable','false');

    primeAutoHide();
  } else {
    // restore original behavior: only fallback when no valid song
    processInput("", "Select a playlist to see songs.");
    currentSongId = null;
  }
  // === LIVE SYNC: Admin broadcasts current song ===
  if (isAdmin && liveSessionRef && currentSongId && loadedSongs.has(currentSongId)) {
    const s = loadedSongs.get(currentSongId);
    liveSessionRef.set({
      isActive: true,
      currentSongId,
      currentSongTitle: s.title,
      currentSongContent: s.content,
      transpose: currentTransposition
    }, { merge: true });
  }
}

async function loadEntriesForCurrentPlaylist() {
  transposeBySongId.clear();
  currentEntries = [];
  currentPlaylistSongs = [];

  if (!currentPlaylistKey) {
    processInput("", "Select a playlist to see songs.");
    currentSongId = null;
    return;
  }

  const { ownerUid, pid } = parsePlKey(currentPlaylistKey);

  try {
    const snap = await playlistEntriesColl(pid, ownerUid).orderBy('order','asc').get();

    if (snap.empty) {
      currentEntries = [];
      currentPlaylistSongs = [];
      currentSongId = null;
      processInput("", "This playlist is empty.");
      return;
    }

    // Collect entries
    snap.forEach(doc => {
      const d = doc.data() || {};
      const songId = doc.id;
      currentEntries.push({
        songId,
        order: (typeof d.order === 'number') ? d.order : 0,
        transpose: (typeof d.transpose === 'number') ? d.transpose : 0
      });
      transposeBySongId.set(songId, d.transpose || 0);
    });

    // Ensure songs exist for each entry
    const ordered = currentEntries.slice().sort((a,b)=>(a.order||0)-(b.order||0));
    currentPlaylistSongs = [];

    for (const e of ordered) {
      let s = loadedSongs.get(e.songId);

      // For shared playlists, try fetching from owner's songs if not cached
      if (!s && ownerUid !== window.userId) {
        try {
          const docSnap = await userSongsColl(ownerUid).doc(e.songId).get();
          if (docSnap.exists) {
            const d = docSnap.data() || {};
            if (d.title && (d.content !== undefined)) {
              s = { id: docSnap.id, title: d.title, content: d.content, _scope: 'shared' };
              loadedSongs.set(docSnap.id, s);
            }
          }
        } catch (err) {
          console.warn('Shared song fetch failed:', e.songId, err);
        }
      }

      if (s) {
        currentPlaylistSongs.push(s);
      } else {
        console.warn(`Entry ${e.songId} skipped (missing or no permission).`);
      }
    }

    // Handle case: all entries invalid/missing
    if (!currentPlaylistSongs.length) {
      currentSongId = null;
      processInput("", "This playlist is empty.");
      return;
    }

    // Ensure currentSongId belongs to this playlist
    if (!currentPlaylistSongs.some(s => s.id === currentSongId)) {
      currentSongId = currentPlaylistSongs[0].id; // reset to first song
    }

    loadSelectedSong(currentSongId);

  } catch (err) {
    console.warn('Failed to load playlist entries:', err);
    processInput("", "Error loading playlist.");
  }
}

function populatePlaylistSelector(){
  if (!playlistSongSelector) return;
  playlistSongSelector.innerHTML='';

  const arr = Array.from(loadedPlaylists.values())
    .sort((a,b)=>(a.name||a.id).localeCompare(b.name||b.id));

  if (arr.length===0){
    const o=document.createElement('option'); o.value=''; o.textContent='No Playlists Available';
    playlistSongSelector.appendChild(o); playlistSongSelector.disabled = true;
  } else {
    playlistSongSelector.disabled=false;
    arr.forEach(p=>{
      const o=document.createElement('option');
      o.value = p.key;
      o.textContent = p.name || p.id;
      playlistSongSelector.appendChild(o);
    });
  }
}

// ===== Data bootstrap (songs + playlists) =====
async function populatePlaylistsAndSongs(){
  if (!window.db || !window.appId || !window.userId) { console.warn("Login required for playlists"); return; }

  const [pls, usr, pub, grants] = await Promise.all([
    userPlaylistsColl(window.userId).get(),
    userSongsColl(window.userId).get(),
    publicSongsColl().get(),
    myGrantsColl().get()
  ]);

  loadedPlaylists.clear();

  if (pls && !pls.empty) {
    pls.forEach(doc=>{
      const d=doc.data()||{};
      const key = makePlKey(window.userId, doc.id);
      loadedPlaylists.set(key, {
        id: doc.id,
        key,
        name: d.name || doc.id,
        ownerUid: window.userId,
        shared: false,
        sharedRole: null,
        notes: d.notes || ""
      });
    });
  }

  // Add shared playlists from my GRANTS (live references)
  if (grants && !grants.empty) {
    grants.forEach(doc => {
      const g = doc.data() || {};
      const ownerUid = g.ownerUid;
      const pid = g.playlistId;
      if (!ownerUid || !pid) return;
      const key = makePlKey(ownerUid, pid);
      loadedPlaylists.set(key, {
        id: pid,
        key,
        name: g.playlistName || pid,
        ownerUid,
        shared: true,
        sharedRole: g.role || 'viewer',
        notes: ''
      });
    });
  }

  // We no longer query collectionGroup('shares'); shares are imported via inboxShared.

  populatePlaylistSelector();

  const last = localStorage.getItem('lastEditedPlaylistKey');
  if (!currentPlaylistKey) {
    if (last && loadedPlaylists.has(last)) currentPlaylistKey = last;
    else if (loadedPlaylists.size) currentPlaylistKey = Array.from(loadedPlaylists.keys())[0];
  }
  if (playlistSongSelector && currentPlaylistKey) playlistSongSelector.value = currentPlaylistKey;

  loadedSongs.clear();
  if (pub && !pub.empty) pub.forEach(doc=>{
    const d=doc.data()||{}; if (d.title && typeof d.title==='string' && (d.content !== undefined)){
      loadedSongs.set(doc.id, {id:doc.id, title:d.title, content:d.content, _scope:'public'});
    }
  });
  if (usr && !usr.empty) usr.forEach(doc=>{
    const d=doc.data()||{}; if (d.title && typeof d.title==='string' && (d.content !== undefined)){
      loadedSongs.set(doc.id, {id:doc.id, title:d.title, content:d.content, _scope:'user'});
    }
  });

  await loadEntriesForCurrentPlaylist();
}

// ===== Save helpers (songs & transpose) =====
async function saveCurrentEntryTranspose(){
  if (!currentPlaylistKey || !currentSongId) return;

  const pl = loadedPlaylists.get(currentPlaylistKey);
  const { ownerUid, pid } = parsePlKey(currentPlaylistKey);
  const canWrite = (ownerUid === window.userId) || (pl && pl.shared && pl.sharedRole === 'editor');

  if (!canWrite) { toast('Shared playlist is read-only (viewer).', 'warn', 1800); return; }

  try {
    await playlistEntriesColl(pid, ownerUid)
      .doc(currentSongId)
      .set({ transpose: currentTransposition }, { merge: true });
    transposeBySongId.set(currentSongId, currentTransposition);
  } catch (e) {
    console.warn('Failed to save transpose:', e);
  }
}

async function saveSong(){
  if (!window.db || !window.appId || !window.userId) { toast("Cannot save: Login required.",'error',2000); return; }
  const songDisplay=document.getElementById('songDisplay');
  const fullText=songDisplay.innerText||"";
  const lines=fullText.split('\n');
  let title=(lines[0]||'').trim()||"Untitled";
  let body = lines.length>1?lines.slice(1).join('\n').trim():"";
  if (!title || title==="Untitled"){
    const nt=prompt("Please enter a title for this song:",""); if (!nt||!nt.trim()){ toast("Save cancelled.",'info',1500); return; } title=nt.trim();
  }
  if (!body.trim()){ toast("Cannot save an empty song.",'error',2000); return; }

  const coll=userSongsColl(window.userId);
  const isNew=!currentSongId;
  const payload={title, content:body, timestamp:Date.now(), userId:window.userId};
  try{
    if (isNew){
      const ref = await coll.add(payload);
      currentSongId = ref.id; loadedSongs.set(currentSongId, {id:currentSongId, ...payload});
      processInput(body, title); await populatePlaylistsAndSongs(); toast(`Song "${title}" saved.`,'success',1600);
    } else {
      await coll.doc(currentSongId).set(payload, {merge:true});
      loadedSongs.set(currentSongId, {id:currentSongId, ...payload});
      processInput(body, title); toast(`Song "${title}" saved.`,'success',1600);
    }
  }catch(e){ toast(`Error saving song: ${e.message}`,'error',3000); }
}
window.saveSong = saveSong;

function newSong(){
  hideAddLocalButton();
  currentSongId=null;
  const songDisplay=document.getElementById('songDisplay');
  songDisplay.innerHTML=""; processInput("", "New Song Title");
  songDisplay.setAttribute('contenteditable','true');
  showMenuBar(true);
  songDisplay.focus();
  showControls();
}
window.newSong = newSong;

async function removeSongFromAllPlaylists(songId){
  if (!window.db || !window.appId || !window.userId || !songId) return;
  // Only cleans up YOUR playlists; songs themselves are NOT deleted here.
  const plsSnap = await userPlaylistsColl(window.userId).get();
  const ops = [];

  plsSnap.forEach(doc => {
    const plId = doc.id;
    // 1) New model: delete entry doc if exists
    ops.push( playlistEntriesColl(plId, window.userId).doc(songId).delete().catch(()=>{}) );

    // 2) Legacy model: arrayRemove from playlist.songs if present
    const data = doc.data() || {};
    if (Array.isArray(data.songs) && data.songs.includes(songId)) {
      ops.push(
        userPlaylistsColl(window.userId).doc(plId)
          .set({ songs: firebase.firestore.FieldValue.arrayRemove(songId) }, { merge: true })
          .catch(()=>{})
      );
    }
  });

  await Promise.all(ops);
}

async function deleteSong(){
  if (!currentSongId){ showMessage("No song selected to delete.",'error'); return; }
  const s = loadedSongs.get(currentSongId);
  if (!s){ showMessage("Song not found to delete.",'error'); return; }

  if (!window.confirm(`Delete "${s.title}"? This removes your copy and cleans up your playlists.`)) return;

  try{
    await userSongsColl(window.userId).doc(currentSongId).delete();
    await removeSongFromAllPlaylists(currentSongId);

    loadedSongs.delete(currentSongId);
    if (currentPlaylistSongs?.length) {
      currentPlaylistSongs = currentPlaylistSongs.filter(x => x?.id !== currentSongId);
    }
    transposeBySongId.delete(currentSongId);
    currentSongId = null;

    showMessage(`"${s.title}" deleted and removed from your playlists.`, 'success', 2000);
    await populatePlaylistsAndSongs();
  }catch(err){
    showMessage(`Error deleting song: ${err.message}`,'error');
  }
}
window.deleteSong = deleteSong;

// --- Add Song additions: create user song from last local & append to playlist ---
async function addCurrentLocalToPlaylist(){
  if (!window.db || !window.appId || !window.userId) { toast('Login required to add to playlist.', 'error', 2500); return; }
  if (!currentPlaylistKey) { toast('Choose a playlist first.', 'warn', 2500); return; }
  const { ownerUid, pid } = parsePlKey(currentPlaylistKey);
  if (ownerUid !== window.userId) { toast('Cannot add local songs to a shared playlist you do not own.', 'warn', 2600); return; }

  const text = (lastLocalText || '').trim();
  if (!text) { toast('Nothing to add.', 'warn', 2000); return; }

  const lines = text.split(/\r\n|\r|\n/);
  let tIndex = lines.findIndex(l => (l||'').trim() !== '');
  if (tIndex < 0) tIndex = 0;
  const title = (lines[tIndex] || 'Untitled').trim();
  const body  = lines.slice(tIndex + 1).join('\n');

  const payload = {
    title, content: body, timestamp: Date.now(), userId: window.userId,
    _source: 'local-file',
    _filename: lastLocalMeta?.name || null
  };

  // 1) create Firestore song
  const ref = await userSongsColl(window.userId).add(payload);
  const newSongId = ref.id;
  loadedSongs.set(newSongId, { id: newSongId, title, content: body, _scope: 'user' });

  // 2) append to playlist entries
  let maxOrder = 0;
  currentEntries.forEach(e => { if (typeof e.order === 'number') maxOrder = Math.max(maxOrder, e.order); });
  const nextOrder = (maxOrder || 0) + 10;
  await playlistEntriesColl(pid, ownerUid).doc(newSongId)
    .set({ order: nextOrder, transpose: 0 }, { merge: true });
  currentEntries.push({ songId: newSongId, order: nextOrder, transpose: 0 });

  // 3) legacy array for compatibility (owner only)
  await userPlaylistsColl(window.userId).doc(pid).set({
    songs: firebase.firestore.FieldValue.arrayUnion(newSongId)
  }, { merge: true });

  // 4) activate it in UI
  currentSongId = newSongId;
  loadSelectedSong(newSongId);
  hideAddLocalButton();
  toast(`Added "${title}" to playlist.`, 'success', 1800);
}

// ===== Search modal (Firebase + Local files) =====
function normalizeText(text){ if (typeof text!== 'string') return ""; return text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase(); }

async function handleSearch(){
  const si  = document.getElementById('searchInput');
  const res = document.getElementById('searchResults');
  const termRaw = (si?.value || '').trim();
  const term = normalizeText(termRaw);
  if (!res) return;
  res.innerHTML = '';

  const byTitle = new Map();
  for (const s of loadedSongs.values()) {
    const key = normalizeKeyTitle(s.title || s.id);
    byTitle.set(key, preferUserOrNewest(byTitle.get(key), s));
  }
  let lib = Array.from(byTitle.values());

  if (term.length > 0) {
    lib = lib.filter(s =>
      normalizeText(s.title).includes(term) ||
      normalizeText(s.content).includes(term)
    );
  }

  lib.sort((a,b)=>normalizeText(a.title).localeCompare(normalizeText(b.title)));

  const header = document.createElement('div');
  header.style.cssText = 'padding:8px 12px; font-weight:700; color:#0f172a; background:#f1f5f9; border:1px solid #e2e8f0; border-radius:6px; margin:6px 0;';
  header.textContent = 'Firebase';
  res.appendChild(header);

  if (lib.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-result-item';
    empty.textContent = 'No matches in Firebase';
    res.appendChild(empty);
  } else {
    lib.forEach(s => {
      const d = document.createElement('div');
      d.className = 'search-result-item';
      d.textContent = s.title;
      d.dataset.src = 'lib';
      d.dataset.songId = s.id;
      res.appendChild(d);
    });
  }

  try {
    const local = await searchLocalSongs(termRaw);
    renderLocalResults(res, local, {
      onOpen: (meta, text) => {
        const lines = (text || '').split(/\r\n|\r|\n/);
        let tIndex = lines.findIndex(l => l.trim() !== '');
        if (tIndex < 0) tIndex = 0;
        const title = (lines[tIndex] || 'Untitled').trim();
        const body  = lines.slice(tIndex + 1).join('\n');
        processInput(body, title);
        currentSongId = null;
        applyTranspositionToDisplay();
        const overlay = document.getElementById('searchOverlay');
        if (overlay) overlay.style.display = 'none';

        lastLocalMeta = meta || null;
        lastLocalText = text || '';
        if (addLocalSongButton) addLocalSongButton.style.display = 'flex';
      }
    });
  } catch (e) {
    console.error('Local search failed', e);
  }

  if (termRaw && lib.length === 0 && !res.querySelector('#local-files-section .search-result-item')){
    const n = document.createElement('div');
    n.style.cssText = 'padding:10px;text-align:center;color:#666;';
    n.textContent = 'No results found.';
    res.appendChild(n);
  }
}

// ===== Keyboard + on-screen navigation =====
function goPrevNextSong(dir) {
  if (!currentPlaylistSongs.length) return;

  const idx = currentPlaylistSongs.findIndex(s => s.id === currentSongId);
  const n = currentPlaylistSongs.length;

  let newIdx;
  if (idx === -1) {
    // If somehow no song is selected, just start at first/last in this SAME playlist
    newIdx = (dir === 'next') ? 0 : n - 1;
  } else {
    // Always wrap within this playlist only
    newIdx = (idx + (dir === 'next' ? 1 : -1) + n) % n;
  }

  const nextSong = currentPlaylistSongs[newIdx];
  if (nextSong) {
    loadSelectedSong(nextSong.id);
  }
}

// ===== Swipe navigation (touch & pointer) =====
function addSwipeNavigation() {
  const area = document.querySelector('.song-viewer') || document.body;
  if (!area) return;

  let startX = 0, startY = 0, tracking = false, moved = false;

  function onStart(e) {
    const t = (e.touches && e.touches[0]) ? e.touches[0] : e;
    startX = t.clientX; startY = t.clientY;
    tracking = true; moved = false;
  }
  function onMove(e) {
    if (!tracking) return;
    moved = true;
  }
  function onEnd(e) {
    if (!tracking) return;
    tracking = false;

    const t = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : e;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    // οριζόντια κίνηση, μικρή κάθετη, αξιοπρεπές μήκος
    const H_THRESHOLD = 60;
    const V_THRESHOLD = 50;
    if (Math.abs(dx) >= H_THRESHOLD && Math.abs(dy) <= V_THRESHOLD) {
      if (dx < 0) {
        // swipe αριστερά -> επόμενο
        goPrevNextSong('next');
      } else {
        // swipe δεξιά -> προηγούμενο
        goPrevNextSong('prev');
      }
      showControls(); // ώστε να μη "κρυφτούν" τα controls
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // Touch
  area.addEventListener('touchstart', onStart, { passive: true });
  area.addEventListener('touchmove',  onMove,  { passive: true });
  area.addEventListener('touchend',   onEnd,   { passive: false });

  // Pointer (για stylus/ποντίκι σε tablets)
  area.addEventListener('pointerdown', onStart, { passive: true });
  area.addEventListener('pointermove',  onMove,  { passive: true });
  area.addEventListener('pointerup',    onEnd,   { passive: false });
}





// ===== Composite key helpers =====
function makePlKey(ownerUid, pid){ return `${ownerUid}__${pid}`; }
function parsePlKey(key){
  const i = key.indexOf('__');
  if (i === -1) return { ownerUid: window.userId, pid: key };
  return { ownerUid: key.slice(0,i), pid: key.slice(i+2) };
}
function normalizeKeyTitle(s=''){
  return s.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().trim();
}
function preferUserOrNewest(a, b){
  if (!a) return b;
  if (!b) return a;
  const rank = x => (x && x._scope === 'user') ? 2 : 1;
  if (rank(b) !== rank(a)) return rank(b) > rank(a) ? b : a;
  const ta = a.timestamp || 0, tb = b.timestamp || 0;
  return tb > ta ? b : a;
}

// ===== Boot =====
document.addEventListener('DOMContentLoaded', async ()=>{
  songSelection = document.querySelector('.song-selection');
  const songDisplay = document.getElementById('songDisplay');
  const songViewer  = document.querySelector('.song-viewer');
  loadingOverlay = document.getElementById('loadingOverlay');
  playlistSongSelector = document.getElementById('playlistSongSelector');

  const vt = document.getElementById('verTag');
  if (vt) vt.textContent = 'INDEX.JS v2025-09-20-shared-playlists • ' + new Date().toLocaleString();

  // Modal bits
  const searchOverlay = document.getElementById('searchOverlay');
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');
  const searchButton = document.getElementById('searchButton');
  const closeSearchButton = document.getElementById('closeSearchButton');

  // Controls
  const btnEdit   = document.getElementById('editButton');
  const btnResetTr= document.getElementById('resetTransposeButton');
  const btnTrDn   = document.getElementById('transposeDownButton');
  const btnTrUp   = document.getElementById('transposeUpButton');
  const btnFontDn = document.getElementById('fontDownButton');
  const btnFontUp = document.getElementById('fontUpButton');
  const btnPrev   = document.getElementById('prevSongButton');
  const btnNext   = document.getElementById('nextSongButton');

  // "Add" button
  if (songSelection) {
    addLocalSongButton = document.createElement('button');
    addLocalSongButton.id = 'addLocalSongButton';
    addLocalSongButton.title = 'Add Song to current playlist';
    addLocalSongButton.textContent = 'Add';
    addLocalSongButton.style.cssText = 'margin-left:8px;padding:8px 12px;border:none;border-radius:10px;background:#6c757d;color:#fff;font-weight:800;cursor:pointer;display:none;';
    songSelection.appendChild(addLocalSongButton);
	  addSwipeNavigation();
    bindClickLike(addLocalSongButton, async () => {
      try { await addCurrentLocalToPlaylist(); }
      catch (e) { toast('Add failed: ' + (e?.message || e), 'error', 3000); console.error(e); }
    });
  }

  // Wire controls
  bindClickLike(btnEdit, toggleEditMode);
  bindClickLike(btnPrev, () => { goPrevNextSong('prev'); showControls(); });
  bindClickLike(btnNext, () => { goPrevNextSong('next'); showControls(); });

  if (searchButton) searchButton.disabled = false;

  bindClickLike(btnTrDn, ()=>{ currentTransposition -= 1; applyTranspositionToDisplay(); saveCurrentEntryTranspose(); showControls(); });
  bindClickLike(btnTrUp, ()=>{ currentTransposition += 1; applyTranspositionToDisplay(); saveCurrentEntryTranspose(); showControls(); });
  bindClickLike(btnResetTr, ()=>{ currentTransposition = 0; applyTranspositionToDisplay(); saveCurrentEntryTranspose(); showControls(); });

  bindClickLike(btnFontDn, ()=>{ setUserFontDelta(userFontDelta - 2); showControls(); });
  bindClickLike(btnFontUp, ()=>{ setUserFontDelta(userFontDelta + 2); showControls(); });

  // Search modal open/close
  bindClickLike(searchButton, () => {
    window.stopVoiceIfActive && window.stopVoiceIfActive();
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    if (searchOverlay) {
      if (searchInput) searchInput.value = '';
      searchOverlay.style.display = 'flex';
      handleSearch();
      const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (!isTouch) searchInput && searchInput.focus();
    }
    showControls();
  });
  bindClickLike(closeSearchButton, () => {
    if (window.stopVoiceIfActive) window.stopVoiceIfActive();
    if (searchOverlay) searchOverlay.style.display = 'none';
    showControls();
  });

  const modalActions = searchOverlay?.querySelector('.modal-actions');
  if (modalActions) {
    const refreshBtn = document.createElement('button');
    refreshBtn.id = 'hardRefreshButton';
    refreshBtn.textContent = 'Hard Refresh';
    refreshBtn.style.backgroundColor = '#0ea5e9';
    refreshBtn.title = 'Reload fresh files (keeps login)';
    modalActions.insertBefore(refreshBtn, modalActions.firstChild);

    async function hardRefreshKeepLogin() {
      if (!confirm('Refresh app files and KEEP login?')) return;
      try {
        window.stopVoiceIfActive && window.stopVoiceIfActive();
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
      } finally {
        const fresh = Date.now();
        location.replace(location.pathname + '?fresh=' + fresh);
      }
    }

    bindClickLike(refreshBtn, hardRefreshKeepLogin);
  }

  searchInput?.addEventListener('input', handleSearch);

  // Voice search
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null, recognizing = false, wantListening = false;
  let endTimer = null, hardKillTimer = null, inactivityTimer = null, sessionTimer = null;
  let cooldownUntil = 0, lastResultAt = 0, recToken = 0;
  const SILENCE_MS=2000, FINAL_GRACE_MS=700, SESSION_MAX_MS=5000, COOLDOWN_MS=700;

  if (SpeechRec && searchInput) {
    const micBtn = document.createElement('button');
    micBtn.id = 'voiceSearchButton';
    micBtn.type = 'button';
    micBtn.title = 'Voice search (Greek)';
    micBtn.textContent = '🎤';
    micBtn.style.cssText = 'margin-left:8px;padding:8px 12px;border:none;border-radius:8px;background:#0ea5e9;color:#fff;font-weight:700;cursor:pointer;';
    searchInput.insertAdjacentElement('afterend', micBtn);

    const setMic = (on) => { micBtn.style.background = on ? '#ef4444' : '#0ea5e9'; micBtn.textContent = on ? '⏺️' : '🎤'; };
    const clearTimers = () => { [endTimer,hardKillTimer,inactivityTimer,sessionTimer].forEach(t=>{ if(t) clearTimeout(t); }); endTimer=hardKillTimer=inactivityTimer=sessionTimer=null; };
    function armInactivity(ms){ if (!ms) return; if (inactivityTimer) clearTimeout(inactivityTimer); inactivityTimer=setTimeout(()=>{ if (recognizing && Date.now()-lastResultAt>=ms-50) gracefulStop(); }, ms); }
    function detachHandlers(r){ if (!r) return; r.onstart=r.onend=r.onerror=r.onresult=r.onspeechend=r.onaudioend=null; }
    async function nudgeMicRelease(){ try{ if (!navigator.mediaDevices?.getUserMedia) return; const s=await navigator.mediaDevices.getUserMedia({audio:true}); setTimeout(()=>{ try{s.getTracks().forEach(t=>t.stop());}catch{} },100);}catch{} }
    function finalizeStop(){ clearTimers(); recToken++; const r=recognition; recognition=null; recognizing=false; wantListening=false; try{ r&&r.stop&&r.stop(); }catch{} try{ r&&r.abort&&r.abort(); }catch{} detachHandlers(r); setMic(false); cooldownUntil=Date.now()+COOLDOWN_MS; nudgeMicRelease(); }
    function gracefulStop(){ wantListening=false; try{ recognition&&recognition.stop&&recognition.stop(); }catch{} if (endTimer) clearTimeout(endTimer); endTimer=setTimeout(()=>{ try{ recognition&&recognition.abort&&recognition.abort(); }catch{} },800); if (hardKillTimer) clearTimeout(hardKillTimer); hardKillTimer=setTimeout(finalizeStop,1800); }
    window.stopVoiceIfActive = gracefulStop;

    function startRecognitionOnce(){
      if (Date.now() < cooldownUntil) return;
      recToken++; const myToken=recToken;
      recognition = new SpeechRec(); recognition.lang='el-GR'; recognition.interimResults=true; recognition.continuous=false; recognition.maxAlternatives=1;

      recognition.onstart = () => { if (recToken!==myToken) return; recognizing=true; wantListening=true; setMic(true); lastResultAt=Date.now(); armInactivity(SILENCE_MS); sessionTimer=setTimeout(gracefulStop, SESSION_MAX_MS); };
      recognition.onend   = () => { if (recToken===myToken) finalizeStop(); };
      recognition.onerror = () => { if (recToken===myToken) finalizeStop(); };
      recognition.onresult = (event) => {
        if (!wantListening || recToken!==myToken) return;
        lastResultAt = Date.now();
        let finalTranscript='', interim='', sawFinal=false;
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r=event.results[i];
          if (r.isFinal){ finalTranscript += r[0].transcript; sawFinal=true; } else interim += r[0].transcript;
        }
        const text = (finalTranscript || interim).trim();
        if (text) { searchInput.value = text; handleSearch(); }
        if (sawFinal){ if (inactivityTimer) clearTimeout(inactivityTimer); if (endTimer) clearTimeout(endTimer); endTimer=setTimeout(gracefulStop, FINAL_GRACE_MS); } else { armInactivity(SILENCE_MS); }
      };

      try { recognition.start(); recognizing=true; setMic(true); }
      catch (err) {
        if ((err?.name === 'InvalidStateError') || (''+err).includes('InvalidState')) {
          setTimeout(()=>{ try{ recognition.start(); recognizing=true; setMic(true); } catch { finalizeStop(); } }, 250);
        } else { finalizeStop(); }
      }
    }

    let clickBlock=false;
    micBtn.addEventListener('click', () => {
      if (clickBlock) return; clickBlock=true; setTimeout(()=>clickBlock=false,300);
      if (!recognizing) { searchInput.value=''; handleSearch(); startRecognitionOnce(); }
      else { gracefulStop(); }
    });

    document.addEventListener('visibilitychange', () => { if (document.hidden) gracefulStop(); });
    searchOverlay?.addEventListener('click', (e) => { if (e.target === searchOverlay) gracefulStop(); });
    window.addEventListener('beforeunload', () => gracefulStop());
  }

  // Clicking Firebase results
  searchResults?.addEventListener('click', (e)=>{
    const t = e.target.closest('.search-result-item');
    if (!t) return;
    if (t.dataset.src === 'lib'){
      const sid = t.dataset.songId;
      if (sid) loadSelectedSong(sid);
      if (searchOverlay) searchOverlay.style.display='none';
    }
  });

  // Also listen to event if helper dispatches it externally
  window.addEventListener('local-file-song:open', (ev) => {
    const { text, meta } = ev.detail || {};
    const lines = (text || '').split(/\r\n|\r|\n/);
    let tIndex = lines.findIndex(l => l.trim() !== '');
    if (tIndex < 0) tIndex = 0;
    const title = (lines[tIndex] || 'Untitled').trim();
    const body  = lines.slice(tIndex + 1).join('\n');
    processInput(body, title);
    currentSongId = null; // ensure edits act as new unless saved
    applyTranspositionToDisplay();
    if (searchOverlay) searchOverlay.style.display='none';

    lastLocalMeta = meta || null;
    lastLocalText = text || '';
    if (addLocalSongButton) addLocalSongButton.style.display = 'flex';
  });

  // Playlist selector (composite keys)
  playlistSongSelector?.addEventListener('change', () => {
    currentPlaylistKey = playlistSongSelector.value || null;
    localStorage.setItem('lastEditedPlaylistKey', currentPlaylistKey || '');
    loadEntriesForCurrentPlaylist();
  });

  // Top menu bar actions
  bindClickLike(document.getElementById('saveSongButton'), saveSong);
  bindClickLike(document.getElementById('newSongButton'),  newSong);
  bindClickLike(document.getElementById('deleteSongButton'), deleteSong);

  document.addEventListener('pointerdown', showControls, { passive: true });
  showControls();

// ===== Auth + Firestore init (use shared instances; NO initializeApp here) =====
showLoadingOverlay();
try {
  // Firestore persistence (multi-tab safe; ignore error if another tab owns it)
  try {
    await window.db.enablePersistence({ synchronizeTabs: true });
  } catch (err) {
    console.warn(`Firebase Persistence Failed: ${err.code || err}`);
  }

  // Extra diagnostics to catch mismatched projects/sessions
  try {
    console.log('[index] appId:', window.appId);
    console.log('[index] authDomain:', firebase.app().options.authDomain);
    console.log('[index] localStorage auth keys:',
      Object.keys(localStorage).filter(k => k.startsWith('firebase:authUser:'))
    );
  } catch {}

  // Single source of truth for auth state
  window.auth.onAuthStateChanged(async (user) => {
    try {
      if (!user) {
        console.warn('🔴 No user logged in');
        toast("Not logged in. Please open login.html manually.", "error");
        processInput("", "Please log in to view your playlists.");
        window.userId = null;
        window.isAuthReady = true;
        hideLoadingOverlay();
        return;
      }

      console.log('🟢 Logged in user:', user.email || user.uid);
      window.userId = user.uid;
      window.isAuthReady = true;

      // ADMIN
      if (user.email === "info@acdcshop.gr") {
        isAdmin = true;
        console.log("✅ Logged in as ADMIN:", user.email);
        await populatePlaylistsAndSongs();
      } else {
        // GUEST
        isAdmin = false;
        const doc = await window.db.collection("approvedUsers").doc(user.uid).get();
        if (!doc.exists) {
          toast("Not approved yet. Contact admin.", "error");
          console.warn("❌ Guest not approved:", user.uid);
          await window.auth.signOut();
          window.userId = null;
          return;
        }
        console.log("👤 Guest approved:", doc.data());
        await populatePlaylistsAndSongs();
      }
    } catch (e) {
      toast("Error during startup: " + (e?.message || e), "error");
      console.error("Auth error:", e);
    } finally {
      hideLoadingOverlay();
    }
  });

  // (Optional) double-check a moment later for visibility
  setTimeout(() => {
    console.log('[index] currentUser after 800ms:', window.auth.currentUser);
  }, 800);
} catch (e) {
  showMessage("Error during startup: " + (e?.message || e), "error");
  console.error(e);
} finally {
  // overlay will also be hidden inside the auth handler; keeping here is harmless
  hideLoadingOverlay();
}


// ===== Global safety nets =====
function isBenignErrorMessage(msg) {
  if (!msg) return false;
  msg = String(msg);
  return msg === 'Script error.' || msg === 'Script error';
}
window.addEventListener('error', (e) => {
  const msg = e?.message || '';
  if (isBenignErrorMessage(msg)) { hideLoadingOverlay(); console.warn('Ignored window error:', msg); return; }
  try { console.error('Unhandled error:', e.error || msg || e); } catch {}
  hideLoadingOverlay();
  toast('App error: ' + (msg || 'unknown'), 'error', 4000);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e?.reason && (e.reason.message || String(e.reason))) || '';
  if (isBenignErrorMessage(msg)) { hideLoadingOverlay(); console.warn('Ignored promise rejection:', msg); return; }
  try { console.error('Unhandled promise rejection:', e.reason); } catch {}
  hideLoadingOverlay();
  toast('App error: ' + (msg || 'unknown'), 'error', 4000);
});

/* ======== LIVE SHARE REBIND (2025-10-04) ======== */
window._ls_processShareInboxOnce = async function(){
  try {
    const snap = await myInboxColl().where('processed','==',false).get();
    if (snap.empty) return;
    for (const doc of snap.docs){
      try { await window._ls_importInboxItem(doc); }
      catch (e) { console.warn('live-share: import failed for', doc.id, e); }
    }
  } catch (err) {
    console.warn('live-share: processShareInboxOnce error', err);
  }
};

window._ls_importInboxItem = async function(docSnap){
  const data = docSnap.data() || {};
  const fromUid   = data.fromUid || data.ownerUid || null;
  const fromEmail = data.fromEmail || '';
  const playlistId   = data.playlistId || data.pid || null;
  const playlistName = (data.playlistName || data.name || 'Shared').toString();
  const role      = data.role || 'viewer';
  if (!fromUid || !playlistId) {
    try { await docSnap.ref.delete(); } catch (e) { try { await docSnap.ref.set({ processed:true, processedAt: Date.now() }, { merge:true }); } catch{} }
    return;
  }
  const plKey = makePlKey(fromUid, playlistId);
  if (loadedPlaylists.has(plKey)) {
    try { await docSnap.ref.delete(); } catch (e) { try { await docSnap.ref.set({ processed:true, processedAt: Date.now() }, { merge:true }); } catch{} }
    return;
  }
  loadedPlaylists.set(plKey, {
    id: playlistId,
    key: plKey,
    name: playlistName,
    ownerUid: fromUid,
    shared: true,
    sharedRole: role,
    notes: '',
    from: { uid: fromUid, email: fromEmail, displayName: data.fromDisplayName || '' }
  });
  try {
    if (typeof populatePlaylistSelector === 'function') populatePlaylistSelector();
    try { localStorage.setItem('lastEditedPlaylistKey', plKey); } catch {}
    if (typeof playlistSongSelector !== 'undefined' && playlistSongSelector) {
      try { playlistSongSelector.value = plKey; } catch {}
    }
    try { currentPlaylistKey = plKey; } catch {}
    if (typeof loadEntriesForCurrentPlaylist === 'function') { await loadEntriesForCurrentPlaylist(); }
  } catch {}
  try { await docSnap.ref.delete(); }
  catch (e) { try { await docSnap.ref.set({ processed: true, processedAt: Date.now() }, { merge: true }); } catch {} }
  try { window.toast && window.toast(`Linked shared playlist “${playlistName}”.`, 'success', 2200); } catch {}
};

window._ls_stopInboxWatcher = function(){
  try { window.__stopInboxWatch_live && window.__stopInboxWatch_live(); } catch {}
  window.__stopInboxWatch_live = null;
};

window._ls_startInboxWatcher = function(){
  window._ls_stopInboxWatcher();
  try {
    window.__stopInboxWatch_live = myInboxColl()
      .where('processed','==',false)
      .onSnapshot(async (snap)=>{
        if (!snap.empty) {
          for (const docSnap of snap.docs) {
            try { await window._ls_importInboxItem(docSnap); }
            catch (e) {
              console.warn('live-share: Inbox import failed for', docSnap.id, e);
              try { window.toast && window.toast('Import failed: ' + (e?.message || e), 'error', 3000); } catch {}
            }
          }
        }
      }, (err)=>{
        console.warn('live-share: Inbox watcher error:', err);
        try { window.toast && window.toast('Inbox listener error: ' + (err?.message || err), 'error', 3000); } catch {}
      });
  } catch (err) {
    console.warn('live-share: startInboxWatcher failed:', err);
  }
};

try { processShareInboxOnce = window._ls_processShareInboxOnce; } catch{}
try { importInboxItem       = window._ls_importInboxItem; } catch{}
try { stopInboxWatcher      = window._ls_stopInboxWatcher; } catch{}
try { startInboxWatcher     = window._ls_startInboxWatcher; } catch{}
/* ======== END LIVE SHARE REBIND ======== */
});
