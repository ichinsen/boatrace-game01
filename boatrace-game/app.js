// boatrace-game/app.js（修正版）
// 参加者専用ロジック（PeerJS P2P通信・管理者機能なし）
// 投票履歴・ポイントは主催者側のデータを正として表示する（スマホ内に履歴を持たない）
'use strict';

let peer = null;
let hostConn = null;
let targetHostId = null;
let retryTimer = null;
let connectTimer = null;
let voteTimer = null;
let lastVote = null; // 直近に送った投票（同名確認のあと再送するため）

let selectedFirst = null;
let selectedSecond = null;
let selectedUnits = 1; // 今回投票する口数（1口=100pt）
let rules = { budget: 500, unit: 100 }; // 主催者から届く（1レースの持ちポイントと投票単位）
let stateReceived = false;

let currentState = {
  currentRace: 5,
  isOpen: true,
  results: {
    5: { first: null, second: null, payout: 0, settled: false },
    6: { first: null, second: null, payout: 0, settled: false },
    7: { first: null, second: null, payout: 0, settled: false }
  }
};
let me = null; // 主催者から届く自分のデータ { user, rank, totalPoints, hitCount, votes }

const $ = id => document.getElementById(id);
const connBadge = $('connBadge');
const manualHostCard = $('manualHostCard');
const manualHostInput = $('manualHostInput');
const manualConnectBtn = $('manualConnectBtn');
const userNameInput = $('userName');
const userPinInput = $('userPin');
const saveUserBtn = $('saveUserBtn');
const currentRaceBadge = $('currentRaceBadge');
const raceStatusBadge = $('raceStatusBadge');
const firstGrid = $('firstBoatGrid');
const secondGrid = $('secondBoatGrid');
const previewFirst = $('previewFirst');
const previewSecond = $('previewSecond');
const previewText = $('previewText');
const submitVoteBtn = $('submitVoteBtn');
const unitMinus = $('unitMinus');
const unitPlus = $('unitPlus');
const stakeValue = $('stakeValue');
const budgetText = $('budgetText');
const budgetBar = $('budgetBar');
const myBetsBox = $('myBetsBox');
const myBetsTitle = $('myBetsTitle');
const myBetsList = $('myBetsList');
const voteMessage = $('voteMessage');
const myTotalPoints = $('myTotalPoints');
const historyTableBody = $('historyTableBody');
const toastEl = $('toast');

let toastTimer = null;
function showToast(msg, duration = 3000) {
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, duration);
}

const esc = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const cleanName = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
const nameKey = s => cleanName(s).normalize('NFKC').toLowerCase();

function currentUserName() {
  return cleanName(userNameInput.value);
}
// PASS番号：数字4桁（全角数字は半角に直す）。不正なら空文字
function normalizePin(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/\D/g, '').slice(0, 4);
}
function currentPin() {
  const p = normalizePin(userPinInput.value);
  return p.length === 4 ? p : '';
}
const identity = () => ({ user: currentUserName(), pin: currentPin() });
const myKey = () => nameKey(currentUserName()) + '#' + currentPin();

// 入力中の「名前＋PASS番号」が、主催者から届いたデータの本人か
function meMatches() {
  return !!(me && currentUserName() && currentPin() && me.k === myKey());
}
function getMyVotes() {
  return meMatches() && me.votes ? me.votes : {};
}
const maxUnits = () => Math.max(1, Math.floor(rules.budget / rules.unit));
// 指定レースで使った口数／残り口数
function usedUnits(r) {
  const v = getMyVotes()[r];
  return v && Number(v.units) ? Number(v.units) : 0;
}
function remainingUnits(r) {
  return Math.max(0, maxUnits() - usedUnits(r));
}
const fmtPt = units => (units * rules.unit).toLocaleString();
// 通信再送による二重登録を防ぐための投票ID
const newVoteId = () => 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function send(obj) {
  try {
    if (hostConn && hostConn.open) { hostConn.send(obj); return true; }
  } catch (e) { console.warn('send failed', e); }
  return false;
}

function setBadge(kind, text) {
  connBadge.className = 'status-badge ' + kind;
  connBadge.textContent = text;
}

// ---------- ニックネーム ----------
function initUser() {
  const saved = localStorage.getItem('boatrace_user');
  if (saved) userNameInput.value = saved;
  const savedPin = localStorage.getItem('boatrace_pin');
  if (savedPin) userPinInput.value = normalizePin(savedPin);
  // 旧版が端末に残した投票履歴は使わない（主催者データを正とする）
  localStorage.removeItem('boatrace_my_votes');
}

