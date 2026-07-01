import { h, render } from 'https://esm.sh/preact@10.24.3';
import { useState, useEffect, useMemo, useRef, useCallback } from 'https://esm.sh/preact@10.24.3/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const html = htm.bind(h);
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { realtime: { params: { eventsPerSecond: 5 } } });

/* ============================ date + money helpers ============================ */
const pad = n => String(n).padStart(2, '0');
const toYMD = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromYMD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayYMD = () => toYMD(new Date());
const isoDow = d => { const g = d.getDay(); return g === 0 ? 7 : g; };            // 1=Mon..7=Sun
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = d => addDays(d, -(isoDow(d) - 1));                            // Monday
const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = d => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const money = n => `$${(Number(n) || 0).toFixed(2)}`;
const prettyDate = s => fromYMD(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const shortDate = s => fromYMD(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const FREQ_LABEL = {
  daily: 'Every day', specific_days: 'Set days', x_per_week: 'X / week',
  weekly: 'Weekly', one_off: 'One-off'
};

/* current payout period [startYMD,endYMD] for a kid, by their cycle */
function currentPeriod(kid) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (kid.payout_period === 'monthly')
    return [toYMD(startOfMonth(today)), toYMD(endOfMonth(today))];
  if (kid.payout_period === 'fortnightly') {
    const anchor = kid.payout_start_date ? fromYMD(kid.payout_start_date) : startOfWeek(today);
    const diff = Math.floor((today - anchor) / 86400000);
    const block = Math.floor(diff / 14);
    const start = addDays(anchor, block * 14);
    return [toYMD(start), toYMD(addDays(start, 13))];
  }
  const start = startOfWeek(today);                                              // weekly
  return [toYMD(start), toYMD(addDays(start, 6))];
}

/* is a chore due on a given date (used for "today" list + missed calc) */
function isDueOn(chore, dateObj) {
  const dow = isoDow(dateObj);
  switch (chore.frequency) {
    case 'daily': return true;
    case 'specific_days': return (chore.days_of_week || []).includes(dow);
    case 'weekly': return (chore.days_of_week || []).includes(dow);
    case 'x_per_week': return true;      // any day, gated by weekly limit in UI
    case 'one_off': return true;         // shown until done once
    default: return false;
  }
}

/* ============================ data hook (load + realtime) ============================ */
function useStore() {
  const [state, setState] = useState({ loading: true, kids: [], chores: [], completions: [], adjustments: [], payouts: [], payoutItems: [], settings: null });
  const timer = useRef(null);

  const load = useCallback(async () => {
    const [kids, chores, comps, adjs, pays, items, settings] = await Promise.all([
      sb.from('cc_kids').select('*').order('sort_order'),
      sb.from('cc_chores').select('*').order('sort_order'),
      sb.from('cc_completions').select('*').order('completed_date', { ascending: false }),
      sb.from('cc_adjustments').select('*').order('adjustment_date', { ascending: false }),
      sb.from('cc_payouts').select('*').order('paid_at', { ascending: false }),
      sb.from('cc_payout_items').select('*'),
      sb.from('cc_settings').select('*').eq('id', 1).single()
    ]);
    setState({
      loading: false,
      kids: kids.data || [], chores: chores.data || [], completions: comps.data || [],
      adjustments: adjs.data || [], payouts: pays.data || [], payoutItems: items.data || [],
      settings: settings.data || { pin: '1234', app_name: 'Chore Coins' }
    });
  }, []);

  useEffect(() => {
    load();
    const debounced = () => { clearTimeout(timer.current); timer.current = setTimeout(load, 250); };
    const ch = sb.channel('cc-sync');
    ['cc_kids', 'cc_chores', 'cc_completions', 'cc_adjustments', 'cc_payouts', 'cc_payout_items', 'cc_settings']
      .forEach(t => ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, debounced));
    ch.subscribe();
    return () => { clearTimeout(timer.current); sb.removeChannel(ch); };
  }, [load]);

  return [state, load];
}

/* ============================ derived selectors ============================ */
const forKid = (rows, kidId) => rows.filter(r => r.kid_id === kidId);
const unpaid = rows => rows.filter(r => !r.payout_id);

function kidChores(chores, kidId) {                    // shared (null) + this kid's own, active only
  return chores.filter(c => c.active && (c.kid_id === null || c.kid_id === kidId));
}
function completedThisWeek(completions, kidId, choreId, ref = new Date()) {
  const ws = toYMD(startOfWeek(ref)), we = toYMD(addDays(startOfWeek(ref), 6));
  return completions.filter(c => c.kid_id === kidId && c.chore_id === choreId && c.completed_date >= ws && c.completed_date <= we).length;
}
function owedFor(store, kidId) {
  const c = unpaid(forKid(store.completions, kidId)).reduce((s, r) => s + Number(r.amount), 0);
  const b = unpaid(forKid(store.adjustments, kidId)).filter(a => a.type === 'bonus').reduce((s, r) => s + Number(r.amount), 0);
  const d = unpaid(forKid(store.adjustments, kidId)).filter(a => a.type === 'deduction').reduce((s, r) => s + Number(r.amount), 0);
  return { chores: c, bonus: b, deduction: d, total: c + b - d };
}

