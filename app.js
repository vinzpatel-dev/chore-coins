// ── Supabase config ───────────────────────────────────────────────
const SUPABASE_URL = 'https://aaraiyrpmdrlupvvpzlm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhcmFpeXJwbWRybHVwdnZwemxtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MTYxMDIsImV4cCI6MjA5ODI5MjEwMn0.UXmMnj4fLjlF5kEpEVF4Cb4nFubZT6cWwWKRurj8Iik';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ── App state ─────────────────────────────────────────────────────
let kids = [], chores = [], completed = [], history = [];
let activeKidId = null;
let payoutKidId = null;
let activeTab = 'chores';
let toastTimer = null;

const today = () => new Date().toISOString().slice(0, 10);
const fmt = v => '$' + parseFloat(v).toFixed(2);

// ── Sync indicator ────────────────────────────────────────────────
function setSyncDot(state) {
  const d = document.getElementById('syncDot');
  d.className = 'sync-dot' + (state === 'syncing' ? ' syncing' : state === 'error' ? ' error' : '');
}

// ── Toast ─────────────────────────────────────────────────────────
function toast(msg) {
  clearTimeout(toastTimer);
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.style.display = 'block';
  toastTimer = setTimeout(() => { if (el) el.style.display = 'none'; }, 2400);
}

// ── Tab switching ─────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  ['chores', 'summary', 'settings'].forEach(t => {
    document.getElementById('tab-' + t).style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', ['chores','summary','settings'][i] === tab);
  });
  if (tab === 'summary') renderSummary();
  if (tab === 'settings') renderSettings();
}

// ── Load all data ─────────────────────────────────────────────────
async function loadAll() {
  setSyncDot('syncing');
  try {
    const [k, c, comp, h] = await Promise.all([
      sb.from('cc_kids').select('*').order('id'),
      sb.from('cc_chores').select('*').where ? sb.from('cc_chores').select('*').eq('active', true).order('id') : sb.from('cc_chores').select('*').order('id'),
      sb.from('cc_completed').select('*').eq('date', today()),
      sb.from('cc_history').select('*').order('created_at', { ascending: false }).limit(50),
    ]);
    kids     = k.data || [];
    chores   = (c.data || []).filter(ch => ch.active !== false);
    completed = comp.data || [];
    history  = h.data || [];
    if (!activeKidId && kids.length) activeKidId = kids[0].id;
    setSyncDot('ok');
  } catch(e) {
    console.error(e);
    setSyncDot('error');
  }
}

// ── Real-time subscriptions ───────────────────────────────────────
function setupRealtime() {
  sb.channel('chore-coins')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cc_kids' }, async () => {
      await loadAll(); renderAll();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cc_chores' }, async () => {
      await loadAll(); renderAll();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cc_completed' }, async () => {
      const { data } = await sb.from('cc_completed').select('*').eq('date', today());
      completed = data || [];
      renderChores();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cc_history' }, async () => {
      const { data } = await sb.from('cc_history').select('*').order('created_at', { ascending: false }).limit(50);
      history = data || [];
      if (activeTab === 'summary') renderHistory();
    })
    .subscribe();
}

function renderAll() {
  renderKidSwitcher();
  renderBalanceCard();
  renderChores();
  if (activeTab === 'summary') renderSummary();
  if (activeTab === 'settings') renderSettings();
}

// ── Kid Switcher ──────────────────────────────────────────────────
function renderKidSwitcher() {
  const el = document.getElementById('kidSwitcher');
  el.innerHTML = kids.map(k => `
    <button class="kid-btn" id="kidbtn-${k.id}"
      onclick="selectKid(${k.id})"
      style="background:${activeKidId === k.id ? k.color : 'rgba(255,255,255,0.07)'};
             border-color:${activeKidId === k.id ? k.color : 'transparent'};
             box-shadow:${activeKidId === k.id ? `0 0 18px ${k.color}66` : 'none'}">
      <span class="kid-emoji">${k.emoji}</span>
      <span>${k.name}</span>
    </button>
  `).join('');
}

function selectKid(id) {
  activeKidId = id;
  renderKidSwitcher();
  renderBalanceCard();
  renderChores();
}

// ── Balance Card ──────────────────────────────────────────────────
function renderBalanceCard() {
  const k = kids.find(x => x.id === activeKidId);
  if (!k) return;
  const el = document.getElementById('balanceCard');
  el.style.background = `linear-gradient(135deg, ${k.color}33, ${k.color}11)`;
  el.style.border = `1px solid ${k.color}44`;
  el.innerHTML = `
    <div>
      <div class="balance-label">${k.name}'s balance</div>
      <div class="balance-amount" style="color:${k.color}">${fmt(k.balance)}</div>
    </div>
    <div class="balance-emoji">${k.emoji}</div>
  `;
}

