// مرسال — رسائل خاصة مشفّرة من طرف إلى طرف.
//
// GitHub Pages لا يشغّل خوادم، لذلك تُنقل الرسائل عبر ntfy.sh (خدمة عامة مجانية).
// كل مستخدم يملك زوج مفاتيح ECDH (P-256) يُنشأ في متصفحه، ومعرّفه هو بصمة مفتاحه العام.
// كل رسالة تُشفَّر بمفتاح مشترك (ECDH + HKDF + AES-GCM) لا يعرفه إلا الطرفان،
// فلا يرى ntfy.sh ولا أي أحد آخر سوى نص مشفّر.
// الصور والفيديوهات تُشفَّر بمفتاح عشوائي قبل رفعها كمرفق، والمفتاح يُرسل داخل الرسالة المشفّرة.

const NTFY = 'https://ntfy.sh';
const NS = 'mrsl-v1';
const MAX_TEXT = 1000;
const MAX_CAPTION = 300;
const MAX_BODY = 4000; // ntfy يحوّل الرسائل الأكبر من 4096 بايت إلى مرفقات
const MAX_MSGS = 400;
// ntfy.sh يقبل مرفقات حتى 2 ميغابايت فقط، ومجموع 20 ميغابايت لكل مستخدم كل 3 ساعات،
// لذلك يُقسَّم الملف المشفّر إلى أجزاء أصغر من 2 ميغابايت ويُعاد تجميعها عند المستلم.
const CHUNK = 1900 * 1024;
const MAX_CHUNKS = 9;
const MAX_MEDIA = 15 * 1024 * 1024;
const MAX_IMAGE_INPUT = 60 * 1024 * 1024; // الصور الكبيرة تُضغط قبل الإرسال
const IMG_MAX_SIDE = 1920;
const IMG_TARGET = 1.5 * 1024 * 1024;
const CHUNK_TIMEOUT = 120e3;
const MEDIA_TTL = 2.5 * 3600e3; // ntfy.sh يحذف المرفقات بعد 3 ساعات
const RESEND_AFTER = 11 * 3600e3; // ntfy.sh يحتفظ بالرسائل 12 ساعة
const RESEND_MAX_AGE = 7 * 864e5;
const PROFILE_EVERY = 3 * 3600e3;
const DEMO_ID = 'demo';
const VERIFIED = new Set(['F77SEZRZW2']); // حسابات موثّقة
const AV_MAX = 2300; // الصورة الشخصية صغيرة لتتسع داخل رسالة مشفّرة (حد ntfy هو 4096 بايت)
const KDF_ITER = 600000;
const VAULT_EVERY = 6 * 3600e3;
const AV_COLORS = ['stone', 'sand', 'sage', 'sky', 'lilac', 'rose'];
const COLOR_NAMES = { stone: 'رمادي', sand: 'رملي', sage: 'أخضر', sky: 'سماوي', lilac: 'بنفسجي', rose: 'وردي' };
const MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'];
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const K = { id: 'mrsl.identity', settings: 'mrsl.settings', legacyState: 'mrsl.state', lastId: 'mrsl.lastId' };
// بيانات كل حساب منفصلة حتى يمكن تسجيل الخروج والدخول بحساب آخر على نفس الجهاز
const stateKey = (id) => `mrsl.state.${id}`;
const vaultKey = (id) => `mrsl.vault.${id}`;
const profKey = (id) => `mrsl.profile.${id}`;
const DEFAULTS = {
  theme: 'system',
  fontSize: 'm',
  readReceipts: true,
  notify: false,
  sound: true,
  enterSend: !matchMedia('(pointer: coarse)').matches,
  protect: true,
};
const RANK = { failed: 0, sending: 0, sent: 1, delivered: 2, read: 3 };
const ERR = {
  too_long: 'الرسالة طويلة جدًا.',
  too_big: 'الملف كبير جدًا — الحد الأقصى 15 ميغابايت.',
  quota: 'وصلت حد الرفع المؤقت (20 ميغابايت كل 3 ساعات). حاول لاحقًا.',
  timeout: 'انقطع الرفع لبطء الاتصال. اضغط على الرسالة لإعادة المحاولة.',
  type: 'يمكن إرسال الصور والفيديوهات فقط.',
  decode: 'تعذّرت قراءة الملف. جرّب صورة JPG أو PNG أو فيديو MP4.',
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

// الصور والفيديوهات تُحفظ في IndexedDB لأنها أكبر من سعة localStorage
const idb = (() => {
  let dbp = null;
  const open = () => (dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('mrsl', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('media');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  // مهلة حتى لا يعلق التطبيق إن تعطّل IndexedDB (يحدث في بعض المتصفحات المدمجة)
  const withTimeout = (p) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('idb-timeout')), 5000))]);
  const run = (mode, fn) => withTimeout(open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction('media', mode);
      const req = fn(t.objectStore('media'));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    })));
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    put: (k, v) => run('readwrite', (s) => s.put(v, k)),
    del: (k) => run('readwrite', (s) => s.delete(k)).catch(() => {}),
  };
})();

let me = store.get(K.id, null);
let state = normalizeState(null);
let settings = { ...DEFAULTS, ...store.get(K.settings, {}) };
let privKey = null;
let es = null;
let activeId = null;
let suspended = false;
let wiped = false;
const drafts = {};
const keyCache = new Map();
const pendingReceipts = new Map();
const blobUrls = new Map();
const memBlobs = new Map(); // نسخة في الذاكرة للجلسة الحالية حتى لو تعذّر الحفظ في IndexedDB
const progress = new Map();
const downloading = new Set();
const typing = new Map();

function normalizeState(s) {
  if (!s || s.v !== 1) s = { v: 1, contacts: {}, seen: {}, profileAt: 0 };
  s.contacts ||= {};
  s.seen ||= {};
  for (const c of Object.values(s.contacts)) {
    c.msgs ||= [];
    for (const m of c.msgs) {
      if (m.me && m.status === 'sending') m.status = 'failed';
      if (m.media?.u && !m.media.us) { m.media.us = [m.media.u]; delete m.media.u; }
    }
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
const idLabel = (c) => (c.bot ? 'حساب تجريبي' : formatId(c.id));
const isMobile = () => matchMedia('(max-width: 760px)').matches;
const validAvatar = (s) => typeof s === 'string' && s.length <= AV_MAX + 40 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(s);
const avatar = (name, color, cls = '', img = '') => `<div class="av av-${AV_COLORS.includes(color) ? color : 'stone'} ${cls}">${validAvatar(img) ? `<img src="${img}" alt="" draggable="false">` : esc(initial(name))}</div>`;
const isVerified = (id) => VERIFIED.has(id);
const badge = (id) => (isVerified(id) ? '<span class="ms fill verified" title="حساب موثّق" aria-label="حساب موثّق">verified</span>' : '');
const nameHtml = (name, id) => `<span class="nm">${esc(name)}</span>${badge(id)}`;
const who = () => ({ n: me.name, c: me.color, ah: me.ah || '' });
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// إظهار وإخفاء بحركة ناعمة (الإخفاء ينتظر انتهاء حركة الخروج)
function openEl(el) {
  clearTimeout(el._hideT);
  el.classList.remove('closing');
  el.hidden = false;
}
function closeEl(el, then) {
  if (el.hidden) return then?.();
  clearTimeout(el._hideT);
  el.classList.add('closing');
  el._hideT = setTimeout(() => { el.classList.remove('closing'); el.hidden = true; then?.(); }, reduceMotion() ? 0 : 190);
}

async function avatarHash(av) {
  if (!av) return '';
  return b64e(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(av)))).slice(0, 12);
}

// قص الصورة مربعًا وتصغيرها لتصبح صورة شخصية خفيفة
async function makeAvatar(file) {
  if (!file.type.startsWith('image/')) throw new Error('type');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url).catch(() => { throw new Error('decode'); });
    const w = img.naturalWidth, h = img.naturalHeight, side = Math.min(w, h);
    for (const size of [88, 72, 56]) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
      for (const q of [0.82, 0.7, 0.58, 0.46]) {
        const d = cv.toDataURL('image/jpeg', q);
        if (d.length <= AV_MAX) return d;
      }
    }
    throw new Error('too_big');
  } finally {
    URL.revokeObjectURL(url);
  }
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clampInt = (v, max = 20000) => (Number.isFinite(+v) ? Math.max(0, Math.min(max, Math.round(+v))) : 0);

function linkify(text) {
  return esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]!?،]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`);
}

const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const daysAgo = (t) => Math.round((startOfDay(Date.now()) - startOfDay(t)) / 864e5);
const fmtTime = (t) => new Date(t).toLocaleTimeString(LOC, { hour: 'numeric', minute: '2-digit' });
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtSize = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} ك.ب` : `${(b / 1024 / 1024).toFixed(1)} م.ب`);
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

// ---------- كلمة المرور ----------
// المفتاح الخاص يُشفَّر بكلمة المرور (PBKDF2 + AES-GCM) ويُحفظ على الجهاز وعلى ntfy،
// فيمكن الدخول بالمعرّف وكلمة المرور. ntfy يحتفظ بالنسخة 12 ساعة وتُجدَّد كلما فُتح الحساب.
async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function makeVault(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, KDF_ITER);
  const data = te.encode(JSON.stringify({ id: me.id, name: me.name, color: me.color, pub: me.pub, priv: me.priv }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(me.id) }, key, data));
  return { v: 1, id: me.id, it: KDF_ITER, s: b64e(salt), iv: b64e(iv), ct: b64e(ct) };
}