/* ============================ mutations ============================ */
async function tickChore(store, kid, chore, dateYMD, isDone, toast) {
  if (isDone) {
    await sb.from('cc_completions').delete().match({ kid_id: kid.id, chore_id: chore.id, completed_date: dateYMD });
  } else {
    const { error } = await sb.from('cc_completions').insert({
      kid_id: kid.id, chore_id: chore.id, chore_name: chore.name, amount: chore.amount, completed_date: dateYMD
    });
    if (error && error.code !== '23505') { toast('Could not save — try again'); return; }
    await maybeStreak(kid, dateYMD, store, toast);
  }
}

async function maybeStreak(kid, dateYMD, store, toast) {
  if (!kid.streak_days || !Number(kid.streak_bonus)) return;
  const dailyIds = kidChores(store.chores, kid.id).filter(c => c.frequency === 'daily').map(c => c.id);
  if (!dailyIds.length) return;
  const since = toYMD(addDays(fromYMD(dateYMD), -(kid.streak_days * 2 + 2)));
  const { data: comps } = await sb.from('cc_completions').select('chore_id,completed_date')
    .eq('kid_id', kid.id).gte('completed_date', since);
  const dayDone = ymd => dailyIds.every(id => comps.some(c => c.chore_id === id && c.completed_date === ymd));
  if (!dayDone(dateYMD)) return;
  let streak = 0, cur = fromYMD(dateYMD);
  while (dayDone(toYMD(cur))) { streak++; cur = addDays(cur, -1); }
  if (streak > 0 && streak % kid.streak_days === 0) {
    const { data: has } = await sb.from('cc_adjustments').select('id')
      .eq('kid_id', kid.id).eq('is_auto', true).eq('adjustment_date', dateYMD).limit(1);
    if (!has || !has.length) {
      await sb.from('cc_adjustments').insert({
        kid_id: kid.id, type: 'bonus', amount: kid.streak_bonus, is_auto: true,
        adjustment_date: dateYMD, note: `Streak bonus 🔥 ${streak} days`
      });
      toast(`🔥 ${kid.name} hit a ${streak}-day streak! +${money(kid.streak_bonus)}`);
    }
  }
}

async function doPayout(store, kid, toast) {
  const comps = unpaid(forKid(store.completions, kid.id));
  const adjs = unpaid(forKid(store.adjustments, kid.id));
  if (!comps.length && !adjs.length) { toast('Nothing to pay out'); return; }
  const o = owedFor(store, kid.id);
  const last = store.payouts.filter(p => p.kid_id === kid.id)[0];
  const allDates = [...comps.map(c => c.completed_date), ...adjs.map(a => a.adjustment_date)].sort();
  const periodStart = last ? toYMD(addDays(fromYMD(last.period_end), 1)) : (allDates[0] || todayYMD());
  const periodEnd = todayYMD();

  const { data: pay, error } = await sb.from('cc_payouts').insert({
    kid_id: kid.id, period_start: periodStart, period_end: periodEnd,
    chores_total: o.chores, bonus_total: o.bonus, deduction_total: o.deduction, total_amount: o.total
  }).select().single();
  if (error) { toast('Payout failed — try again'); return; }

  const groups = {};
  comps.forEach(c => {
    const k = c.chore_id || c.chore_name;
    (groups[k] ||= { chore_id: c.chore_id, chore_name: c.chore_name, unit: Number(c.amount), times: 0, subtotal: 0, dates: [] });
    groups[k].times++; groups[k].subtotal += Number(c.amount); groups[k].dates.push(c.completed_date);
  });
  const items = Object.values(groups).map(g => ({
    payout_id: pay.id, item_type: 'chore', chore_id: g.chore_id, chore_name: g.chore_name,
    times: g.times, unit_amount: g.unit, subtotal: g.subtotal, dates: g.dates.sort()
  }));
  adjs.forEach(a => items.push({
    payout_id: pay.id, item_type: a.type, chore_name: a.note || (a.type === 'bonus' ? 'Bonus' : 'Deduction'),
    times: 1, unit_amount: Number(a.amount), subtotal: Number(a.amount), dates: [a.adjustment_date]
  }));
  if (items.length) await sb.from('cc_payout_items').insert(items);
  if (comps.length) await sb.from('cc_completions').update({ payout_id: pay.id }).in('id', comps.map(c => c.id));
  if (adjs.length) await sb.from('cc_adjustments').update({ payout_id: pay.id }).in('id', adjs.map(a => a.id));
  toast(`Paid ${kid.name} ${money(o.total)} 🎉`);
}

/* ============================ PIN gate ============================ */
function PinGate({ pin, onOk }) {
  const [entry, setEntry] = useState('');
  const [err, setErr] = useState(false);
  const press = v => {
    if (v === 'del') { setEntry(e => e.slice(0, -1)); return; }
    const next = (entry + v).slice(0, 4);
    setEntry(next);
    if (next.length === 4) {
      if (next === String(pin)) { setTimeout(() => onOk(), 120); }
      else { setErr(true); setTimeout(() => { setErr(false); setEntry(''); }, 500); }
    }
  };
  return html`
    <div class="pin-wrap">
      <div class="pin-coin">🪙</div>
      <div class="pin-title">Chore Coins</div>
      <div class="pin-sub">Enter your PIN</div>
      <div class="pin-dots">
        ${[0, 1, 2, 3].map(i => html`<div class=${'pin-dot' + (entry.length > i ? ' on' : '')}></div>`)}
      </div>
      <div class=${'pin-err' + (err ? ' shake' : '')}>${err ? 'Wrong PIN' : ''}</div>
      <div class="pad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => html`<button class="key" onClick=${() => press(String(n))}>${n}</button>`)}
        <button class="key blank"></button>
        <button class="key" onClick=${() => press('0')}>0</button>
        <button class="key" onClick=${() => press('del')}>⌫</button>
      </div>
    </div>`;
}