// ── Chore List ────────────────────────────────────────────────────
function renderChores() {
  const el = document.getElementById('choreList');
  const doneIds = new Set(completed.filter(c => c.kid_id === activeKidId).map(c => c.chore_id));
  el.innerHTML = chores.map(c => {
    const done = doneIds.has(c.id);
    return `
      <button class="chore-item ${done ? 'done' : ''}" onclick="toggleChore(${c.id})">
        <span class="chore-check">${done ? '✓' : c.emoji}</span>
        <span class="chore-name">${c.label}</span>
        <span class="chore-amount">${fmt(c.amount)}</span>
      </button>
    `;
  }).join('');
}

// ── Toggle Chore ──────────────────────────────────────────────────
async function toggleChore(choreId) {
  const chore = chores.find(c => c.id === choreId);
  const kid   = kids.find(k => k.id === activeKidId);
  if (!chore || !kid) return;

  const existing = completed.find(c => c.kid_id === activeKidId && c.chore_id === choreId);
  setSyncDot('syncing');

  if (existing) {
    // Undo
    await sb.from('cc_completed').delete().eq('id', existing.id);
    const newBal = Math.max(0, parseFloat(kid.balance) - parseFloat(chore.amount));
    await sb.from('cc_kids').update({ balance: newBal }).eq('id', activeKidId);
    await sb.from('cc_history').insert({ kid_id: activeKidId, type: 'undo', label: chore.label, amount: chore.amount, date: today() });
    kids = kids.map(k => k.id === activeKidId ? { ...k, balance: newBal } : k);
    completed = completed.filter(c => c.id !== existing.id);
  } else {
    // Done
    const { data: newComp } = await sb.from('cc_completed').insert({ kid_id: activeKidId, chore_id: choreId, date: today() }).select().single();
    const newBal = parseFloat(kid.balance) + parseFloat(chore.amount);
    await sb.from('cc_kids').update({ balance: newBal }).eq('id', activeKidId);
    await sb.from('cc_history').insert({ kid_id: activeKidId, type: 'done', label: chore.label, amount: chore.amount, date: today() });
    kids = kids.map(k => k.id === activeKidId ? { ...k, balance: newBal } : k);
    if (newComp) completed = [...completed, newComp];
    toast(`+${fmt(chore.amount)} earned! 🎉`);
  }

  setSyncDot('ok');
  renderBalanceCard();
  renderChores();
  if (activeTab === 'summary') renderSummary();
}

// ── Summary ───────────────────────────────────────────────────────
function renderSummary() {
  const el = document.getElementById('summaryCards');
  el.innerHTML = kids.map(k => `
    <div class="summary-card" style="background:linear-gradient(135deg,${k.color}33,${k.color}11);border:1px solid ${k.color}44">
      <div class="s-emoji">${k.emoji}</div>
      <div class="s-name">${k.name}</div>
      <div class="s-amount" style="color:${k.color}">${fmt(k.balance)}</div>
      <button class="payout-btn" style="background:${k.color}" onclick="openPayout(${k.id})">Pay Out 💸</button>
    </div>
  `).join('');
  renderHistory();
}

function renderHistory() {
  const el = document.getElementById('historyList');
  if (!history.length) { el.innerHTML = '<div class="empty">No activity yet — start ticking off chores!</div>'; return; }
  el.innerHTML = history.slice(0, 25).map(h => {
    const k = kids.find(x => x.id === h.kid_id);
    const icon = h.type === 'payout' ? '💸' : h.type === 'undo' ? '↩️' : '✅';
    const color = h.type === 'payout' ? '#ff8888' : h.type === 'undo' ? '#aaa' : '#88dd88';
    const sign = h.type === 'payout' ? '-' : h.type === 'undo' ? '-' : '+';
    return `
      <div class="history-item">
        <span class="h-icon">${icon}</span>
        <div style="flex:1">
          <div class="h-label">${h.label}</div>
          <div class="h-sub">${k?.name || '?'} · ${h.date}</div>
        </div>
        <span class="h-amount" style="color:${color}">${sign}${fmt(h.amount)}</span>
      </div>
    `;
  }).join('');
}