async function openVault(vault, password) {
  if (!vault || vault.v !== 1 || !validId(vault.id)) throw new Error('bad');
  const it = clampInt(vault.it, 5e6);
  if (it < 100000) throw new Error('bad');
  const key = await deriveKey(password, b64d(vault.s), it);
  let pt;
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(vault.iv), additionalData: te.encode(vault.id) }, key, b64d(vault.ct));
  } catch { throw new Error('password'); }
  const d = JSON.parse(td.decode(pt));
  if (d.id !== vault.id || await idFromPub(b64d(d.pub)) !== d.id) throw new Error('bad');
  await crypto.subtle.importKey('jwk', d.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { id: d.id, name: cleanName(d.name) || 'أنا', color: AV_COLORS.includes(d.color) ? d.color : 'stone', pub: d.pub, priv: d.priv, created: Date.now() };
}

const vaultTopic = (id) => `${NS}-acct-${id.toLowerCase()}`;

async function publishVault(force = false) {
  const vault = me && store.get(vaultKey(me.id), null);
  if (!vault || suspended) return;
  if (!force && Date.now() - (state.vaultAt || 0) < VAULT_EVERY) return;
  try {
    await publish(vaultTopic(me.id), JSON.stringify(vault));
    state.vaultAt = Date.now();
    save();
  } catch {}
}

async function fetchRemoteVault(id) {
  let res;
  try { res = await fetch(`${NTFY}/${vaultTopic(id)}/json?poll=1&since=all`); } catch { throw new Error('network'); }
  if (!res.ok) throw new Error('network');
  const lines = (await res.text()).trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.event !== 'message') continue;
      const v = JSON.parse(ev.message);
      if (v.v === 1 && v.id === id) return v;
    } catch {}
  }
  return null;
}

async function login(id, password) {
  const local = store.get(vaultKey(id), null);
  if (local) {
    try { return { ident: await openVault(local, password), vault: local }; } catch (err) {
      if (err.message !== 'password') throw err;
    }
  }
  // كلمة المرور ربما تغيّرت من جهاز آخر، أو هذا جهاز جديد
  const remote = await fetchRemoteVault(id).catch((e) => { if (!local) throw e; return null; });
  if (!remote) throw new Error(local ? 'password' : 'missing');
  return { ident: await openVault(remote, password), vault: remote };
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
    const prof = { v: 1, id: me.id, k: me.pub, n: me.name, c: me.color };
    let body = JSON.stringify({ ...prof, av: me.av || undefined });
    if (body.length > 3900) body = JSON.stringify(prof);
    await publish(profileTopic(me.id), body);
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
      return { id, pub: p.k, name: cleanName(p.n), color: AV_COLORS.includes(p.c) ? p.c : 'stone', av: validAvatar(p.av) ? p.av : '' };
    } catch {}
  }
  return null;
}

async function getBlob(id) {
  if (memBlobs.has(id)) return memBlobs.get(id);
  const blob = await idb.get(id).catch(() => null);
  if (blob) memBlobs.set(id, blob);
  return blob || null;
}

function putBlob(id, blob) {
  memBlobs.set(id, blob);
  return idb.put(id, blob).catch(() => {});
}

function setProgress(id, frac) {
  progress.set(id, frac);
  const el = $(`#messages .msg[data-id="${CSS.escape(id)}"] .pct`);
  if (el) el.textContent = `${Math.round(frac * 100)}%`;
}

async function fetchWithTimeout(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHUNK_TIMEOUT);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

// رفع ملف مشفّر كأجزاء (مرفقات ntfy) على مواضيع عشوائية مؤقتة
async function uploadMedia(m) {
  const blob = await getBlob(m.id);
  if (!blob) throw new Error('missing');
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ck = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, await blob.arrayBuffer());
  const parts = [];
  for (let i = 0; i < ct.byteLength; i += CHUNK) parts.push(ct.slice(i, i + CHUNK));
  if (parts.length > MAX_CHUNKS) throw new Error('too_big');
  const urls = new Array(parts.length);
  let done = 0;
  setProgress(m.id, 0.02);
  const uploadPart = async (i) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchWithTimeout(`${NTFY}/${NS}-f-${rid()}?filename=m.bin`, { method: 'POST', body: new Blob([parts[i]]) });
        if (res.status === 413) throw new Error('quota');
        if (res.status === 429) throw new Error('rate');
        if (!res.ok) throw new Error('network');
        const url = (await res.json().catch(() => null))?.attachment?.url;
        if (typeof url !== 'string' || !url.startsWith(`${NTFY}/file/`)) throw new Error('network');
        urls[i] = url;
        setProgress(m.id, 0.02 + 0.98 * (++done / parts.length));
        return;
      } catch (err) {
        if (attempt >= 1 || err.message === 'quota' || err.message === 'rate') throw err;
      }
    }
  };
  // جزءان في نفس الوقت
  let next = 0;
  const worker = async () => { while (next < parts.length) await uploadPart(next++); };
  await Promise.all([worker(), worker()]);
  Object.assign(m.media, { us: urls, key: b64e(key), iv: b64e(iv), upAt: Date.now() });
  delete m.media.u;
}

async function downloadMedia(c, m) {
  if (!m.media || downloading.has(m.id)) return;
  downloading.add(m.id);
  m.media.st = 'downloading';
  progress.set(m.id, 0);
  refreshMedia(c, m);
  try {
    const urls = m.media.us || [];
    const bufs = [];
    let expired = false;
    for (let i = 0; i < urls.length; i++) {
      const res = await fetchWithTimeout(urls[i]);
      if (res.status === 404 || res.status === 410) { expired = true; break; }
      if (!res.ok) throw new Error('network');
      bufs.push(new Uint8Array(await res.arrayBuffer()));
      setProgress(m.id, (i + 1) / urls.length);
    }
    if (expired) {
      m.media.st = 'expired';
    } else {
      const all = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
      let off = 0;
      for (const b of bufs) { all.set(b, off); off += b.length; }
      const ck = await crypto.subtle.importKey('raw', b64d(m.media.key), 'AES-GCM', false, ['decrypt']);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(m.media.iv) }, ck, all);
      await putBlob(m.id, new Blob([pt], { type: m.media.mime }));
      m.media.st = 'ready';
    }
  } catch {
    m.media.st = 'error';
  } finally {
    downloading.delete(m.id);
    progress.delete(m.id);
    save();
    refreshMedia(c, m);
  }
  // انتهت صلاحية المرفق (المستلم كان غير متصل أكثر من 3 ساعات): نطلب من المرسل رفعه من جديد
  if (m.media.st === 'expired' && !m.media.reqAt) requestResend(c, m);
}