// 戻り値: '' = 登録OK / それ以外はエラーメッセージ
function registerName() {
  const name = currentUserName();
  if (!name) return 'ニックネームを入力してください';
  userPinInput.value = normalizePin(userPinInput.value);
  if (!currentPin()) return 'PASS番号を数字4桁で入力してください';
  userNameInput.value = name;
  localStorage.setItem('boatrace_user', name);
  localStorage.setItem('boatrace_pin', currentPin());
  send(Object.assign({ type: 'get_state' }, identity())); // 自分の履歴を主催者に問い合わせ
  updateSubmitButtonState();
  renderHistoryTable();
  return '';
}

saveUserBtn.addEventListener('click', () => {
  const err = registerName();
  if (err) {
    showToast('⚠️ ' + err);
    return;
  }
  showToast(`✅ 「${currentUserName()}」（PASS ${currentPin()}）で登録しました！`);
});
userNameInput.addEventListener('change', registerName);
userPinInput.addEventListener('change', registerName);
const refreshIdentityUi = () => {
  updateSubmitButtonState();
  renderHistoryTable();
};
userNameInput.addEventListener('input', refreshIdentityUi);
userPinInput.addEventListener('input', () => {
  userPinInput.value = normalizePin(userPinInput.value);
  refreshIdentityUi();
});

// ---------- 艇番選択 ----------
firstGrid.querySelectorAll('.boat-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const boat = parseInt(btn.dataset.boat, 10);
    if (selectedFirst === boat) {
      selectedFirst = null;
    } else {
      selectedFirst = boat;
      if (selectedSecond === boat) selectedSecond = null;
    }
    updateSelectionUI();
  });
});

secondGrid.querySelectorAll('.boat-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const boat = parseInt(btn.dataset.boat, 10);
    if (boat === selectedFirst) return;
    selectedSecond = selectedSecond === boat ? null : boat;
    updateSelectionUI();
  });
});

unitMinus.addEventListener('click', () => {
  if (selectedUnits > 1) selectedUnits--;
  updateSelectionUI();
});
unitPlus.addEventListener('click', () => {
  if (selectedUnits < remainingUnits(currentState.currentRace)) selectedUnits++;
  updateSelectionUI();
});

// 持ちポイント・投票済み一覧の表示を更新
function updateBudgetUI() {
  const r = currentState.currentRace;
  const remain = remainingUnits(r);
  if (remain > 0 && selectedUnits > remain) selectedUnits = remain;
  if (selectedUnits < 1) selectedUnits = 1;

  stakeValue.textContent = remain > 0 ? fmtPt(selectedUnits) : '0';
  unitMinus.disabled = remain === 0 || selectedUnits <= 1;
  unitPlus.disabled = remain === 0 || selectedUnits >= remain;
  budgetText.textContent = `第${r}Rの持ちポイント：残り ${fmtPt(remain)} / ${rules.budget.toLocaleString()} pt`;
  budgetBar.style.width = Math.round((remain / maxUnits()) * 100) + '%';

  const v = getMyVotes()[r];
  if (v && v.bets && v.bets.length) {
    myBetsBox.style.display = 'block';
    myBetsTitle.textContent = `第${r}Rのあなたの投票（使用 ${fmtPt(usedUnits(r))}pt）`;
    myBetsList.innerHTML = v.bets.map(b => {
      const bt = String(b.bet).split('-');
      return `<div class="my-bet-row">
        <span><span class="boat-badge boat-${esc(bt[0])}" style="width:30px;height:30px;font-size:1rem;">${esc(bt[0])}</span> ー
        <span class="boat-badge boat-${esc(bt[1])}" style="width:30px;height:30px;font-size:1rem;">${esc(bt[1])}</span></span>
        <b>${fmtPt(b.units)} pt</b>
      </div>`;
    }).join('');
  } else {
    myBetsBox.style.display = 'none';
    myBetsList.innerHTML = '';
  }
}

