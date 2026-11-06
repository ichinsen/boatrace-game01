// boatrace-game/admin.js（修正版）
// 主催者ダッシュボード：ブラウザ完結 / PeerJS(P2P)でスマホと同期 / ローカルCSV自動保存
'use strict';

const KEY_STATE = 'boatrace_p2p_state';
const KEY_VOTES = 'boatrace_p2p_votes';
const KEY_HOST = 'boatrace_host_id';
const KEY_BASE = 'boatrace_custom_base_url';
const RACES = [5, 6, 7];

const $ = id => document.getElementById(id);
const blankResult = () => ({ first: null, second: null, payout: 0, settled: false, settledAt: '' });
const freshState = () => ({
  currentRace: 5,
  isOpen: true,
  results: { 5: blankResult(), 6: blankResult(), 7: blankResult() }
});

let currentState = freshState();
let votesList = []; // [{ time, race, user, first, second, bet }]
let peer = null;
let hostId = null;
const connectedClients = new Map(); // peerId => connection
let currentSelectedRace = 5;
let unavailableRetries = 0;

// フォルダ連携
let directoryHandle = null;
let pendingHandle = null;
let folderState = 'none'; // none | ok | needperm | error
let folderName = '';
let lastSaved = '';
let syncQueue = Promise.resolve();

// DOM
const p2pStatusPill = $('p2pStatusPill');
const wakePill = $('wakePill');
const folderStatusText = $('folderStatusText');
const selectFolderBtn = $('selectFolderBtn');
const resumeFolderBtn = $('resumeFolderBtn');
const exportCsvBtn = $('exportCsvBtn');
const qrContainer = $('qrContainer');
const joinUrlText = $('joinUrlText');
const urlWarning = $('urlWarning');
const urlSettings = $('urlSettings');
const connectedPeersCount = $('connectedPeersCount');
const customBaseUrlInput = $('customBaseUrlInput');
const applyBaseUrlBtn = $('applyBaseUrlBtn');
const regenKeyBtn = $('regenKeyBtn');
const currentStatusText = $('currentStatusText');
const voteCountText = $('voteCountText');
const toggleOpenBtn = $('toggleOpenBtn');
const raceTabBtns = document.querySelectorAll('.race-tab-btn');
const settleTargetTitle = $('settleTargetTitle');
const settleFirst = $('settleFirst');
const settleSecond = $('settleSecond');
const settlePayout = $('settlePayout');
const settleBtn = $('settleBtn');
const proxyUser = $('proxyUser');
const proxyPin = $('proxyPin');
const proxyFirst = $('proxyFirst');
const proxySecond = $('proxySecond');
const proxyVoteBtn = $('proxyVoteBtn');
const rankingTableBody = $('rankingTableBody');
const adminResetBtn = $('adminResetBtn');
const toastEl = $('toast');

// ---------- 共通ユーティリティ ----------
let toastTimer = null;
function showToast(msg, duration = 3000) {
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, duration);
}

function formatDateTime(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const stamp = () => formatDateTime().replace(/[: ]/g, '-');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ニックネームの整形と照合キー（全角/半角・大文字小文字の違いを同一人物として扱う）
function cleanName(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
}
function nameKey(s) {
  return cleanName(s).normalize('NFKC').toLowerCase();
}
// PASS番号：数字4桁（全角数字も受け付ける）。不正なら空文字
function cleanPin(p) {
  const s = String(p == null ? '' : p).trim().normalize('NFKC');
  return /^\d{4}$/.test(s) ? s : '';
}
// 参加者の識別キー = 名前 ＋ PASS番号
const userKey = (name, pin) => nameKey(name) + '#' + pin;

// ---------- 保存・復元（このブラウザ内） ----------
function loadSavedState() {
  try {
    const s = localStorage.getItem(KEY_STATE);
    if (s) {
      const p = JSON.parse(s);
      const res = p.results || {};
      currentState = {
        currentRace: RACES.includes(p.currentRace) ? p.currentRace : 5,
        isOpen: p.isOpen !== false,
        results: {
          5: Object.assign(blankResult(), res[5]),
          6: Object.assign(blankResult(), res[6]),
          7: Object.assign(blankResult(), res[7])
        }
      };
    }
    const v = localStorage.getItem(KEY_VOTES);
    if (v) {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) votesList = arr;
    }
  } catch (e) {
    console.warn('Storage load error:', e);
  }
  // 表示中のレースは、保存されている「進行中レース」に合わせる
  currentSelectedRace = currentState.currentRace;
}