async function requestResend(c, m) {
  if (c.bot || !m.media) return;
  m.media.reqAt = Date.now();
  m.media.st = 'requested';
  save();
  refreshMedia(c, m);
  try { await sendEnvelope(c, { t: 'q', id: m.id, ...who() }); } catch {
    m.media.st = 'expired';
    save();
    refreshMedia(c, m);
  }
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

function parseMediaWire(a) {
  if (!a || typeof a !== 'object') return null;
  const kind = a.k === 'image' || a.k === 'video' ? a.k : null;
  const us = Array.isArray(a.us) ? a.us : typeof a.u === 'string' ? [a.u] : [];
  if (!kind || !us.length || us.length > MAX_CHUNKS || !us.every((u) => typeof u === 'string' && u.startsWith(`${NTFY}/file/`) && u.length < 200)) return null;
  if (typeof a.key !== 'string' || typeof a.iv !== 'string') return null;
  const mime = MIMES.includes(a.m) && a.m.startsWith(kind) ? a.m : kind === 'image' ? 'image/jpeg' : 'video/mp4';
  const thumb = typeof a.t === 'string' && a.t.startsWith('data:image/jpeg;base64,') && a.t.length < 3000 ? a.t : '';
  return {
    kind, mime, thumb,
    w: clampInt(a.w), h: clampInt(a.h),
    dur: Number(a.d) > 0 ? Math.min(Number(a.d), 36000) : 0,
    size: clampInt(a.z, MAX_MEDIA * 2),
    us, key: a.key, iv: a.iv, st: 'downloading',
  };
}

function onInner(fromId, pub, inner, evTime) {
  if (!inner || !['m', 'r', 'q', 'p', 'pa'].includes(inner.t)) return;
  let c = state.contacts[fromId];
  if (c?.blocked) return;
  if (!c) {
    if (inner.t !== 'm') return;
    c = state.contacts[fromId] = newContact({ id: fromId, pub });
  }
  const n = cleanName(inner.n);
  if (n) c.name = n;
  if (AV_COLORS.includes(inner.c)) c.color = inner.c;
  if (inner.t !== 'p' && typeof inner.ah === 'string') syncAvatar(c, inner.ah);

  if (inner.t === 'r') {
    applyReceipt(c, inner);
  } else if (inner.t === 'p') {
    // صورة شخصية جديدة من الطرف الآخر
    c.av = validAvatar(inner.av) ? inner.av : '';
    c.ah = c.av && typeof inner.ah === 'string' ? inner.ah.slice(0, 16) : '';
  } else if (inner.t === 'pa') {
    // الطرف الآخر يطلب صورتي
    if (Date.now() - (c.avSentAt || 0) > 60e3) {
      c.avSentAt = Date.now();
      sendEnvelope(c, { t: 'p', av: me.av || '', ...who() }).catch(() => {});
    }
  } else if (inner.t === 'q') {
    // طلب إعادة رفع مرفق انتهت صلاحيته عند الطرف الآخر
    const m = c.msgs.find((x) => x.me && x.id === inner.id && x.media);
    if (m && Date.now() - (m.media.reqAt || 0) > 60e3) {
      m.media.reqAt = Date.now();
      deliver(c, m, { quiet: true, reupload: true });
    }
  } else {
    const id = typeof inner.id === 'string' ? inner.id.slice(0, 32) : '';
    const text = typeof inner.x === 'string' ? inner.x.slice(0, MAX_TEXT) : '';
    const media = parseMediaWire(inner.a);
    if (!id || (!text.trim() && !media)) return;
    const dup = c.msgs.find((m) => !m.me && m.id === id);
    if (dup) {
      // إعادة إرسال: إن كان المرفق منتهيًا عندنا نستخدم الرابط الجديد
      if (dup.media && media && ['expired', 'error', 'requested'].includes(dup.media.st)) {
        Object.assign(dup.media, media);
        downloadMedia(c, dup);
      }
      queueReceipt(c, dup.read ? 'r' : 'd', id);
      save();
      return;
    }
    if (media) media.pr = inner.a?.pr ? 1 : 0;
    let ts = Number(inner.s);
    if (!Number.isFinite(ts) || ts > evTime + 5 * 60e3 || ts < evTime - RESEND_MAX_AGE - 864e5) ts = evTime;
    const m = { id, me: false, text, ts };
    if (media) m.media = media;
    receive(c, m, { fresh: Date.now() - evTime < 5 * 60e3 });
    if (media) downloadMedia(c, m);
    return;
  }
  save();
  renderList();
  updateTitle();
  if (activeId === c.id) renderConvHead(c);
}

// إضافة رسالة واردة (من الشبكة أو من الحساب التجريبي)
function receive(c, m, { fresh = true } = {}) {
  insertMsg(c, m);
  if (activeId === c.id && !document.hidden) {
    m.read = true;
    queueReceipt(c, 'r', m.id);
    if (fresh) ping();
  } else {
    c.unread = (c.unread || 0) + 1;
    queueReceipt(c, 'd', m.id);
    if (fresh) alertIncoming(c, m);
  }
  if (activeId === c.id) { appendMessage(c, m); renderConvHead(c); }
  save();
  renderList();
  updateTitle();
}

function syncAvatar(c, ah) {
  if (c.bot || ah === (c.ah || '')) return;
  if (!ah) { c.av = ''; c.ah = ''; return; }
  if (Date.now() - (c.avReqAt || 0) < 10 * 60e3) return;
  c.avReqAt = Date.now();
  sendEnvelope(c, { t: 'pa', ...who() }).catch(() => {});
}

// إرسال صورتي الجديدة لمن أراسلهم مؤخرًا
async function pushAvatar() {
  const recent = Object.values(state.contacts)
    .filter((c) => !c.bot && !c.blocked && Date.now() - (c.updated || 0) < 30 * 864e5)
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 15);
  for (const c of recent) {
    c.avSentAt = Date.now();
    await sendEnvelope(c, { t: 'p', av: me.av || '', ...who() }).catch(() => {});
  }
}

function applyReceipt(c, inner) {
  const upd = (ids, st) => {
    if (!Array.isArray(ids)) return;
    for (const id of ids.slice(0, 200)) {
      const m = c.msgs.find((x) => x.me && x.id === id);
      if (m) setStatus(c, m, st);
    }
  };
  upd(inner.d, 'delivered');
  upd(inner.r, 'read');
}

function setStatus(c, m, st) {
  if (RANK[st] <= (RANK[m.status] ?? 0)) return;
  m.status = st;
  save();
  refreshMsg(c, m);
  renderList();
}

function queueReceipt(c, kind, id) {
  if (c.bot) return;
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
  if (!p || !c || c.blocked || c.bot || suspended) return;
  const d = [...p.d].slice(-100), r = [...p.r].slice(-100);
  if (!d.length && !r.length) return;
  try { await sendEnvelope(c, { t: 'r', d, r, ...who() }); } catch {}
}

// ---------- الرسائل ----------
function newContact({ id, pub, name = '', color = 'stone' }) {
  return { id, pub, name, color, msgs: [], unread: 0, updated: Date.now(), blocked: false };
}

function insertMsg(c, m) {
  let i = c.msgs.length;
  while (i > 0 && c.msgs[i - 1].ts > m.ts) i--;
  c.msgs.splice(i, 0, m);
  if (c.msgs.length > MAX_MSGS) dropMedia(c.msgs.splice(0, c.msgs.length - MAX_MSGS));
  c.updated = Math.max(c.updated || 0, m.ts);
}

function dropMedia(msgs) {
  for (const m of msgs) {
    if (!m.media) continue;
    idb.del(m.id);
    memBlobs.delete(m.id);
    if (blobUrls.has(m.id)) { URL.revokeObjectURL(blobUrls.get(m.id)); blobUrls.delete(m.id); }
  }
}

// ---------- مزايا التطبيق على iPhone ----------
const isApp = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// اهتزاز خفيف: Safari على iOS لا يدعم Vibration API، لكنه يهتز عند تبديل <input switch>
// عبر الضغط على label مرتبط به (يعمل من iOS 17.4 حتى 26.4). على أندرويد نستخدم vibrate.
let hapticLabel = null;
function haptic() {
  try {
    if (!isIOS) { navigator.vibrate?.(8); return; }
    if (!hapticLabel) {
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.id = 'hapticSwitch';
      sw.setAttribute('switch', '');
      sw.tabIndex = -1;
      sw.setAttribute('aria-hidden', 'true');
      sw.style.cssText = 'position:fixed;left:-100px;width:1px;height:1px;opacity:0;pointer-events:none';
      hapticLabel = document.createElement('label');
      hapticLabel.htmlFor = sw.id;
      hapticLabel.style.display = 'none';
      document.body.append(sw, hapticLabel);
    }
    const focused = document.activeElement;
    hapticLabel.click();
    if (focused && focused !== document.activeElement) focused.focus({ preventScroll: true });
  } catch {}
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
async function showInstall() {
  if (installPrompt) {
    installPrompt.prompt();
    installPrompt = null;
    return;
  }
  const steps = isIOS
    ? 'افتح الموقع في Safari ← اضغط زر المشاركة ⬆️ ← «إضافة إلى الشاشة الرئيسية». بعدها افتح مرسال من أيقونته.'
    : 'افتح الموقع في Chrome ← القائمة ⋮ ← «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».';
  confirmDialog({ title: 'إضافة مرسال للشاشة الرئيسية', text: steps, ok: 'تمام', cancel: '' });
}

function sendCurrent() {
  const c = state.contacts[activeId];
  if (!c || c.blocked) return;
  const text = input.value.trim();
  if (!text) return;
  if (text.length > MAX_TEXT) return toast(ERR.too_long, 'error');
  haptic();
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

async function sendMedia(c, prep, caption, protect) {
  const m = {
    id: rid(), me: true, text: caption, ts: Date.now(), status: 'sending',
    media: { kind: prep.kind, mime: prep.mime, w: prep.w, h: prep.h, thumb: prep.thumb, dur: prep.dur, size: prep.blob.size, pr: protect ? 1 : 0 },
  };
  putBlob(m.id, prep.blob);
  insertMsg(c, m);
  save();
  appendMessage(c, m);
  renderList();
  deliver(c, m);
}

async function deliver(c, m, { quiet = false, reupload = false } = {}) {
  if (c.bot) return botHandle(c, m);
  if (!quiet) { m.status = 'sending'; refreshMsg(c, m); }
  try {
    const inner = { t: 'm', id: m.id, x: m.text, s: m.ts, ...who() };
    if (m.media) {
      if (reupload || !m.media.us || Date.now() - (m.media.upAt || 0) > MEDIA_TTL) await uploadMedia(m);
      const md = m.media;
      inner.a = { k: md.kind, m: md.mime, w: md.w, h: md.h, t: md.thumb, d: md.dur, z: md.size, us: md.us, key: md.key, iv: md.iv, pr: md.pr ? 1 : 0 };
    }
    try {
      await sendEnvelope(c, inner);
    } catch (err) {
      if (err.message !== 'too_long' || !inner.a?.t) throw err;
      inner.a.t = ''; // بدون الصورة المصغّرة إن تجاوزت الرسالة الحد
      await sendEnvelope(c, inner);
    }
    m.pubAt = Date.now();
    if ((RANK[m.status] ?? 0) < RANK.sent) m.status = 'sent';
  } catch (err) {
    if (!quiet) {
      m.status = 'failed';
      toast(ERR[err.message] || ERR.network, 'error');
    }
  }
  progress.delete(m.id);
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
    if (c.blocked || c.bot) continue;
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

// ---------- تجهيز الصور والفيديو ----------
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function drawTo(source, w, h, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * scale));
  cv.height = Math.max(1, Math.round(h * scale));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(source, 0, 0, cv.width, cv.height);
  return cv;
}
const toBlob = (cv, q = 0.85) => new Promise((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error('decode'))), 'image/jpeg', q));
const makeThumb = (source, w, h) => drawTo(source, w, h, 20).toDataURL('image/jpeg', 0.5);