function updateSelectionUI() {
  firstGrid.querySelectorAll('.boat-btn').forEach(btn => {
    btn.classList.toggle('selected', parseInt(btn.dataset.boat, 10) === selectedFirst);
  });
  secondGrid.querySelectorAll('.boat-btn').forEach(btn => {
    const b = parseInt(btn.dataset.boat, 10);
    btn.classList.toggle('selected', b === selectedSecond);
    btn.disabled = (b === selectedFirst);
  });

  if (selectedFirst) {
    previewFirst.textContent = selectedFirst;
    previewFirst.className = `boat-badge boat-${selectedFirst}`;
    previewFirst.style.visibility = 'visible';
  } else {
    previewFirst.style.visibility = 'hidden';
  }
  if (selectedSecond) {
    previewSecond.textContent = selectedSecond;
    previewSecond.className = `boat-badge boat-${selectedSecond}`;
    previewSecond.style.visibility = 'visible';
  } else {
    previewSecond.style.visibility = 'hidden';
  }

  if (selectedFirst && selectedSecond) {
    previewText.textContent = `2連単 【 ${selectedFirst} - ${selectedSecond} 】 ${fmtPt(selectedUnits)}pt`;
    previewText.style.color = '#0284c7';
  } else if (selectedFirst) {
    previewText.textContent = '2着の艇番を選択してください';
    previewText.style.color = '#64748b';
  } else {
    previewText.textContent = '艇番を選んでください';
    previewText.style.color = '#64748b';
  }
  updateSubmitButtonState();
}

function updateSubmitButtonState() {
  const r = currentState.currentRace;
  const user = currentUserName();
  const pin = currentPin();
  const remain = remainingUnits(r);
  updateBudgetUI();

  if (!hostConn || !hostConn.open || !stateReceived) {
    submitVoteBtn.disabled = true;
    submitVoteBtn.innerHTML = '<span>📡</span> 主催者と接続中...';
    voteMessage.textContent = '主催者画面と通信しています。しばらくお待ちください。';
    return;
  }
  if (!currentState.isOpen) {
    submitVoteBtn.disabled = true;
    submitVoteBtn.innerHTML = '<span>🛑</span> 受付停止中';
    voteMessage.textContent = `第${r}レースの投票は現在受け付けていません。`;
    return;
  }
  if (!user || !pin) {
    submitVoteBtn.disabled = true;
    submitVoteBtn.innerHTML = '<span>👤</span> ニックネームとPASS番号を入力してください';
    voteMessage.textContent = '投票するには、ニックネームとPASS番号（数字4桁）の登録が必要です。';
    return;
  }
  if (remain <= 0) {
    submitVoteBtn.disabled = true;
    submitVoteBtn.innerHTML = '<span>✅</span> 持ちポイントを使い切りました';
    voteMessage.textContent = `第${r}Rの持ちポイント${rules.budget.toLocaleString()}ptはすべて投票済みです。レース観戦をお楽しみください！`;
    return;
  }
  if (selectedFirst && selectedSecond) {
    submitVoteBtn.disabled = false;
    submitVoteBtn.innerHTML = `<span>📝</span> 第${r}R 【 ${selectedFirst} - ${selectedSecond} 】${fmtPt(selectedUnits)}ptで投票！`;
    voteMessage.textContent = '';
  } else {
    submitVoteBtn.disabled = true;
    submitVoteBtn.innerHTML = '<span>📝</span> 1着・2着を選択してください';
    voteMessage.textContent = '';
  }
}

// ---------- 投票送信 ----------
submitVoteBtn.addEventListener('click', () => {
  const user = currentUserName();
  if (!user) {
    showToast('⚠️ ニックネームを入力してください');
    userNameInput.focus();
    return;
  }
  if (!currentPin()) {
    showToast('⚠️ PASS番号を数字4桁で入力してください');
    userPinInput.focus();
    return;
  }
  if (!selectedFirst || !selectedSecond) {
    showToast('⚠️ 1着と2着の艇番を選択してください');
    return;
  }
  const race = currentState.currentRace;
  const remain = remainingUnits(race);
  if (remain <= 0) {
    showToast('⚠️ このレースの持ちポイントは使い切っています');
    return;
  }
  const units = Math.min(selectedUnits, remain);
  const msg = `【投票の最終確認】\nニックネーム: ${user}\nPASS番号: ${currentPin()}\n対象レース: 第${race}レース\n予想: 2連単 ${selectedFirst} - ${selectedSecond}\n投票ポイント: ${fmtPt(units)}pt\n\n※このレースの持ちポイントは残り ${fmtPt(remain)}pt です。投票後は取り消せません。投票しますか？`;
  if (!confirm(msg)) return;

  localStorage.setItem('boatrace_user', user);
  localStorage.setItem('boatrace_pin', currentPin());
  submitVoteBtn.disabled = true;
  submitVoteBtn.innerHTML = '<span>⏳</span> 投票送信中...';

  lastVote = { type: 'vote', user, pin: currentPin(), race, first: selectedFirst, second: selectedSecond, units, vid: newVoteId() };
  const ok = send(lastVote);
  clearTimeout(voteTimer);
  if (!ok) {
    showToast('⚠️ 通信が切れています。つながるまでお待ちください', 4000);
    updateSubmitButtonState();
    return;
  }
  // 返事が来ない場合に、ボタンが固まらないようにする
  voteTimer = setTimeout(() => {
    showToast('⚠️ 応答がありません。履歴で投票済みか確認してから、必要なら再度お試しください', 5000);
    send(Object.assign({ type: 'get_state' }, identity()));
    updateSubmitButtonState();
  }, 8000);
});