/* ============================ Chores tab ============================ */
function ChoresTab({ store, reload, kid, toast, openSheet }) {
  const today = todayYMD();
  const list = useMemo(() => {
    const now = new Date();
    return kidChores(store.chores, kid.id).filter(c => isDueOn(c, now)).map(c => {
      const done = store.completions.some(x => x.kid_id === kid.id && x.chore_id === c.id && x.completed_date === today);
      const wkCount = c.frequency === 'x_per_week' ? completedThisWeek(store.completions, kid.id, c.id) : 0;
      const atLimit = c.frequency === 'x_per_week' && !done && wkCount >= c.times_per_week;
      const everDone = c.frequency === 'one_off' && store.completions.some(x => x.kid_id === kid.id && x.chore_id === c.id);
      return { c, done, wkCount, atLimit, hide: (c.frequency === 'one_off' && everDone && !done) };
    }).filter(x => !x.hide)
      .sort((a, b) => (a.done - b.done) || (a.c.sort_order - b.c.sort_order));
  }, [store, kid, today]);

  const o = owedFor(store, kid.id);
  const [period] = [currentPeriod(kid)];
  const doneCount = list.filter(x => x.done).length;

  const onTick = async (row) => {
    if (row.atLimit) { toast(`Weekly limit reached (${row.c.times_per_week}×)`); return; }
    await tickChore(store, kid, row.c, today, row.done, toast);
    reload();
  };

  return html`
    <div class="screen">
      <div class="kid-switch">${store.kids.map(k => html`
        <button class="kid-pill" style=${{ '--pk': k.color }} aria-pressed=${k.id === kid.id}
          onClick=${() => openSheet({ type: 'switchKid', kidId: k.id })}>
          <span class="emoji">${k.emoji}</span>${k.name}
        </button>`)}
      </div>

      <div class="owed-card">
        <div class="owed-label">${kid.name}'s balance owed</div>
        <div class="owed-amount"><span class="cur">$</span>${o.total.toFixed(2)}</div>
        <div class="owed-sub">
          ${money(o.chores)} chores${o.bonus ? ` · +${money(o.bonus)} bonus` : ''}${o.deduction ? ` · −${money(o.deduction)} deduction` : ''}
          · ${DOW_period(period)}
        </div>
        <div class="owed-actions">
          <button class="btn btn-ghost" onClick=${() => openSheet({ type: 'bonus', kid })}>➕ Bonus</button>
          <button class="btn btn-ghost" onClick=${() => openSheet({ type: 'deduct', kid })}>➖ Deduct</button>
          <button class="btn btn-accent" disabled=${o.total <= 0 && o.chores <= 0 && o.bonus <= 0}
            onClick=${() => openSheet({ type: 'payout', kid })}>💰 Pay</button>
        </div>
      </div>

      <div class="sec-head"><span>Today · ${prettyDate(today)}</span><span class="line"></span><span>${doneCount}/${list.length}</span></div>

      ${list.length === 0
      ? html`<div class="empty"><span class="em">🎈</span>No chores due today for ${kid.name}.</div>`
      : list.map(row => html`
        <div class=${'chore' + (row.done ? ' done' : '')} key=${row.c.id} onClick=${() => onTick(row)}>
          <div class="chore-emoji">${row.c.emoji}</div>
          <div class="chore-main">
            <div class="chore-name">${row.c.name}</div>
            <div class="chore-meta">
              <span class="chip">${freqChip(row.c)}</span>
              ${row.c.kid_id === null ? html`<span class="chip">shared</span>` : ''}
              ${row.c.frequency === 'x_per_week' ? html`<span class=${'limit-tag'}>${row.wkCount}/${row.c.times_per_week} this week</span>` : ''}
            </div>
          </div>
          <div class="chore-amt">${money(row.c.amount)}</div>
          <button class="coin-tick" aria-label="tick"><span class="mark">✓</span></button>
        </div>`)}
    </div>`;
}
function DOW_period([s, e]) { return `period ${shortDate(s)}–${shortDate(e)}`; }
function freqChip(c) {
  if (c.frequency === 'daily') return 'daily';
  if (c.frequency === 'one_off') return 'one-off';
  if (c.frequency === 'x_per_week') return `${c.times_per_week}× / week`;
  if (c.frequency === 'weekly') return 'weekly ' + (c.days_of_week || []).map(d => DOW[d - 1]).join('');
  if (c.frequency === 'specific_days') return (c.days_of_week || []).map(d => DOW[d - 1]).join('/');
  return c.frequency;
}