async function prepareMedia(file) {
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : null;
  if (!kind) throw new Error('type');
  const url = URL.createObjectURL(file);
  try {
    if (kind === 'image') {
      if (file.size > MAX_IMAGE_INPUT) throw new Error('too_big');
      const img = await loadImage(url).catch(() => { throw new Error('decode'); });
      const w = img.naturalWidth, h = img.naturalHeight;
      let blob = file, mime = file.type, side = Math.max(w, h);
      const keepGif = file.type === 'image/gif' && file.size <= MAX_MEDIA;
      if (!keepGif && (!MIMES.includes(file.type) || side > IMG_MAX_SIDE || file.size > IMG_TARGET)) {
        // نضغط حتى يصبح الحجم مناسبًا (أقل من 1.5 ميغابايت غالبًا)
        let maxSide = Math.min(side, IMG_MAX_SIDE), q = 0.85;
        blob = await toBlob(drawTo(img, w, h, maxSide), q);
        while (blob.size > IMG_TARGET && maxSide > 640) {
          maxSide = Math.round(maxSide * 0.8);
          q = Math.max(0.6, q - 0.08);
          blob = await toBlob(drawTo(img, w, h, maxSide), q);
        }
        mime = 'image/jpeg';
        side = maxSide;
      }
      if (blob.size > MAX_MEDIA) throw new Error('too_big');
      const scale = Math.min(1, side / Math.max(w, h));
      return { kind, mime, blob, w: Math.round(w * scale), h: Math.round(h * scale), thumb: makeThumb(img, w, h), dur: 0 };
    }
    if (file.size > MAX_MEDIA) throw new Error('too_big');
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    const wait = (ev, ms) => new Promise((resolve) => { v.addEventListener(ev, resolve, { once: true }); v.addEventListener('error', resolve, { once: true }); setTimeout(resolve, ms); });
    await wait('loadedmetadata', 3000);
    let thumb = '';
    const w = v.videoWidth, h = v.videoHeight, dur = Number.isFinite(v.duration) ? v.duration : 0;
    if (w && h) {
      v.currentTime = Math.min(0.5, dur / 2 || 0);
      await wait('seeked', 1500);
      try { thumb = makeThumb(v, w, h); } catch {}
    }
    return { kind, mime: MIMES.includes(file.type) ? file.type : 'video/mp4', blob: file, w, h, thumb, dur };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function pickFile(file) {
  const c = state.contacts[activeId];
  if (!c || c.blocked || !file) return;
  let prep;
  toast('جارٍ تجهيز الملف…', 'hourglass_top', 20000);
  try { prep = await prepareMedia(file); } catch (err) { return toast(ERR[err.message] || ERR.decode, 'error'); }
  hideToast();
  const res = await previewDialog(prep);
  if (res) sendMedia(c, prep, res.caption, res.protect);
}

// ---------- الحساب التجريبي ----------
// شخص وهمي يعيش داخل الجهاز فقط: يرد تلقائيًا ويحاكي علامات الصح، ولا يرسل شيئًا للإنترنت.
function ensureDemo(force = false) {
  if (state.contacts[DEMO_ID]) return state.contacts[DEMO_ID];
  if (!force && state.demoAdded) return null;
  state.demoAdded = true;
  const c = state.contacts[DEMO_ID] = { ...newContact({ id: DEMO_ID, pub: '', name: 'سالم (تجريبي)', color: 'sky' }), bot: true };
  const now = Date.now();
  insertMsg(c, { id: rid(), me: false, ts: now, text: 'أهلًا! 👋 أنا سالم، حساب تجريبي داخل جهازك فقط وأرد عليك تلقائيًا.' });
  insertMsg(c, { id: rid(), me: false, ts: now + 1, text: 'اكتب لي أي شيء، أو أرسل صورة أو فيديو من زر 🖼️ — وراقب علامات الصح ✓ ✓✓' });
  c.unread = 2;
  save();
  return c;
}

function setTyping(c, on) {
  const n = Math.max(0, (typing.get(c.id) || 0) + (on ? 1 : -1));
  typing.set(c.id, n);
  renderList();
  if (activeId !== c.id) return;
  renderConvHead(c);
  const box = $('#messages');
  const row = $('.typing-row', box);
  if (n && !row) {
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.insertAdjacentHTML('beforeend', '<div class="msg in typing-row new"><div class="bubble typing"><i></i><i></i><i></i></div></div>');
    if (stick) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  } else if (!n && row) row.remove();
}

function botHandle(c, m) {
  const alive = () => state.contacts[c.id] === c && !c.blocked;
  const later = (ms, fn) => setTimeout(() => { if (alive()) fn(); }, ms);
  later(350, () => setStatus(c, m, 'sent'));
  later(900, () => setStatus(c, m, 'delivered'));
  const reply = botReply(c, m);
  later(1600, () => { setStatus(c, m, 'read'); setTyping(c, true); });
  later(1600 + reply.delay, async () => {
    const r = { id: rid(), me: false, text: reply.text, ts: Date.now() };
    if (reply.image) {
      try {
        const img = await botImage();
        putBlob(r.id, img.blob);
        r.media = { kind: 'image', mime: 'image/jpeg', w: img.w, h: img.h, thumb: img.thumb, dur: 0, size: img.blob.size, st: 'ready' };
      } catch {}
    }
    setTyping(c, false);
    receive(c, r);
  });
}

function botReply(c, m) {
  const t = String(m.text || '').replace(/[ً-ْـ]/g, '').toLowerCase();
  const has = (...w) => w.some((x) => t.includes(x));
  let text = '', image = false;
  if (m.media?.pr) text = 'وصلت محمية 🛡️ — ما أقدر أشوفها إلا وأنا ضاغط عليها، وعليها اسمي كعلامة مائية.';
  else if (m.media) text = m.media.kind === 'image' ? pick(['صورة حلوة! 📸 وصلتني بدون مشاكل.', 'وصلت الصورة ✅ شفت كيف تتحمّل؟']) : pick(['وصلني الفيديو 🎬 شغّال تمام!', 'فيديو رهيب! 👌 وصل كامل.']);
  else if (has('السلام', 'سلام')) text = 'وعليكم السلام ورحمة الله 🌿';
  else if (has('كيف حالك', 'كيفك', 'شلونك', 'اخبارك', 'أخبارك')) text = 'بخير الحمد لله 😊 وأنت؟';
  else if (has('مرحبا', 'هلا', 'اهلا', 'أهلا', 'hi', 'hello')) text = 'هلا والله! 👋 جرّب ترسل لي صورة.';
  else if (has('صورة', 'صوره', 'صور')) { text = 'تفضل، سويت لك هذي الصورة 🎨'; image = true; }
  else if (has('اسمك', 'من انت', 'مين انت', 'من أنت')) text = 'أنا سالم، حساب تجريبي يعيش داخل جهازك فقط. رسائلي ما تطلع للإنترنت 🙂';
  else if (has('شكرا', 'مشكور', 'يعطيك')) text = 'العفو! 🌹';
  else if (has('تست', 'test', 'تجربة', 'تجربه')) text = 'التجربة ناجحة ✅ الرسالة وصلت وقريتها.';
  else if (has('ثيم', 'داكن', 'ليلي')) text = 'تقدر تغيّر الثيم من الإعدادات ⚙️ ← المظهر.';
  else {
    const short = [...String(m.text)].slice(0, 40).join('');
    text = pick([`وصلتني رسالتك: «${short}» ✅`, 'تمام 👍', 'اكتب "صورة" وأرسل لك صورة 🎨', 'جرّب ترسل لي فيديو قصير 🎬', 'تقدر توقف إشعارات القراءة من الإعدادات 👀', 'حلو! 😄']);
  }
  return { text, image, delay: 700 + Math.min(1800, text.length * 30) };
}

async function botImage() {
  const w = 800, h = 520;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const palettes = [['#e2ebf8', '#f3e9dc'], ['#e2eee5', '#ede6f6'], ['#f7e4e4', '#e2ebf8'], ['#ede6f6', '#f3e9dc']];
  const [a, b] = pick(palettes);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.25})`;
    ctx.beginPath();
    ctx.arc(Math.random() * w, Math.random() * h, 20 + Math.random() * 90, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.save();
  ctx.translate(w / 2 - 60, 130);
  ctx.scale(1.25, 1.25);
  const lg = ctx.createLinearGradient(0, 0, 96, 96);
  lg.addColorStop(0, '#7b6cff');
  lg.addColorStop(1, '#4a3fd6');
  ctx.fillStyle = lg;
  ctx.beginPath();
  ctx.roundRect(0, 0, 96, 96, 30);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fill(new Path2D('M48 21c15.8 0 28.5 10.8 28.5 24.2S63.8 69.4 48 69.4c-3.1 0-6-.4-8.8-1.2L27.5 75.5l2.8-10.8C23.8 60.3 19.5 53.2 19.5 45.2 19.5 31.8 32.2 21 48 21z'));
  ctx.strokeStyle = '#5a4df0';
  ctx.lineWidth = 5.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D('M33.5 46l6.5 6.5L52.5 40M46.5 50.5l2 2L61 40'));
  ctx.restore();
  ctx.fillStyle = '#0c0c0d';
  ctx.textAlign = 'center';
  ctx.direction = 'rtl';
  ctx.font = "700 54px 'IBM Plex Sans Arabic', sans-serif";
  ctx.fillText('مرسال', w / 2, 360);
  ctx.font = "400 26px 'IBM Plex Sans Arabic', sans-serif";
  ctx.fillStyle = '#5f5f66';
  ctx.fillText('صورة تجريبية من سالم', w / 2, 410);
  return { blob: await toBlob(cv, 0.9), w, h, thumb: makeThumb(cv, w, h) };
}

// ---------- الحفظ ----------
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); }
function saveNow() {
  clearTimeout(saveTimer);
  if (suspended || wiped || !me) return;
  const cutoff = Date.now() / 1000 - 13 * 3600;
  for (const k in state.seen) if (state.seen[k] < cutoff) delete state.seen[k];
  if (!store.set(stateKey(me.id), state)) {
    for (const c of Object.values(state.contacts)) dropMedia(c.msgs.splice(0, Math.max(0, c.msgs.length - 100)));
    store.set(stateKey(me.id), state);
  }
}
function loadState() {
  let s = store.get(stateKey(me.id), null);
  const legacy = store.get(K.legacyState, null);
  if (!s && legacy) s = legacy; // نقل بيانات الإصدار السابق
  if (legacy) store.del(K.legacyState);
  state = normalizeState(s);
}

function saveSettings() { store.set(K.settings, settings); applySettings(); syncSettingsUI(); }

// ---------- العرض ----------
function tick(status) {
  switch (status) {
    case 'sending': return '<span data-s="sending" class="ms tick" title="جارٍ الإرسال">schedule</span>';
    case 'failed': return '<span data-s="failed" class="ms tick failed" title="لم تُرسل">error</span>';
    case 'sent': return '<span data-s="sent" class="ms tick" title="أُرسلت">check</span>';
    case 'delivered': return '<span data-s="delivered" class="ms tick" title="وصلت">done_all</span>';
    case 'read': return '<span data-s="read" class="ms tick read" title="قُرئت">done_all</span>';
    default: return '';
  }
}

function previewHtml(m) {
  if (!m.media) return `<span class="ci-prev-t">${esc(m.text)}</span>`;
  const img = m.media.kind === 'image';
  return `<span class="ms ci-ic">${img ? 'photo_camera' : 'videocam'}</span><span class="ci-prev-t">${esc(m.text || (img ? 'صورة' : 'فيديو'))}</span>`;
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
      <button class="btn btn-soft" data-act="demo" type="button"><span class="ms">smart_toy</span> جرّب مع حساب تجريبي</button>
    </div>`;
    return;
  }
  const q = $('#search').value.trim().toLowerCase();
  const qid = normalizeId(q);
  const list = all
    .filter((c) => !q || displayName(c).toLowerCase().includes(q) || (qid && c.id.includes(qid)))
    .sort((a, b) => b.updated - a.updated);
  if (!list.length) { box.innerHTML = '<div class="list-note">لا توجد نتائج</div>'; return; }
  box.innerHTML = list.map((c, i) => {
    const last = c.msgs[c.msgs.length - 1];
    let prev;
    if (typing.get(c.id)) prev = '<span class="ci-prev-t typing-t">يكتب…</span>';
    else if (last) prev = (last.me ? tick(last.status) : '') + previewHtml(last);
    else prev = `<span class="ci-prev-t muted">${c.blocked ? 'محظور' : 'ابدأ المحادثة 👋'}</span>`;
    return `<button class="chat-item${c.id === activeId ? ' active' : ''}${c.unread ? ' unread' : ''}" data-id="${esc(c.id)}" type="button" style="--i:${Math.min(i, 12)}">
      ${avatar(displayName(c), c.color, '', c.av)}
      <div class="ci-body">
        <div class="ci-top"><span class="ci-name">${nameHtml(displayName(c), c.id)}</span><span class="ci-time">${last ? listTime(last.ts) : ''}</span></div>
        <div class="ci-bottom"><span class="ci-prev">${prev}</span>${c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div>
      </div>
    </button>`;
  }).join('');
}