// ---------- 履歴 ----------
function renderHistoryTable() {
  const votes = getMyVotes();
  myTotalPoints.textContent = (meMatches() ? Number(me.totalPoints) || 0 : 0).toLocaleString();

  let html = '';
  [5, 6, 7].forEach(r => {
    const v = votes[r];
    const res = currentState.results[r];
    const bets = v && v.bets ? v.bets : [];

    const betDisplay = bets.length
      ? bets.map(b => `<div class="history-bet-line"><b>${esc(b.bet)}</b> <span class="pt">${fmtPt(b.units)}pt</span></div>`).join('')
      : '<span class="badge-waiting">未投票</span>';
    let resultDisplay = '<span class="badge-waiting">未確定</span>';
    let pointsDisplay = '-';

    if (res && res.settled) {
      const payout = parseInt(res.payout, 10) || 0;
      resultDisplay = `<b>${esc(res.first)}-${esc(res.second)}</b> (${payout.toLocaleString()}円)`;
      if (bets.length) {
        const total = Number(v.points) || 0;
        pointsDisplay = v.isHit
          ? `<span class="badge-hit">🎯 的中! +${total.toLocaleString()}pt</span>`
          : '<span class="badge-miss">不的中 (0pt)</span>';
      } else {
        pointsDisplay = '<span class="badge-miss">未投票</span>';
      }
    } else if (bets.length) {
      pointsDisplay = '<span class="badge-waiting">結果待ち</span>';
    }

    html += `<tr><td><b>第${r}R</b></td><td>${betDisplay}</td><td>${resultDisplay}</td><td>${pointsDisplay}</td></tr>`;
  });
  historyTableBody.innerHTML = html;
}

// ---------- P2P接続（切れても自動で再接続） ----------
function scheduleRetry(delay = 3000) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!targetHostId) return;
    if (!peer || peer.destroyed) {
      startPeer();
    } else if (peer.disconnected) {
      try { peer.reconnect(); } catch (e) { /* ignore */ }
    } else if (peer.open) {
      openHostConnection();
    }
  }, delay);
}

function startPeer() {
  const p = new Peer({ debug: 1 });
  peer = p;
  p.on('open', () => {
    if (peer === p) openHostConnection();
  });
  p.on('disconnected', () => {
    if (peer !== p) return;
    setBadge('closed', '通信再接続中...');
    scheduleRetry();
  });
  p.on('error', err => {
    console.warn('Peer error:', err);
    if (peer !== p) return;
    if (err.type === 'peer-unavailable') {
      setBadge('closed', '主催者が見つかりません（再試行中）');
    } else {
      setBadge('closed', '接続エラー（再試行中）');
    }
    scheduleRetry();
  });
}

function openHostConnection() {
  if (!peer || !peer.open || !targetHostId) return;
  if (hostConn && hostConn.open) return;
  if (hostConn) { try { hostConn.close(); } catch (e) { /* ignore */ } }

  const conn = peer.connect(targetHostId, { reliable: true });
  hostConn = conn;
  setBadge('closed', '接続中...');

  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if (hostConn === conn && !conn.open) {
      try { conn.close(); } catch (e) { /* ignore */ }
      setBadge('closed', '接続できません（再試行中）');
      scheduleRetry();
    }
  }, 10000);

  conn.on('open', () => {
    clearTimeout(connectTimer);
    setBadge('open', '🟢 主催者と接続中');
    manualHostCard.style.display = 'none';
    send(Object.assign({ type: 'get_state' }, identity()));
    updateSubmitButtonState();
  });
  conn.on('data', handleHostMessage);
  conn.on('close', () => {
    if (hostConn !== conn) return;
    setBadge('closed', '切断（再接続中）');
    updateSubmitButtonState();
    scheduleRetry();
  });
  conn.on('error', () => {
    if (hostConn !== conn) return;
    setBadge('closed', '接続失敗（再試行中）');
    updateSubmitButtonState();
    scheduleRetry();
  });
}