/* ============================ Reports tab ============================ */
function ReportsTab({ store }) {
  const today = todayYMD();
  const ws = toYMD(startOfWeek(new Date())), we = toYMD(addDays(startOfWeek(new Date()), 6));
  return html`<div class="screen">
    <div class="sec-head"><span>Reports · week of ${shortDate(ws)}</span><span class="line"></span></div>
    ${store.kids.map(kid => html`<${KidReport} store=${store} kid=${kid} ws=${ws} we=${we} today=${today} key=${kid.id}/>`)}
  </div>`;
}

function KidReport({ store, kid, ws, we, today }) {
  const inWeek = (dt) => dt >= ws && dt <= we;
  const comps = forKid(store.completions, kid.id);
  const adjs = forKid(store.adjustments, kid.id);

  const weekEarn = comps.filter(c => inWeek(c.completed_date)).reduce((s, c) => s + Number(c.amount), 0)
    + adjs.filter(a => inWeek(a.adjustment_date)).reduce((s, a) => s + (a.type === 'bonus' ? 1 : -1) * Number(a.amount), 0);

  const [ps, pe] = currentPeriod(kid);
  const inPeriod = dt => dt >= ps && dt <= pe;
  const periodEarn = comps.filter(c => inPeriod(c.completed_date)).reduce((s, c) => s + Number(c.amount), 0)
    + adjs.filter(a => inPeriod(a.adjustment_date)).reduce((s, a) => s + (a.type === 'bonus' ? 1 : -1) * Number(a.amount), 0);

  // most completed this week
  const top = {};
  comps.filter(c => inWeek(c.completed_date)).forEach(c => { top[c.chore_name] = (top[c.chore_name] || 0) + 1; });
  const topList = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // missed: due on past days this week (strictly before today), not completed
  const missed = {};
  const mine = kidChores(store.chores, kid.id);
  for (let d = fromYMD(ws); toYMD(d) < today && toYMD(d) <= we; d = addDays(d, 1)) {
    const ymd = toYMD(d);
    mine.forEach(c => {
      if (c.frequency === 'x_per_week' || c.frequency === 'one_off') return;
      if (!isDueOn(c, d)) return;
      const done = comps.some(x => x.chore_id === c.id && x.completed_date === ymd);
      if (!done) missed[c.name] = (missed[c.name] || 0) + 1;
    });
  }
  // x_per_week shortfall (whole week)
  mine.filter(c => c.frequency === 'x_per_week').forEach(c => {
    const n = completedThisWeek(store.completions, kid.id, c.id);
    if (today > we && n < c.times_per_week) missed[c.name] = (missed[c.name] || 0) + (c.times_per_week - n);
  });
  const missList = Object.entries(missed).sort((a, b) => b[1] - a[1]);

  // day-by-day this week
  const days = [];
  for (let d = fromYMD(ws); toYMD(d) <= today && toYMD(d) <= we; d = addDays(d, 1)) {
    const ymd = toYMD(d);
    const items = comps.filter(c => c.completed_date === ymd).map(c => ({ t: 'c', name: c.chore_name, amt: Number(c.amount) }))
      .concat(adjs.filter(a => a.adjustment_date === ymd).map(a => ({ t: a.type, name: a.note || a.type, amt: Number(a.amount) })));
    if (items.length) days.push({ ymd, items });
  }

  return html`<div class="card" style=${{ '--pk': kid.color }}>
    <div class="kid-report-head"><div class="kid-dot">${kid.emoji}</div><div class="nm">${kid.name}</div></div>
    <div class="stat-row">
      <div class="stat"><div class="k">This week</div><div class="v">${money(weekEarn)}</div></div>
      <div class="stat"><div class="k">This period (${kid.payout_period})</div><div class="v">${money(periodEarn)}</div></div>
    </div>

    <div class="subhead">Most completed</div>
    ${topList.length ? topList.map(([n, c]) => html`<div class="list-line"><span>${n}</span><span class="r">×${c}</span></div>`)
      : html`<div class="list-line"><span style="color:var(--faint)">Nothing yet this week</span></div>`}

    <div class="subhead">Missed (due, not ticked)</div>
    ${missList.length ? missList.map(([n, c]) => html`<div class="list-line"><span class="miss">${n}</span><span class="r miss">×${c}</span></div>`)
      : html`<div class="list-line"><span style="color:var(--good)">None missed 🎉</span></div>`}

    <div class="subhead">Day-by-day</div>
    ${days.length ? days.slice().reverse().map(day => html`<div class="day-block">
      <div class="d">${prettyDate(day.ymd)}</div>
      ${day.items.map(it => html`<div class=${'day-item' + (it.t === 'bonus' ? ' adj-bonus' : it.t === 'deduction' ? ' adj-deduction' : '')}>
        <span>${it.t === 'c' ? '✓ ' : it.t === 'bonus' ? '➕ ' : '➖ '}${it.name}</span>
        <span>${it.t === 'deduction' ? '−' : ''}${money(it.amt)}</span></div>`)}
    </div>`) : html`<div class="list-line"><span style="color:var(--faint)">No activity yet</span></div>`}
  </div>`;
}