function mediaState(m) {
  if (m.me) return m.status === 'sending' ? 'uploading' : 'ready';
  return m.media.st || 'ready';
}

function mediaHtml(m) {
  const md = m.media;
  const st = mediaState(m);
  const ratio = md.w && md.h ? Math.min(Math.max(md.w / md.h, 0.56), 1.9) : md.kind === 'video' ? 16 / 9 : 4 / 3;
  // الوسائط المحمية تظهر للمستلم فقط أثناء الضغط عليها، مع علامة مائية باسمه
  const prot = md.pr && !m.me;
  let body = '';
  if (st === 'ready' || st === 'uploading') {
    body = md.kind === 'image'
      ? `<img class="mb-full" data-src="${esc(m.id)}" alt="صورة" draggable="false">`
      : prot
        ? `<video class="mb-full" data-src="${esc(m.id)}" playsinline preload="metadata" disablepictureinpicture controlslist="nodownload noplaybackrate noremoteplayback"></video>`
        : `<video class="mb-full" data-src="${esc(m.id)}" controls playsinline preload="metadata"></video>`;
  }
  if (prot && st === 'ready') {
    const wm = esc(`${me.name} · ${formatId(me.id)}`);
    body += `<div class="mb-wm" aria-hidden="true">${`<span>${wm}</span>`.repeat(14)}</div>
      <div class="mb-shield"><span class="ms">shield</span><small>اضغط مطولًا للعرض</small></div>`;
  }
  const prBadge = md.pr && m.me && st === 'ready' ? '<span class="mb-pr" title="محمية"><span class="ms fill">shield</span></span>' : '';
  let overlay = '';
  if (st === 'uploading' || st === 'downloading') {
    const p = progress.get(m.id);
    overlay = `<div class="mb-state"><span class="spinner lg"></span><small class="pct">${p ? `${Math.round(p * 100)}%` : ''}</small></div>`;
  }
  else if (st === 'error') overlay = '<button class="mb-state" data-media-retry type="button"><span class="ms">refresh</span><small>تعذّر التحميل — اضغط للمحاولة</small></button>';
  else if (st === 'expired') overlay = '<button class="mb-state" data-media-req type="button"><span class="ms">history</span><small>انتهت صلاحية الملف — اضغط لطلبه من جديد</small></button>';
  else if (st === 'requested') overlay = '<div class="mb-state"><span class="ms">hourglass_top</span><small>بانتظار إعادة الإرسال من المرسل…</small></div>';
  const dur = md.kind === 'video' && md.dur && st !== 'ready' ? `<span class="mb-dur"><span class="ms">videocam</span>${fmtDur(md.dur)}</span>` : '';
  const thumb = md.thumb ? `<img class="mb-thumb" src="${esc(md.thumb)}" alt="">` : '';
  return `<div class="mb${prot ? ' prot' : ''}" data-st="${st}" style="aspect-ratio:${ratio.toFixed(3)}">${thumb}${body}${overlay}${dur}${prBadge}</div>`;
}

function msgHtml(m, prev, isNew) {
  let h = '';
  const newDay = !prev || startOfDay(prev.ts) !== startOfDay(m.ts);
  if (newDay) h += `<div class="day"><span>${dayLabel(m.ts)}</span></div>`;
  const cont = !newDay && prev.me === m.me && m.ts - prev.ts < 5 * 60e3;
  const cls = ['msg', m.me ? 'out' : 'in', cont && 'cont', isNew && 'new', m.status === 'failed' && 'failed'].filter(Boolean).join(' ');
  const title = m.status === 'failed' ? ' title="لم تُرسل — اضغط لإعادة المحاولة"' : '';
  const meta = `<span class="meta"><time>${fmtTime(m.ts)}</time>${m.me ? tick(m.status) : ''}</span>`;
  if (m.media) {
    const bcls = ['bubble', 'media', !m.text && 'bare', m.media.kind === 'video' && 'has-video'].filter(Boolean).join(' ');
    return `${h}<div class="${cls}" data-id="${esc(m.id)}"${title}><div class="${bcls}">${mediaHtml(m)}${m.text ? `<span class="txt">${linkify(m.text)}</span>` : ''}${meta}</div></div>`;
  }
  return `${h}<div class="${cls}" data-id="${esc(m.id)}"${title}><div class="bubble"><span class="txt">${linkify(m.text)}</span>${meta}</div></div>`;
}