function connectToHost(hostId) {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(hostId)) {
    manualHostCard.style.display = 'block';
    showToast('⚠️ ルームキーの形式が正しくありません', 4000);
    return;
  }
  targetHostId = hostId;
  setBadge('closed', '接続中...');
  if (!peer || peer.destroyed) {
    startPeer();
  } else if (peer.open) {
    openHostConnection();
  } else {
    scheduleRetry(500);
  }
}

// スマホがスリープから戻ったときは、すぐ再接続する
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && targetHostId && !(hostConn && hostConn.open)) {
    clearTimeout(retryTimer);
    retryTimer = null;
    scheduleRetry(300);
  }
});

// ---------- 主催者からのメッセージ ----------
function handleHostMessage(data) {
  if (!data || typeof data !== 'object') return;

  if (data.type === 'state_update' && data.state) {
    currentState = data.state;
    me = data.me || null;
    if (data.rules && Number(data.rules.budget) > 0 && Number(data.rules.unit) > 0) {
      rules = { budget: Number(data.rules.budget), unit: Number(data.rules.unit) };
    }
    stateReceived = true;

    currentRaceBadge.textContent = `第 ${currentState.currentRace} レース`;
    if (currentState.isOpen) {
      raceStatusBadge.textContent = '🟢 投票受付中';
      raceStatusBadge.className = 'status-badge open';
    } else {
      raceStatusBadge.textContent = '🛑 受付停止中';
      raceStatusBadge.className = 'status-badge closed';
    }
    updateSubmitButtonState();
    renderHistoryTable();
    return;
  }

  if (data.type === 'vote_result') {
    clearTimeout(voteTimer);
    if (data.success && data.vote) {
      showToast(`🎉 ${data.message}`, 4000);
      const v = data.vote;
      // 主催者からの最新データが届くまでの間、手元で反映
      if (!v.alreadyCounted) {
        if (!meMatches()) {
          me = { user: v.user, k: myKey(), rank: null, totalPoints: 0, hitCount: 0, votes: { 5: null, 6: null, 7: null } };
        }
        const rv = me.votes[v.race] || (me.votes[v.race] = { bets: [], units: 0, points: 0, settled: false, isHit: false });
        const units = Number(v.units) || 1;
        rv.units = (Number(rv.units) || 0) + units;
        const same = rv.bets.find(b => b.first === v.first && b.second === v.second);
        if (same) same.units += units;
        else rv.bets.push({ first: v.first, second: v.second, bet: v.bet, units, settled: false, isHit: false, points: 0 });
      }
      selectedFirst = null;
      selectedSecond = null;
      selectedUnits = 1;
      lastVote = null;
      updateSelectionUI();
      renderHistoryTable();
    } else if (data.needConfirm && lastVote) {
      // 同じ名前でPASS番号が違う人がすでにいる：入力ミスでないか確認する
      const retry = confirm(`${data.error}\n\n同じ名前の別の人として投票しますか？\n（PASS番号の入力ミスかもしれない場合は［キャンセル］を押してください）`);
      if (retry) {
        submitVoteBtn.disabled = true;
        submitVoteBtn.innerHTML = '<span>⏳</span> 投票送信中...';
        send(Object.assign({}, lastVote, { confirmSame: true }));
        clearTimeout(voteTimer);
      } else {
        userPinInput.focus();
        updateSubmitButtonState();
      }
    } else {
      alert(`❌ エラー: ${data.error || '投票できませんでした'}`);
      send(Object.assign({ type: 'get_state' }, identity()));
      updateSubmitButtonState();
    }
  }
}

manualConnectBtn.addEventListener('click', () => {
  const key = manualHostInput.value.trim();
  if (key) connectToHost(key);
});

// ---------- 初期化 ----------
initUser();
updateSelectionUI();
renderHistoryTable();

const params = new URLSearchParams(window.location.search);
const paramHost = params.get('host') || params.get('room');
if (paramHost) {
  connectToHost(paramHost.trim());
} else {
  manualHostCard.style.display = 'block';
  setBadge('closed', '未接続');
}