// ── Payout ────────────────────────────────────────────────────────
function openPayout(kidId) {
  payoutKidId = kidId;
  const k = kids.find(x => x.id === kidId);
  document.getElementById('payoutTitle').textContent = `Pay out to ${k?.name}`;
  document.getElementById('payoutAmt').value = '';
  document.getElementById('payoutMax').textContent = `Balance: ${fmt(k?.balance || 0)}`;
  document.getElementById('payoutPanel').style.display = 'block';
  document.getElementById('payoutAmt').focus();
}

function closePayout() {
  payoutKidId = null;
  document.getElementById('payoutPanel').style.display = 'none';
}

function updatePayoutMax() {
  if (!payoutKidId) return;
  const k = kids.find(x => x.id === payoutKidId);
  const entered = parseFloat(document.getElementById('payoutAmt').value) || 0;
  const remaining = Math.max(0, parseFloat(k?.balance || 0) - entered);
  document.getElementById('payoutMax').textContent = `Balance: ${fmt(k?.balance || 0)} → After payout: ${fmt(remaining)}`;
}

async function confirmPayout() {
  const amt = parseFloat(document.getElementById('payoutAmt').value);
  const kid = kids.find(k => k.id === payoutKidId);
  if (!kid || isNaN(amt) || amt <= 0) { toast('Enter a valid amount'); return; }
  setSyncDot('syncing');
  const newBal = Math.max(0, parseFloat(kid.balance) - amt);
  await sb.from('cc_kids').update({ balance: newBal }).eq('id', payoutKidId);
  await sb.from('cc_history').insert({ kid_id: payoutKidId, type: 'payout', label: 'Payout', amount: amt, date: today() });
  kids = kids.map(k => k.id === payoutKidId ? { ...k, balance: newBal } : k);
  const { data } = await sb.from('cc_history').select('*').order('created_at', { ascending: false }).limit(50);
  history = data || [];
  setSyncDot('ok');
  closePayout();
  toast(`${fmt(amt)} paid out! 💰`);
  renderSummary();
  renderBalanceCard();
}

// ── Settings ──────────────────────────────────────────────────────
function renderSettings() {
  // Kid names
  document.getElementById('kidNameSettings').innerHTML = kids.map(k => `
    <div class="settings-row">
      <span class="settings-emoji">${k.emoji}</span>
      <input type="text" id="kidname-${k.id}" value="${k.name}" style="flex:1" />
      <button class="btn-primary" onclick="saveKidName(${k.id})">Save</button>
    </div>
  `).join('');

  // Chore manage
  document.getElementById('choreManageList').innerHTML = chores.map(c => `
    <div class="chore-manage-item" id="chore-row-${c.id}">
      <span style="font-size:18px">${c.emoji}</span>
      <span style="flex:1;font-size:14px">${c.label}</span>
      <span style="font-size:13px;color:#6C63FF;font-weight:700">${fmt(c.amount)}</span>
      <button class="btn-edit" onclick="startEditChore(${c.id})">✏️</button>
      <button class="btn-delete" onclick="deleteChore(${c.id})">✕</button>
    </div>
    <div class="chore-edit-row" id="chore-edit-${c.id}" style="display:none">
      <input type="text" id="edit-emoji-${c.id}" value="${c.emoji}"
        maxlength="2" style="width:44px;text-align:center;font-size:18px;padding:7px 4px" />
      <input type="text" id="edit-label-${c.id}" value="${c.label}" style="flex:1" />
      <input type="number" id="edit-amount-${c.id}" value="${c.amount}"
        step="0.50" min="0" style="width:64px" />
      <button class="btn-primary" onclick="saveEditChore(${c.id})">Save</button>
      <button class="btn-ghost" onclick="cancelEditChore(${c.id})">✕</button>
    </div>
  `).join('');
}

async function saveKidName(id) {
  const val = document.getElementById('kidname-' + id)?.value?.trim();
  if (!val) return;
  setSyncDot('syncing');
  await sb.from('cc_kids').update({ name: val }).eq('id', id);
  kids = kids.map(k => k.id === id ? { ...k, name: val } : k);
  setSyncDot('ok');
  renderKidSwitcher();
  renderBalanceCard();
  toast('Name saved!');
}

async function addChore() {
  const label  = document.getElementById('newChoreLabel').value.trim();
  const amount = parseFloat(document.getElementById('newChoreAmt').value);
  const emoji  = document.getElementById('newEmoji').value.trim() || '⭐';
  if (!label || isNaN(amount) || amount <= 0) { toast('Fill in chore name and amount'); return; }
  setSyncDot('syncing');
  const { data } = await sb.from('cc_chores').insert({ label, emoji, amount, active: true }).select().single();
  if (data) chores = [...chores, data];
  document.getElementById('newChoreLabel').value = '';
  document.getElementById('newChoreAmt').value = '';
  document.getElementById('newEmoji').value = '⭐';
  setSyncDot('ok');
  renderSettings();
  renderChores();
  toast('Chore added!');
}