function persistState() {
  try {
    localStorage.setItem(KEY_STATE, JSON.stringify(currentState));
    localStorage.setItem(KEY_VOTES, JSON.stringify(votesList));
  } catch (e) {
    console.warn('Storage save error:', e);
    showToast('⚠️ ブラウザ内への保存に失敗しました（CSVで必ずバックアップしてください）', 5000);
  }
}

// ---------- CSV生成 ----------
// ダブルクォートのエスケープ＋（名前のみ）Excel数式として解釈される先頭文字を無害化
function csvCell(v, protect) {
  let s = v == null ? '' : String(v);
  if (protect && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// PASS番号：Excelで先頭の0が消えないよう ="0123" 形式で出力（数字4桁のみなので安全）
function csvPin(p) {
  return p ? '"=""' + p + '"""' : '""';
}

function buildVotesCsv() {
  let c = '投票日時,レース番号,ニックネーム,PASS番号,予想1着,予想2着,買い目\r\n';
  votesList.forEach(v => {
    c += [csvCell(v.time), csvCell(v.race + 'R'), csvCell(v.user, true), csvPin(v.pin), v.first, v.second, csvCell(v.bet)].join(',') + '\r\n';
  });
  return c;
}

function buildResultsCsv() {
  let c = 'レース番号,確定1着,確定2着,出目,払戻金(円),確定日時\r\n';
  RACES.forEach(r => {
    const x = currentState.results[r];
    if (x && x.settled) {
      c += [csvCell(r + 'R'), x.first, x.second, csvCell(x.first + '-' + x.second), x.payout, csvCell(x.settledAt)].join(',') + '\r\n';
    }
  });
  return c;
}

function buildRankingCsv() {
  let c = '順位,ニックネーム,PASS番号,合計ポイント,的中レース数,5R予想,5R結果,6R予想,6R結果,7R予想,7R結果\r\n';
  computeRankings().forEach(r => {
    const cols = [r.rank, csvCell(r.user, true), csvPin(r.pin), r.totalPoints, r.hitCount];
    RACES.forEach(n => {
      const v = r.votes[n];
      cols.push(csvCell(v ? v.bet : '-'));
      cols.push(csvCell(v && v.settled ? (v.isHit ? `的中(+${v.points}pt)` : '不的中') : '未確定'));
    });
    c += cols.join(',') + '\r\n';
  });
  return c;
}

// ---------- フォルダ連携（File System Access API） ----------
const idb = {
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('boatrace-admin', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  },
  async set(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
};

function updateFolderStatus() {
  const m = {
    none: ['⚠️ 未連携：CSVはまだ保存されていません（右のボタンでdataフォルダを選択）', '#fbbf24'],
    ok: [`✅ 連動中 [ ${folderName} ] 最終保存 ${lastSaved || '-'}（投票・確定のたびに自動更新）`, '#34d399'],
    needperm: [`🔁 フォルダ「${folderName}」への書き込み許可が必要です（「フォルダ連携を再開」を押してください）`, '#fbbf24'],
    error: ['❌ 直近のCSV保存に失敗しました（フォルダの移動・権限を確認し、フォルダを選び直してください）', '#f87171']
  }[folderState];
  folderStatusText.textContent = m[0];
  folderStatusText.style.color = m[1];
  resumeFolderBtn.style.display = folderState === 'needperm' ? '' : 'none';
}

async function writeTextFile(filename, text) {
  const fh = await directoryHandle.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write('\uFEFF' + text); // UTF-8 BOM（Excel対応）
  await w.close();
}

async function doSync() {
  try {
    await writeTextFile('votes.csv', buildVotesCsv());
    await writeTextFile('results.csv', buildResultsCsv());
    await writeTextFile('ranking.csv', buildRankingCsv());
    folderState = 'ok';
    lastSaved = formatDateTime().slice(11);
  } catch (e) {
    console.warn('CSV sync failed:', e);
    folderState = 'error';
    showToast('❌ CSVの保存に失敗しました。画面上部のフォルダ状態を確認してください', 5000);
  }
  updateFolderStatus();
}

function syncAllCsvToDisk() {
  if (!directoryHandle) return Promise.resolve();
  syncQueue = syncQueue.then(doSync).catch(() => {});
  return syncQueue;
}

selectFolderBtn.addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    alert('お使いのブラウザはフォルダ直接保存に対応していません（ChromeまたはEdgeを使ってください）。「CSVを手動保存」ボタンをご利用ください。');
    return;
  }
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite' });
    directoryHandle = h;
    pendingHandle = null;
    folderName = h.name;
    folderState = 'ok';
    try { await idb.set('dir', h); } catch (e) { console.warn('handle save failed', e); }
    updateFolderStatus();
    showToast(`📁 フォルダ「${h.name}」と連携しました！`);
    await syncAllCsvToDisk();
  } catch (err) {
    if (err.name !== 'AbortError') alert('フォルダの選択に失敗しました: ' + err.message);
  }
});