/* ============================ History tab ============================ */
function HistoryTab({ store }) {
  const [openId, setOpenId] = useState(null);
  const [filter, setFilter] = useState('all');
  const kidsById = Object.fromEntries(store.kids.map(k => [k.id, k]));
  const payouts = store.payouts.filter(p => filter === 'all' || p.kid_id === filter);
  return html`<div class="screen">
    <div class="sec-head"><span>Payout history</span><span class="line"></span></div>
    <div class="seg" style="margin-bottom:14px">
      <button aria-pressed=${filter === 'all'} onClick=${() => setFilter('all')}>All</button>
      ${store.kids.map(k => html`<button style=${{ '--accent': k.color }} aria-pressed=${filter === k.id} onClick=${() => setFilter(k.id)}>${k.emoji} ${k.name}</button>`)}
    </div>
    ${payouts.length === 0 ? html`<div class="empty"><span class="em">🧾</span>No payouts yet. Tap <b>Pay</b> on the Chores tab when it's payday.</div>`
      : payouts.map(p => {
        const kid = kidsById[p.kid_id] || {};
        const items = store.payoutItems.filter(i => i.payout_id === p.id);
        const open = openId === p.id;
        return html`<div class=${'payout' + (open ? ' open' : '')} style=${{ '--pk': kid.color }} key=${p.id}>
          <div class="payout-head" onClick=${() => setOpenId(open ? null : p.id)}>
            <div class="kid-dot">${kid.emoji || '🧒'}</div>
            <div><div style="font-weight:600">${kid.name || 'Kid'}</div>
              <div class="when">${shortDate(p.period_start)}–${shortDate(p.period_end)} · ${new Date(p.paid_at).toLocaleDateString()}</div></div>
            <div class="amt">${money(p.total_amount)}</div>
            <div class="chevron">›</div>
          </div>
          ${open ? html`<div class="payout-body">
            ${items.filter(i => i.item_type === 'chore').map(i => html`<div class="pi">
              <div class="lbl"><div>${i.chore_name} <span style="color:var(--faint)">×${i.times}</span></div>
                <div class="dates">${(i.dates || []).map(shortDate).join(', ')}</div></div>
              <div class="val">${money(i.subtotal)}</div></div>`)}
            ${items.filter(i => i.item_type === 'bonus').map(i => html`<div class="pi bonus"><div class="lbl">➕ ${i.chore_name}</div><div class="val">+${money(i.subtotal)}</div></div>`)}
            ${items.filter(i => i.item_type === 'deduction').map(i => html`<div class="pi deduction"><div class="lbl">➖ ${i.chore_name}</div><div class="val">−${money(i.subtotal)}</div></div>`)}
            <div class="pi" style="border-top:1px solid var(--card-border);margin-top:6px;padding-top:10px;font-weight:700">
              <div class="lbl">Total paid</div><div class="val">${money(p.total_amount)}</div></div>
          </div>` : ''}
        </div>`;
      })}
  </div>`;
}

/* ============================ Settings tab ============================ */
function SettingsTab({ store, reload, toast, openSheet, onLock }) {
  return html`<div class="screen">
    <div class="sec-head"><span>Kids</span><span class="line"></span></div>
    ${store.kids.map(k => html`<div class="set-row" style=${{ '--pk': k.color }} onClick=${() => openSheet({ type: 'kid', kid: k })} key=${k.id}>
      <div class="ic">${k.emoji}</div>
      <div class="t"><div style="font-weight:600">${k.name}</div>
        <div class="s">${k.payout_period} · streak ${k.streak_days}d → ${money(k.streak_bonus)}</div></div>
      <div class="go">›</div></div>`)}

    <div class="sec-head"><span>Chores</span><span class="line"></span>
      <button class="chip" style="cursor:pointer" onClick=${() => openSheet({ type: 'chore', chore: null })}>+ Add</button></div>
    ${store.chores.slice().sort((a, b) => a.sort_order - b.sort_order).map(c => {
      const owner = c.kid_id ? (store.kids.find(k => k.id === c.kid_id)?.name || '') : 'Shared';
      return html`<div class=${'chore-manage' + (c.active ? '' : ' off')} onClick=${() => openSheet({ type: 'chore', chore: c })} key=${c.id}>
        <div class="e">${c.emoji}</div>
        <div class="m"><div class="n">${c.name}</div><div class="s">${money(c.amount)} · ${freqChip(c)} · ${owner}</div></div>
        <div class="go">›</div></div>`;
    })}

    <div class="sec-head"><span>App</span><span class="line"></span></div>
    <div class="set-row" onClick=${() => openSheet({ type: 'pin' })}><div class="ic">🔒</div>
      <div class="t"><div style="font-weight:600">Change PIN</div><div class="s">4-digit lock for the whole app</div></div><div class="go">›</div></div>
    <div class="set-row" onClick=${onLock}><div class="ic">🚪</div>
      <div class="t"><div style="font-weight:600">Lock app now</div><div class="s">Require PIN again</div></div><div class="go">›</div></div>
    <div style="text-align:center;color:var(--faint);font-size:12px;margin-top:20px">Chore Coins V2 · synced live via Supabase</div>
  </div>`;
}

/* ============================ Sheets (modals) ============================ */
function Sheet({ sheet, store, reload, toast, close, onSwitchKid }) {
  if (!sheet) return null;
  const stop = e => e.stopPropagation();
  return html`<div class="scrim" onClick=${close}><div class="sheet" onClick=${stop}>
    <div class="grab"></div>
    ${sheet.type === 'bonus' || sheet.type === 'deduct'
      ? html`<${AdjustSheet} sheet=${sheet} close=${close} reload=${reload} toast=${toast}/>`
      : sheet.type === 'payout' ? html`<${PayoutSheet} sheet=${sheet} store=${store} close=${close} reload=${reload} toast=${toast}/>`
      : sheet.type === 'chore' ? html`<${ChoreSheet} sheet=${sheet} store=${store} close=${close} reload=${reload} toast=${toast}/>`
      : sheet.type === 'kid' ? html`<${KidSheet} sheet=${sheet} close=${close} reload=${reload} toast=${toast}/>`
      : sheet.type === 'pin' ? html`<${PinSheet} store=${store} close=${close} reload=${reload} toast=${toast}/>`
      : null}
  </div></div>`;
}

function AdjustSheet({ sheet, close, reload, toast }) {
  const bonus = sheet.type === 'bonus';
  const [amt, setAmt] = useState('');
  const [note, setNote] = useState('');
  const save = async () => {
    const n = parseFloat(amt);
    if (!n || n <= 0) { toast('Enter an amount'); return; }
    await sb.from('cc_adjustments').insert({
      kid_id: sheet.kid.id, type: bonus ? 'bonus' : 'deduction', amount: n,
      note: note || (bonus ? 'Bonus' : 'Deduction'), adjustment_date: todayYMD()
    });
    toast(`${bonus ? 'Bonus' : 'Deduction'} added for ${sheet.kid.name}`); reload(); close();
  };
  return html`<div style=${{ '--accent': sheet.kid.color }}>
    <h3>${bonus ? '➕ Bonus' : '➖ Deduction'} · ${sheet.kid.name}</h3>
    <div class="field"><label>Amount ($)</label><input class="input" type="number" inputmode="decimal" step="0.5" placeholder="0.00" value=${amt} onInput=${e => setAmt(e.target.value)}/></div>
    <div class="field"><label>${bonus ? 'What for?' : 'Reason'}</label><input class="input" placeholder=${bonus ? 'e.g. helped without asking' : 'e.g. bad behaviour'} value=${note} onInput=${e => setNote(e.target.value)}/></div>
    <div class="actions"><button class="btn btn-ghost" onClick=${close}>Cancel</button>
      <button class=${'btn ' + (bonus ? 'btn-accent' : 'btn-danger')} onClick=${save}>${bonus ? 'Add bonus' : 'Apply deduction'}</button></div>
  </div>`;
}

function PayoutSheet({ sheet, store, close, reload, toast }) {
  const kid = sheet.kid;
  const o = owedFor(store, kid.id);
  const comps = unpaid(forKid(store.completions, kid.id));
  const adjs = unpaid(forKid(store.adjustments, kid.id));
  const groups = {};
  comps.forEach(c => { (groups[c.chore_name] ||= { n: 0, sub: 0 }); groups[c.chore_name].n++; groups[c.chore_name].sub += Number(c.amount); });
  const [busy, setBusy] = useState(false);
  const pay = async () => { setBusy(true); await doPayout(store, kid, toast); reload(); close(); };
  return html`<div style=${{ '--accent': kid.color }}>
    <h3>💰 Pay ${kid.name}</h3>
    <div class="owed-amount" style="margin:0 0 4px"><span class="cur">$</span>${o.total.toFixed(2)}</div>
    <div class="owed-sub" style="margin-bottom:12px">for period up to ${prettyDate(todayYMD())}</div>
    ${Object.entries(groups).map(([n, g]) => html`<div class="pi"><div class="lbl">${n} <span style="color:var(--faint)">×${g.n}</span></div><div class="val">${money(g.sub)}</div></div>`)}
    ${adjs.filter(a => a.type === 'bonus').map(a => html`<div class="pi bonus"><div class="lbl">➕ ${a.note}</div><div class="val">+${money(a.amount)}</div></div>`)}
    ${adjs.filter(a => a.type === 'deduction').map(a => html`<div class="pi deduction"><div class="lbl">➖ ${a.note}</div><div class="val">−${money(a.amount)}</div></div>`)}
    <div class="pi" style="font-weight:700;border-top:1px solid var(--card-border);margin-top:6px;padding-top:10px"><div class="lbl">Total</div><div class="val">${money(o.total)}</div></div>
    <div class="actions"><button class="btn btn-ghost" onClick=${close}>Cancel</button>
      <button class="btn btn-good" disabled=${busy} onClick=${pay}>${busy ? 'Paying…' : `Pay ${money(o.total)} & reset`}</button></div>
  </div>`;
}

function ChoreSheet({ sheet, store, close, reload, toast }) {
  const c = sheet.chore;
  const [f, setF] = useState(c || {
    name: '', emoji: '✅', amount: 0.5, frequency: 'daily', days_of_week: [], times_per_week: 3, kid_id: null, active: true, sort_order: (store.chores.length + 1)
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const toggleDay = d => set('days_of_week', f.days_of_week.includes(d) ? f.days_of_week.filter(x => x !== d) : [...f.days_of_week, d].sort());
  const save = async () => {
    if (!f.name.trim()) { toast('Name required'); return; }
    const payload = {
      name: f.name.trim(), emoji: f.emoji || '✅', amount: parseFloat(f.amount) || 0, frequency: f.frequency,
      days_of_week: (f.frequency === 'specific_days' || f.frequency === 'weekly') ? f.days_of_week : [],
      times_per_week: f.frequency === 'x_per_week' ? (parseInt(f.times_per_week) || 1) : 1,
      kid_id: f.kid_id || null, active: f.active !== false, sort_order: f.sort_order || 0
    };
    if (f.frequency === 'weekly' && payload.days_of_week.length > 1) payload.days_of_week = [payload.days_of_week[0]];
    if (c) await sb.from('cc_chores').update(payload).eq('id', c.id);
    else await sb.from('cc_chores').insert(payload);
    toast(c ? 'Chore updated' : 'Chore added'); reload(); close();
  };
  const del = async () => { if (confirm(`Delete "${c.name}"? Past completions are kept.`)) { await sb.from('cc_chores').delete().eq('id', c.id); toast('Chore deleted'); reload(); close(); } };
  return html`<div>
    <h3>${c ? 'Edit chore' : 'New chore'}</h3>
    <div class="row2">
      <div class="field" style="flex:0 0 76px"><label>Icon</label><input class="input" style="text-align:center" value=${f.emoji} onInput=${e => set('emoji', e.target.value)} maxlength="2"/></div>
      <div class="field"><label>Name</label><input class="input" value=${f.name} placeholder="e.g. Make bed" onInput=${e => set('name', e.target.value)}/></div>
    </div>
    <div class="field"><label>Coins ($)</label><input class="input" type="number" step="0.1" inputmode="decimal" value=${f.amount} onInput=${e => set('amount', e.target.value)}/></div>
    <div class="field"><label>Frequency</label>
      <select class="input" value=${f.frequency} onInput=${e => set('frequency', e.target.value)}>
        <option value="daily">Every day</option><option value="specific_days">Specific days</option>
        <option value="x_per_week">X times a week</option><option value="weekly">Weekly (one set day)</option>
        <option value="one_off">One-off / ad hoc</option></select></div>
    ${(f.frequency === 'specific_days' || f.frequency === 'weekly') ? html`<div class="field"><label>${f.frequency === 'weekly' ? 'Which day' : 'Which days'}</label>
      <div class="days">${DOW.map((d, i) => html`<button class="day-btn" aria-pressed=${f.days_of_week.includes(i + 1)}
        onClick=${() => f.frequency === 'weekly' ? set('days_of_week', [i + 1]) : toggleDay(i + 1)}>${d[0]}</button>`)}</div></div>` : ''}
    ${f.frequency === 'x_per_week' ? html`<div class="field"><label>Times per week</label>
      <input class="input" type="number" min="1" max="14" value=${f.times_per_week} onInput=${e => set('times_per_week', e.target.value)}/></div>` : ''}
    <div class="field"><label>Assigned to</label>
      <div class="seg">
        <button aria-pressed=${!f.kid_id} onClick=${() => set('kid_id', null)}>👥 Shared</button>
        ${store.kids.map(k => html`<button style=${{ '--accent': k.color }} aria-pressed=${f.kid_id === k.id} onClick=${() => set('kid_id', k.id)}>${k.emoji} ${k.name}</button>`)}
      </div></div>
    <div class="field"><label>Active</label>
      <div class="seg"><button aria-pressed=${f.active !== false} onClick=${() => set('active', true)}>On</button>
        <button aria-pressed=${f.active === false} onClick=${() => set('active', false)}>Off</button></div></div>
    <div class="actions">
      ${c ? html`<button class="btn btn-danger" onClick=${del}>Delete</button>` : html`<button class="btn btn-ghost" onClick=${close}>Cancel</button>`}
      <button class="btn btn-accent" onClick=${save}>${c ? 'Save' : 'Add chore'}</button></div>
  </div>`;
}

function KidSheet({ sheet, close, reload, toast }) {
  const k = sheet.kid;
  const [f, setF] = useState({ ...k });
  const set = (key, v) => setF(p => ({ ...p, [key]: v }));
  const save = async () => {
    await sb.from('cc_kids').update({
      name: f.name, emoji: f.emoji, color: f.color, payout_period: f.payout_period,
      payout_start_date: f.payout_start_date, streak_days: parseInt(f.streak_days) || 0,
      streak_bonus: parseFloat(f.streak_bonus) || 0
    }).eq('id', k.id);
    toast('Saved'); reload(); close();
  };
  return html`<div style=${{ '--accent': f.color }}>
    <h3>${f.emoji} ${f.name} · settings</h3>
    <div class="row2">
      <div class="field" style="flex:0 0 76px"><label>Emoji</label><input class="input" style="text-align:center" value=${f.emoji} onInput=${e => set('emoji', e.target.value)} maxlength="2"/></div>
      <div class="field"><label>Name</label><input class="input" value=${f.name} onInput=${e => set('name', e.target.value)}/></div>
    </div>
    <div class="field"><label>Accent colour</label><input class="input" type="color" value=${f.color} onInput=${e => set('color', e.target.value)} style="height:46px;padding:4px"/></div>
    <div class="field"><label>Payout period</label>
      <div class="seg">${['weekly', 'fortnightly', 'monthly'].map(p => html`<button aria-pressed=${f.payout_period === p} onClick=${() => set('payout_period', p)}>${p}</button>`)}</div></div>
    <div class="field"><label>Period start / anchor date</label><input class="input" type="date" value=${f.payout_start_date} onInput=${e => set('payout_start_date', e.target.value)}/></div>
    <div class="row2">
      <div class="field"><label>Streak days</label><input class="input" type="number" min="0" value=${f.streak_days} onInput=${e => set('streak_days', e.target.value)}/></div>
      <div class="field"><label>Streak bonus ($)</label><input class="input" type="number" step="0.5" value=${f.streak_bonus} onInput=${e => set('streak_bonus', e.target.value)}/></div>
    </div>
    <div class="actions"><button class="btn btn-ghost" onClick=${close}>Cancel</button><button class="btn btn-accent" onClick=${save}>Save</button></div>
  </div>`;
}

function PinSheet({ store, close, reload, toast }) {
  const [cur, setCur] = useState(''); const [nw, setNw] = useState(''); const [cf, setCf] = useState('');
  const save = async () => {
    if (cur !== String(store.settings.pin)) { toast('Current PIN is wrong'); return; }
    if (!/^\d{4}$/.test(nw)) { toast('New PIN must be 4 digits'); return; }
    if (nw !== cf) { toast('New PINs don\'t match'); return; }
    await sb.from('cc_settings').update({ pin: nw, updated_at: new Date().toISOString() }).eq('id', 1);
    toast('PIN changed'); reload(); close();
  };
  return html`<div>
    <h3>🔒 Change PIN</h3>
    <div class="field"><label>Current PIN</label><input class="input" type="password" inputmode="numeric" maxlength="4" value=${cur} onInput=${e => setCur(e.target.value)}/></div>
    <div class="field"><label>New PIN</label><input class="input" type="password" inputmode="numeric" maxlength="4" value=${nw} onInput=${e => setNw(e.target.value)}/></div>
    <div class="field"><label>Confirm new PIN</label><input class="input" type="password" inputmode="numeric" maxlength="4" value=${cf} onInput=${e => setCf(e.target.value)}/></div>
    <div class="actions"><button class="btn btn-ghost" onClick=${close}>Cancel</button><button class="btn btn-accent" onClick=${save}>Save PIN</button></div>
  </div>`;
}

/* ============================ root ============================ */
function App() {
  const [store, reload] = useStore();
  const [unlocked, setUnlocked] = useState(sessionStorage.getItem('cc_unlocked') === '1');
  const [tab, setTab] = useState('chores');
  const [activeKid, setActiveKid] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const toastTimer = useRef(null);
  const toast = useCallback(m => { setToastMsg(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToastMsg(null), 2600); }, []);

  useEffect(() => { if (store.kids.length && !activeKid) setActiveKid(store.kids[0].id); }, [store.kids]);
  const unlock = () => { sessionStorage.setItem('cc_unlocked', '1'); setUnlocked(true); };
  const lock = () => { sessionStorage.removeItem('cc_unlocked'); setUnlocked(false); };

  const kid = store.kids.find(k => k.id === activeKid) || store.kids[0];
  const accent = kid?.color || '#6C63FF';

  const openSheet = s => { if (s.type === 'switchKid') { setActiveKid(s.kidId); return; } setSheet(s); };

  if (store.loading) return html`<div class="center-load"><div class="spin"></div></div>`;
  if (!unlocked) return html`<${PinGate} pin=${store.settings?.pin || '1234'} onOk=${unlock}/>`;

  return html`<div style=${{ '--accent': accent }}>
    <div class="topbar">
      <div class="brand"><span class="coin">🪙</span>${store.settings?.app_name || 'Chore Coins'}</div>
      <div class="spacer"></div>
      <button class="lock-btn" onClick=${lock} aria-label="Lock">🔒</button>
    </div>

    ${tab === 'chores' && kid ? html`<${ChoresTab} store=${store} reload=${reload} kid=${kid} toast=${toast} openSheet=${openSheet}/>` : ''}
    ${tab === 'reports' ? html`<${ReportsTab} store=${store}/>` : ''}
    ${tab === 'history' ? html`<${HistoryTab} store=${store}/>` : ''}
    ${tab === 'settings' ? html`<${SettingsTab} store=${store} reload=${reload} toast=${toast} openSheet=${openSheet} onLock=${lock}/>` : ''}

    <nav class="nav">
      ${[['chores', '🪙', 'Chores'], ['reports', '📊', 'Reports'], ['history', '🧾', 'History'], ['settings', '⚙️', 'Settings']]
      .map(([t, ic, lb]) => html`<button aria-current=${tab === t} onClick=${() => setTab(t)}><span class="ni">${ic}</span>${lb}</button>`)}
    </nav>

    <${Sheet} sheet=${sheet} store=${store} reload=${reload} toast=${toast} close=${() => setSheet(null)}/>
    ${toastMsg ? html`<div class="toast">${toastMsg}</div>` : ''}
  </div>`;
}

render(html`<${App}/>`, document.getElementById('app'));

/* register service worker */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
