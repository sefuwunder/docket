// public/app.js — Docket UI (ES module; imports shared agent helpers)
import { fmtDate, addDays, formatTime, formatDay } from '../src/agent.js';

const $ = (s) => document.querySelector(s);
const COLORS = {
  blue: '#0A84FF', green: '#30D158', orange: '#FF9F0A',
  purple: '#BF5AF2', red: '#FF453A', gray: '#8E8E93',
};

const state = {
  tab: 'calendar', seg: 'month',
  selectedDate: fmtDate(new Date()),
  monthCursor: fmtDate(new Date()).slice(0, 7), // YYYY-MM
  events: [],          // expanded occurrences for the loaded range
  editingId: null,      // stored event id being edited (null = new)
  pendingSlot: null,    // {start,end} awaiting a title from chat
};

// ---------- api ----------
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body.error || 'request failed');
    e.status = r.status; e.body = body;
    throw e;
  }
  return body;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

async function refreshEvents() {
  // load a generous window around the cursor
  const from = addDays(state.monthCursor + '-01', -7);
  const to = addDays(state.monthCursor + '-01', 75);
  state.events = await api(`/api/events?from=${from}&to=${to}&external=1`);
  render();
}

// ---------- tabs & segmented ----------
function setTab(tab) {
  state.tab = tab;
  $('#view-calendar').classList.toggle('hidden', tab !== 'calendar');
  $('#view-agent').classList.toggle('hidden', tab !== 'agent');
  $('#tab-calendar').classList.toggle('active', tab === 'calendar');
  $('#tab-agent').classList.toggle('active', tab === 'agent');
}
function setSeg(seg) {
  state.seg = seg;
  document.querySelectorAll('.segmented button').forEach((b) =>
    b.classList.toggle('active', b.dataset.seg === seg));
  for (const s of ['month', 'day', 'agenda']) {
    $('#seg-' + s).classList.toggle('hidden', s !== seg);
  }
  render();
}
$('#tab-calendar').onclick = () => setTab('calendar');
$('#tab-agent').onclick = () => setTab('agent');
document.querySelectorAll('.segmented button').forEach((b) => {
  b.onclick = () => setSeg(b.dataset.seg);
});