resumeFolderBtn.addEventListener('click', async () => {
  if (!pendingHandle) return;
  try {
    const p = await pendingHandle.requestPermission({ mode: 'readwrite' });
    if (p === 'granted') {
      directoryHandle = pendingHandle;
      pendingHandle = null;
      folderState = 'ok';
      updateFolderStatus();
      showToast('📁 フォルダ連携を再開しました');
      await syncAllCsvToDisk();
    } else {
      showToast('⚠️ 許可されませんでした。「dataフォルダを選択」からやり直してください', 4500);
    }
  } catch (e) {
    showToast('⚠️ 再開できませんでした。フォルダを選び直してください', 4500);
  }
});

async function restoreFolder() {
  try {
    if (!window.indexedDB || !window.showDirectoryPicker) { updateFolderStatus(); return; }
    const h = await idb.get('dir');
    if (!h) { updateFolderStatus(); return; }
    folderName = h.name;
    const p = await h.queryPermission({ mode: 'readwrite' });
    if (p === 'granted') {
      directoryHandle = h;
      folderState = 'ok';
      await syncAllCsvToDisk();
    } else {
      pendingHandle = h;
      folderState = 'needperm';
    }
  } catch (e) {
    console.warn('restoreFolder failed', e);
  }
  updateFolderStatus();
}

// 手動CSVダウンロード
function downloadOne(content, filename) {
  const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), content], { type: 'text/csv;charset=utf-8;' });
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}

function exportAllCsv(prefix) {
  downloadOne(buildRankingCsv(), `${prefix}ranking.csv`);
  setTimeout(() => downloadOne(buildVotesCsv(), `${prefix}votes.csv`), 300);
  setTimeout(() => downloadOne(buildResultsCsv(), `${prefix}results.csv`), 600);
}

exportCsvBtn.addEventListener('click', () => {
  exportAllCsv('boatrace_');
  showToast('📥 3つのCSVファイルをダウンロードしました！');
});