function hydrate(root) {
  $$('[data-src]:not([src])', root).forEach(async (el) => {
    const id = el.dataset.src;
    let url = blobUrls.get(id);
    if (!url) {
      const blob = await getBlob(id);
      if (!blob) return;
      url = blobUrls.get(id) || URL.createObjectURL(blob);
      blobUrls.set(id, url);
    }
    if (el.tagName === 'VIDEO') {
      el.addEventListener('loadeddata', () => el.classList.add('loaded'), { once: true });
      el.src = `${url}#t=0.1`;
    } else {
      el.addEventListener('load', () => el.classList.add('loaded'), { once: true });
      el.src = url;
    }
  });
}

function typingRowHtml() {
  return '<div class="msg in typing-row"><div class="bubble typing"><i></i><i></i><i></i></div></div>';
}

function renderMessages(c) {
  const box = $('#messages');
  if (!c.msgs.length) {
    box.innerHTML = `<div class="conv-empty">
      ${avatar(displayName(c), c.color, 'av-lg', c.av)}
      <b>${nameHtml(displayName(c), c.id)}</b>
      <bdi${c.bot ? ' class="plain"' : ''}>${esc(idLabel(c))}</bdi>
      <p>${c.bot ? '🤖 هذا حساب تجريبي داخل جهازك فقط. اكتب له أي شيء 👋' : '🔒 الرسائل في هذه المحادثة مشفّرة من طرف إلى طرف. قل مرحبًا 👋'}</p>
    </div>${typing.get(c.id) ? typingRowHtml() : ''}`;
    return;
  }
  box.innerHTML = c.msgs.map((m, i) => msgHtml(m, c.msgs[i - 1], false)).join('') + (typing.get(c.id) ? typingRowHtml() : '');
  hydrate(box);
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
  const html = msgHtml(m, c.msgs[i - 1], true);
  const tr = $('.typing-row', box);
  if (tr) tr.insertAdjacentHTML('beforebegin', html);
  else box.insertAdjacentHTML('beforeend', html);
  hydrate(box);
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
  if (t && t.dataset.s !== m.status) {
    t.outerHTML = tick(m.status);
    $('.tick', el)?.classList.add('pop');
  }
  if (m.media) refreshMedia(c, m);
}

function refreshMedia(c, m) {
  if (c.id !== activeId) return;
  const el = $(`#messages .msg[data-id="${CSS.escape(m.id)}"] .mb`);
  if (!el || el.dataset.st === mediaState(m)) return;
  // نحافظ على عنصر الصورة/الفيديو إن كان جاهزًا لتجنّب الوميض
  const keep = $('.mb-full[src]', el);
  el.outerHTML = mediaHtml(m);
  const fresh = $(`#messages .msg[data-id="${CSS.escape(m.id)}"] .mb`);
  const slot = $('.mb-full', fresh);
  if (keep && slot) slot.replaceWith(keep);
  hydrate(fresh);
}

function renderConvHead(c) {
  $('#convAv').innerHTML = avatar(displayName(c), c.color, 'av-sm', c.av);
  $('#convName').innerHTML = nameHtml(displayName(c), c.id);
  const isTyping = !!typing.get(c.id);
  $('#convSubWrap').classList.toggle('typing', isTyping);
  $('#convSubIcon').textContent = c.bot ? 'smart_toy' : 'lock';
  $('#convSubIcon').hidden = isTyping;
  $('#convSub').textContent = isTyping ? 'يكتب…' : idLabel(c);
  $('#convSub').classList.toggle('plain', isTyping || !!c.bot);
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
  // عدد الرسائل على أيقونة التطبيق في الشاشة الرئيسية (iOS 16.4+ يتطلب إذن الإشعارات)
  if ('setAppBadge' in navigator) {
    (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {});
  }
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
  const conv = $('#conv');
  conv.classList.remove('enter');
  void conv.offsetWidth;
  conv.classList.add('enter');
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
    if (!isMobile()) setTimeout(() => $('#newId').focus(), 320);
  }
  if (name === 'settings') renderSettings();
}
function closeDrawers() { $$('.drawer.open').forEach((d) => d.classList.remove('open')); }

function toggleMenu() { const m = $('#convMenu'); if (m.hidden || m.classList.contains('closing')) { haptic(); openEl(m); } else closeEl(m); }
function closeMenu() { closeEl($('#convMenu')); toggleAttach(false); }
function toggleAttach(show) {
  const m = $('#attachMenu');
  if (show === undefined) show = m.hidden || m.classList.contains('closing');
  if (show) { haptic(); openEl(m); } else closeEl(m);
  $('#attachBtn').setAttribute('aria-expanded', String(show));
}

function openDemo() {
  const c = ensureDemo(true);
  closeDrawers();
  openChat(c.id);
}

async function convAction(act) {
  closeMenu();
  const c = state.contacts[activeId];
  if (!c) return;
  if (act === 'copy') {
    if (c.bot) toast('هذا حساب تجريبي بلا معرّف', 'smart_toy');
    else copy(formatId(c.id), 'تم نسخ المعرّف');
  }
  if (act === 'block') toggleBlock(c.id);
  if (act === 'clear') {
    const ok = await confirmDialog({ title: 'مسح الرسائل؟', text: `ستُحذف رسائل المحادثة مع ${displayName(c)} من هذا الجهاز فقط.`, ok: 'مسح', danger: true });
    if (!ok) return;
    dropMedia(c.msgs);
    c.msgs = [];
    c.unread = 0;
    save(); renderMessages(c); renderList(); updateTitle();
  }
  if (act === 'delete') {
    const ok = await confirmDialog({ title: 'حذف المحادثة؟', text: `ستُحذف المحادثة مع ${displayName(c)} من هذا الجهاز.${c.bot ? ' يمكنك إرجاعه من «محادثة جديدة».' : ' إذا راسلك مجددًا ستظهر من جديد.'}`, ok: 'حذف', danger: true });
    if (!ok) return;
    dropMedia(c.msgs);
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
  if (!c) {
    c = state.contacts[p.id] = newContact(p);
    if (p.av) c.av = p.av;
  } else {
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
    ${avatar(p.name || '؟', p.color, '', p.av)}
    <div class="found-body"><b>${nameHtml(p.name || 'مستخدم', p.id)}</b><bdi>${formatId(p.id)}</bdi></div>
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
  const ib = $('#installBtn');
  if (ib) ib.hidden = isApp();
  $('meta[name="theme-color"]').content = dark ? '#0e0e10' : '#ffffff';
}

function syncSettingsUI() {
  $$('.segmented').forEach((s) => $$('button', s).forEach((b) => b.classList.toggle('on', settings[s.dataset.setting] === b.dataset.v)));
  $$('.switch[data-setting]').forEach((x) => { x.checked = !!settings[x.dataset.setting]; });
}

function renderSettings() {
  $('#setAv').innerHTML = avatar(me.name, me.color, 'av-xl', me.av);
  $('#removeAvatar').hidden = !me.av;
  $('#setVerified').hidden = !isVerified(me.id);
  $('#passwordLabel').textContent = store.get(vaultKey(me.id), null) ? 'تغيير كلمة المرور' : 'إضافة كلمة مرور';
  if (document.activeElement !== $('#setName')) $('#setName').value = me.name;
  renderSwatches($('#setColors'), me.color, (c) => { me.color = c; saveMe(); });
  syncSettingsUI();
  renderBlocked();
}

function renderBlocked() {
  const list = Object.values(state.contacts).filter((c) => c.blocked);
  $('#blockedList').innerHTML = list.length
    ? list.map((c) => `<div class="row">${avatar(displayName(c), c.color, 'av-sm', c.av)}<span class="row-text"><b>${nameHtml(displayName(c), c.id)}</b><small><bdi>${esc(idLabel(c))}</bdi></small></span><button class="btn btn-soft btn-sm" data-unblock="${esc(c.id)}" type="button">إلغاء الحظر</button></div>`).join('')
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

// ---------- تنبيهات ونوافذ ----------
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
  const body = m.media ? `${m.media.kind === 'image' ? '📷 صورة' : '🎬 فيديو'}${m.text ? ` — ${m.text}` : ''}` : m.text;
  try {
    const n = new Notification(displayName(c), { body: body.slice(0, 140), tag: c.id, icon: 'assets/logo.svg' });
    n.onclick = () => { window.focus(); openChat(c.id); n.close(); };
  } catch {}
}

let toastTimer = null;
function hideToast() { clearTimeout(toastTimer); $('#toast').classList.remove('show'); }
function toast(text, icon = 'check', ms = 2600) {
  const t = $('#toast');
  t.innerHTML = `<span class="ms">${icon}</span><span>${esc(text)}</span>`;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
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

// نافذة عامة: تعرض المحتوى وتعيد قيمة عند الإغلاق
function openModal(html, setup) {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = html;
    openEl(m);
    let cleanup = null, finished = false;
    const done = (v) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey, true);
      const fn = cleanup;
      closeEl(m, () => { m.innerHTML = ''; fn?.(); });
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape' && m.dataset.dismiss !== 'no') { e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    m.onclick = (e) => { if (e.target === m && m.dataset.dismiss !== 'no') done(null); };
    cleanup = setup(m, done);
  });
}