// ---------- month ----------
function renderMonth() {
  const grid = $('#month-grid');
  grid.innerHTML = '';
  const [y, mo] = state.monthCursor.split('-').map(Number);
  const first = new Date(y, mo - 1, 1);
  const startOffset = first.getDay();
  const daysInMonth = new Date(y, mo, 0).getDate();
  const today = fmtDate(new Date());

  const byDay = {};
  for (const e of state.events) {
    const d = e.start.slice(0, 10);
    (byDay[d] = byDay[d] || []).push(e);
  }

  const total = 42;
  for (let i = 0; i < total; i++) {
    const dayNum = i - startOffset + 1;
    const btn = document.createElement('button');
    btn.className = 'day-cell';
    if (dayNum < 1 || dayNum > daysInMonth) {
      btn.classList.add('dim');
      const edge = new Date(y, mo - 1, dayNum);
      btn.innerHTML = `<span class="dnum">${edge.getDate()}</span>`;
      btn.disabled = true;
    } else {
      const ds = `${state.monthCursor}-${String(dayNum).padStart(2, '0')}`;
      const evs = (byDay[ds] || []).slice(0, 3);
      btn.innerHTML = `<span class="dnum">${dayNum}</span><span class="dots">${
        evs.map((e) => e.external
          ? `<i class="ext"></i>`
          : `<i style="background:${COLORS[e.color] || COLORS.blue}"></i>`).join('')
      }</span>`;
      if (ds === today) btn.classList.add('today');
      if (ds === state.selectedDate) btn.classList.add('selected');
      btn.onclick = () => {
        state.selectedDate = ds;
        setSeg('day');
      };
    }
    grid.appendChild(btn);
  }
  const d = new Date(y, mo - 1, 1);
  $('#cal-title').textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  $('#cal-sub').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// ---------- day timeline ----------
const HOUR_H = 56;
function renderDay() {
  const tl = $('#timeline');
  tl.innerHTML = '';
  const ds = state.selectedDate;
  const d = new Date(ds + 'T12:00');
  $('#cal-title').textContent = d.toLocaleDateString('en-US', { weekday: 'long' });
  $('#cal-sub').textContent = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  for (let h = 0; h < 24; h++) {
    const row = document.createElement('div');
    row.className = 'hour-row';
    const ap = h >= 12 ? 'PM' : 'AM';
    const hh = h % 12 === 0 ? 12 : h % 12;
    row.innerHTML = `<span class="hlabel">${hh} ${ap}</span>`;
    row.onclick = () => openSheet({ start: `${ds}T${String(h).padStart(2, '0')}:00`, end: `${ds}T${String(h + 1).padStart(2, '0')}:00` });
    tl.appendChild(row);
  }

  const dayEvs = state.events.filter((e) => e.start.slice(0, 10) === ds);
  for (const e of dayEvs) {
    const [sh, sm] = e.start.slice(11, 16).split(':').map(Number);
    const [eh, em] = e.end.slice(11, 16).split(':').map(Number);
    const top = (sh + sm / 60) * HOUR_H;
    const height = Math.max(24, (eh + em / 60 - (sh + sm / 60)) * HOUR_H - 3);
    const b = document.createElement('button');
    b.className = 'event-block' + (e.external ? ' ext' : '');
    b.style.top = top + 'px';
    b.style.height = height + 'px';
    if (!e.external) b.style.background = COLORS[e.color] || COLORS.blue;
    b.innerHTML = `<span class="et">${escapeHtml(e.title)}</span><span class="eh">${formatTime(e.start)} – ${formatTime(e.end)}${e.external ? ' · ' + escapeHtml(e.source || '') : ''}</span>`;
    b.onclick = (ev) => { ev.stopPropagation(); e.external ? openInfoSheet(e) : openSheet(e); };
    tl.appendChild(b);
  }

  // now line
  const now = new Date();
  if (fmtDate(now) === ds) {
    const line = document.createElement('div');
    line.className = 'now-line';
    line.style.top = ((now.getHours() + now.getMinutes() / 60) * HOUR_H) + 'px';
    tl.appendChild(line);
    setTimeout(() => tl.scrollTop = Math.max(0, (now.getHours() - 2) * HOUR_H), 50);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- agenda (swipe to delete) ----------
function renderAgenda() {
  const el = $('#agenda');
  el.innerHTML = '';
  $('#cal-title').textContent = 'Agenda';
  $('#cal-sub').textContent = '';
  const now = new Date();
  const groups = {};
  for (const e of state.events) {
    if (e.end < fmtDate(now) + 'T00:00') continue;
    const d = e.start.slice(0, 10);
    (groups[d] = groups[d] || []).push(e);
  }
  const days = Object.keys(groups).sort().slice(0, 21);
  if (!days.length) {
    el.innerHTML = '<div class="empty">Nothing coming up.<br>Ask the agent to schedule something.</div>';
    return;
  }
  for (const d of days) {
    const sec = document.createElement('div');
    sec.className = 'agenda-day';
    sec.innerHTML = `<h3>${formatDay(d, now)}</h3>`;
    for (const e of groups[d]) {
      sec.appendChild(agendaRow(e));
    }
    el.appendChild(sec);
  }
}

function agendaRow(e) {
  const ext = !!e.external;
  const row = document.createElement('div');
  row.className = 'swipe-row';
  row.innerHTML = `
    <div class="swipe-inner">
      <button class="agenda-item${ext ? ' ext' : ''}">
        <span class="colorbar" style="background:${ext ? 'var(--text-3)' : (COLORS[e.color] || COLORS.blue)}"></span>
        <span class="at">${formatTime(e.start)} – ${formatTime(e.end)}</span>
        <span class="ti">${escapeHtml(e.title)}</span>
        ${ext ? `<span class="src-tag">${escapeHtml(e.source || 'external')}</span>` : ''}
      </button>
      ${ext ? '' : '<button class="swipe-del">Delete</button>'}
    </div>`;
  const inner = row.querySelector('.swipe-inner');
  const del = row.querySelector('.swipe-del');
  const item = row.querySelector('.agenda-item');
  let startX = 0, dx = 0, open = false;

  if (ext) {
    // external events are read-only: info sheet, no swipe-to-delete
    item.addEventListener('click', () => openInfoSheet(e));
    return row;
  }

  inner.addEventListener('touchstart', (t) => {
    startX = t.touches[0].clientX; dx = 0;
  }, { passive: true });
  inner.addEventListener('touchmove', (t) => {
    dx = t.touches[0].clientX - startX;
    const x = open ? Math.min(0, Math.max(-84, dx)) : Math.min(0, Math.max(-84, dx));
    inner.style.transform = `translateX(${x}px)`;
  }, { passive: true });
  inner.addEventListener('touchend', () => {
    open = dx < -40;
    inner.style.transform = open ? 'translateX(-84px)' : 'translateX(0)';
  });
  // mouse fallback for desktop testing
  item.addEventListener('click', () => {
    if (!open) openSheet(e);
    else { open = false; inner.style.transform = 'translateX(0)'; }
  });
  del.addEventListener('click', async () => {
    if (!del.classList.contains('confirm')) {
      del.classList.add('confirm');
      del.textContent = 'Confirm?';
      setTimeout(() => { del.classList.remove('confirm'); del.textContent = 'Delete'; }, 3000);
      return;
    }
    try {
      await api(`/api/events/${e.occurrenceOf}`, { method: 'DELETE' });
      toast('Deleted');
      await refreshEvents();
    } catch (err) { toast('Delete failed'); }
  });
  return row;
}

function render() {
  if (state.tab !== 'calendar') return;
  if (state.seg === 'month') renderMonth();
  else if (state.seg === 'day') renderDay();
  else renderAgenda();
}

// ---------- event sheet ----------
function fillColors(sel) {
  const w = $('#f-colors');
  w.innerHTML = '';
  for (const [name, hex] of Object.entries(COLORS)) {
    const b = document.createElement('button');
    b.style.background = hex;
    b.classList.toggle('sel', name === sel);
    b.onclick = () => { w.dataset.color = name; fillColors(name); hideTagSuggest(); };
    w.appendChild(b);
  }
  w.dataset.color = sel;
}

/** ev may be a stored event, an occurrence, or a {start,end} draft */
function openSheet(ev = {}) {
  if (ev && ev.external) return openInfoSheet(ev);
  state.editingId = ev.occurrenceOf ?? ev.id ?? null;
  $('#sheet-title').textContent = state.editingId ? 'Edit Event' : 'New Event';
  $('#f-title').value = ev.title || '';
  $('#f-start').value = ev.start || '';
  $('#f-end').value = ev.end || '';
  $('#f-location').value = ev.location || '';
  $('#f-notes').value = ev.notes || '';
  $('#f-rrule').value = ev.rrule || '';
  fillColors(ev.color || 'blue');
  const del = $('#sheet-delete');
  del.style.display = state.editingId ? '' : 'none';
  del.classList.remove('confirm');
  del.textContent = 'Delete Event';
  $('#scrim').classList.add('show');
  $('#sheet').classList.add('show');
  setTimeout(() => $('#f-title').focus(), 300);
  hideTagSuggest();
  maybeSuggestTag();
}
function closeSheet() {
  $('#scrim').classList.remove('show');
  $('#sheet').classList.remove('show');
  hideTagSuggest();
}

// ---------- tag suggestion (advisory; an explicit color choice always wins) ----------
let tagSuggestTimer = null;
function hideTagSuggest() {
  const el = $('#tag-suggest');
  if (!el) return;
  el.innerHTML = '';
  el.style.display = 'none';
}
function maybeSuggestTag() {
  clearTimeout(tagSuggestTimer);
  tagSuggestTimer = setTimeout(async () => {
    const title = $('#f-title').value.trim();
    const start = $('#f-start').value, end = $('#f-end').value;
    hideTagSuggest();
    if (title.length < 3 || !start || !end) return;
    try {
      const r = await api(`/api/model/predict?title=${encodeURIComponent(title)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
      const s = (r.suggestions || [])[0];
      const cur = $('#f-colors').dataset.color || 'blue';
      if (!s || s.class === cur) return;
      const el = $('#tag-suggest');
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = `Tag ${s.class} (${Math.round(s.prob * 100)}%)?`;
      b.onclick = () => { fillColors(s.class); hideTagSuggest(); };
      el.appendChild(b);
      el.style.display = '';
    } catch { /* advisory only — never break the sheet */ }
  }, 400);
}
for (const id of ['f-title', 'f-start', 'f-end']) {
  $('#' + id).addEventListener('input', maybeSuggestTag);
}
/** Read-only info sheet for external events — never the edit sheet. */
function openInfoSheet(ev) {
  $('#info-title').textContent = ev.title || 'Busy';
  const d = new Date(ev.start.slice(0, 10) + 'T12:00');
  $('#info-when').textContent =
    d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) +
    ' · ' + formatTime(ev.start) + ' – ' + formatTime(ev.end);
  $('#info-src').textContent = ev.source || 'External calendar';
  $('#scrim').classList.add('show');
  $('#infosheet').classList.add('show');
}
function closeInfoSheet() {
  $('#scrim').classList.remove('show');
  $('#infosheet').classList.remove('show');
}
$('#scrim').onclick = () => { closeSheet(); closeInfoSheet(); };
$('#infosheet-close').onclick = closeInfoSheet;
$('#sheet-cancel').onclick = closeSheet;

$('#sheet-save').onclick = async () => {
  if (state.editingId && String(state.editingId).startsWith('ext:')) {
    toast('External events are read-only');
    return;
  }
  const body = {
    title: $('#f-title').value.trim(),
    start: $('#f-start').value,
    end: $('#f-end').value,
    location: $('#f-location').value.trim(),
    notes: $('#f-notes').value.trim(),
    color: $('#f-colors').dataset.color || 'blue',
    rrule: $('#f-rrule').value || null,
  };
  try {
    if (state.editingId) {
      await api(`/api/events/${state.editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      toast('Saved');
    } else {
      await api('/api/events', { method: 'POST', body: JSON.stringify(body) });
      toast('Event created');
    }
    closeSheet();
    await refreshEvents();
  } catch (e) {
    if (e.status === 409 && e.body.conflicts) {
      const names = e.body.conflicts.map((c) => `'${c.title}'`).join(', ');
      toast(`Conflicts with ${names}`);
    } else {
      toast(e.body.error || 'Save failed');
    }
  }
};

$('#sheet-delete').onclick = async function () {
  if (state.editingId && String(state.editingId).startsWith('ext:')) {
    toast('External events are read-only');
    return;
  }
  if (!this.classList.contains('confirm')) {
    this.classList.add('confirm');
    this.textContent = 'Tap again to confirm delete';
    return;
  }
  try {
    await api(`/api/events/${state.editingId}`, { method: 'DELETE' });
    toast('Deleted');
    closeSheet();
    await refreshEvents();
  } catch (e) { toast('Delete failed'); }
};

// ---------- agent chat ----------
const chatInput = $('#chat-input');
const sendBtn = $('#chat-send');

function addMsg(text, who) {
  const m = document.createElement('div');
  m.className = 'msg ' + who;
  m.textContent = text;
  $('#messages').appendChild(m);
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
  return m;
}

function showChips(chips) {
  const w = $('#chips');
  w.innerHTML = '';
  if (!chips || !chips.length) { w.style.display = 'none'; return; }
  w.style.display = 'flex';
  for (const c of chips) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = c.label;
    b.onclick = () => handleChip(c);
    w.appendChild(b);
  }
}

async function handleChip(chip) {
  const a = chip.action;
  showChips([]);
  if (a.type === 'send') {
    return sendChat(a.message);
  }
  if (a.type === 'create') {
    try {
      await api('/api/events', { method: 'POST', body: JSON.stringify(a.event) });
      addMsg(`Booked '${a.event.title}' ${formatTime(a.event.start)}.`, 'agent');
      toast('Event created');
      await refreshEvents();
    } catch (e) { addMsg(e.body?.error || 'Booking failed.', 'agent'); }
    return;
  }
  if (a.type === 'confirm' || a.type === 'pickmove') {
    const body = a.type === 'confirm' ? { confirmId: a.confirmId } : { pickmove: a };
    const r = await api('/api/agent', { method: 'POST', body: JSON.stringify(body) });
    return agentReply(r);
  }
  if (a.type === 'applytag') {
    const r = await api('/api/agent', { method: 'POST', body: JSON.stringify({ applytag: a }) });
    return agentReply(r);
  }
  if (a.type === 'book') {
    state.pendingSlot = { start: a.start, end: a.end };
    addMsg(`What should I call the ${formatTime(a.start)} slot?`, 'agent');
    chatInput.focus();
    return;
  }
}

function slotLabelForParse(slot) {
  // "October 20 at 1:00 PM for 30 min" — parseable by the agent
  const d = new Date(slot.start.slice(0, 10) + 'T12:00');
  const label = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const mins = Math.round((new Date(slot.end) - new Date(slot.start)) / 60000);
  return `${label} at ${formatTime(slot.start)} for ${mins} min`;
}

async function sendChat(text) {
  text = (text || '').trim();
  if (!text) return;
  addMsg(text, 'user');
  chatInput.value = '';
  sendBtn.disabled = true;

  // pending title for a tapped free slot
  if (state.pendingSlot) {
    const slot = state.pendingSlot;
    state.pendingSlot = null;
    text = `${text} ${slotLabelForParse(slot)}`;
  }

  const typing = addMsg('…', 'agent');
  typing.classList.add('typing');
  try {
    const r = await api('/api/agent', { method: 'POST', body: JSON.stringify({ message: text }) });
    typing.remove();
    agentReply(r);
  } catch (e) {
    typing.remove();
    addMsg('Something went wrong — try again.', 'agent');
  }
  sendBtn.disabled = false;
}

function agentReply(r) {
  addMsg(r.reply, 'agent');
  showChips(r.chips);
  if (r.refresh) refreshEvents();
}

sendBtn.onclick = () => sendChat(chatInput.value);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat(chatInput.value);
});

function suggestions() {
  const w = $('#suggest');
  const items = ["What's on today?", 'Find 30 min free tomorrow', 'Lunch with Ana tomorrow at noon'];
  for (const s of items) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = s;
    b.onclick = () => sendChat(s);
    w.appendChild(b);
  }
}

// ---------- boot ----------
addMsg("Hi — I'm your scheduling agent. Tell me what to put on the calendar.", 'agent');
suggestions();
refreshEvents();
setInterval(() => { if (state.seg === 'day') renderDay(); }, 60000);

// ---------- settings ----------
async function loadSettings() {
  const s = await api('/api/settings');
  $('#s-ical-status').textContent = s.ical.configured ? 'Configured ✓ (value never leaves the server)' : 'Not configured';
  $('#s-goa-enabled').checked = !!s.goaEnabled;
  const list = $('#s-goa-list');
  list.innerHTML = '';
  if (!s.goa.length) {
    list.innerHTML = '<p class="settings-note">No calendar accounts found on this machine. Add one in GNOME Settings → Online Accounts.</p>';
  } else {
    for (const a of s.goa) {
      const d = document.createElement('div');
      d.className = 'goa-item';
      d.dataset.acc = a.id;
      d.innerHTML = `<span>${escapeHtml(a.identity)}<span class="prov">${escapeHtml(a.provider)}</span></span><span class="settings-note goa-st">not synced yet — tap Sync now</span>`;
      list.appendChild(d);
    }
  }
  $('#s-sync-note').textContent = '';
}
function statusLabel(st) {
  if (st.status === 'synced') return `synced · ${st.count} event${st.count === 1 ? '' : 's'}`;
  if (st.status === 'needs re-auth') return 'needs re-auth — sign in again in GNOME Settings';
  if (st.status === 'unsupported provider') return 'unsupported provider';
  return 'error — will retry on next sync';
}
$('#s-sync').onclick = async () => {
  const btn = $('#s-sync');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const r = await api('/api/sync', { method: 'POST' });
    $('#s-sync-note').textContent = r.note || '';
    for (const st of r.accountStatus) {
      const el = document.querySelector(`#s-goa-list .goa-item[data-acc="${CSS.escape(st.id)}"] .goa-st`);
      if (el) {
        el.textContent = statusLabel(st);
        el.classList.toggle('warn', st.status !== 'synced');
      }
    }
    if (!r.accountStatus.length) {
      $('#s-goa-list').innerHTML = `<p class="settings-note">${escapeHtml(r.note || 'Nothing synced.')}</p>`;
    } else if (!r.note && r.count > 0) {
      $('#s-sync-note').textContent = `${r.count} external event${r.count === 1 ? '' : 's'} found.`;
    }
    await refreshEvents(); // calendar views pick up the external events
  } catch (e) { $('#s-sync-note').textContent = e.message || 'Sync failed'; }
  btn.disabled = false;
  btn.textContent = 'Sync now';
};
function openSettings() {
  $('#view-settings').classList.remove('hidden');
  loadSettings().catch((e) => toast(e.message || 'settings failed'));
}
function closeSettings() { $('#view-settings').classList.add('hidden'); }
$('#btn-settings').onclick = openSettings;
$('#btn-settings-close').onclick = closeSettings;
$('#s-ical-save').onclick = async () => {
  const v = $('#s-ical').value.trim();
  if (!v) { toast('Paste the iCal URL first'); return; }
  try {
    const s = await api('/api/settings', { method: 'POST', body: JSON.stringify({ icalUrl: v }) });
    $('#s-ical').value = '';
    $('#s-ical-status').textContent = s.ical.configured ? 'Configured ✓' : 'Not configured';
    toast('iCal URL saved');
  } catch (e) { toast(e.message || 'save failed'); }
};
$('#s-ical-clear').onclick = async () => {
  try {
    const s = await api('/api/settings', { method: 'POST', body: JSON.stringify({ icalUrl: '' }) });
    $('#s-ical').value = '';
    $('#s-ical-status').textContent = 'Not configured';
    toast('iCal URL removed');
  } catch (e) { toast(e.message || 'remove failed'); }
};
$('#s-goa-enabled').onchange = async (e) => {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ goaEnabled: e.target.checked }) });
    toast(e.target.checked ? 'GOA calendars on' : 'GOA calendars off');
  } catch (err) { toast(err.message || 'failed'); }
};