// ---------- 参加用URL / QRコード ----------
function buildJoinUrl(id) {
  const base = (localStorage.getItem(KEY_BASE) || '').trim();
  const problemLocal = 'このPC上のアドレス（ファイル／localhost）のままでは、スマホからは開けません。参加者用ページ(index.html)を公開したURLを、下の「参加者URLの設定」に入力してください。';
  try {
    if (base) {
      const u = new URL(base.replace(/admin\.html(?=$|[?#])/, 'index.html'));
      u.searchParams.set('host', id);
      u.hash = '';
      return { url: u.toString(), problem: '' };
    }
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
      if (!isLocal) {
        const u = new URL('index.html', location.href);
        u.searchParams.set('host', id);
        return { url: u.toString(), problem: '' };
      }
    }
  } catch (e) {
    return { url: '', problem: '参加者URLの形式が正しくありません。https:// から始まるURLを入力してください。' };
  }
  return { url: '', problem: problemLocal };
}

function renderHostQrCode(id) {
  if (customBaseUrlInput && !customBaseUrlInput.value) {
    customBaseUrlInput.value = localStorage.getItem(KEY_BASE) || '';
  }
  const r = buildJoinUrl(id);
  joinUrlText.innerHTML = `ルームキー: <b style="color: #ffd700;">${escapeHtml(id)}</b>` +
    (r.url ? `<br><span style="font-size: 0.75rem; color: #94a3b8; word-break: break-all;">${escapeHtml(r.url)}</span>` : '');

  if (r.problem) {
    urlWarning.textContent = '⚠️ ' + r.problem;
    urlWarning.style.display = 'block';
    urlSettings.open = true;
  } else {
    urlWarning.style.display = 'none';
  }

  if (!r.url) {
    qrContainer.innerHTML = '<span style="color: #64748b; font-size: 0.85rem;">参加者URLを設定するとQRコードが表示されます</span>';
    return;
  }
  try {
    const qr = qrcode(0, 'M'); // 型番は文字数に応じて自動選択
    qr.addData(r.url);
    qr.make();
    qrContainer.innerHTML = qr.createSvgTag(4, 0);
    const svg = qrContainer.querySelector('svg');
    if (svg) { svg.style.width = '180px'; svg.style.height = '180px'; }
  } catch (e) {
    console.warn('QR error:', e);
    qrContainer.innerHTML = '<span style="color: #f87171; font-size: 0.85rem;">QRコードを生成できませんでした（URLをそのまま参加者に伝えてください）</span>';
  }
}

applyBaseUrlBtn.addEventListener('click', () => {
  const val = customBaseUrlInput.value.trim();
  if (val && !/^https?:\/\//i.test(val)) {
    alert('https:// から始まるURLを入力してください。');
    return;
  }
  if (val) {
    localStorage.setItem(KEY_BASE, val);
    showToast('✅ 参加者用URLを保存しました');
  } else {
    localStorage.removeItem(KEY_BASE);
    showToast('🔄 参加者用URLの設定を解除しました');
  }
  if (hostId) renderHostQrCode(hostId);
});

// ---------- PeerJS P2P ----------
function newHostId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return 'boatrace-' + Array.from(a, b => (b % 36).toString(36)).join('');
}

// ルームキーは保存して再利用する（管理画面を再読み込みしても参加者がつながったままになる）
function getOrCreateHostId() {
  let id = null;
  try { id = localStorage.getItem(KEY_HOST); } catch (e) { /* ignore */ }
  if (!id || !/^boatrace-[a-z0-9]{6,}$/.test(id)) {
    id = newHostId();
    try { localStorage.setItem(KEY_HOST, id); } catch (e) { /* ignore */ }
  }
  return id;
}

function setP2P(kind, html) {
  p2pStatusPill.className = 'status-pill ' + kind;
  p2pStatusPill.innerHTML = html;
}

function initP2P() {
  hostId = getOrCreateHostId();
  setP2P('waiting', '<span>⏳</span> 通信接続中...');
  const me = new Peer(hostId, { debug: 1 });
  peer = me;

  me.on('open', id => {
    unavailableRetries = 0;
    setP2P('connected', `<span>🟢</span> P2P受付中 [ ${escapeHtml(id)} ]`);
    renderHostQrCode(id);
  });

  me.on('connection', conn => {
    connectedClients.set(conn.peer, conn);
    updatePeerCount();
    conn.on('open', () => sendState(conn, computeRankings()));
    conn.on('data', data => handleClientMessage(data, conn));
    const gone = () => {
      // 同じ端末が再接続した場合、古い接続の close で新しい接続を消さない
      if (connectedClients.get(conn.peer) === conn) connectedClients.delete(conn.peer);
      updatePeerCount();
    };
    conn.on('close', gone);
    conn.on('error', gone);
  });

  me.on('disconnected', () => {
    setP2P('waiting', '<span>⚠️</span> 再接続中...');
    setTimeout(() => {
      if (peer === me && !me.destroyed) { try { me.reconnect(); } catch (e) { /* ignore */ } }
    }, 2000);
  });

  me.on('error', err => {
    console.warn('PeerJS error:', err);
    if (err.type === 'unavailable-id') {
      // 直前の接続がまだ解放されていない（再読み込み直後など）。少し待って再試行
      unavailableRetries++;
      if (unavailableRetries > 8) {
        setP2P('waiting', '<span>⚠️</span> ルームキーが使用中です（「ルームキーを再発行」を試してください）');
      } else {
        setP2P('waiting', '<span>⏳</span> 前回の接続の解放待ち...');
      }
      try { me.destroy(); } catch (e) { /* ignore */ }
      setTimeout(() => { if (peer === me) initP2P(); }, 4000);
    } else {
      setP2P('waiting', `<span>⚠️</span> 通信エラー (${escapeHtml(err.type || 'unknown')})`);
    }
  });
}

regenKeyBtn.addEventListener('click', () => {
  if (!confirm('ルームキーを再発行します。\n接続中の参加者は切断され、新しいQRコードの読み取りが必要になります。よろしいですか？')) return;
  try { localStorage.setItem(KEY_HOST, newHostId()); } catch (e) { /* ignore */ }
  connectedClients.clear();
  updatePeerCount();
  if (peer) { const old = peer; peer = null; try { old.destroy(); } catch (e) { /* ignore */ } }
  unavailableRetries = 0;
  initP2P();
  showToast('🔑 ルームキーを再発行しました。新しいQRコードを案内してください', 5000);
});

function updatePeerCount() {
  connectedPeersCount.textContent = connectedClients.size;
}

// 参加者へ送る内容：自分の投票は本人にだけ送る。他人の予想は結果確定まで送らない
function buildPayload(conn, rankings) {
  let me = null;
  if (conn.userKey) {
    const u = rankings.find(x => x.key === conn.userKey);
    me = u
      ? { user: u.user, k: u.key, rank: u.rank, totalPoints: u.totalPoints, hitCount: u.hitCount, votes: u.votes }
      : { user: conn.userName, k: conn.userKey, rank: null, totalPoints: 0, hitCount: 0, votes: { 5: null, 6: null, 7: null } };
  }
  return { type: 'state_update', state: currentState, me };
}

function safeSend(conn, payload) {
  try { if (conn.open) conn.send(payload); } catch (e) { console.warn('send failed', e); }
}

function sendState(conn, rankings) {
  safeSend(conn, buildPayload(conn, rankings));
}

function broadcastState() {
  const rankings = computeRankings();
  connectedClients.forEach(conn => sendState(conn, rankings));
}

function setConnUser(conn, name, pin) {
  const n = typeof name === 'string' ? cleanName(name) : '';
  const p = cleanPin(pin);
  if (!n || !p) {
    conn.userName = null;
    conn.userKey = null;
    return;
  }
  conn.userName = n;
  conn.userKey = userKey(n, p);
}

async function afterChange() {
  persistState();
  updateAllUI();
  broadcastState();
  await syncAllCsvToDisk();
}

async function handleClientMessage(data, conn) {
  if (!data || typeof data !== 'object') return;

  if (data.type === 'get_state') {
    setConnUser(conn, data.user, data.pin);
    sendState(conn, computeRankings());
    return;
  }

  if (data.type === 'vote') {
    setConnUser(conn, data.user, data.pin);
    const result = recordVote(data.user, data.pin, data.race, data.first, data.second, { confirmSame: data.confirmSame === true });
    safeSend(conn, Object.assign({ type: 'vote_result' }, result));
    if (result.success) {
      showToast(`📩 ${result.vote.user} さんから第${result.vote.race}Rの投票（${result.vote.bet}）を受信！`);
      await afterChange();
    }
  }
}

// ---------- 投票登録 ----------
function recordVote(user, pinRaw, race, first, second, opts = {}) {
  if (typeof user !== 'string' || !cleanName(user)) {
    return { success: false, error: 'ニックネームを入力してください。' };
  }
  const pin = cleanPin(pinRaw);
  if (!pin) {
    return { success: false, error: 'PASS番号は数字4桁で入力してください。' };
  }
  const cleanUser = cleanName(user);
  const key = userKey(cleanUser, pin);
  const r = parseInt(race, 10);
  const f = parseInt(first, 10);
  const s = parseInt(second, 10);

  if (!RACES.includes(r)) return { success: false, error: '無効なレースです。' };
  if (![1, 2, 3, 4, 5, 6].includes(f) || ![1, 2, 3, 4, 5, 6].includes(s) || f === s) {
    return { success: false, error: '1着・2着を正しく選択してください。' };
  }
  if (currentState.currentRace !== r) {
    return { success: false, error: `現在は第${currentState.currentRace}レースの進行中です。` };
  }
  if (!currentState.isOpen) {
    return { success: false, error: `第${r}レースの投票受付はすでに締め切られました。` };
  }
  if (votesList.some(v => v.race === r && userKey(v.user, v.pin || '') === key)) {
    return { success: false, error: `「${cleanUser}」さん（PASS番号が同じ）はすでに第${r}Rに投票済みです（1人1回まで）。` };
  }

  // 同じ名前でPASS番号が違う人がすでにいる場合は、入力ミスの可能性があるので確認する
  const known = votesList.some(v => userKey(v.user, v.pin || '') === key);
  const sameNameOther = votesList.some(v => nameKey(v.user) === nameKey(cleanUser) && (v.pin || '') !== pin);
  if (!known && sameNameOther && !opts.confirmSame) {
    return {
      success: false,
      needConfirm: true,
      error: `「${cleanUser}」という名前の方がすでに登録されています（PASS番号が違います）。`
    };
  }

  const bet = `${f}-${s}`;
  const nowStr = formatDateTime();
  votesList.push({ time: nowStr, race: r, user: cleanUser, pin, first: f, second: s, bet });
  return {
    success: true,
    message: `第${r}レースの予想【${bet}】を受け付けました！`,
    vote: { time: nowStr, race: r, user: cleanUser, first: f, second: s, bet }
  };
}

// ---------- ランキング ----------
function computeRankings() {
  const userMap = {};
  for (const v of votesList) {
    const key = userKey(v.user, v.pin || '');
    if (!userMap[key]) {
      userMap[key] = {
        key,
        user: v.user,
        pin: v.pin || '',
        seq: Object.keys(userMap).length,
        totalPoints: 0,
        hitCount: 0,
        votes: { 5: null, 6: null, 7: null },
        firstVoteTime: v.time
      };
    }
    userMap[key].votes[v.race] = { first: v.first, second: v.second, bet: v.bet, time: v.time };
  }

  RACES.forEach(r => {
    const res = currentState.results[r];
    for (const u of Object.values(userMap)) {
      const uVote = u.votes[r];
      if (!uVote) continue;
      if (res && res.settled) {
        const isHit = uVote.first === res.first && uVote.second === res.second;
        uVote.settled = true;
        uVote.isHit = isHit;
        uVote.points = isHit ? parseInt(res.payout, 10) : 0;
        if (isHit) {
          u.totalPoints += uVote.points;
          u.hitCount += 1;
        }
      } else {
        uVote.settled = false;
        uVote.isHit = false;
        uVote.points = 0;
      }
    }
  });

  const list = Object.values(userMap).sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    return (a.firstVoteTime || '').localeCompare(b.firstVoteTime || '');
  });
  list.forEach((u, i) => {
    if (i > 0 && u.totalPoints === list[i - 1].totalPoints && u.hitCount === list[i - 1].hitCount) {
      u.rank = list[i - 1].rank;
    } else {
      u.rank = i + 1;
    }
  });
  // 同じ名前の人が複数いるときは、画面表示用に（1）（2）…を付けて区別する（PASS番号は表示しない）
  const byName = {};
  list.forEach(u => { (byName[nameKey(u.user)] = byName[nameKey(u.user)] || []).push(u); });
  Object.values(byName).forEach(g => {
    [...g].sort((a, b) => a.seq - b.seq).forEach((u, i) => {
      u.label = g.length > 1 ? `${u.user}（${i + 1}）` : u.user;
    });
  });
  return list;
}