function confirmDialog({ title, text, ok = 'تأكيد', cancel = 'إلغاء', danger = false }) {
  $('#modal').dataset.dismiss = cancel ? 'yes' : 'no';
  return openModal(`<div class="modal-card" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="modal-actions">
        ${cancel ? `<button class="btn btn-soft" data-r="0" type="button">${esc(cancel)}</button>` : ''}
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-r="1" type="button">${esc(ok)}</button>
      </div>
    </div>`, (m, done) => {
    $$('[data-r]', m).forEach((b) => { b.onclick = () => done(b.dataset.r === '1'); });
    setTimeout(() => $('[data-r="1"]', m)?.focus(), 50);
  }).then((v) => v === true);
}

function previewDialog(prep) {
  const url = URL.createObjectURL(prep.blob);
  const img = prep.kind === 'image';
  $('#modal').dataset.dismiss = 'yes';
  return openModal(`<div class="modal-card preview" role="dialog" aria-modal="true">
      <div class="pv-head">
        <button class="icon-btn" data-close-pv type="button" aria-label="إلغاء"><span class="ms">close</span></button>
        <b>${img ? 'إرسال صورة' : 'إرسال فيديو'}</b>
        <span class="pv-size">${fmtSize(prep.blob.size)}${prep.dur ? ` · ${fmtDur(prep.dur)}` : ''}</span>
      </div>
      <div class="pv-media">${img ? `<img src="${url}" alt="">` : `<video src="${url}" controls playsinline muted></video>`}</div>
      <div class="pv-opts"><button class="chip${settings.protect ? ' on' : ''}" type="button" data-protect aria-pressed="${settings.protect}"><span class="ms fill">shield</span> محمية من الحفظ</button></div>
      <form class="pv-row">
        <input class="input" id="pvCaption" placeholder="أضف تعليقًا (اختياري)" maxlength="${MAX_CAPTION}" autocomplete="off" />
        <button class="send-btn" type="submit" aria-label="إرسال"><span class="ms fill flip">send</span></button>
      </form>
    </div>`, (m, done) => {
    $('[data-close-pv]', m).onclick = () => done(null);
    const chip = $('[data-protect]', m);
    chip.onclick = () => { const on = !chip.classList.contains('on'); chip.classList.toggle('on', on); chip.setAttribute('aria-pressed', String(on)); };
    $('form', m).onsubmit = (e) => {
      e.preventDefault();
      done({ caption: String($('#pvCaption').value || '').trim().slice(0, MAX_CAPTION), protect: chip.classList.contains('on') });
    };
    if (!isMobile()) setTimeout(() => $('#pvCaption').focus(), 50);
    return () => URL.revokeObjectURL(url);
  });
}

function openViewer(src, id) {
  const v = $('#viewer');
  const md = Object.values(state.contacts).flatMap((c) => c.msgs).find((x) => x.id === id)?.media;
  const ext = (md?.mime || 'image/jpeg').split('/')[1].replace('jpeg', 'jpg');
  v.innerHTML = `<div class="viewer-bar">
      <button class="icon-btn" data-close-viewer type="button" aria-label="إغلاق"><span class="ms">close</span></button>
      <a class="icon-btn" href="${esc(src)}" download="mersal-${esc(id)}.${esc(ext)}" aria-label="حفظ"><span class="ms">download</span></a>
    </div>
    <img src="${esc(src)}" alt="">`;
  openEl(v);
  v.onclick = (e) => { if (e.target === v || e.target.closest('[data-close-viewer]')) closeViewer(); };
}
function closeViewer() { const v = $('#viewer'); closeEl(v, () => { v.innerHTML = ''; }); }

// ---------- حماية الوسائط ----------
function revealProtected(mb) {
  if (!mb || mb.classList.contains('reveal')) return;
  haptic();
  hideProtected();
  mb.classList.add('reveal');
  const v = $('video', mb);
  if (v) v.play().catch(() => {});
}
function hideProtected() {
  $$('.mb.prot.reveal').forEach((mb) => {
    mb.classList.remove('reveal');
    const v = $('video', mb);
    if (v) v.pause();
  });
}

// ---------- كلمة المرور وتسجيل الخروج ----------
function passwordDialog() {
  const has = !!store.get(vaultKey(me.id), null);
  $('#modal').dataset.dismiss = 'yes';
  return openModal(`<form class="modal-card" role="dialog" aria-modal="true" novalidate>
      <h3>${has ? 'تغيير كلمة المرور' : 'إضافة كلمة مرور'}</h3>
      <p>ادخل بها مع معرّفك <bdi class="mono">${formatId(me.id)}</bdi> متى ما أردت. اختر كلمة قوية (8 أحرف على الأقل) ولا تنسها.</p>
      <input type="text" autocomplete="username" value="${formatId(me.id)}" hidden />
      <label class="field"><span>كلمة المرور</span><input class="input" id="pw1" type="password" dir="ltr" autocomplete="new-password" /></label>
      <label class="field"><span>تأكيد كلمة المرور</span><input class="input" id="pw2" type="password" dir="ltr" autocomplete="new-password" /></label>
      <div class="modal-actions">
        <button class="btn btn-soft" data-r="0" type="button">إلغاء</button>
        <button class="btn btn-primary" type="submit">حفظ</button>
      </div>
    </form>`, (m, done) => {
    $('[data-r="0"]', m).onclick = () => done(false);
    $('form', m).onsubmit = async (e) => {
      e.preventDefault();
      const a = $('#pw1', m).value, b = $('#pw2', m).value;
      if (a.length < 8) { shake($('#pw1', m)); return toast('كلمة المرور قصيرة — 8 أحرف على الأقل.', 'error'); }
      if (a !== b) { shake($('#pw2', m)); return toast('كلمتا المرور غير متطابقتين.', 'error'); }
      const btn = $('[type="submit"]', m);
      busy(btn, true);
      try {
        store.set(vaultKey(me.id), await makeVault(a));
        publishVault(true);
        done(true);
        renderSettings();
        toast('تم حفظ كلمة المرور');
      } catch {
        busy(btn, false);
        toast('تعذّر حفظ كلمة المرور.', 'error');
      }
    };
    setTimeout(() => $('#pw1', m).focus(), 80);
  });
}

