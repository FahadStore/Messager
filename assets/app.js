// مرسال — رسائل خاصة مشفّرة من طرف إلى طرف.
//
// GitHub Pages لا يشغّل خوادم، لذلك تُنقل الرسائل عبر ntfy.sh (خدمة عامة مجانية).
// كل مستخدم يملك زوج مفاتيح ECDH (P-256) يُنشأ في متصفحه، ومعرّفه هو بصمة مفتاحه العام.
// كل رسالة تُشفَّر بمفتاح مشترك (ECDH + HKDF + AES-GCM) لا يعرفه إلا الطرفان،
// فلا يرى ntfy.sh ولا أي أحد آخر سوى نص مشفّر.

const NTFY = 'https://ntfy.sh';
const NS = 'mrsl-v1';
const MAX_TEXT = 1000;
const MAX_BODY = 4000; // ntfy يحوّل الرسائل الأكبر من 4096 بايت إلى مرفقات
const MAX_MSGS = 400;
const RESEND_AFTER = 11 * 3600e3; // ntfy يحتفظ بالرسائل 12 ساعة
const RESEND_MAX_AGE = 7 * 864e5;
const PROFILE_EVERY = 3 * 3600e3;
const AV_COLORS = ['stone', 'sand', 'sage', 'sky', 'lilac', 'rose'];
const COLOR_NAMES = { stone: 'رمادي', sand: 'رملي', sage: 'أخضر', sky: 'سماوي', lilac: 'بنفسجي', rose: 'وردي' };
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const K = { id: 'mrsl.identity', state: 'mrsl.state', settings: 'mrsl.settings' };
const DEFAULTS = {
  theme: 'system',
  fontSize: 'm',
  readReceipts: true,
  notify: false,
  sound: true,
  enterSend: !matchMedia('(pointer: coarse)').matches,
};
const RANK = { failed: 0, sending: 0, sent: 1, delivered: 2, read: 3 };
const ERR = {
  too_long: 'الرسالة طويلة جدًا.',
  rate: 'أرسلت كثيرًا بسرعة، انتظر قليلًا ثم حاول.',
  network: 'تعذّر الاتصال. تحقق من الإنترنت.',
};
const LOC = 'ar-u-nu-latn';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const te = new TextEncoder();
const td = new TextDecoder();
const input = $('#input');

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let me = store.get(K.id, null);
let state = normalizeState(store.get(K.state, null));
let settings = { ...DEFAULTS, ...store.get(K.settings, {}) };
let privKey = null;
let es = null;
let activeId = null;
let suspended = false;
let wiped = false;
const drafts = {};
const keyCache = new Map();
const pendingReceipts = new Map();

function normalizeState(s) {
  if (!s || s.v !== 1) s = { v: 1, contacts: {}, seen: {}, profileAt: 0 };
  s.contacts ||= {};
  s.seen ||= {};
  for (const c of Object.values(s.contacts)) {
    c.msgs ||= [];
    for (const m of c.msgs) if (m.me && m.status === 'sending') m.status = 'failed';
  }
  return s;
}