// ---------- 画面更新 ----------
function updateAllUI() {
  raceTabBtns.forEach(b => b.classList.toggle('active', parseInt(b.dataset.race, 10) === currentSelectedRace));
  settleTargetTitle.textContent = `第${currentSelectedRace}レース 結果確定・払戻金登録`;

  const count = votesList.filter(v => v.race === currentSelectedRace).length;
  voteCountText.textContent = `第${currentSelectedRace}R 投票数: ${count} 人`;

  if (currentState.isOpen) {
    currentStatusText.textContent = `🟢 第${currentState.currentRace}R 投票受付中`;
    currentStatusText.style.background = '#065f46';
    currentStatusText.style.color = '#34d399';
    toggleOpenBtn.className = 'btn-toggle-open open';
    toggleOpenBtn.innerHTML = '<span>🛑</span> 締切にする';
  } else {
    currentStatusText.textContent = `🛑 第${currentState.currentRace}R 投票締切中`;
    currentStatusText.style.background = '#7f1d1d';
    currentStatusText.style.color = '#f87171';
    toggleOpenBtn.className = 'btn-toggle-open closed';
    toggleOpenBtn.innerHTML = '<span>🟢</span> 投票受付を開始する';
  }

  const res = currentState.results[currentSelectedRace];
  if (res && res.settled) {
    settleFirst.value = res.first;
    settleSecond.value = res.second;
    settlePayout.value = res.payout;
    settleBtn.innerHTML = '🔄 結果・配当を更新（再集計）する';
  } else {
    settleBtn.innerHTML = '🏆 結果を確定してポイントを集計する！';
  }

  RACES.forEach(r => {
    const card = $(`raceSummary${r}`);
    const textEl = card.querySelector('.res-text');
    const rRes = currentState.results[r];
    if (rRes && rRes.settled) {
      textEl.innerHTML = `出目: <b>${rRes.first}-${rRes.second}</b><br><span style="font-size: 0.85rem; color: #38bdf8;">${parseInt(rRes.payout, 10).toLocaleString()} 円</span>`;
      card.style.borderLeftColor = '#10b981';
    } else {
      textEl.textContent = '未確定';
      card.style.borderLeftColor = '#64748b';
    }
  });

  renderRankingTable(computeRankings());
}