async function signOut() {
  if (!store.get(vaultKey(me.id), null)) {
    const ok = await confirmDialog({ title: 'أضف كلمة مرور أولًا', text: 'حتى تستطيع الدخول مجددًا بمعرّفك، أضف كلمة مرور قبل تسجيل الخروج.', ok: 'إضافة كلمة مرور' });
    if (ok) passwordDialog();
    return;
  }
  const ok = await confirmDialog({
    title: 'تسجيل الخروج؟',
    text: `للدخول مجددًا استخدم معرّفك ${formatId(me.id)} وكلمة المرور. تبقى محادثاتك محفوظة على هذا الجهاز.`,
    ok: 'تسجيل الخروج',
  });
  if (!ok) return;
  await publishVault(true);
  store.set(profKey(me.id), { av: me.av || '', ah: me.ah || '' });
  saveNow();
  wiped = true;
  es?.close();
  store.del(K.id);
  location.replace(location.pathname);
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

let obAvatar = '';
function renderObAvatar() {
  $('#obAv').innerHTML = avatar(cleanName($('#obName').value) || '؟', obColor, 'av-xl', obAvatar);
}

function showOnboard() {
  $('#app').hidden = true;
  $('#onboard').hidden = false;
  bootDone();
  renderSwatches($('#obColors'), obColor, (c) => { obColor = c; renderObAvatar(); });
  renderObAvatar();
  // من سجّل خروجه سابقًا يرى شاشة الدخول مباشرة
  const last = store.get(K.lastId, null);
  if (last && store.get(vaultKey(last), null)) {
    obStep('login');
    $('#obLoginId').value = formatId(last);
    $('#obLoginTitle').textContent = 'مرحبًا مجددًا 👋';
    if (!isMobile()) setTimeout(() => $('#obLoginPw').focus(), 100);
  } else {
    obStep('welcome');
    if (!isMobile()) setTimeout(() => $('#obName').focus(), 100);
  }
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
  bootDone();
  store.set(K.lastId, me.id);
  loadState();
  channel?.postMessage({ t: 'takeover' });
  ensureDemo();
  $('#chatList').classList.add('intro');
  setTimeout(() => $('#chatList').classList.remove('intro'), 1000);
  renderMe();
  renderList();
  updateTitle();
  subscribe();
  publishProfile();
  publishVault();
  handleHash();
  // استكمال تنزيل المرفقات التي انقطع تنزيلها
  for (const c of Object.values(state.contacts)) {
    for (const m of c.msgs) if (!m.me && m.media?.st === 'downloading') downloadMedia(c, m);
  }
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
      if (obAvatar) { me.av = obAvatar; me.ah = await avatarHash(obAvatar); }
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
  $$('[data-ob]').forEach((b) => { b.onclick = () => obStep(b.dataset.ob); });
  $('#obName').addEventListener('input', renderObAvatar);
  $('#obAvatarInput').onchange = async () => {
    const f = $('#obAvatarInput').files[0];
    $('#obAvatarInput').value = '';
    if (!f) return;
    try { obAvatar = await makeAvatar(f); renderObAvatar(); } catch (err) { toast(ERR[err.message] || ERR.decode, 'error'); }
  };
  $('#obLoginForm').onsubmit = async (e) => {
    e.preventDefault();
    const id = normalizeId($('#obLoginId').value);
    const pw = $('#obLoginPw').value;
    if (!validId(id)) { shake($('#obLoginId')); return toast('المعرّف غير صحيح.', 'error'); }
    if (!pw) return shake($('#obLoginPw'));
    const btn = $('#obLoginGo');
    busy(btn, true);
    try {
      const { ident, vault } = await login(id, pw);
      me = ident;
      const prof = store.get(profKey(id), null) || (await lookupProfile(id).catch(() => null));
      if (prof?.av && validAvatar(prof.av)) { me.av = prof.av; me.ah = await avatarHash(prof.av); }
      store.set(vaultKey(id), vault);
      store.set(K.id, me);
      $('#obLoginPw').value = '';
      startApp();
    } catch (err) {
      const msg = {
        password: 'كلمة المرور غير صحيحة.',
        missing: 'لم نجد هذا الحساب. إن لم يُفتح منذ أكثر من 12 ساعة على أي جهاز، استخدم المفتاح الاحتياطي.',
        network: ERR.network,
      }[err.message] || 'تعذّر تسجيل الدخول.';
      toast(msg, 'error', 4500);
      if (err.message === 'password') shake($('#obLoginPw'));
    } finally {
      busy(btn, false);
    }
  };
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
    const c = state.contacts[activeId];
    const row = e.target.closest('.msg');
    if (!c || !row) return;
    const m = c.msgs.find((x) => x.id === row.dataset.id);
    if (!m) return;
    const img = e.target.closest('img.mb-full.loaded');
    if (img && !img.closest('.mb.prot')) return openViewer(img.src, m.id);
    if (e.target.closest('[data-media-retry]')) return downloadMedia(c, m);
    if (e.target.closest('[data-media-req]')) return requestResend(c, m);
    if (row.classList.contains('failed') && !e.target.closest('a, video')) retry(m.id);
  };
  input.addEventListener('input', () => { autosize(); if (activeId) drafts[activeId] = input.value; });
  // عند الضغط على مربع الكتابة تبقى آخر الرسائل ظاهرة فوق لوحة المفاتيح
  input.addEventListener('focus', () => setTimeout(() => scrollToEnd(true), 120));
  // زر الإرسال لا يسحب التركيز من مربع الكتابة، فتبقى لوحة المفاتيح مفتوحة
  $('#sendBtn').addEventListener('mousedown', (e) => e.preventDefault());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && settings.enterSend) {
      e.preventDefault();
      sendCurrent();
    }
  });
  input.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => /^(image|video)\//.test(x.type));
    if (f) { e.preventDefault(); pickFile(f); }
  });
  $('#composer').onsubmit = (e) => { e.preventDefault(); sendCurrent(); input.focus(); };

  // الصور والفيديو
  // المتصفحات داخل التطبيقات (تيليجرام، إنستغرام…) قد لا تسمح برفع الملفات
  $('#attachHint').hidden = !/Telegram|Instagram|FBAN|FBAV|FB_IAB|Snapchat|musical_ly|BytedanceWebview|Line\/|MicroMessenger|; wv\)/i.test(navigator.userAgent);
  $('#attachBtn').onclick = (e) => { e.stopPropagation(); toggleAttach(); };
  $('#attachMenu').onclick = (e) => { if (e.target.closest('label')) setTimeout(() => toggleAttach(false), 60); };
  for (const id of ['#fileInput', '#cameraInput']) {
    $(id).onchange = () => {
      const f = $(id).files[0];
      $(id).value = '';
      if (f) pickFile(f);
    };
  }
  const conv = $('#conv');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  conv.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); conv.classList.add('dragging'); } });
  conv.addEventListener('dragleave', (e) => { if (!conv.contains(e.relatedTarget)) conv.classList.remove('dragging'); });
  conv.addEventListener('drop', (e) => {
    conv.classList.remove('dragging');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const f = [...e.dataTransfer.files][0];
    if (f && !/^(image|video)\//.test(f.type)) return toast(ERR.type, 'error');
    pickFile(f);
  });

  // الإعدادات
  $$('.segmented').forEach((s) => {
    s.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[s.dataset.setting] = b.dataset.v;
      // انتقال ناعم عند تغيير الثيم
      if (s.dataset.setting === 'theme' && document.startViewTransition && !reduceMotion()) document.startViewTransition(saveSettings);
      else saveSettings();
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
  $('#avatarInput').onchange = async () => {
    const f = $('#avatarInput').files[0];
    $('#avatarInput').value = '';
    if (!f) return;
    try {
      me.av = await makeAvatar(f);
      me.ah = await avatarHash(me.av);
      saveMe();
      pushAvatar();
      toast('تم تحديث صورتك');
    } catch (err) { toast(ERR[err.message] || ERR.decode, 'error'); }
  };
  $('#removeAvatar').onclick = () => { me.av = ''; me.ah = ''; saveMe(); pushAvatar(); toast('تمت إزالة الصورة'); };
  $('#passwordBtn').onclick = () => passwordDialog();
  $('#installBtn').onclick = () => showInstall();
  matchMedia('(display-mode: standalone)').addEventListener?.('change', applySettings);
  $('#signoutBtn').onclick = () => signOut();
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
      text: 'سيُحذف المفتاح وجميع المحادثات والصور من هذا المتصفح. إن لم تحفظ المفتاح الاحتياطي فلن تستطيع استعادة هذا المعرّف.',
      ok: 'حذف',
      danger: true,
    });
    if (!ok) return;
    wiped = true;
    es?.close();
    [K.id, K.legacyState, K.lastId, stateKey(me.id), vaultKey(me.id), profKey(me.id)].forEach((k) => store.del(k));
    try { indexedDB.deleteDatabase('mrsl'); } catch {}
    location.replace(location.pathname);
  };

  // عام
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#convMenu')) closeEl($('#convMenu'));
    if (!e.target.closest('#attachMenu, #attachBtn')) toggleAttach(false);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'copy-id' && me) copy(formatId(me.id), 'تم نسخ معرّفك');
    if (act === 'share' && me) shareInvite();
    if (act === 'new-chat') openDrawer('newChat');
    if (act === 'demo' && me) openDemo();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !$('#modal').hidden) return;
    if (!$('#viewer').hidden) return closeViewer();
    if (!$('#convMenu').hidden || !$('#attachMenu').hidden) return closeMenu();
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
  // حماية الوسائط: تظهر أثناء الضغط فقط، وتختفي فورًا عند مغادرة الصفحة أو محاولة التصوير
  const msgs = $('#messages');
  msgs.addEventListener('pointerdown', (e) => { const mb = e.target.closest('.mb.prot'); if (mb) revealProtected(mb); });
  ['pointerup', 'pointercancel'].forEach((ev) => document.addEventListener(ev, hideProtected));
  msgs.addEventListener('pointerleave', hideProtected);
  msgs.addEventListener('contextmenu', (e) => { if (e.target.closest('.mb.prot')) e.preventDefault(); });
  window.addEventListener('blur', hideProtected);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hideProtected(); });
  document.addEventListener('keydown', (e) => {
    const shot = e.key === 'PrintScreen' || (e.metaKey && e.shiftKey && ['3', '4', '5', 's', 'S'].includes(e.key));
    if (shot) {
      hideProtected();
      if ($('.mb.prot')) toast('تم إخفاء الوسائط المحمية', 'shield');
    }
  }, true);
  window.addEventListener('pagehide', saveNow);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySettings);
}

// ---------- منع التكبير ----------
// Safari على iPhone يتجاهل user-scalable=no أحيانًا، فنمنع إيماءة التكبير بإصبعين
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
// النقر المزدوج يمنعه touch-action: manipulation في CSS دون تأخير النقرات المتتالية

// ---------- ملاءمة لوحة المفاتيح على الجوال ----------
// iPhone لا يصغّر الصفحة عند فتح لوحة المفاتيح، فنضبط ارتفاع التطبيق على المساحة الظاهرة
// ونبقي آخر رسالة ظاهرة، مثل تطبيقات الدردشة.
function scrollToEnd(smooth) {
  const box = $('#messages');
  if (box && activeId) box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}
function fitViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement.style;
  root.setProperty('--app-h', `${Math.round(vv.height)}px`);
  root.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`);
  document.body.classList.toggle('kb-open', window.innerHeight - vv.height > 120);
}

// تبقى آخر رسالة ملتصقة بالأسفل طوال حركة تغيّر الحجم (لوحة المفاتيح، كبر مربع الكتابة)
let stickToEnd = true;
{
  const box = $('#messages');
  box.addEventListener('scroll', () => { stickToEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 90; }, { passive: true });
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => { if (stickToEnd && activeId) box.scrollTop = box.scrollHeight; }).observe(box);
  }
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', fitViewport);
  visualViewport.addEventListener('scroll', fitViewport);
  fitViewport();
}

// ---------- البدء ----------
function bootDone() {
  window.__booted = true;
  clearTimeout(window.__bootT);
  const b = $('#boot');
  if (b) closeEl(b, () => b.remove());
}

try {
  applySettings();
  bindUI();
  if (me) startApp();
  else showOnboard();
} catch (err) {
  console.error(err);
  window.__bootFail?.();
}