// ---------- أدوات ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const b64e = (u8) => {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64d = (str) => {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
function base32(u8) {
  let bits = 0, val = 0, out = '';
  for (const b of u8) {
    val = ((val << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out;
}
const rid = () => b64e(crypto.getRandomValues(new Uint8Array(8)));
const formatId = (id) => `${id.slice(0, 5)}-${id.slice(5)}`;
const normalizeId = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
const validId = (id) => /^[0-9A-HJKMNP-TV-Z]{10}$/.test(id);
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);
const initial = (name) => ([...String(name || '').trim()][0] || '؟').toUpperCase();
const displayName = (c) => c.name || `مستخدم ${c.id.slice(0, 5)}`;
const isMobile = () => matchMedia('(max-width: 760px)').matches;
const avatar = (name, color, cls = '') => `<div class="av av-${AV_COLORS.includes(color) ? color : 'stone'} ${cls}">${esc(initial(name))}</div>`;

function linkify(text) {
  return esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]!?،]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`);
}

const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const daysAgo = (t) => Math.round((startOfDay(Date.now()) - startOfDay(t)) / 864e5);
const fmtTime = (t) => new Date(t).toLocaleTimeString(LOC, { hour: 'numeric', minute: '2-digit' });
function dayLabel(t) {
  const n = daysAgo(t);
  if (n === 0) return 'اليوم';
  if (n === 1) return 'أمس';
  if (n < 7) return new Date(t).toLocaleDateString(LOC, { weekday: 'long' });
  const sameYear = new Date(t).getFullYear() === new Date().getFullYear();
  return new Date(t).toLocaleDateString(LOC, { day: 'numeric', month: 'long', year: sameYear ? undefined : 'numeric' });
}
function listTime(t) {
  const n = daysAgo(t);
  if (n === 0) return fmtTime(t);
  if (n === 1) return 'أمس';
  if (n < 7) return new Date(t).toLocaleDateString(LOC, { weekday: 'short' });
  return new Date(t).toLocaleDateString(LOC, { day: 'numeric', month: 'numeric', year: '2-digit' });
}

// ---------- التشفير ----------
async function idFromPub(raw) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return base32(h).slice(0, 10);
}

async function createIdentity(name, color) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { id: await idFromPub(pubRaw), name, color, pub: b64e(pubRaw), priv, created: Date.now() };
}

async function loadPriv() {
  privKey = await crypto.subtle.importKey('jwk', me.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

function convKey(peerId, peerPub) {
  const cacheKey = `${peerId}:${peerPub}`;
  if (!keyCache.has(cacheKey)) {
    keyCache.set(cacheKey, (async () => {
      const pub = await crypto.subtle.importKey('raw', b64d(peerPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, privKey, 256);
      const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
      const salt = te.encode([me.id, peerId].sort().join('|'));
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('mrsl-v1-dm') },
        hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
      );
    })());
  }
  return keyCache.get(cacheKey);
}

function exportBackup() {
  const { id, name, color, pub, priv } = me;
  return 'MRSL1.' + b64e(te.encode(JSON.stringify({ id, name, color, pub, priv })));
}

async function parseBackup(str) {
  const s = String(str || '').trim();
  if (!s.startsWith('MRSL1.')) throw new Error('bad');
  const d = JSON.parse(td.decode(b64d(s.slice(6))));
  if (!validId(d.id) || typeof d.pub !== 'string' || !d.priv) throw new Error('bad');
  if (await idFromPub(b64d(d.pub)) !== d.id) throw new Error('bad');
  await crypto.subtle.importKey('jwk', d.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { id: d.id, name: cleanName(d.name) || 'أنا', color: AV_COLORS.includes(d.color) ? d.color : 'stone', pub: d.pub, priv: d.priv, created: Date.now() };
}

// ---------- الشبكة ----------
const inboxTopic = (id) => `${NS}-in-${id.toLowerCase()}`;
const profileTopic = (id) => `${NS}-p-${id.toLowerCase()}`;

async function publish(topic, body) {
  if (body.length > MAX_BODY) throw new Error('too_long');
  let res;
  try { res = await fetch(`${NTFY}/${topic}`, { method: 'POST', body }); } catch { throw new Error('network'); }
  if (res.status === 429) throw new Error('rate');
  if (!res.ok) throw new Error('network');
}

async function sendEnvelope(c, inner) {
  const key = await convKey(c.id, c.pub);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(`${me.id}>${c.id}`) },
    key, te.encode(JSON.stringify(inner)),
  ));
  await publish(inboxTopic(c.id), JSON.stringify({ v: 1, f: me.id, k: me.pub, iv: b64e(iv), ct: b64e(ct) }));
}

async function publishProfile(force = false) {
  if (!me || suspended) return;
  if (!force && Date.now() - (state.profileAt || 0) < PROFILE_EVERY) return;
  try {
    await publish(profileTopic(me.id), JSON.stringify({ v: 1, id: me.id, k: me.pub, n: me.name, c: me.color }));
    state.profileAt = Date.now();
    save();
  } catch {}
}

async function lookupProfile(id) {
  let res;
  try { res = await fetch(`${NTFY}/${profileTopic(id)}/json?poll=1&since=all`); } catch { throw new Error('network'); }
  if (!res.ok) throw new Error('network');
  const lines = (await res.text()).trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.event !== 'message') continue;
      const p = JSON.parse(ev.message);
      if (p.v !== 1 || p.id !== id || typeof p.k !== 'string') continue;
      if (await idFromPub(b64d(p.k)) !== id) continue;
      return { id, pub: p.k, name: cleanName(p.n), color: AV_COLORS.includes(p.c) ? p.c : 'stone' };
    } catch {}
  }
  return null;
}

let queue = Promise.resolve();
let connTimer = null;
function subscribe() {
  if (!me || suspended) return;
  es?.close();
  const src = new EventSource(`${NTFY}/${inboxTopic(me.id)}/sse?since=12h`);
  es = src;
  src.onopen = () => setConn(true);
  src.onerror = () => {
    if (src !== es) return;
    setConn(false);
    if (src.readyState === EventSource.CLOSED) setTimeout(() => { if (src === es) subscribe(); }, 5000);
  };
  src.onmessage = (e) => { queue = queue.then(() => handleEvent(e.data)).catch(() => {}); };
}

function setConn(ok) {
  clearTimeout(connTimer);
  if (ok) $('#conn').hidden = true;
  else connTimer = setTimeout(() => { $('#conn').hidden = false; }, 1500);
}

async function handleEvent(raw) {
  let ev;
  try { ev = JSON.parse(raw); } catch { return; }
  if (ev.event !== 'message' || typeof ev.id !== 'string' || state.seen[ev.id]) return;
  state.seen[ev.id] = ev.time || Math.floor(Date.now() / 1000);
  save();
  let env;
  try { env = JSON.parse(ev.message); } catch { return; }
  if (!env || env.v !== 1 || !validId(env.f) || env.f === me.id || typeof env.k !== 'string') return;
  let inner;
  try {
    if (await idFromPub(b64d(env.k)) !== env.f) return;
    const key = await convKey(env.f, env.k);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64d(env.iv), additionalData: te.encode(`${env.f}>${me.id}`) },
      key, b64d(env.ct),
    );
    inner = JSON.parse(td.decode(pt));
  } catch { return; }
  onInner(env.f, env.k, inner, (ev.time || Date.now() / 1000) * 1000);
}

function onInner(fromId, pub, inner, evTime) {
  if (!inner || (inner.t !== 'm' && inner.t !== 'r')) return;
  let c = state.contacts[fromId];
  if (c?.blocked) return;
  if (!c) {
    if (inner.t !== 'm') return;
    c = state.contacts[fromId] = newContact({ id: fromId, pub });
  }
  const n = cleanName(inner.n);
  if (n) c.name = n;
  if (AV_COLORS.includes(inner.c)) c.color = inner.c;

  if (inner.t === 'r') {
    applyReceipt(c, inner);
  } else {
    const id = typeof inner.id === 'string' ? inner.id.slice(0, 32) : '';
    const text = typeof inner.x === 'string' ? inner.x.slice(0, MAX_TEXT) : '';
    if (!id || !text.trim()) return;
    const dup = c.msgs.find((m) => !m.me && m.id === id);
    if (dup) {
      // المرسل أعاد الإرسال لأنه لم يستلم إشعار الوصول
      queueReceipt(c, dup.read ? 'r' : 'd', id);
      return;
    }
    let ts = Number(inner.s);
    if (!Number.isFinite(ts) || ts > evTime + 5 * 60e3 || ts < evTime - RESEND_MAX_AGE - 864e5) ts = evTime;
    const m = { id, me: false, text, ts };
    insertMsg(c, m);
    const fresh = Date.now() - evTime < 5 * 60e3;
    if (activeId === c.id && !document.hidden) {
      m.read = true;
      queueReceipt(c, 'r', id);
      if (fresh) ping();
    } else {
      c.unread = (c.unread || 0) + 1;
      queueReceipt(c, 'd', id);
      if (fresh) alertIncoming(c, m);
    }
    if (activeId === c.id) appendMessage(c, m);
  }
  save();
  renderList();
  updateTitle();
  if (activeId === c.id) renderConvHead(c);
}

function applyReceipt(c, inner) {
  const upd = (ids, st) => {
    if (!Array.isArray(ids)) return;
    for (const id of ids.slice(0, 200)) {
      const m = c.msgs.find((x) => x.me && x.id === id);
      if (m && RANK[st] > (RANK[m.status] ?? 0)) { m.status = st; refreshMsg(c, m); }
    }
  };
  upd(inner.d, 'delivered');
  upd(inner.r, 'read');
}

function queueReceipt(c, kind, id) {
  if (kind === 'r' && !settings.readReceipts) kind = 'd';
  const p = pendingReceipts.get(c.id) || { d: new Set(), r: new Set(), timer: 0 };
  p[kind].add(id);
  if (kind === 'r') p.d.delete(id);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => flushReceipts(c.id), 1200);
  pendingReceipts.set(c.id, p);
}

async function flushReceipts(peerId) {
  const p = pendingReceipts.get(peerId);
  pendingReceipts.delete(peerId);
  const c = state.contacts[peerId];
  if (!p || !c || c.blocked || suspended) return;
  const d = [...p.d].slice(-100), r = [...p.r].slice(-100);
  if (!d.length && !r.length) return;
  try { await sendEnvelope(c, { t: 'r', d, r, n: me.name, c: me.color }); } catch {}
}

// ---------- الرسائل ----------
function newContact({ id, pub, name = '', color = 'stone' }) {
  return { id, pub, name, color, msgs: [], unread: 0, updated: Date.now(), blocked: false };
}

function insertMsg(c, m) {
  let i = c.msgs.length;
  while (i > 0 && c.msgs[i - 1].ts > m.ts) i--;
  c.msgs.splice(i, 0, m);
  if (c.msgs.length > MAX_MSGS) c.msgs.splice(0, c.msgs.length - MAX_MSGS);
  c.updated = Math.max(c.updated || 0, m.ts);
}

function sendCurrent() {
  const c = state.contacts[activeId];
  if (!c || c.blocked) return;
  const text = input.value.trim();
  if (!text) return;
  if (text.length > MAX_TEXT) return toast(ERR.too_long, 'error');
  input.value = '';
  drafts[activeId] = '';
  autosize();
  const m = { id: rid(), me: true, text, ts: Date.now(), status: 'sending' };
  insertMsg(c, m);
  save();
  appendMessage(c, m);
  renderList();
  deliver(c, m);
}

async function deliver(c, m, { quiet = false } = {}) {
  if (!quiet) { m.status = 'sending'; refreshMsg(c, m); }
  try {
    await sendEnvelope(c, { t: 'm', id: m.id, x: m.text, s: m.ts, n: me.name, c: me.color });
    m.pubAt = Date.now();
    if ((RANK[m.status] ?? 0) < RANK.sent) m.status = 'sent';
  } catch (err) {
    if (!quiet) {
      m.status = 'failed';
      toast(ERR[err.message] || ERR.network, 'error');
    }
  }
  save();
  refreshMsg(c, m);
  renderList();
}

function retry(id) {
  const c = state.contacts[activeId];
  const m = c?.msgs.find((x) => x.me && x.id === id);
  if (m && m.status === 'failed') deliver(c, m);
}

function resendStale() {
  if (suspended) return;
  const now = Date.now();
  let budget = 20;
  for (const c of Object.values(state.contacts)) {
    if (c.blocked) continue;
    for (const m of c.msgs) {
      if (budget <= 0) return;
      if (m.me && m.status === 'sent' && now - (m.pubAt || m.ts) > RESEND_AFTER && now - m.ts < RESEND_MAX_AGE) {
        budget--;
        deliver(c, m, { quiet: true });
      }
    }
  }
}

function markChatRead(c) {
  let changed = false;
  for (const m of c.msgs) {
    if (!m.me && !m.read) {
      m.read = true;
      changed = true;
      if (settings.readReceipts) queueReceipt(c, 'r', m.id);
    }
  }
  if (c.unread) { c.unread = 0; changed = true; }
  if (changed) save();
}

// ---------- الحفظ ----------
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); }
function saveNow() {
  clearTimeout(saveTimer);
  if (suspended || wiped) return;
  const cutoff = Date.now() / 1000 - 13 * 3600;
  for (const k in state.seen) if (state.seen[k] < cutoff) delete state.seen[k];
  if (!store.set(K.state, state)) {
    for (const c of Object.values(state.contacts)) c.msgs = c.msgs.slice(-100);
    store.set(K.state, state);
  }
}
function saveSettings() { store.set(K.settings, settings); applySettings(); syncSettingsUI(); }

// ---------- العرض ----------
function tick(status) {
  switch (status) {
    case 'sending': return '<span class="ms tick" title="جارٍ الإرسال">schedule</span>';
    case 'failed': return '<span class="ms tick failed" title="لم تُرسل">error</span>';
    case 'sent': return '<span class="ms tick" title="أُرسلت">check</span>';
    case 'delivered': return '<span class="ms tick" title="وصلت">done_all</span>';
    case 'read': return '<span class="ms tick read" title="قُرئت">done_all</span>';
    default: return '';
  }
}

function renderList() {
  const box = $('#chatList');
  const all = Object.values(state.contacts);
  if (!all.length) {
    box.innerHTML = `<div class="list-empty">
      <div class="le-icon"><span class="ms">chat</span></div>
      <b>لا توجد محادثات بعد</b>
      <p>أضف صديقًا بمعرّفه، أو شارك معرّفك ليبدأ بمراسلتك.</p>
      <button class="btn btn-primary" data-act="new-chat" type="button"><span class="ms">person_add</span> محادثة جديدة</button>
      <button class="id-card" data-act="copy-id" type="button"><span class="id-label">معرّفك</span><bdi class="id-val">${formatId(me.id)}</bdi><span class="ms">content_copy</span></button>
    </div>`;
    return;
  }
  const q = $('#search').value.trim().toLowerCase();
  const qid = normalizeId(q);
  const list = all
    .filter((c) => !q || displayName(c).toLowerCase().includes(q) || (qid && c.id.includes(qid)))
    .sort((a, b) => b.updated - a.updated);
  if (!list.length) { box.innerHTML = '<div class="list-note">لا توجد نتائج</div>'; return; }
  box.innerHTML = list.map((c) => {
    const last = c.msgs[c.msgs.length - 1];
    const prev = last
      ? (last.me ? tick(last.status) : '') + `<span class="ci-prev-t">${esc(last.text)}</span>`
      : `<span class="ci-prev-t muted">${c.blocked ? 'محظور' : 'ابدأ المحادثة 👋'}</span>`;
    return `<button class="chat-item${c.id === activeId ? ' active' : ''}${c.unread ? ' unread' : ''}" data-id="${esc(c.id)}" type="button">
      ${avatar(displayName(c), c.color)}
      <div class="ci-body">
        <div class="ci-top"><span class="ci-name">${esc(displayName(c))}</span><span class="ci-time">${last ? listTime(last.ts) : ''}</span></div>
        <div class="ci-bottom"><span class="ci-prev">${prev}</span>${c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div>
      </div>
    </button>`;
  }).join('');
}

function msgHtml(m, prev, isNew) {
  let h = '';
  const newDay = !prev || startOfDay(prev.ts) !== startOfDay(m.ts);
  if (newDay) h += `<div class="day"><span>${dayLabel(m.ts)}</span></div>`;
  const cont = !newDay && prev.me === m.me && m.ts - prev.ts < 5 * 60e3;
  const cls = ['msg', m.me ? 'out' : 'in', cont && 'cont', isNew && 'new', m.status === 'failed' && 'failed'].filter(Boolean).join(' ');
  const title = m.status === 'failed' ? ' title="لم تُرسل — اضغط لإعادة المحاولة"' : '';
  return `${h}<div class="${cls}" data-id="${esc(m.id)}"${title}><div class="bubble"><span class="txt">${linkify(m.text)}</span><span class="meta"><time>${fmtTime(m.ts)}</time>${m.me ? tick(m.status) : ''}</span></div></div>`;
}

function renderMessages(c) {
  const box = $('#messages');
  if (!c.msgs.length) {
    box.innerHTML = `<div class="conv-empty">
      ${avatar(displayName(c), c.color, 'av-lg')}
      <b>${esc(displayName(c))}</b>
      <bdi>${formatId(c.id)}</bdi>
      <p>🔒 الرسائل في هذه المحادثة مشفّرة من طرف إلى طرف. قل مرحبًا 👋</p>
    </div>`;
    return;
  }
  box.innerHTML = c.msgs.map((m, i) => msgHtml(m, c.msgs[i - 1], false)).join('');
  box.scrollTop = box.scrollHeight;
}

function appendMessage(c, m) {
  if (c.id !== activeId) return;
  const box = $('#messages');
  const i = c.msgs.indexOf(m);
  if (i !== c.msgs.length - 1 || $('.conv-empty', box)) {
    renderMessages(c);
    return;
  }
  const stick = m.me || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.insertAdjacentHTML('beforeend', msgHtml(m, c.msgs[i - 1], true));
  if (stick) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
}

function refreshMsg(c, m) {
  if (c.id !== activeId) return;
  const el = $(`#messages .msg[data-id="${CSS.escape(m.id)}"]`);
  if (!el) return;
  el.classList.toggle('failed', m.status === 'failed');
  if (m.status === 'failed') el.title = 'لم تُرسل — اضغط لإعادة المحاولة';
  else el.removeAttribute('title');
  const t = $('.tick', el);
  if (t) t.outerHTML = tick(m.status);
}

function renderConvHead(c) {
  $('#convAv').innerHTML = avatar(displayName(c), c.color, 'av-sm');
  $('#convName').textContent = displayName(c);
  $('#convSub').textContent = formatId(c.id);
  $('#blockLabel').textContent = c.blocked ? 'إلغاء الحظر' : 'حظر';
  $('#blockedBar').hidden = !c.blocked;
  $('#composer').hidden = !!c.blocked;
}

function renderMe() {
  if (!me) return;
  $$('[data-my-id]').forEach((el) => { el.textContent = formatId(me.id); });
  if ($('#settingsDrawer').classList.contains('open')) renderSettings();
}

function updateTitle() {
  const total = Object.values(state.contacts).reduce((n, c) => n + (c.blocked ? 0 : c.unread || 0), 0);
  document.title = total ? `(${total}) مرسال` : 'مرسال';
}

// ---------- التنقل ----------
function openChat(id, { push = true } = {}) {
  const c = state.contacts[id];
  if (!c) return;
  if (activeId && activeId !== id) drafts[activeId] = input.value;
  activeId = id;
  closeMenu();
  $('#app').classList.add('chat-open');
  $('#emptyMain').hidden = true;
  $('#conv').hidden = false;
  renderConvHead(c);
  renderMessages(c);
  input.value = drafts[id] || '';
  autosize();
  markChatRead(c);
  renderList();
  updateTitle();
  if (push) {
    if (history.state?.chat) history.replaceState({ chat: id }, '');
    else history.pushState({ chat: id }, '');
  }
  if (!isMobile()) input.focus();
}

function closeChat() {
  if (activeId) drafts[activeId] = input.value;
  activeId = null;
  closeMenu();
  $('#app').classList.remove('chat-open');
  renderList();
  setTimeout(() => {
    if (activeId) return;
    $('#conv').hidden = true;
    $('#emptyMain').hidden = false;
  }, isMobile() ? 360 : 0);
}

function openDrawer(name) {
  closeDrawers();
  $(`#${name}Drawer`).classList.add('open');
  if (name === 'newChat') {
    $('#newId').value = '';
    $('#newResult').innerHTML = '';
    setTimeout(() => $('#newId').focus(), 320);
  }
  if (name === 'settings') renderSettings();
}
function closeDrawers() { $$('.drawer.open').forEach((d) => d.classList.remove('open')); }

function toggleMenu() { $('#convMenu').hidden = !$('#convMenu').hidden; }
function closeMenu() { $('#convMenu').hidden = true; }

async function convAction(act) {
  closeMenu();
  const c = state.contacts[activeId];
  if (!c) return;
  if (act === 'copy') copy(formatId(c.id), 'تم نسخ المعرّف');
  if (act === 'block') toggleBlock(c.id);
  if (act === 'clear') {
    const ok = await confirmDialog({ title: 'مسح الرسائل؟', text: `ستُحذف رسائل المحادثة مع ${displayName(c)} من هذا الجهاز فقط.`, ok: 'مسح', danger: true });
    if (!ok) return;
    c.msgs = [];
    c.unread = 0;
    save(); renderMessages(c); renderList(); updateTitle();
  }
  if (act === 'delete') {
    const ok = await confirmDialog({ title: 'حذف المحادثة؟', text: `ستُحذف المحادثة مع ${displayName(c)} من هذا الجهاز. إذا راسلك مجددًا ستظهر من جديد.`, ok: 'حذف', danger: true });
    if (!ok) return;
    delete state.contacts[c.id];
    save();
    if (history.state?.chat) history.back(); else closeChat();
    updateTitle();
  }
}

function toggleBlock(id) {
  const c = state.contacts[id];
  if (!c) return;
  c.blocked = !c.blocked;
  save();
  if (activeId === id) renderConvHead(c);
  renderList(); renderBlocked(); updateTitle();
  toast(c.blocked ? `تم حظر ${displayName(c)}` : `تم إلغاء حظر ${displayName(c)}`, c.blocked ? 'block' : 'check');
}

// ---------- إضافة جهة اتصال ----------
function inviteLink() {
  return `${location.origin}${location.pathname}#add=${me.id}.${me.pub}&n=${encodeURIComponent(me.name)}&c=${me.color}`;
}

async function parseInvite(str) {
  const s = String(str);
  const i = s.indexOf('#');
  if (i < 0) return null;
  const q = new URLSearchParams(s.slice(i + 1));
  const [rawId, k] = (q.get('add') || '').split('.');
  const id = normalizeId(rawId);
  if (!validId(id) || !k) return null;
  try { if (await idFromPub(b64d(k)) !== id) return null; } catch { return null; }
  const color = q.get('c');
  return { id, pub: k, name: cleanName(q.get('n')), color: AV_COLORS.includes(color) ? color : 'stone' };
}

function startChatWith(p) {
  let c = state.contacts[p.id];
  if (!c) c = state.contacts[p.id] = newContact(p);
  else {
    if (!c.name && p.name) c.name = p.name;
    if (c.blocked) toast('هذا الشخص محظور لديك', 'block');
  }
  save();
  closeDrawers();
  openChat(p.id);
}

async function findContact() {
  const raw = $('#newId').value.trim();
  const out = $('#newResult');
  const note = (icon, text, err = false) => { out.innerHTML = `<div class="note${err ? ' err' : ''}"><span class="ms">${icon}</span><span>${text}</span></div>`; };
  if (!raw) return $('#newId').focus();
  let p = raw.includes('#') ? await parseInvite(raw) : null;
  if (raw.includes('#') && !p) return note('error', 'رابط الدعوة غير صالح.', true);
  const id = p ? p.id : normalizeId(raw);
  if (!validId(id)) return note('error', 'المعرّف غير صحيح — يتكوّن من 10 أحرف وأرقام، مثل: 7K2QM-9XAP4', true);
  if (id === me.id) return note('info', 'هذا معرّفك أنت 🙂');
  if (state.contacts[id]) return startChatWith(state.contacts[id]);
  if (!p) {
    out.innerHTML = '<div class="note"><span class="spinner"></span><span>جارٍ البحث…</span></div>';
    try { p = await lookupProfile(id); } catch { return note('error', ERR.network, true); }
    if (!p) return note('info', 'لم نعثر على هذا المعرّف. قد لا يكون صاحبه فتح مرسال مؤخرًا — اطلب منه رابط الدعوة من الإعدادات.');
  }
  out.innerHTML = `<div class="found">
    ${avatar(p.name || '؟', p.color)}
    <div class="found-body"><b>${esc(p.name || 'مستخدم')}</b><bdi>${formatId(p.id)}</bdi></div>
    <button class="btn btn-primary" id="foundGo" type="button">مراسلة</button>
  </div>`;
  $('#foundGo').onclick = () => startChatWith(p);
}

async function handleHash() {
  if (!me || !location.hash.includes('add=')) return;
  const p = await parseInvite(location.href);
  history.replaceState(history.state, '', location.pathname + location.search);
  if (!p) return toast('رابط الدعوة غير صالح.', 'error');
  if (p.id === me.id) return toast('هذا رابط دعوتك أنت 🙂', 'info');
  startChatWith(p);
}

async function shareInvite() {
  const url = inviteLink();
  if (navigator.share) {
    try {
      await navigator.share({ title: 'مرسال', text: `راسلني بالخاص على مرسال — معرّفي: ${formatId(me.id)}`, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  copy(url, 'تم نسخ رابط الدعوة');
}

// ---------- الإعدادات ----------
function applySettings() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.font = settings.fontSize;
  $('meta[name="theme-color"]').content = dark ? '#0c0c0d' : '#ffffff';
}

function syncSettingsUI() {
  $$('.segmented').forEach((s) => $$('button', s).forEach((b) => b.classList.toggle('on', settings[s.dataset.setting] === b.dataset.v)));
  $$('.switch[data-setting]').forEach((x) => { x.checked = !!settings[x.dataset.setting]; });
}

function renderSettings() {
  $('#setAv').innerHTML = avatar(me.name, me.color, 'av-xl');
  if (document.activeElement !== $('#setName')) $('#setName').value = me.name;
  renderSwatches($('#setColors'), me.color, (c) => { me.color = c; saveMe(); });
  syncSettingsUI();
  renderBlocked();
}

function renderBlocked() {
  const list = Object.values(state.contacts).filter((c) => c.blocked);
  $('#blockedList').innerHTML = list.length
    ? list.map((c) => `<div class="row">${avatar(displayName(c), c.color, 'av-sm')}<span class="row-text"><b>${esc(displayName(c))}</b><small><bdi>${formatId(c.id)}</bdi></small></span><button class="btn btn-soft btn-sm" data-unblock="${esc(c.id)}" type="button">إلغاء الحظر</button></div>`).join('')
    : '<div class="row"><span class="ms">block</span><span class="row-text"><b>المحظورون</b><small>لا يوجد أحد محظور.</small></span></div>';
}

function saveMe() {
  store.set(K.id, me);
  publishProfile(true);
  renderMe();
  renderSettings();
}

function renderSwatches(el, current, onPick) {
  el.innerHTML = AV_COLORS.map((c) => `<button type="button" class="swatch av-${c}${c === current ? ' on' : ''}" data-c="${c}" aria-label="${COLOR_NAMES[c]}" title="${COLOR_NAMES[c]}"></button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    $$('.swatch', el).forEach((x) => x.classList.toggle('on', x === b));
    onPick(b.dataset.c);
  };
}

// ---------- تنبيهات ----------
let audioCtx = null;
function ping() {
  if (!settings.sound) return;
  try {
    audioCtx ||= new AudioContext();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, t);
    o.frequency.exponentialRampToValueAtTime(1320, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.3);
  } catch {}
}

function alertIncoming(c, m) {
  ping();
  if (!settings.notify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(displayName(c), { body: m.text.slice(0, 140), tag: c.id, icon: 'assets/logo.svg' });
    n.onclick = () => { window.focus(); openChat(c.id); n.close(); };
  } catch {}
}

let toastTimer = null;
function toast(text, icon = 'check') {
  const t = $('#toast');
  t.innerHTML = `<span class="ms">${icon}</span><span>${esc(text)}</span>`;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function copy(text, msg = 'تم النسخ') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
  toast(msg, 'content_copy');
}

function confirmDialog({ title, text, ok = 'تأكيد', cancel = 'إلغاء', danger = false }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="modal-actions">
        ${cancel ? `<button class="btn btn-soft" data-r="0" type="button">${esc(cancel)}</button>` : ''}
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-r="1" type="button">${esc(ok)}</button>
      </div>
    </div>`;
    m.hidden = false;
    const done = (v) => {
      m.hidden = true;
      m.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape' && cancel) { e.stopPropagation(); done(false); } };
    document.addEventListener('keydown', onKey, true);
    m.onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (b) done(b.dataset.r === '1');
      else if (e.target === m && cancel) done(false);
    };
    setTimeout(() => $('[data-r="1"]', m)?.focus(), 50);
  });
}

function shake(el) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  el.focus();
}

function busy(btn, on) { btn.setAttribute('aria-busy', on ? 'true' : 'false'); }

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  $('#sendBtn').disabled = !input.value.trim();
}

// ---------- نافذة واحدة فقط ----------
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('mrsl') : null;
if (channel) {
  channel.onmessage = (e) => { if (e.data?.t === 'takeover' && me && !suspended && !$('#app').hidden) suspend(); };
}
function suspend() {
  saveNow();
  suspended = true;
  es?.close();
  es = null;
  confirmDialog({ title: 'مرسال مفتوح في نافذة أخرى', text: 'يمكن استخدام مرسال في نافذة واحدة فقط في الوقت نفسه.', ok: 'استخدم هنا', cancel: '' })
    .then(() => location.reload());
}

// ---------- التسجيل ----------
let obColor = AV_COLORS[Math.floor(Math.random() * AV_COLORS.length)];
function obStep(name) { $$('.ob-step').forEach((s) => { s.hidden = s.dataset.step !== name; }); }

function showOnboard() {
  $('#app').hidden = true;
  $('#onboard').hidden = false;
  obStep('welcome');
  renderSwatches($('#obColors'), obColor, (c) => { obColor = c; });
  setTimeout(() => $('#obName').focus(), 100);
}

async function startApp() {
  try {
    await loadPriv();
  } catch {
    toast('تعذّر تحميل مفتاح الحساب.', 'error');
    me = null;
    showOnboard();
    return;
  }
  $('#onboard').hidden = true;
  $('#app').hidden = false;
  channel?.postMessage({ t: 'takeover' });
  renderMe();
  renderList();
  updateTitle();
  subscribe();
  publishProfile();
  handleHash();
  setTimeout(resendStale, 5000);
  setInterval(resendStale, 10 * 60e3);
  setInterval(() => publishProfile(), 30 * 60e3);
}

// ---------- ربط الأحداث ----------
function bindUI() {
  // التسجيل
  $('#obForm').onsubmit = async (e) => {
    e.preventDefault();
    const name = cleanName($('#obName').value);
    if (!name) return shake($('#obName'));
    const btn = $('#obCreate');
    busy(btn, true);
    try {
      me = await createIdentity(name, obColor);
      store.set(K.id, me);
      renderMe();
      obStep('done');
    } catch {
      toast('المتصفح لا يدعم التشفير المطلوب.', 'error');
    } finally {
      busy(btn, false);
    }
  };
  $('#obEnter').onclick = startApp;
  $('#obRestoreOpen').onclick = () => { obStep('restore'); setTimeout(() => $('#obKey').focus(), 50); };
  $('#obRestoreBack').onclick = () => obStep('welcome');
  $('#obRestoreGo').onclick = async () => {
    try {
      me = await parseBackup($('#obKey').value);
      store.set(K.id, me);
      startApp();
    } catch {
      shake($('#obKey'));
      toast('المفتاح غير صالح.', 'error');
    }
  };

  // القائمة الجانبية
  $('#search').oninput = renderList;
  $('#chatList').onclick = (e) => {
    const item = e.target.closest('.chat-item');
    if (item) openChat(item.dataset.id);
  };
  $('#newChatBtn').onclick = () => openDrawer('newChat');
  $('#settingsBtn').onclick = () => openDrawer('settings');
  $$('[data-close]').forEach((b) => { b.onclick = closeDrawers; });
  $('#newForm').onsubmit = (e) => { e.preventDefault(); findContact(); };

  // المحادثة
  $('#backBtn').onclick = () => { if (history.state?.chat) history.back(); else closeChat(); };
  $('#convMenuBtn').onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  $('#convMenu').onclick = (e) => { const b = e.target.closest('[data-act]'); if (b) convAction(b.dataset.act); };
  $('#unblockBtn').onclick = () => toggleBlock(activeId);
  $('#messages').onclick = (e) => {
    const m = e.target.closest('.msg.failed');
    if (m && !e.target.closest('a')) retry(m.dataset.id);
  };
  input.addEventListener('input', () => { autosize(); if (activeId) drafts[activeId] = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && settings.enterSend) {
      e.preventDefault();
      sendCurrent();
    }
  });
  $('#composer').onsubmit = (e) => { e.preventDefault(); sendCurrent(); input.focus(); };

  // الإعدادات
  $$('.segmented').forEach((s) => {
    s.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[s.dataset.setting] = b.dataset.v;
      saveSettings();
    };
  });
  $$('.switch[data-setting]').forEach((x) => {
    x.onchange = async () => {
      const key = x.dataset.setting;
      if (key === 'notify' && x.checked) {
        if (!('Notification' in window)) { x.checked = false; return toast('المتصفح لا يدعم الإشعارات.', 'error'); }
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { x.checked = false; return toast('لم يُسمح بالإشعارات من المتصفح.', 'error'); }
      }
      settings[key] = x.checked;
      saveSettings();
    };
  });
  $('#setName').onchange = () => {
    const n = cleanName($('#setName').value);
    if (!n) { $('#setName').value = me.name; return; }
    if (n === me.name) return;
    me.name = n;
    saveMe();
    toast('تم حفظ الاسم');
  };
  $('#setName').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
  $('#blockedList').onclick = (e) => { const b = e.target.closest('[data-unblock]'); if (b) toggleBlock(b.dataset.unblock); };
  $('#exportKey').onclick = async () => {
    const ok = await confirmDialog({
      title: 'نسخ المفتاح الاحتياطي',
      text: 'هذا المفتاح يمنح صلاحية كاملة لحسابك ورسائلك. احفظه في مكان آمن ولا تشاركه مع أي أحد.',
      ok: 'نسخ المفتاح',
    });
    if (ok) copy(exportBackup(), 'تم نسخ المفتاح — احفظه في مكان آمن');
  };
  $('#logoutBtn').onclick = async () => {
    const ok = await confirmDialog({
      title: 'حذف الحساب من هذا الجهاز؟',
      text: 'سيُحذف المفتاح وجميع المحادثات من هذا المتصفح. إن لم تحفظ المفتاح الاحتياطي فلن تستطيع استعادة هذا المعرّف.',
      ok: 'حذف',
      danger: true,
    });
    if (!ok) return;
    wiped = true;
    es?.close();
    Object.values(K).forEach((k) => store.del(k));
    location.replace(location.pathname);
  };

  // عام
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#convMenu')) closeMenu();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'copy-id' && me) copy(formatId(me.id), 'تم نسخ معرّفك');
    if (act === 'share' && me) shareInvite();
    if (act === 'new-chat') openDrawer('newChat');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !$('#modal').hidden) return;
    if (!$('#convMenu').hidden) return closeMenu();
    if ($('.drawer.open')) return closeDrawers();
    if (activeId) $('#backBtn').click();
  });
  window.addEventListener('popstate', (e) => {
    const id = e.state?.chat;
    if (id && state.contacts[id]) openChat(id, { push: false });
    else if (activeId) closeChat();
  });
  window.addEventListener('hashchange', handleHash);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { saveNow(); return; }
    const c = state.contacts[activeId];
    if (c) { markChatRead(c); renderList(); updateTitle(); }
  });
  window.addEventListener('online', subscribe);
  window.addEventListener('pagehide', saveNow);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySettings);
}

// ---------- البدء ----------
applySettings();
bindUI();
if (me) startApp();
else showOnboard();