function renderRankingTable(rankings) {
  if (!rankings || rankings.length === 0) {
    rankingTableBody.innerHTML = '<tr><td colspan="7" style="color: #64748b; padding: 24px;">参加者の投票を待っています...</td></tr>';
    return;
  }
  let html = '';
  rankings.forEach(r => {
    let rankBadge = `<span style="font-weight: 800; font-size: 1.1rem;">${r.rank}</span>`;
    if (r.rank === 1) rankBadge = '<span class="rank-badge rank-1">🥇 1</span>';
    else if (r.rank === 2) rankBadge = '<span class="rank-badge rank-2">🥈 2</span>';
    else if (r.rank === 3) rankBadge = '<span class="rank-badge rank-3">🥉 3</span>';

    const raceCell = n => {
      const v = r.votes[n];
      if (!v) return '<span style="color: #64748b;">-</span>';
      if (!v.settled) return `<span style="font-weight: 700;">${escapeHtml(v.bet)}</span>`;
      if (v.isHit) return `<span style="color: #10b981; font-weight: 800;">🎯 ${escapeHtml(v.bet)} (+${v.points.toLocaleString()}pt)</span>`;
      return `<span style="color: #94a3b8;">${escapeHtml(v.bet)} (0pt)</span>`;
    };

    html += `
      <tr>
        <td>${rankBadge}</td>
        <td style="text-align: left; padding-left: 16px; font-weight: 800; font-size: 1.05rem; color: #0f172a;">${escapeHtml(r.label)}</td>
        <td><span class="points-highlight">${r.totalPoints.toLocaleString()}</span><span style="font-size: 0.85rem; color: #64748b;"> pt</span></td>
        <td><span style="font-weight: 800; font-size: 1rem; color: #0284c7;">${r.hitCount}</span><span style="font-size: 0.8rem; color: #64748b;"> 回</span></td>
        <td>${raceCell(5)}</td>
        <td>${raceCell(6)}</td>
        <td>${raceCell(7)}</td>
      </tr>`;
  });
  rankingTableBody.innerHTML = html;
}