function startEditChore(id) {
  document.getElementById('chore-row-' + id).style.display = 'none';
  document.getElementById('chore-edit-' + id).style.display = 'flex';
  document.getElementById('edit-label-' + id).focus();
}

function cancelEditChore(id) {
  document.getElementById('chore-row-' + id).style.display = 'flex';
  document.getElementById('chore-edit-' + id).style.display = 'none';
}

async function saveEditChore(id) {
  const emoji  = document.getElementById('edit-emoji-' + id).value.trim() || '⭐';
  const label  = document.getElementById('edit-label-' + id).value.trim();
  const amount = parseFloat(document.getElementById('edit-amount-' + id).value);
  if (!label || isNaN(amount) || amount <= 0) { toast('Fill in all fields'); return; }
  setSyncDot('syncing');
  await sb.from('cc_chores').update({ emoji, label, amount }).eq('id', id);
  chores = chores.map(c => c.id === id ? { ...c, emoji, label, amount } : c);
  setSyncDot('ok');
  renderSettings();
  renderChores();
  toast('Chore updated! ✅');
}

async function deleteChore(id) {
  setSyncDot('syncing');
  await sb.from('cc_chores').update({ active: false }).eq('id', id);
  chores = chores.filter(c => c.id !== id);
  setSyncDot('ok');
  renderSettings();
  renderChores();
}

// ── PIN Logic ─────────────────────────────────────────────────────
const SESSION_KEY = 'cc_unlocked';
let pinEntry = '';
let correctPin = '1234';
let pinMode = 'unlock'; // 'unlock'

function isUnlocked() {
  return sessionStorage.getItem(SESSION_KEY) === 'yes';
}

async function loadPin() {
  const { data } = await sb.from('cc_settings').select('value').eq('key', 'pin').single();
  if (data) correctPin = data.value;
}

function showPinScreen(subtitle = 'Enter PIN to continue') {
  document.getElementById('pinScreen').style.display = 'block';
  document.getElementById('app').style.display = 'none';
  document.getElementById('pinSubtitle').textContent = subtitle;
  pinEntry = '';
  updatePinDots();
}

function pinKey(digit) {
  if (pinEntry.length >= 4) return;
  pinEntry += digit;
  updatePinDots();
  if (pinEntry.length === 4) setTimeout(checkPin, 120);
}

function pinDel() {
  pinEntry = pinEntry.slice(0, -1);
  updatePinDots();
  clearPinError();
}

function updatePinDots() {
  for (let i = 0; i < 4; i++) {
    const d = document.getElementById('d' + i);
    d.className = 'dot' + (i < pinEntry.length ? ' filled' : '');
  }
}

function setPinError(msg) {
  document.getElementById('pinError').textContent = msg;
  for (let i = 0; i < 4; i++) document.getElementById('d' + i).className = 'dot error';
  pinEntry = '';
  setTimeout(() => { updatePinDots(); clearPinError(); }, 800);
}

function clearPinError() {
  document.getElementById('pinError').textContent = '';
}

function checkPin() {
  if (pinEntry === correctPin) {
    sessionStorage.setItem(SESSION_KEY, 'yes');
    document.getElementById('pinScreen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    renderAll();
  } else {
    setPinError('Incorrect PIN — try again');
  }
}

async function changePin() {
  const np = document.getElementById('newPin').value.trim();
  const cp = document.getElementById('confirmPin').value.trim();
  if (!/^\d{4}$/.test(np)) { toast('PIN must be exactly 4 digits'); return; }
  if (np !== cp) { toast('PINs do not match'); return; }
  setSyncDot('syncing');
  await sb.from('cc_settings').upsert({ key: 'pin', value: np });
  correctPin = np;
  document.getElementById('newPin').value = '';
  document.getElementById('confirmPin').value = '';
  setSyncDot('ok');
  toast('PIN updated! 🔐');
}

// ── Init ──────────────────────────────────────────────────────────
(async () => {
  await Promise.all([loadAll(), loadPin()]);
  document.getElementById('loading').style.display = 'none';

  if (isUnlocked()) {
    document.getElementById('app').style.display = 'flex';
    renderAll();
  } else {
    showPinScreen();
  }

  setupRealtime();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