// ---------- 操作 ----------
raceTabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const r = parseInt(btn.dataset.race, 10);
    if (r === currentSelectedRace && currentState.currentRace === r) return;
    currentSelectedRace = r;
    currentState.currentRace = r;
    currentState.isOpen = false; // 切替直後に意図せず受付が始まらないよう、いったん停止
    persistState();
    updateAllUI();
    broadcastState();
    showToast(`📌 第${r}レースに切り替えました。投票受付は停止中です（準備ができたら「投票受付を開始する」）`, 4500);
  });
});

toggleOpenBtn.addEventListener('click', () => {
  currentState.isOpen = !currentState.isOpen;
  persistState();
  updateAllUI();
  broadcastState();
  showToast(currentState.isOpen ? '🟢 投票受付を開始しました！' : '🛑 投票を締め切りました！');
});

settleBtn.addEventListener('click', async () => {
  const first = parseInt(settleFirst.value, 10);
  const second = parseInt(settleSecond.value, 10);
  const payout = parseInt(settlePayout.value, 10);

  if (first === second) {
    alert('1着と2着に同じ艇番は選べません。');
    return;
  }
  if (isNaN(payout) || payout < 100) {
    alert('2連単の払戻金額（円）を正しく入力してください（例: 1450）。');
    settlePayout.focus();
    return;
  }
  const msg = `第${currentSelectedRace}レースの結果を確定しますか？\n\n出目: ${first} - ${second}\n払戻金: ${payout.toLocaleString()} 円\n\n※的中者に ${payout.toLocaleString()}pt が付与され、CSVが自動更新されます。`;
  if (!confirm(msg)) return;

  currentState.results[currentSelectedRace] = { first, second, payout, settled: true, settledAt: formatDateTime() };
  await afterChange();
  showToast(`🏆 第${currentSelectedRace}レースの結果（出目: ${first}-${second}、払戻: ${payout.toLocaleString()}円）を確定しました！`, 4000);
});

proxyVoteBtn.addEventListener('click', async () => {
  const user = proxyUser.value.trim();
  const pin = proxyPin.value.trim();
  const first = parseInt(proxyFirst.value, 10);
  const second = parseInt(proxySecond.value, 10);
  let res = recordVote(user, pin, currentSelectedRace, first, second);
  if (res.needConfirm && confirm(`${res.error}\n\n別の人として登録しますか？（PASS番号の入力ミスなら［キャンセル］）`)) {
    res = recordVote(user, pin, currentSelectedRace, first, second, { confirmSame: true });
  }
  if (res.success) {
    showToast(`✅ ${res.vote.user} さんの第${currentSelectedRace}R予想 【 ${first}-${second} 】 を登録しました`);
    proxyUser.value = '';
    proxyPin.value = '';
    await afterChange();
  } else {
    alert(`エラー: ${res.error}`);
  }
});

adminResetBtn.addEventListener('click', async () => {
  const ans = prompt('⚠️ 本当に全データを初期化しますか？\n投票データと結果がすべてリセットされます（初期化前のCSVを自動でバックアップします）。\n実行する場合は「リセット」と入力してください。');
  if (ans !== 'リセット') return;

  // 初期化前にバックアップ
  const ts = stamp();
  try {
    if (directoryHandle) {
      await writeTextFile(`votes_backup_${ts}.csv`, buildVotesCsv());
      await writeTextFile(`results_backup_${ts}.csv`, buildResultsCsv());
      await writeTextFile(`ranking_backup_${ts}.csv`, buildRankingCsv());
    } else if (votesList.length > 0) {
      exportAllCsv(`boatrace_backup_${ts}_`);
    }
  } catch (e) {
    if (!confirm('バックアップの保存に失敗しました。このまま初期化を続けますか？')) return;
  }

  currentState = freshState();
  currentSelectedRace = 5;
  votesList = [];
  await afterChange();
  showToast('✅ 全データを初期化しました（バックアップ保存済み）');
});

// ---------- 画面スリープ防止 ----------
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakePill.className = 'status-pill connected';
      wakePill.textContent = '🔆 スリープ防止: 有効';
      wakeLock.addEventListener('release', () => {
        wakePill.className = 'status-pill waiting';
        wakePill.textContent = '🔆 スリープ防止: 解除';
      });
      return;
    }
  } catch (e) { /* ignore */ }
  wakePill.className = 'status-pill waiting';
  wakePill.textContent = '🔆 スリープ防止: 非対応（PCの電源設定でスリープを無効に）';
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
});

// ---------- 初期実行 ----------
loadSavedState();
updateAllUI();
updateFolderStatus();
initP2P();
restoreFolder();
keepAwake();
