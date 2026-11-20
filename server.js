'use strict';
// EasyTournament server. Zero npm dependencies. Needs Node >= 22.13 (built-in SQLite).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const E = process.env;
const PORT = +E.PORT || 3000, DATA = E.DATA_DIR || path.join(__dirname, 'data');
const DEMO = E.DEMO_MONEY === '1';                       // test deposits without Stripe (NEVER in production)
const REVIEW_MS = +E.REVIEW_MS || 24 * 3600 * 1000;      // complaint window before prizes are released
const TICK_MS = +E.TICK_MS || 30000, BASE = (E.PUBLIC_URL || '').trim().replace(/\/$/, '');
const SUPPORT = (E.SUPPORT_KEY || '').trim(), STRIPE = (E.STRIPE_SECRET_KEY || '').trim(), WH = (E.STRIPE_WEBHOOK_SECRET || '').trim();
const CALL_MS = +E.CALL_MS || 15000;
const OAI_KEY = (E.OPENAI_API_KEY || '').trim(), OAI_BASE = (E.OPENAI_API_BASE || 'https://api.openai.com/v1').trim().replace(/\/$/, ''), OAI_MODEL = (E.OPENAI_IMAGE_MODEL || 'gpt-image-1').trim(), AI_LIMIT = +E.AI_DAILY_LIMIT || 8;
const SB_URL = ((E.SUPABASE_URL || '').trim()).replace(/\/$/, ''), SB_KEY = (E.SUPABASE_PUBLISHABLE_KEY || '').trim(), JWKS_URL = E.SUPABASE_JWKS_URL || (SB_URL ? SB_URL + '/auth/v1/.well-known/jwks.json' : '');
const AUTH_LOCAL = E.AUTH_LOCAL !== undefined ? E.AUTH_LOCAL === '1' : !SB_URL;      // local email+password only when Supabase is not configured
const ADS_CLIENT = E.ADSENSE_CLIENT || '', ADS_SLOT = E.ADSENSE_SLOT || '';
const FLW = (E.FLW_SECRET_KEY || '').trim(), FLW_HASH = (E.FLW_SECRET_HASH || '').trim(), FLW_BASE = (E.FLW_API_BASE || 'https://api.flutterwave.com/v3').replace(/\/$/, '');
const RATE = +E.USD_TZS_RATE || 0, FEE = Math.max(0, +E.DEPOSIT_FEE_PCT || 0) / 100;   // RATE: TZS per 1 USD (include your margin). FEE: optional % added to what the payer is charged
const PPID = (E.PAYPAL_CLIENT_ID || '').trim(), PPSEC = (E.PAYPAL_CLIENT_SECRET || '').trim(), PPBASE = (E.PAYPAL_API_BASE || 'https://api-m.paypal.com').trim().replace(/\/$/, ''), PPWH = (E.PAYPAL_WEBHOOK_ID || '').trim(), PP = !!(PPID && PPSEC);
function methodsList() {   // what the deposit screen may offer, based on which providers are configured
  if (E.PAY_PROVIDER === 'demo') return [{ id: 'demo', label: 'Test deposit (demo money)' }];
  const m = []; if (DEMO) m.push({ id: 'demo', label: 'Test deposit (demo money, no real payment)' }); if (PP) m.push({ id: 'paypal', label: 'PayPal (cards, and Google Pay where available)' });
  if (FLW || STRIPE) m.push({ id: 'card', label: 'Visa / Mastercard' }); if (FLW && RATE) m.push({ id: 'mobile', label: 'Mobile money (Tanzania, TZS)' }); return m;
}
function depositRoute(m) {
  if (E.PAY_PROVIDER === 'demo' || (m === 'demo' && DEMO)) return 'demo'; if (m === 'paypal' && PP) return 'paypal'; if (m === 'mobile' && FLW && RATE) return 'flutterwave';
  if (m === 'card' && FLW) return 'flutterwave'; if (m === 'card' && STRIPE) return 'stripe'; if (DEMO && !FLW && !STRIPE && !PP) return 'demo';
  throw new HttpErr(503, 'This payment method is not available yet');
}
const PROD = E.NODE_ENV === 'production';
if (PROD && DEMO) { console.error('Refusing to start: DEMO_MONEY=1 is not allowed in production.'); process.exit(1); }
if (PROD && SUPPORT.length < 20) { console.error('Refusing to start: set SUPPORT_KEY (20+ characters) in production.'); process.exit(1); }
const WD_MIN_AGE = E.WITHDRAW_MIN_AGE_MS !== undefined ? +E.WITHDRAW_MIN_AGE_MS : 864e5, WD_DAILY = +E.WITHDRAW_DAILY_CENTS || 50000, WD_MIN = 500;
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'easytournament.db'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,pw TEXT NOT NULL,salt TEXT NOT NULL,pin TEXT,pin_salt TEXT,pin_fail INTEGER DEFAULT 0,pin_lock INTEGER DEFAULT 0,sig_name TEXT,sig_at INTEGER,created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY,user_id INTEGER,created INTEGER);
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY,account TEXT NOT NULL,cents INTEGER NOT NULL,kind TEXT,ref TEXT,note TEXT,created INTEGER);
CREATE INDEX IF NOT EXISTS ledger_acc ON ledger(account);
CREATE TABLE IF NOT EXISTS leagues(code TEXT PRIMARY KEY,admin_id INTEGER,mode TEXT,fee INTEGER DEFAULT 0,status TEXT DEFAULT 'open',review_at INTEGER,rk TEXT,payouts TEXT,data TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS members(code TEXT,user_id INTEGER,display TEXT,team TEXT,logo TEXT,paid INTEGER DEFAULT 0,paid_at INTEGER,PRIMARY KEY(code,user_id));
CREATE TABLE IF NOT EXISTS proofs(id INTEGER PRIMARY KEY,code TEXT,midx INTEGER,user_id INTEGER,author TEXT,type TEXT,val TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS complaints(id INTEGER PRIMARY KEY,code TEXT,user_id INTEGER,author TEXT,body TEXT,resolved INTEGER DEFAULT 0,created INTEGER);
CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY,code TEXT,user_id INTEGER,author TEXT,body TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS withdrawals(id INTEGER PRIMARY KEY,user_id INTEGER,cents INTEGER,method TEXT,dest TEXT,status TEXT DEFAULT 'pending',created INTEGER);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ai_usage(user_id INTEGER,day TEXT,n INTEGER DEFAULT 0,PRIMARY KEY(user_id,day));
CREATE TABLE IF NOT EXISTS saved_methods(id INTEGER PRIMARY KEY,user_id INTEGER,provider TEXT,kind TEXT,label TEXT,token TEXT,meta TEXT,created INTEGER,UNIQUE(user_id,token));
CREATE TABLE IF NOT EXISTS push_subs(id INTEGER PRIMARY KEY,user_id INTEGER,endpoint TEXT UNIQUE,p256dh TEXT,auth TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS slots(code TEXT,id TEXT,team TEXT,logo TEXT,user_id INTEGER,PRIMARY KEY(code,id));
CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY,code TEXT,midx INTEGER,from_id INTEGER,to_id INTEGER,from_name TEXT,to_name TEXT,from_team TEXT,to_team TEXT,lname TEXT,whn TEXT,dur INTEGER,created INTEGER,expires INTEGER,status TEXT,ended INTEGER);
CREATE TABLE IF NOT EXISTS deposits(ref TEXT PRIMARY KEY,user_id INTEGER,usd INTEGER,currency TEXT,amount REAL,status TEXT DEFAULT 'pending',created INTEGER,provider TEXT,pid TEXT);
CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY,user_id INTEGER,author TEXT,title TEXT,game TEXT,type TEXT,url TEXT,size INTEGER DEFAULT 0,views INTEGER DEFAULT 0,created INTEGER);`);
const VID_DIR = path.join(DATA, 'videos'), MAXV = 100 * 1024 * 1024; fs.mkdirSync(VID_DIR, { recursive: true });

function backup() {
  const dir = path.join(DATA, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'et-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db'); db.exec("VACUUM INTO '" + f.replace(/'/g, "''") + "'");
  fs.readdirSync(dir).filter(x => x.endsWith('.db')).sort().slice(0, -8).forEach(x => fs.rmSync(path.join(dir, x), { force: true })); return f;
}
setInterval(() => { try { backup(); } catch (e) { console.error('backup failed', e); } }, 6 * 3600 * 1000).unref?.();
try { db.exec('ALTER TABLE users ADD COLUMN sb_id TEXT'); } catch { }
try { db.exec('ALTER TABLE users ADD COLUMN stripe_customer TEXT'); } catch { }
try { db.exec('ALTER TABLE deposits ADD COLUMN save INTEGER'); } catch { }
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_sb ON users(sb_id)');
for (const col of ['provider TEXT', 'pid TEXT']) { try { db.exec('ALTER TABLE deposits ADD COLUMN ' + col); } catch { } }
class HttpErr extends Error { constructor(s, m) { super(m); this.s = s; } }
const get = (s, ...a) => db.prepare(s).get(...a), all = (s, ...a) => db.prepare(s).all(...a), run = (s, ...a) => db.prepare(s).run(...a);
const now = () => Date.now();
let POST = [];
function tx(fn) { const n0 = POST.length; db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); POST.length = n0; throw e; } }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (p, s) => crypto.scryptSync(String(p), s, 32).toString('hex');
const eq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
const str = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const fmtD = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

// ---- ledger: every movement is two rows that sum to zero. Balances are always SUM(cents). ----
const bal = a => get('SELECT COALESCE(SUM(cents),0) s FROM ledger WHERE account=?', a).s;
function move(from, to, c, kind, ref, note) {
  if (!Number.isInteger(c) || c < 0) throw new HttpErr(400, 'Bad amount');
  if (c === 0) return;
  if (from !== 'ext' && bal(from) < c) throw new HttpErr(402, 'Insufficient balance');
  const t = now(), q = 'INSERT INTO ledger(account,cents,kind,ref,note,created) VALUES(?,?,?,?,?,?)';
  run(q, from, -c, kind, ref, note, t); run(q, to, c, kind, ref, note, t);
  if (to.startsWith('user:')) { const u = +to.slice(5), m = '$' + (c / 100).toFixed(2); if (kind === 'deposit') POST.push([u, { title: '💰 Deposit received', body: m + ' was added to your wallet', url: '/', tag: 'dep-' + ref }]); else if (kind === 'prize') POST.push([u, { title: '🏆 Prize paid: ' + m, body: note, url: '/?join=' + ref, tag: 'prize-' + ref }]); else if (kind === 'admin_fee') POST.push([u, { title: '💰 Admin fee paid: ' + m, body: note, url: '/?join=' + ref, tag: 'fee-' + ref }]); else if (kind === 'refund') POST.push([u, { title: '↩️ Refund: ' + m, body: note, url: '/', tag: 'ref-' + ref }]); }
}
const cents = x => { const n = Math.round(Number(x) * 100); if (!Number.isFinite(n) || n < 100 || n > 500000) throw new HttpErr(400, 'Amount must be between $1 and $5,000'); return n; };

// ---- auth ----
const rl = new Map();
function limit(ip) { const t = now(), r = rl.get(ip) || { n: 0, t }; if (t - r.t > 600000) { r.n = 0; r.t = t; } r.n++; rl.set(ip, r); if (r.n > 40) throw new HttpErr(429, 'Too many attempts. Try later.'); }
function newSession(uid) { const tok = crypto.randomBytes(24).toString('hex'); run('INSERT INTO sessions(h,user_id,created) VALUES(?,?,?)', sha(tok), uid, now()); return tok; }
// ---- Supabase Auth: verify the user's access token (JWT) against Supabase's public keys (JWKS). No secret key is needed. ----
let jwks = { keys: [], t: 0 };
async function getJwks(force) { if (!force && jwks.keys.length && now() - jwks.t < 600000) return jwks.keys; const r = await fetch(JWKS_URL); const j = await r.json().catch(() => ({})); jwks = { keys: j.keys || [], t: now() }; return jwks.keys; }
async function verifySb(tok) {
  const [h, p, sg] = tok.split('.'); let H, P; try { H = JSON.parse(Buffer.from(h, 'base64url')); P = JSON.parse(Buffer.from(p, 'base64url')); } catch { return null; }
  if (!['ES256', 'RS256'].includes(H.alg)) return null;     // legacy HS256 shared-secret tokens are deliberately not accepted
  let k = (await getJwks(false)).find(x => x.kid === H.kid); if (!k) k = (await getJwks(true)).find(x => x.kid === H.kid); if (!k) return null;
  let ok = false; try { const pub = crypto.createPublicKey({ key: k, format: 'jwk' }); ok = crypto.verify('sha256', Buffer.from(h + '.' + p), H.alg === 'ES256' ? { key: pub, dsaEncoding: 'ieee-p1363' } : pub, Buffer.from(sg, 'base64url')); } catch { }
  if (!ok || !P.exp || P.exp * 1000 < now() || P.iss !== SB_URL + '/auth/v1' || P.aud !== 'authenticated' || !P.sub) return null; return P;
}
function sbUser(P) {
  const email = String(P.email || '').toLowerCase(), um = P.user_metadata || {}; if (!email) return null;
  let u = get('SELECT * FROM users WHERE sb_id=?', P.sub); if (u) return u;
  const ex = get('SELECT * FROM users WHERE email=?', email);
  if (ex) { if (ex.sb_id || um.email_verified === false) return null; run('UPDATE users SET sb_id=? WHERE id=?', P.sub, ex.id); return get('SELECT * FROM users WHERE id=?', ex.id); }
  const nm = str(um.full_name || um.name || email.split('@')[0], 40) || 'Player', r = run('INSERT INTO users(email,name,pw,salt,sb_id,created) VALUES(?,?,?,?,?,?)', email, nm, '!', '!', P.sub, now());
  return get('SELECT * FROM users WHERE id=?', Number(r.lastInsertRowid));
}
async function authUserA(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || ''); if (!m) return null;
  if (m[1].split('.').length === 3) { if (!SB_URL) return null; const P = await verifySb(m[1]); return P ? sbUser(P) : null; }
  return authUser(req);
}
// ---- Web Push (VAPID + aes128gcm, RFC 8030 / 8291 / 8292) with no dependencies ----
let VAPID = { pub: E.VAPID_PUBLIC || '', priv: E.VAPID_PRIVATE || '' };
if (!VAPID.pub || !VAPID.priv) {
  const f = path.join(DATA, 'vapid.json');
  try { VAPID = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), j = kp.publicKey.export({ format: 'jwk' }), pj = kp.privateKey.export({ format: 'jwk' });
    VAPID = { pub: Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url'), priv: pj.d }; fs.writeFileSync(f, JSON.stringify(VAPID), { mode: 0o600 });
  }
}
const vPub = Buffer.from(VAPID.pub, 'base64url'), vKey = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: vPub.subarray(1, 33).toString('base64url'), y: vPub.subarray(33, 65).toString('base64url'), d: VAPID.priv }, format: 'jwk' });
function vapidHeader(endpoint) {
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url'), h = b({ typ: 'JWT', alg: 'ES256' }), c = b({ aud: new URL(endpoint).origin, exp: Math.floor(now() / 1000) + 12 * 3600, sub: E.VAPID_SUBJECT || 'mailto:admin@example.com' });
  return 'vapid t=' + h + '.' + c + '.' + crypto.sign('sha256', Buffer.from(h + '.' + c), { key: vKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') + ', k=' + VAPID.pub;
}
function encryptPush(buf, p256dh, auth) {
  const ua = Buffer.from(p256dh, 'base64url'), au = Buffer.from(auth, 'base64url'), e = crypto.createECDH('prime256v1'); e.generateKeys(); const asPub = e.getPublicKey(), secret = e.computeSecret(ua);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, au, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32)), salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const ci = crypto.createCipheriv('aes-128-gcm', cek, nonce), ct = Buffer.concat([ci.update(Buffer.concat([buf, Buffer.from([2])])), ci.final(), ci.getAuthTag()]), rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
async function pushTo(uid, p) {
  for (const s of all('SELECT * FROM push_subs WHERE user_id=?', uid)) {
    try {
      const r = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: vapidHeader(s.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(p.ttl || 86400), Urgency: p.call ? 'high' : 'normal' }, body: encryptPush(Buffer.from(JSON.stringify(p)), s.p256dh, s.auth) });
      if (r.status === 404 || r.status === 410) run('DELETE FROM push_subs WHERE id=?', s.id);
    } catch { /* the push service is unreachable: try again on the next event */ }
  }
}
const flush = () => { const q = POST; POST = []; q.forEach(([u, p]) => notify(u, p)); };
const notify = (uid, p) => { try { pushTo(uid, p).catch(() => { }); } catch { } };
const money = c => '$' + (c / 100).toFixed(2);
function authUser(req) {
  const m = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || ''); if (!m) return null;
  const s = get('SELECT * FROM sessions WHERE h=?', sha(m[1])); if (!s || now() - s.created > 30 * 864e5) return null;
  return get('SELECT * FROM users WHERE id=?', s.user_id);
}
function checkPin(u, pin) {   // call OUTSIDE a transaction so failures are recorded
  if (!u.pin) throw new HttpErr(400, 'Set a PIN first');
  if (u.pin_lock > now()) throw new HttpErr(429, 'PIN locked. Try again in a minute.');
  if (!/^\d{4}$/.test(String(pin)) || !eq(scrypt(pin, u.pin_salt), u.pin)) {
    const f = u.pin_fail + 1; run('UPDATE users SET pin_fail=?,pin_lock=? WHERE id=?', f >= 3 ? 0 : f, f >= 3 ? now() + 60000 : 0, u.id);
    throw new HttpErr(403, 'Wrong PIN');
  }
  run('UPDATE users SET pin_fail=0 WHERE id=?', u.id);
}
const needSigned = u => { if (!u.sig_at) throw new HttpErr(403, 'Sign the agreement in Settings first'); };

// ---- leagues ----
const cid = uid => i => i === 'u' + uid ? 'me' : i;
const sidf = uid => i => i === 'me' ? 'u' + uid : String(i);
const mySlot = (code, uid) => (get('SELECT id FROM slots WHERE code=? AND user_id=?', code, uid) || {}).id;
const meId = (r, uid) => r.mode ? mySlot(r.code, uid) : 'u' + uid;           // this user's player id inside the league
const sidf2 = (r, uid) => i => i === 'me' ? (meId(r, uid) || 'u' + uid) : String(i);
const userOf = (r, id) => r.mode ? (get('SELECT user_id u FROM slots WHERE code=? AND id=?', r.code, id) || {}).u : (/^u\d+$/.test(String(id)) ? +String(id).slice(1) : undefined);
const teamOf = (r, id) => { if (r.mode) return (get('SELECT team FROM slots WHERE code=? AND id=?', r.code, id) || {}).team || ''; const m = get('SELECT team,display FROM members WHERE code=? AND user_id=?', r.code, +String(id).slice(1)); return m ? (m.team || m.display) : ''; };
function isMember(code, uid) { return !!get('SELECT 1 x FROM members WHERE code=? AND user_id=?', code, uid); }
function view(r, uid, mode) {   // mode: 'light' | 'full' | 'public'
  const d = JSON.parse(r.data), ms = all('SELECT * FROM members WHERE code=?', r.code), slots = r.mode ? all('SELECT * FROM slots WHERE code=? ORDER BY rowid', r.code) : [], mine = r.mode ? (slots.find(x => x.user_id === uid) || {}).id : 'u' + uid, c = i => (mine && i === mine) ? 'me' : i;
  const isA = r.admin_id === uid, isM = ms.some(m => m.user_id === uid), priv = mode !== 'public' && (isA || isM);
  const st = r.status === 'review' ? 'Review' : r.status === 'finished' ? 'Finished' : r.status === 'cancelled' ? 'Cancelled' : (d.started ? 'Active' : 'Upcoming');
  const players = r.mode ? slots.map(x => { const m = ms.find(y => y.user_id === x.user_id); return { id: c(x.id), name: m ? m.display : '', team: x.team, logo: x.logo || '', paid: !!x.user_id, pd: m && m.paid_at ? fmtD(m.paid_at) : '', slot: 1, open: !x.user_id }; }) : ms.map(m => ({ id: c('u' + m.user_id), name: m.display, team: m.team || '', logo: m.logo || '', paid: !!m.paid, pd: m.paid_at ? fmtD(m.paid_at) : '' })).concat(d.players || []);
  const o = { n: d.n, c: r.code, g: d.g, d: d.d, rules: d.rules || '', fmt: d.fmt || 'league', logo: d.logo || '', st, p: String(players.length), admin: isA && mode !== 'public' ? 1 : 0, mine: priv ? 1 : 0, mode: r.mode || undefined, started: !!d.started, ko: d.ko || 0, shared: true, joined: isM, dur: d.dur || 0, players, relAt: r.review_at || 0 };
  if (r.mode === 'money') { o.fee = r.fee / 100; o.pot = bal('league:' + r.code) / 100; }
  if (r.rk && r.status === 'finished') { o.rk = JSON.parse(r.rk).map(i => { if (r.mode === 'money') { const x = slots.find(y => 'u' + y.user_id === i); return x ? c(x.id) : i; } return c(i); }); o.finAt = r.review_at || r.created; }
  if (r.payouts) o.payouts = JSON.parse(r.payouts).map(p => ({ n: p.n, a: p.a / 100 }));
  if (mode === 'light' && !priv) { o.matches = []; o.ann = []; return o; }
  const pr = priv ? all('SELECT * FROM proofs WHERE code=? ORDER BY id', r.code) : [];
  o.matches = (d.matches || []).map((m, i) => ({ h: c(m.h), a: m.a ? c(m.a) : null, hs: m.hs, as: m.as, r: m.r, st: m.st, g: m.g, bye: m.bye, ev: m.ev, when: m.when, proofs: pr.filter(p => p.midx === i).map(p => ({ t: p.type, v: p.val, by: p.author, d: fmtD(p.created) })) }));
  o.groups = (d.groups || []).map(g => g.map(c));
  o.fr = (d.fr || []).map(f => ({ pos: Object.fromEntries(Object.entries(f.pos || {}).map(([k, v]) => [c(k), v])) }));
  o.ann = d.ann || [];
  if (priv) {
    o.chat = all('SELECT * FROM chat WHERE code=? ORDER BY id DESC LIMIT 100', r.code).reverse().map(m => ({ by: m.author, t: m.body, d: fmtD(m.created) }));
  }
  o.complaints = all('SELECT * FROM complaints WHERE code=? ORDER BY id', r.code).map(m => ({ by: m.author, t: m.body, d: fmtD(m.created), res: !!m.resolved }));
  return o;
}
function league(code, uid, need) {
  const r = get('SELECT * FROM leagues WHERE code=?', String(code).toUpperCase()); if (!r) throw new HttpErr(404, 'League not found');
  if (need === 'admin' && r.admin_id !== uid) throw new HttpErr(403, 'Only the league admin can do this');
  if (need === 'member' && r.admin_id !== uid && !isMember(r.code, uid)) throw new HttpErr(403, 'Join the league first');
  return r;
}
const evs = a => (Array.isArray(a) ? a : []).slice(0, 30).map(e => ({ t: ['goal', 'assist', 'yellow', 'red', 'own', 'note'].includes(e && e.t) ? e.t : 'note', p: str(e && e.p, 30), min: Math.max(0, Math.min(130, (e && e.min) | 0)), s: e && e.s === 'a' ? 'a' : 'h' }));
const num = v => (v === null || v === '' || v === undefined) ? null : Math.max(0, Math.min(999, Math.round(Number(v) * 2) / 2)) || 0;
const okLogo = s => typeof s === 'string' && s.length < 150000 && (s === '' || /^data:image\/(jpeg|png|webp|svg\+xml)/.test(s)) ? s : '';
function saveLeague(r, b, uid) {
  const d = JSON.parse(r.data), sid = sidf2(r, uid), locked = ['review', 'finished', 'cancelled'].includes(r.status);
  if (!locked && !d.started) { d.n = str(b.n, 60) || d.n; d.g = str(b.g, 40) || d.g; d.d = str(b.d, 30); d.rules = str(b.rules, 600); d.fmt = ['league', 'group', 'ko', 'ffa'].includes(b.fmt) ? b.fmt : d.fmt; }
  d.logo = okLogo(b.logo) || (b.logo === '' ? '' : d.logo);
  d.ann = (Array.isArray(b.ann) ? b.ann : []).slice(0, 50).map(a => ({ t: str(a.t, 200), by: str(a.by, 40), d: str(a.d, 30) }));
  if (!locked) {
    d.started = !!b.started; d.ko = b.ko ? 1 : 0; d.dur = Math.max(0, Math.min(180, b.dur | 0));
    const gid = x => String(sid(x)).slice(0, 20);
    d.groups = (Array.isArray(b.groups) ? b.groups : []).slice(0, 16).map(g => (Array.isArray(g) ? g : []).slice(0, 64).map(gid));
    d.matches = (Array.isArray(b.matches) ? b.matches : []).slice(0, 600).map(m => ({ h: gid(m.h), a: m.a ? gid(m.a) : null, hs: num(m.hs), as: num(m.as), r: Math.max(1, Math.min(99, m.r | 0)), st: m.st === 'ko' ? 'ko' : 'g', g: m.g === undefined ? undefined : m.g | 0, bye: m.bye ? 1 : undefined, ev: evs(m.ev), when: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(m.when || '')) ? m.when : undefined }));
    d.fr = (Array.isArray(b.fr) ? b.fr : []).slice(0, 60).map(f => ({ pos: Object.fromEntries(Object.entries(f && f.pos || {}).slice(0, 64).map(([k, v]) => [gid(k), Math.max(1, Math.min(64, v | 0))])) }));
    d.players = r.mode ? [] : (Array.isArray(b.players) ? b.players : []).filter(p => /^p\d+$/.test(String(p.id))).slice(0, 64).map(p => ({ id: String(p.id), name: str(p.name, 30), team: str(p.team, 30), logo: okLogo(p.logo) }));
    if (d.started && r.status === 'open') run("UPDATE leagues SET status='active' WHERE code=?", r.code);
  }
  for (const p of Array.isArray(b.players) ? b.players : []) if (sid(p.id) === 'u' + uid && isMember(r.code, uid)) run('UPDATE members SET team=?,logo=? WHERE code=? AND user_id=?', str(p.team, 30), okLogo(p.logo), r.code, uid);
  run('UPDATE leagues SET data=? WHERE code=?', JSON.stringify(d), r.code);
}
function addMember(code, u, paid) {
  if (get('SELECT COUNT(*) c FROM members WHERE code=?', code).c >= 64) throw new HttpErr(400, 'League is full');
  run('INSERT INTO members(code,user_id,display,paid,paid_at) VALUES(?,?,?,?,?)', code, u.id, u.name, paid ? 1 : 0, paid ? now() : null);
}
function refund(code, uid, why) {
  const m = get('SELECT * FROM members WHERE code=? AND user_id=?', code, uid), r = get('SELECT * FROM leagues WHERE code=?', code);
  if (m && m.paid && r.mode === 'money') move('league:' + code, 'user:' + uid, r.fee, 'refund', code, why + ' (' + code + ')');
  run('UPDATE slots SET user_id=NULL WHERE code=? AND user_id=?', code, uid);
  run('DELETE FROM members WHERE code=? AND user_id=?', code, uid);
}
function release(code) {   // runs ONLY from the timer: nobody (not even the admin) can trigger or redirect it
  return tx(() => {
    const r = get('SELECT * FROM leagues WHERE code=?', code);
    if (!r || r.status !== 'review' || r.review_at > now() || get('SELECT COUNT(*) c FROM complaints WHERE code=? AND resolved=0', code).c) return false;
    const pot = bal('league:' + code), rk = JSON.parse(r.rk).filter(i => /^u\d+$/.test(i));
    const fee = Math.floor(pot * 0.01), net = pot - 2 * fee, sh = [50, 30, 20].slice(0, Math.min(3, rk.length)), tot = sh.reduce((a, b) => a + b, 0);
    const pay = sh.map((s, i) => ({ u: +rk[i].slice(1), a: Math.floor(net * s / tot), n: i + 1 }));
    if (pay.length) pay[0].a += net - pay.reduce((a, p) => a + p.a, 0);
    const out = [], d = JSON.parse(r.data), name = u => (get('SELECT display FROM members WHERE code=? AND user_id=?', code, u) || {}).display || 'Player';
    for (const p of pay) { move('league:' + code, 'user:' + p.u, p.a, 'prize', code, 'Prize #' + p.n + ': ' + d.n); out.push({ n: p.n + '. ' + name(p.u), a: p.a }); }
    move('league:' + code, 'user:' + r.admin_id, fee, 'admin_fee', code, 'Admin fee 1%: ' + d.n); out.push({ n: 'League admin (1%)', a: fee });
    move('league:' + code, 'platform', bal('league:' + code), 'platform_fee', code, 'Platform fee 1%: ' + d.n); out.push({ n: 'Platform (1%)', a: fee });
    run("UPDATE leagues SET status='finished',payouts=? WHERE code=?", JSON.stringify(out), code); return true;
  });
}
setInterval(() => { try { all("SELECT code FROM leagues WHERE status='review' AND review_at<=?", now()).forEach(r => release(r.code)); flush(); } catch (e) { console.error('release error', e); } }, TICK_MS).unref?.();

// ---- routes ----
const routes = [];
const R = (m, p, fn, auth = true) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, auth });
const meOut = u => ({ id: u.id, name: u.name, email: u.email, hasPin: !!u.pin, sig: u.sig_at ? { n: u.sig_name, d: fmtD(u.sig_at) } : null, balance: bal('user:' + u.id) / 100,
  tx: all('SELECT * FROM ledger WHERE account=? ORDER BY id DESC LIMIT 60', 'user:' + u.id).map(t => ({ t: t.note, a: t.cents / 100, m: t.kind, d: fmtD(t.created) })) });
R('GET', '/api/health', c => ({ ok: true, payments: methodsList().map(x => x.id), paypal: PP ? (PPBASE.includes('sandbox') ? 'sandbox' : 'live') : 'off', aiLogos: !!OAI_KEY, returnUrlBase: BASE || (String(c.req.headers['x-forwarded-proto'] || 'http').split(',')[0] + '://' + c.req.headers.host), support: !!SUPPORT, production: PROD }), false);
R('POST', '/api/signup', c => {
  if (!AUTH_LOCAL) throw new HttpErr(404, 'Use the sign-in page'); limit(c.ip); const e = str(c.b.email, 120).toLowerCase(), n = str(c.b.name, 40), p = String(c.b.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new HttpErr(400, 'Enter a valid email'); if (n.length < 2) throw new HttpErr(400, 'Enter your name'); if (p.length < 8) throw new HttpErr(400, 'Password needs 8+ characters');
  if (get('SELECT 1 x FROM users WHERE email=?', e)) throw new HttpErr(409, 'Email already registered');
  const salt = crypto.randomBytes(16).toString('hex'), r = run('INSERT INTO users(email,name,pw,salt,created) VALUES(?,?,?,?,?)', e, n, scrypt(p, salt), salt, now());
  return { token: newSession(Number(r.lastInsertRowid)) };
}, false);
R('POST', '/api/login', c => {
  if (!AUTH_LOCAL) throw new HttpErr(404, 'Use the sign-in page'); limit(c.ip); const u = get('SELECT * FROM users WHERE email=?', str(c.b.email, 120).toLowerCase());
  if (!u || !eq(scrypt(c.b.password || '', u.salt), u.pw)) throw new HttpErr(401, 'Wrong email or password'); return { token: newSession(u.id) };
}, false);
R('POST', '/api/logout', c => { const t = /[a-f0-9]{48}/.exec(c.req.headers.authorization || ''); if (t && !/\./.test(c.req.headers.authorization)) run('DELETE FROM sessions WHERE h=?', sha(t[0])); return { ok: true }; });
R('GET', '/api/config', () => ({ supabaseUrl: SB_URL, publishableKey: SB_KEY, authLocal: AUTH_LOCAL, vapidPublicKey: VAPID.pub, ads: ADS_CLIENT ? { client: ADS_CLIENT, slot: ADS_SLOT } : null }), false);
R('GET', '/api/public', () => all('SELECT * FROM leagues ORDER BY created DESC LIMIT 100').map(r => view(r, 0, 'light')), false);
R('POST', '/api/push/subscribe', c => {
  const sub = c.b.subscription || c.b, ep = String(sub.endpoint || ''), k = sub.keys || {};
  if (!/^https?:\/\/[^\s]{8,600}$/.test(ep) || !/^[A-Za-z0-9_-]{80,100}$/.test(String(k.p256dh || '')) || !/^[A-Za-z0-9_-]{16,32}$/.test(String(k.auth || ''))) throw new HttpErr(400, 'Invalid subscription');
  tx(() => { run('DELETE FROM push_subs WHERE endpoint=?', ep); if (get('SELECT COUNT(*) c FROM push_subs WHERE user_id=?', c.u.id).c >= 5) run('DELETE FROM push_subs WHERE id=(SELECT MIN(id) FROM push_subs WHERE user_id=?)', c.u.id); run('INSERT INTO push_subs(user_id,endpoint,p256dh,auth,created) VALUES(?,?,?,?,?)', c.u.id, ep, k.p256dh, k.auth, now()); });
  return { ok: true };
});
R('POST', '/api/push/unsubscribe', c => { run('DELETE FROM push_subs WHERE endpoint=? AND user_id=?', String(c.b.endpoint || ''), c.u.id); return { ok: true }; });
R('GET', '/api/me', c => meOut(c.u));
R('POST', '/api/sign', c => {
  const n = str(c.b.name, 60); if (n.length < 3 || !c.b.agree) throw new HttpErr(400, 'Type your full name and accept the agreement');
  run('UPDATE users SET sig_name=?,sig_at=? WHERE id=?', n, now(), c.u.id); return meOut(get('SELECT * FROM users WHERE id=?', c.u.id));
});
R('POST', '/api/pin', c => {
  const p = String(c.b.pin || ''); if (!/^\d{4}$/.test(p)) throw new HttpErr(400, 'PIN must be 4 digits');
  if (c.u.pin) checkPin(c.u, c.b.current);
  const salt = crypto.randomBytes(16).toString('hex'); run('UPDATE users SET pin=?,pin_salt=?,pin_fail=0 WHERE id=?', scrypt(p, salt), salt, c.u.id); return meOut(get('SELECT * FROM users WHERE id=?', c.u.id));
});
// wallet
function keepMethod(uid, provider, kind, label, token, meta) { try { run('INSERT OR IGNORE INTO saved_methods(user_id,provider,kind,label,token,meta,created) VALUES(?,?,?,?,?,?,?)', uid, provider, kind, str(label, 60), String(token), JSON.stringify(meta || {}), now()); } catch { } }
async function flwConfirm(ref) {   // asks Flutterwave directly (never trusts the browser or the webhook body), then credits once
  const row = get('SELECT * FROM deposits WHERE ref=?', ref); if (!row) throw new HttpErr(404, 'Unknown payment');
  if (row.status === 'paid') return true;
  const r = await fetch(FLW_BASE + '/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(ref), { headers: { Authorization: 'Bearer ' + FLW } });
  const j = await r.json().catch(() => ({})), d = j && j.data;
  if (!r.ok || j.status !== 'success' || !d || d.status !== 'successful' || d.tx_ref !== ref || d.currency !== row.currency || Number(d.amount) + 0.01 < row.amount) return false;
  tx(() => { const x = get('SELECT status FROM deposits WHERE ref=?', ref); if (x.status === 'paid') return; run("UPDATE deposits SET status='paid' WHERE ref=?", ref); move('ext', 'user:' + row.user_id, row.usd, 'deposit', ref, 'Deposit (' + (row.currency === 'TZS' ? 'mobile money' : 'card') + ')'); });
  if (row.save && d.card && d.card.token) keepMethod(row.user_id, 'flutterwave', 'card', (d.card.type || 'Card') + ' •••• ' + (d.card.last_4digits || '????') + (d.card.expiry ? ' (exp ' + d.card.expiry + ')' : ''), d.card.token, { country: String(d.card.country || '').split(' ').pop() });
  return true;
}
let ppTok = { t: '', exp: 0 };
async function ppAuth() {
  if (ppTok.exp > now() + 60000) return ppTok.t;
  const r = await fetch(PPBASE + '/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(PPID + ':' + PPSEC).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) { console.error('PayPal sign-in failed:', r.status, JSON.stringify(j).slice(0, 300)); throw new HttpErr(502, 'PayPal rejected the server keys. Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_API_BASE (sandbox keys need https://api-m.sandbox.paypal.com).'); } ppTok = { t: j.access_token, exp: now() + (j.expires_in || 300) * 1000 }; return ppTok.t;
}
async function ppConfirm(ref) {   // captures the approved order (or reads it if already captured), verifies amount/currency, credits once
  const row = get('SELECT * FROM deposits WHERE ref=?', ref); if (!row || row.provider !== 'paypal') throw new HttpErr(404, 'Unknown payment'); if (row.status === 'paid') return true;
  const H = { Authorization: 'Bearer ' + await ppAuth(), 'Content-Type': 'application/json', 'PayPal-Request-Id': ref };
  let r = await fetch(PPBASE + '/v2/checkout/orders/' + encodeURIComponent(row.pid) + '/capture', { method: 'POST', headers: H, body: '{}' }), j = await r.json().catch(() => ({}));
  if (!r.ok) { r = await fetch(PPBASE + '/v2/checkout/orders/' + encodeURIComponent(row.pid), { headers: H }); j = await r.json().catch(() => ({})); if (!r.ok) return false; }
  const u = j.purchase_units && j.purchase_units[0], cap = u && u.payments && u.payments.captures && u.payments.captures[0];
  if (j.status !== 'COMPLETED' || !cap || cap.status !== 'COMPLETED' || !cap.amount || cap.amount.currency_code !== 'USD' || Number(cap.amount.value) + 0.001 < row.amount || (u.custom_id && u.custom_id !== ref)) return false;
  tx(() => { const x = get('SELECT status FROM deposits WHERE ref=?', ref); if (x.status === 'paid') return; run("UPDATE deposits SET status='paid' WHERE ref=?", ref); move('ext', 'user:' + row.user_id, row.usd, 'deposit', ref, 'Deposit (PayPal)'); });
  const pv = j.payment_source && j.payment_source.paypal, vt = pv && pv.attributes && pv.attributes.vault;
  if (row.save && vt && vt.id && vt.status === 'VAULTED') keepMethod(row.user_id, 'paypal', 'paypal', 'PayPal ' + (pv.email_address || ''), vt.id, {});
  return true;
}
R('GET', '/api/wallet/methods', () => ({ methods: methodsList() }), false);
R('POST', '/api/wallet/deposit', async c => {
  const newRef = () => 'ET-' + crypto.randomBytes(8).toString('hex');
  if (c.b.saved) {   // one-tap payment with a method the provider stored for this user (PIN required)
    const sm = get('SELECT * FROM saved_methods WHERE id=? AND user_id=?', +c.b.saved, c.u.id); if (!sm) throw new HttpErr(404, 'Saved payment method not found');
    const a = cents(c.b.amount), amount = Math.ceil(a * (1 + FEE)) / 100, ref = newRef(); checkPin(c.u, c.b.pin);
    if (sm.provider === 'paypal' && PP) {
      const r = await fetch(PPBASE + '/v2/checkout/orders', { method: 'POST', headers: { Authorization: 'Bearer ' + await ppAuth(), 'Content-Type': 'application/json', 'PayPal-Request-Id': ref }, body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ reference_id: ref, custom_id: ref, description: 'EasyTournament wallet top-up', amount: { currency_code: 'USD', value: amount.toFixed(2) } }], payment_source: { paypal: { vault_id: sm.token } } }) });
      const j = await r.json().catch(() => ({})); if (!r.ok || !j.id) throw new HttpErr(502, 'Payment provider error');
      run('INSERT INTO deposits(ref,user_id,usd,currency,amount,created,provider,pid) VALUES(?,?,?,?,?,?,?,?)', ref, c.u.id, a, 'USD', amount, now(), 'paypal', j.id);
      { const ok = await ppConfirm(ref); return { ...meOut(get('SELECT * FROM users WHERE id=?', c.u.id)), credited: ok }; }
    }
    if (sm.provider === 'flutterwave' && FLW) {
      run('INSERT INTO deposits(ref,user_id,usd,currency,amount,created,provider) VALUES(?,?,?,?,?,?,?)', ref, c.u.id, a, 'USD', amount, now(), 'flutterwave');
      const nm = String(c.u.name).split(' '), meta = JSON.parse(sm.meta || '{}');
      const r = await fetch(FLW_BASE + '/tokenized-charges', { method: 'POST', headers: { Authorization: 'Bearer ' + FLW, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: sm.token, currency: 'USD', country: meta.country || 'US', amount, email: c.u.email, first_name: nm[0], last_name: nm.slice(1).join(' ') || '-', tx_ref: ref }) });
      const j = await r.json().catch(() => ({})); if (!r.ok || j.status !== 'success') throw new HttpErr(402, 'The card could not be charged. Add it again with a new payment.');
      { const ok = await flwConfirm(ref); return { ...meOut(get('SELECT * FROM users WHERE id=?', c.u.id)), credited: ok }; }
    }
    throw new HttpErr(503, 'This saved payment method is not available');
  }
  const a = cents(c.b.amount), route = depositRoute(String(c.b.method || '')), gross = a * (1 + FEE), keep = c.b.save === true ? 1 : 0, origin = BASE || ((c.req.headers['x-forwarded-proto'] || 'http').split(',')[0] + '://' + c.req.headers.host);
  if (route === 'flutterwave') {
    const cur = c.b.method === 'mobile' ? 'TZS' : 'USD', amount = cur === 'USD' ? Math.ceil(gross) / 100 : Math.ceil(gross / 100 * RATE), ref = newRef();
    run('INSERT INTO deposits(ref,user_id,usd,currency,amount,created,provider,save) VALUES(?,?,?,?,?,?,?,?)', ref, c.u.id, a, cur, amount, now(), 'flutterwave', cur === 'USD' ? keep : 0);
    const r = await fetch(FLW_BASE + '/payments', { method: 'POST', headers: { Authorization: 'Bearer ' + FLW, 'Content-Type': 'application/json' }, body: JSON.stringify({ tx_ref: ref, amount, currency: cur, redirect_url: origin + '/', customer: { email: c.u.email, name: c.u.name }, customizations: { title: 'EasyTournament wallet top-up' }, meta: { user_id: c.u.id } }) });
    const j = await r.json().catch(() => ({})); if (!r.ok || !j.data || !j.data.link) { console.error('Flutterwave could not create the payment:', r.status, JSON.stringify(j).slice(0, 600)); throw new HttpErr(502, 'The card payment could not be started. Check the Flutterwave settings on the server.'); } return { url: j.data.link };
  }
  if (route === 'paypal') {
    const amount = Math.ceil(gross) / 100, ref = newRef();
    const mk = async vault => fetch(PPBASE + '/v2/checkout/orders', { method: 'POST', headers: { Authorization: 'Bearer ' + await ppAuth(), 'Content-Type': 'application/json', 'PayPal-Request-Id': ref + (vault ? '-v' : '') }, body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ reference_id: ref, custom_id: ref, description: 'EasyTournament wallet top-up', amount: { currency_code: 'USD', value: amount.toFixed(2) } }], payment_source: { paypal: { ...(vault ? { attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER', permit_multiple_payment_tokens: true } } } : {}), experience_context: { return_url: origin + '/?pp=1&ref=' + ref, cancel_url: origin + '/?pp=0', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', brand_name: 'EasyTournament' } } } }) });
    let useVault = !!keep, r = await mk(useVault);
    if (!r.ok && useVault) { console.error('PayPal refused to save the payer (is Vault enabled?). Retrying without saving.', r.status); useVault = false; r = await mk(false); }
    const j = await r.json().catch(() => ({})), link = (j.links || []).find(l => l.rel === 'payer-action' || l.rel === 'approve'); if (!r.ok || !j.id || !link) { console.error('PayPal could not create the order:', r.status, JSON.stringify(j).slice(0, 600)); const d0 = (j.details && j.details[0]) || {}; throw new HttpErr(502, 'PayPal could not start the payment: ' + (d0.description || d0.issue || j.message || j.name || 'HTTP ' + r.status) + '. Check the PayPal settings on the server (client id, secret, sandbox/live).'); }
    run('INSERT INTO deposits(ref,user_id,usd,currency,amount,created,provider,pid,save) VALUES(?,?,?,?,?,?,?,?,?)', ref, c.u.id, a, 'USD', amount, now(), 'paypal', j.id, useVault ? 1 : 0); return { url: link.href, saving: useVault };
  }
  if (route === 'stripe') {
    let cust = get('SELECT stripe_customer s FROM users WHERE id=?', c.u.id).s;
    if (!cust) { const cr = await fetch('https://api.stripe.com/v1/customers', { method: 'POST', headers: { Authorization: 'Bearer ' + STRIPE, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: c.u.email, name: c.u.name, 'metadata[user_id]': String(c.u.id) }) }), cj = await cr.json().catch(() => ({})); if (cr.ok && cj.id) { cust = cj.id; run('UPDATE users SET stripe_customer=? WHERE id=?', cust, c.u.id); } }
    const body = new URLSearchParams({ mode: 'payment', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][product_data][name]': 'EasyTournament wallet top-up', 'line_items[0][price_data][unit_amount]': String(a), 'line_items[0][quantity]': '1', success_url: origin + '/?paid=1', cancel_url: origin + '/', client_reference_id: String(c.u.id), 'metadata[user_id]': String(c.u.id), 'metadata[cents]': String(a), ...(cust ? { customer: cust, 'saved_payment_method_options[payment_method_save]': 'enabled' } : {}) });
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + STRIPE, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json(); if (!r.ok) throw new HttpErr(502, 'Payment provider error'); return { url: j.url };
  }
  tx(() => move('ext', 'user:' + c.u.id, a, 'deposit', 'demo', 'Deposit (demo)')); return meOut(c.u);
});
R('POST', '/api/paypal/webhook', async c => {
  if (!PP || !PPWH) throw new HttpErr(503, 'Webhook not configured'); const h = c.req.headers;
  const r = await fetch(PPBASE + '/v1/notifications/verify-webhook-signature', { method: 'POST', headers: { Authorization: 'Bearer ' + await ppAuth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'], transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'], webhook_id: PPWH, webhook_event: c.b }) });
  const j = await r.json().catch(() => ({})); if (!r.ok || j.verification_status !== 'SUCCESS') throw new HttpErr(400, 'Bad signature');
  const ref = c.b.resource && c.b.resource.custom_id; if (c.b.event_type === 'PAYMENT.CAPTURE.COMPLETED' && ref && get('SELECT 1 x FROM deposits WHERE ref=?', String(ref))) await ppConfirm(String(ref)); return { received: true };
}, false);
// AI logos (OpenAI Images). The API key stays on the server; each user has a daily limit.
R('POST', '/api/ai/logo', async c => {
  if (!OAI_KEY) throw new HttpErr(503, 'AI logos are not enabled on this server yet');
  const mode = c.b.mode === 'edit' ? 'edit' : 'generate', name = str(c.b.name, 40), extra = str(c.b.prompt, 200);
  if (!extra && mode === 'edit') throw new HttpErr(400, 'Describe the change you want');
  const day = new Date().toISOString().slice(0, 10), used = (get('SELECT n FROM ai_usage WHERE user_id=? AND day=?', c.u.id, day) || { n: 0 }).n;
  if (used >= AI_LIMIT) throw new HttpErr(429, 'Daily AI logo limit reached (' + AI_LIMIT + '). Try again tomorrow.');
  const base = 'Original emblem-style logo for a sports team or tournament' + (name ? ' called "' + name + '"' : '') + '. Bold colours, simple centered shapes, clean vector look, transparent background, no watermark. Do not copy any real club, league, brand or trademark.';
  const prompt = mode === 'edit' ? 'Edit this logo: ' + extra + '. Keep it a clean emblem on a transparent background. Do not add real brand marks.' : base + (extra ? ' Style and idea: ' + extra : '');
  let r;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 95000);
  try {
    if (mode === 'edit') {
      const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(c.b.image || '')); if (!m || m[2].length > 400000) throw new HttpErr(400, 'Upload or create a logo first');
      const fd = new FormData(); fd.append('model', OAI_MODEL); fd.append('prompt', prompt); fd.append('size', '1024x1024'); fd.append('image', new Blob([Buffer.from(m[2], 'base64')], { type: 'image/' + m[1] }), 'logo.' + (m[1] === 'jpeg' ? 'jpg' : m[1]));
      r = await fetch(OAI_BASE + '/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + OAI_KEY }, body: fd, signal: ctl.signal });
    } else {
      const body = OAI_MODEL.startsWith('gpt-image') ? { model: OAI_MODEL, prompt, size: '1024x1024', quality: 'low', background: 'transparent', output_format: 'png', n: 1 } : { model: OAI_MODEL, prompt, size: '1024x1024', response_format: 'b64_json', n: 1 };
      r = await fetch(OAI_BASE + '/images/generations', { method: 'POST', headers: { Authorization: 'Bearer ' + OAI_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    }
  } catch (e) { if (e instanceof HttpErr) throw e; throw new HttpErr(504, 'The AI took too long. Please try again.'); } finally { clearTimeout(timer); }
  const j = await r.json().catch(() => ({})), b64 = j.data && j.data[0] && j.data[0].b64_json;
  if (!r.ok || !b64) { console.error('OpenAI image error', r.status, JSON.stringify(j).slice(0, 400)); throw new HttpErr(r.status === 400 ? 400 : 502, 'AI could not make this logo: ' + ((j.error && j.error.message) || 'HTTP ' + r.status)); }
  run('INSERT INTO ai_usage(user_id,day,n) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET n=n+1', c.u.id, day);
  return { image: 'data:image/png;base64,' + b64, left: AI_LIMIT - used - 1 };
});
R('GET', '/api/wallet/saved', c => ({ saved: all('SELECT id,kind,label,provider FROM saved_methods WHERE user_id=? ORDER BY id DESC', c.u.id) }));
R('DELETE', '/api/wallet/saved/:id', async c => {
  const sm = get('SELECT * FROM saved_methods WHERE id=? AND user_id=?', +c.p.id, c.u.id); if (!sm) throw new HttpErr(404, 'Not found');
  if (sm.provider === 'paypal' && PP) { try { await fetch(PPBASE + '/v3/vault/payment-tokens/' + encodeURIComponent(sm.token), { method: 'DELETE', headers: { Authorization: 'Bearer ' + await ppAuth() } }); } catch { } }
  run('DELETE FROM saved_methods WHERE id=?', sm.id); return { ok: true };
});
R('POST', '/api/wallet/deposit/confirm', async c => {
  const row = get('SELECT * FROM deposits WHERE ref=?', String(c.b.ref || '')); if (!row || row.user_id !== c.u.id) throw new HttpErr(404, 'Unknown payment');
  const ok = row.provider === 'paypal' ? await ppConfirm(row.ref) : row.provider === 'flutterwave' ? await flwConfirm(row.ref) : false; return { ...meOut(get('SELECT * FROM users WHERE id=?', c.u.id)), credited: ok };
});
R('POST', '/api/flutterwave/webhook', async c => {
  if (!FLW_HASH || !eq(c.req.headers['verif-hash'] || '', FLW_HASH)) throw new HttpErr(401, 'Bad signature');
  const ref = c.b && c.b.data && c.b.data.tx_ref; if (ref && get('SELECT 1 x FROM deposits WHERE ref=?', String(ref))) await flwConfirm(String(ref)); return { received: true };
}, false);
R('POST', '/api/stripe/webhook', c => {
  if (!WH) throw new HttpErr(503, 'Webhook not configured');
  const h = Object.fromEntries(String(c.req.headers['stripe-signature'] || '').split(',').map(x => x.split('=')));
  const mac = crypto.createHmac('sha256', WH).update(h.t + '.' + c.raw).digest('hex');
  if (!h.v1 || !eq(mac, h.v1) || Math.abs(now() / 1000 - Number(h.t)) > 300) throw new HttpErr(400, 'Bad signature');
  const ev = JSON.parse(c.raw), s = ev.data && ev.data.object;
  if (ev.type === 'checkout.session.completed' && s && s.payment_status === 'paid') tx(() => {
    if (get('SELECT 1 x FROM events WHERE id=?', ev.id)) return; run('INSERT INTO events(id) VALUES(?)', ev.id);
    if (!get('SELECT 1 x FROM users WHERE id=?', +s.metadata.user_id)) return;
    move('ext', 'user:' + (+s.metadata.user_id), s.amount_total, 'deposit', ev.id, 'Deposit (card / Google Pay)');
  });
  return { received: true };
}, false);
R('POST', '/api/wallet/withdraw', c => {
  const a = cents(c.b.amount), m = str(c.b.method, 30), dest = str(c.b.dest, 80); if (!dest) throw new HttpErr(400, 'Enter where to send the money');
  if (a < WD_MIN) throw new HttpErr(400, 'Minimum withdrawal is $5');
  if (now() - c.u.created < WD_MIN_AGE) throw new HttpErr(403, 'New accounts can withdraw after 24 hours');
  if (get('SELECT COALESCE(SUM(cents),0) s FROM withdrawals WHERE user_id=? AND created>?', c.u.id, now() - 864e5).s + a > WD_DAILY) throw new HttpErr(400, 'Daily withdrawal limit reached');
  checkPin(c.u, c.b.pin);
  tx(() => { move('user:' + c.u.id, 'hold:withdraw', a, 'withdraw', 'pending', 'Withdrawal requested (' + m + ')'); run('INSERT INTO withdrawals(user_id,cents,method,dest,created) VALUES(?,?,?,?,?)', c.u.id, a, m, dest, now()); });
  return meOut(c.u);
});
// leagues
R('GET', '/api/leagues', c => all('SELECT * FROM leagues ORDER BY created DESC LIMIT 200').map(r => view(r, c.u.id, 'light')));
R('POST', '/api/leagues', c => {
  needSigned(c.u); const n = str(c.b.n, 60); if (!n) throw new HttpErr(400, 'Enter a league name');
  let code; do { code = Array.from(crypto.randomBytes(5), x => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x % 32]).join(''); } while (get('SELECT 1 x FROM leagues WHERE code=?', code));
  const d = { n, g: str(c.b.g, 40), d: str(c.b.d, 30), rules: str(c.b.rules, 600), fmt: ['league', 'group', 'ko', 'ffa'].includes(c.b.fmt) ? c.b.fmt : 'league', started: false, players: [], matches: [], ann: [] };
  run('INSERT INTO leagues(code,admin_id,data,created) VALUES(?,?,?,?)', code, c.u.id, JSON.stringify(d), now());
  return view(get('SELECT * FROM leagues WHERE code=?', code), c.u.id, 'full');
});
R('GET', '/api/leagues/:code', c => view(league(c.p.code, c.u.id), c.u.id, 'full'));
R('GET', '/api/public/:code', c => { const r = get('SELECT * FROM leagues WHERE code=?', c.p.code.toUpperCase()); if (!r) throw new HttpErr(404, 'League not found'); return view(r, 0, 'public'); }, false);
R('POST', '/api/leagues/:code', c => { const r = league(c.p.code, c.u.id, 'admin'), before = (JSON.parse(r.data).ann || []).length; tx(() => saveLeague(r, c.b, c.u.id));
  { const after = JSON.parse(get('SELECT data FROM leagues WHERE code=?', r.code).data); if ((after.ann || []).length > before) for (const m of all('SELECT user_id FROM members WHERE code=? AND user_id<>?', r.code, c.u.id)) notify(m.user_id, { title: '📢 ' + after.n, body: after.ann[0].t, url: '/?join=' + r.code, tag: 'ann-' + r.code }); } return view(get('SELECT * FROM leagues WHERE code=?', r.code), c.u.id, 'full'); });
R('POST', '/api/leagues/:code/mode', c => {
  needSigned(c.u); const r = league(c.p.code, c.u.id, 'admin'); if (r.mode) throw new HttpErr(400, 'League type already chosen');
  const money = c.b.mode === 'money', fee = money ? cents(c.b.fee) : 0; if (money) checkPin(c.u, c.b.pin);
  tx(() => { run('UPDATE leagues SET mode=?,fee=? WHERE code=?', money ? 'money' : 'free', fee, r.code); addMember(r.code, c.u, money); if (money) move('user:' + c.u.id, 'league:' + r.code, fee, 'league_fee', r.code, 'League fee: ' + JSON.parse(r.data).n); });
  return view(get('SELECT * FROM leagues WHERE code=?', r.code), c.u.id, 'full');
});
R('POST', '/api/leagues/:code/join', c => {
  const r = league(c.p.code, c.u.id); if (!r.mode) throw new HttpErr(400, 'Registration is not open yet'); if (r.status !== 'open' || JSON.parse(r.data).started) throw new HttpErr(400, 'This league has already started');
  if (isMember(r.code, c.u.id)) throw new HttpErr(400, 'You already joined');
  if (!get('SELECT 1 x FROM slots WHERE code=? AND user_id IS NULL', r.code)) throw new HttpErr(400, r.mode === 'money' ? 'No open teams left in this league' : 'No open teams left. Ask the admin to add your team.');
  if (r.mode === 'money') { needSigned(c.u); checkPin(c.u, c.b.pin); }
  tx(() => { addMember(r.code, c.u, r.mode === 'money'); if (r.mode === 'money') move('user:' + c.u.id, 'league:' + r.code, r.fee, 'league_fee', r.code, 'League fee: ' + JSON.parse(r.data).n); });
  return view(get('SELECT * FROM leagues WHERE code=?', r.code), c.u.id, 'full');
});
R('PATCH', '/api/leagues/:code/team', c => { const r = league(c.p.code, c.u.id, 'member'); if (!['open', 'active'].includes(r.status)) throw new HttpErr(400, 'Teams are locked'); if (r.mode) run('UPDATE slots SET logo=? WHERE code=? AND user_id=?', okLogo(c.b.logo), r.code, c.u.id); else run('UPDATE members SET team=?,logo=? WHERE code=? AND user_id=?', str(c.b.team, 30), okLogo(c.b.logo), r.code, c.u.id); return { ok: true }; });
R('POST', '/api/leagues/:code/remove', c => {
  const r = league(c.p.code, c.u.id, 'admin'); if (r.status !== 'open' || JSON.parse(r.data).started) throw new HttpErr(400, 'Teams cannot be removed after fixtures are created');
  const id = sidf2(r, c.u.id)(c.b.id);
  tx(() => { if (r.mode) { const x = get('SELECT * FROM slots WHERE code=? AND id=?', r.code, id); if (!x) throw new HttpErr(404, 'Team not found'); if (x.user_id) refund(r.code, x.user_id, 'Removed from league'); run('DELETE FROM slots WHERE code=? AND id=?', r.code, id); } else refund(r.code, +String(id).slice(1), 'Removed from league'); }); return view(get('SELECT * FROM leagues WHERE code=?', r.code), c.u.id, 'full');
});
R('POST', '/api/leagues/:code/cancel', c => {   // admin may cancel only BEFORE fixtures exist; afterwards only support can
  const r = league(c.p.code, c.u.id, 'admin'); if (r.status !== 'open' || JSON.parse(r.data).started) throw new HttpErr(403, 'After the league starts, only support can cancel it');
  tx(() => { all('SELECT user_id FROM members WHERE code=?', r.code).forEach(m => refund(r.code, m.user_id, 'League cancelled')); run("UPDATE leagues SET status='cancelled' WHERE code=?", r.code); });
  return view(get('SELECT * FROM leagues WHERE code=?', r.code), c.u.id, 'full');
});
R('POST', '/api/leagues/:code/finish', c => {
  const r = league(c.p.code, c.u.id, 'admin'); if (!['open', 'active'].includes(r.status)) throw new HttpErr(400, 'Already finished');
  const sid = sidf2(r, c.u.id); let rk = [...new Set((Array.isArray(c.b.rk) ? c.b.rk : []).map(sid))].slice(0, 64);
  if (r.mode === 'money') rk = rk.map(i => { const x = get('SELECT user_id u FROM slots WHERE code=? AND id=?', r.code, i); if (!x || !x.u) throw new HttpErr(400, 'A ranked team has no player yet'); return 'u' + x.u; });
  if (!rk.length) throw new HttpErr(400, 'Ranking is empty');
  if (r.mode === 'money' && !rk.every(i => /^u\d+$/.test(i) && isMember(r.code, +i.slice(1)))) throw new HttpErr(400, 'Ranking must contain league members');
  if (r.mode === 'money') run("UPDATE leagues SET status='review',review_at=?,rk=? WHERE code=?", now() + REVIEW_MS, JSON.stringify(rk), r.code);
  else run("UPDATE leagues SET status='finished',rk=?,review_at=? WHERE code=?", JSON.stringify(rk), now(), r.code);
  return view(get('SELECT * FROM leagues WHERE code=?', r.code), c.u.id, 'full');
});
R('POST', '/api/leagues/:code/slots', c => {   // admin lists the team names players can pick (money leagues)
  const r = league(c.p.code, c.u.id, 'admin'); if (!r.mode) throw new HttpErr(400, 'Choose the league type first');
  if (r.status !== 'open' || JSON.parse(r.data).started) throw new HttpErr(400, 'Teams cannot be added after fixtures are created');
  const t = str(c.b.team, 30); if (!t) throw new HttpErr(400, 'Enter a team name');
  if (get('SELECT COUNT(*) c FROM slots WHERE code=?', r.code).c >= 64) throw new HttpErr(400, 'League is full');
  if (get('SELECT 1 x FROM slots WHERE code=? AND lower(team)=lower(?)', r.code, t)) throw new HttpErr(400, 'That team already exists');
  const n = get("SELECT COALESCE(MAX(CAST(SUBSTR(id,2) AS INTEGER)),0) m FROM slots WHERE code=?", r.code).m + 1; run('INSERT INTO slots(code,id,team) VALUES(?,?,?)', r.code, 's' + n, t);
  return view(get('SELECT * FROM leagues WHERE code=?', r.code), c.u.id, 'full');
});
R('POST', '/api/leagues/:code/pick', c => {   // a player who has paid taps the tick next to their team
  const r = league(c.p.code, c.u.id, 'member'); if (!r.mode) throw new HttpErr(400, 'Registration is not open yet'); if (!['open', 'active'].includes(r.status)) throw new HttpErr(400, 'League is closed');
  if (JSON.parse(r.data).started && mySlot(r.code, c.u.id)) throw new HttpErr(400, 'Your team is locked once fixtures are created');
  const id = String(c.b.slot || '');
  tx(() => {
    const x = get('SELECT * FROM slots WHERE code=? AND id=?', r.code, id); if (!x) throw new HttpErr(404, 'Team not found'); if (x.user_id && x.user_id !== c.u.id) throw new HttpErr(409, 'That team was just taken');
    if (!isMember(r.code, c.u.id)) throw new HttpErr(403, 'Join the league first');
    run('UPDATE slots SET user_id=NULL WHERE code=? AND user_id=?', r.code, c.u.id); run('UPDATE slots SET user_id=? WHERE code=? AND id=?', c.u.id, r.code, id);
  });
  return view(get('SELECT * FROM leagues WHERE code=?', r.code), c.u.id, 'full');
});
// "Start": rings the opponent for CALL_MS, then both see the match time
R('POST', '/api/leagues/:code/call', c => {
  const r = league(c.p.code, c.u.id, 'member'), d = JSON.parse(r.data); if (r.status !== 'active') throw new HttpErr(400, 'Matches can be started once the league is running');
  const mi = c.b.midx | 0, m = d.matches[mi]; if (!m || m.bye || !m.a) throw new HttpErr(400, 'Match not found'); if (m.hs != null && m.as != null) throw new HttpErr(400, 'This match already has a result');
  const me = meId(r, c.u.id); if (!me || (m.h !== me && m.a !== me)) throw new HttpErr(403, 'Only the two players can start this match');
  const other = m.h === me ? m.a : m.h, to = userOf(r, other); if (!to) throw new HttpErr(400, 'The other player has not joined yet');
  if (get("SELECT 1 x FROM calls WHERE code=? AND midx=? AND status='ringing' AND expires>?", r.code, mi, now())) throw new HttpErr(400, 'Already calling');
  const last = get('SELECT created FROM calls WHERE from_id=? AND code=? AND midx=? ORDER BY id DESC LIMIT 1', c.u.id, r.code, mi); if (last && now() - last.created < 20000) throw new HttpErr(429, 'Wait a moment before calling again');
  const t = now(), u2 = get('SELECT name FROM users WHERE id=?', to), res = run("INSERT INTO calls(code,midx,from_id,to_id,from_name,to_name,from_team,to_team,lname,whn,dur,created,expires,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'ringing')", r.code, mi, c.u.id, to, c.u.name, u2.name, teamOf(r, me), teamOf(r, other), d.n, m.when || '', d.dur || 0, t, t + CALL_MS);
  notify(to, { title: '📞 ' + c.u.name + ' is calling you', body: teamOf(r, me) + ' vs ' + teamOf(r, other) + ' · ' + d.n + '. Open the app to answer.', url: '/?join=' + r.code, tag: 'call-' + Number(res.lastInsertRowid), call: 1, ttl: Math.ceil(CALL_MS / 1000) });
  return { id: Number(res.lastInsertRowid), left: CALL_MS };
});
R('GET', '/api/calls', c => {
  run("UPDATE calls SET status='missed',ended=expires WHERE status='ringing' AND expires<=?", now());
  return { calls: all("SELECT * FROM calls WHERE (from_id=? OR to_id=?) AND (status='ringing' OR ended>?) ORDER BY id DESC LIMIT 5", c.u.id, c.u.id, now() - 60000).map(x => ({ id: x.id, code: x.code, midx: x.midx, status: x.status, role: x.from_id === c.u.id ? 'caller' : 'callee', left: Math.max(0, x.expires - now()), league: x.lname, when: x.whn, dur: x.dur, me: x.from_id === c.u.id ? { name: x.from_name, team: x.from_team } : { name: x.to_name, team: x.to_team }, other: x.from_id === c.u.id ? { name: x.to_name, team: x.to_team } : { name: x.from_name, team: x.from_team } })) };
});
R('POST', '/api/calls/:id/answer', c => {
  const x = get('SELECT * FROM calls WHERE id=?', +c.p.id); if (!x || x.to_id !== c.u.id) throw new HttpErr(404, 'Call not found'); if (x.status !== 'ringing' || x.expires <= now()) throw new HttpErr(400, 'The call has ended');
  run('UPDATE calls SET status=?,ended=? WHERE id=?', c.b.accept ? 'answered' : 'declined', now(), x.id); return { ok: true };
});
R('POST', '/api/calls/:id/cancel', c => {
  const x = get('SELECT * FROM calls WHERE id=?', +c.p.id); if (!x || x.from_id !== c.u.id) throw new HttpErr(404, 'Call not found'); if (x.status === 'ringing') run("UPDATE calls SET status='cancelled',ended=? WHERE id=?", now(), x.id); return { ok: true };
});
R('POST', '/api/leagues/:code/complaint', c => {
  const r = league(c.p.code, c.u.id, 'member'); if (r.status !== 'review') throw new HttpErr(400, 'Complaints can be filed while prizes are locked for review');
  const t = str(c.b.text, 200); if (!t) throw new HttpErr(400, 'Describe the problem'); run('INSERT INTO complaints(code,user_id,author,body,created) VALUES(?,?,?,?,?)', r.code, c.u.id, c.u.name, t, now());
  return view(get('SELECT * FROM leagues WHERE code=?', r.code), c.u.id, 'full');
});
R('POST', '/api/leagues/:code/proof', c => {
  const r = league(c.p.code, c.u.id, 'member'), d = JSON.parse(r.data), mi = c.b.midx | 0; if (!d.matches[mi]) throw new HttpErr(400, 'Match not found');
  if (['finished', 'cancelled'].includes(r.status)) throw new HttpErr(400, 'League is closed');
  const type = c.b.type === 'link' ? 'link' : 'img', v = String(c.b.val || '');
  if (type === 'img' ? !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > 450000 : !/^https:\/\/[^\s"'<>]{4,300}$/.test(v)) throw new HttpErr(400, type === 'img' ? 'Upload a JPEG screenshot' : 'Link must start with https://');
  if (get('SELECT COUNT(*) c FROM proofs WHERE code=? AND midx=?', r.code, mi).c >= 4) throw new HttpErr(400, 'Maximum 4 proofs');
  run('INSERT INTO proofs(code,midx,user_id,author,type,val,created) VALUES(?,?,?,?,?,?,?)', r.code, mi, c.u.id, c.u.name, type, v, now());
  return view(get('SELECT * FROM leagues WHERE code=?', r.code), c.u.id, 'full');
});
R('POST', '/api/leagues/:code/chat', c => {
  const r = league(c.p.code, c.u.id, 'member'), t = str(c.b.text, 300); if (!t) throw new HttpErr(400, 'Empty message');
  run('INSERT INTO chat(code,user_id,author,body,created) VALUES(?,?,?,?,?)', r.code, c.u.id, c.u.name, t, now()); return view(get('SELECT * FROM leagues WHERE code=?', r.code), c.u.id, 'full');
});

// user videos: links or uploaded files (stored on the server disk)
const vOut = (v, uid) => ({ id: v.id, title: v.title, game: v.game, author: v.author, created: v.created, type: v.type, url: v.type === 'link' ? v.url : '', src: v.type === 'file' ? '/api/videos/' + v.id + '/file' : '', views: v.views, mine: v.user_id === uid });
const vGame = g => ['eFootball', 'Dream League Soccer', 'EA Sports FC', 'Other'].includes(g) ? g : 'Other';
R('GET', '/api/videos', c => all('SELECT * FROM videos ORDER BY created DESC LIMIT 100').map(v => vOut(v, c.u.id)));
R('POST', '/api/videos', c => {
  const t = str(c.b.title, 80), u = String(c.b.url || ''); if (t.length < 2) throw new HttpErr(400, 'Enter a title'); if (!/^https:\/\/[^\s"'<>]{4,300}$/.test(u)) throw new HttpErr(400, 'Link must start with https://');
  if (get('SELECT COUNT(*) c FROM videos WHERE user_id=?', c.u.id).c >= 50) throw new HttpErr(400, 'Video limit reached');
  const id = crypto.randomBytes(12).toString('hex'); run("INSERT INTO videos(id,user_id,author,title,game,type,url,created) VALUES(?,?,?,?,?,'link',?,?)", id, c.u.id, c.u.name, t, vGame(c.b.game), u, now()); return vOut(get('SELECT * FROM videos WHERE id=?', id), c.u.id);
});
R('POST', '/api/videos/:id/view', c => { run('UPDATE videos SET views=views+1 WHERE id=?', c.p.id); return { ok: true }; });
R('DELETE', '/api/videos/:id', c => {
  const v = get('SELECT * FROM videos WHERE id=?', c.p.id); if (!v) throw new HttpErr(404, 'Not found'); if (v.user_id !== c.u.id) throw new HttpErr(403, 'Not your video');
  run('DELETE FROM videos WHERE id=?', v.id); if (v.type === 'file') fs.rm(path.join(VID_DIR, v.id), () => { }); return { ok: true };
});
async function uploadVideo(req, res, url, send) {
  const u = await authUserA(req); if (!u) throw new HttpErr(401, 'Please sign in');
  const ct = String(req.headers['content-type'] || ''); if (!/^video\//.test(ct)) throw new HttpErr(400, 'Only video files are allowed');
  const title = str(url.searchParams.get('title'), 80); if (title.length < 2) throw new HttpErr(400, 'Enter a title');
  if (get('SELECT COUNT(*) c FROM videos WHERE user_id=?', u.id).c >= 50) throw new HttpErr(400, 'Video limit reached');
  const id = crypto.randomBytes(12).toString('hex'), fp = path.join(VID_DIR, id); let n = 0;
  await new Promise((ok, no) => {
    const ws = fs.createWriteStream(fp), bad = e => { ws.destroy(); fs.rm(fp, () => { }); no(e); };
    req.on('data', d => { n += d.length; if (n > MAXV) { req.unpipe(ws); bad(new HttpErr(413, 'Video is larger than 100 MB')); } });
    req.on('error', bad); ws.on('error', bad); ws.on('finish', ok); req.pipe(ws);
  });
  if (!n) { fs.rm(fp, () => { }); throw new HttpErr(400, 'Empty file'); }
  run("INSERT INTO videos(id,user_id,author,title,game,type,url,size,created) VALUES(?,?,?,?,?,'file',?,?,?)", id, u.id, u.name, title, vGame(url.searchParams.get('game')), ct.slice(0, 40), n, now());
  send(200, vOut(get('SELECT * FROM videos WHERE id=?', id), u.id));
}
function serveVideo(req, res, id) {
  const v = get("SELECT * FROM videos WHERE id=? AND type='file'", id); if (!v) { res.writeHead(404); return res.end(); }
  const fp = path.join(VID_DIR, v.id); let st; try { st = fs.statSync(fp); } catch { res.writeHead(404); return res.end(); }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || ''), h = { 'Content-Type': v.url || 'video/mp4', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' };
  if (m) {
    let a = m[1] === '' ? Math.max(0, st.size - +m[2]) : +m[1], b = m[1] !== '' && m[2] !== '' ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (a > b || a >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 }); return fs.createReadStream(fp, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { ...h, 'Content-Length': st.size }); fs.createReadStream(fp).pipe(res);
}
// support (protected by SUPPORT_KEY)
const sup = c => { if (!SUPPORT || !eq(c.req.headers['x-support-key'] || '', SUPPORT)) throw new HttpErr(401, 'Support key required'); };
R('GET', '/api/support/open', c => { sup(c); return { complaints: all('SELECT * FROM complaints WHERE resolved=0'), withdrawals: all("SELECT * FROM withdrawals WHERE status='pending'") }; }, false);
R('GET', '/api/support/report', c => {
  sup(c); const sm = l => get('SELECT COALESCE(SUM(cents),0) s FROM ledger WHERE account LIKE ?', l).s / 100;
  return { users: get('SELECT COUNT(*) c FROM users').c, user_balances: sm('user:%'), league_escrow: sm('league:%'), platform_revenue: sm('platform'), pending_withdrawals: sm('hold:withdraw'), external_net: sm('ext'),
    ledger_balanced: get('SELECT COALESCE(SUM(cents),0) s FROM ledger').s === 0, leagues_in_review: get("SELECT COUNT(*) c FROM leagues WHERE status='review'").c, open_complaints: get('SELECT COUNT(*) c FROM complaints WHERE resolved=0').c, pending_withdrawal_requests: get("SELECT COUNT(*) c FROM withdrawals WHERE status='pending'").c };
}, false);
R('POST', '/api/support/complaints/:id/resolve', c => { sup(c); run('UPDATE complaints SET resolved=1 WHERE id=?', +c.p.id); return { ok: true }; }, false);
R('POST', '/api/support/withdrawals/:id', c => {
  sup(c); const w = get("SELECT * FROM withdrawals WHERE id=? AND status='pending'", +c.p.id); if (!w) throw new HttpErr(404, 'Not found');
  tx(() => { if (c.b.action === 'paid') { move('hold:withdraw', 'ext', w.cents, 'withdraw', 'paid', 'Withdrawal paid'); run("UPDATE withdrawals SET status='paid' WHERE id=?", w.id); } else { move('hold:withdraw', 'user:' + w.user_id, w.cents, 'refund', 'withdrawal', 'Withdrawal rejected: refunded'); run("UPDATE withdrawals SET status='rejected' WHERE id=?", w.id); } });
  return { ok: true };
}, false);
R('POST', '/api/support/leagues/:code/cancel', c => {
  sup(c); const r = get('SELECT * FROM leagues WHERE code=?', c.p.code.toUpperCase()); if (!r || ['finished', 'cancelled'].includes(r.status)) throw new HttpErr(400, 'Cannot cancel');
  tx(() => { all('SELECT user_id FROM members WHERE code=?', r.code).forEach(m => refund(r.code, m.user_id, 'League cancelled by support')); run("UPDATE leagues SET status='cancelled' WHERE code=?", r.code); }); return { ok: true };
}, false);

// ---- http ----
const INDEX = path.join(__dirname, 'index.html');
function csp() {
  const ad = ADS_CLIENT ? ' https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.google.com https://*.doubleclick.net https://www.googletagservices.com https://*.adtrafficquality.google' : '';
  return "default-src 'self'; script-src 'self' 'unsafe-inline'" + ad + "; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:" + (ADS_CLIENT ? ' https:' : '') + "; media-src 'self' blob:; connect-src 'self'" + (SB_URL ? ' ' + SB_URL : '') + ad + "; frame-src " + (ADS_CLIENT ? "https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com" : "'none'") + "; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
}
const STATIC = { '/sw.js': ['application/javascript; charset=utf-8', { 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' }, 'sw.js'], '/manifest.webmanifest': ['application/manifest+json', {}, 'manifest.webmanifest'], '/icons/icon-192.png': ['image/png', { 'Cache-Control': 'public, max-age=86400' }, 'icon-192.png'], '/icons/icon-512.png': ['image/png', { 'Cache-Control': 'public, max-age=86400' }, 'icon-512.png'] };   // all files live next to server.js (easy to upload from a phone)
function readBody(req, max = 1.6e6) { return new Promise((ok, no) => { let s = '', n = 0; req.on('data', d => { n += d.length; if (n > max) { no(new HttpErr(413, 'Too large')); req.destroy(); } else s += d; }); req.on('end', () => ok(s)); req.on('error', no); }); }
http.createServer(async (req, res) => {
  const send = (s, o, h = {}) => { res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...h }); res.end(JSON.stringify(o)); };
  try {
    if (PROD && req.headers['x-forwarded-proto'] === 'http') { res.writeHead(301, { Location: 'https://' + req.headers.host + req.url }); return res.end(); }
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (req.method === 'GET' && p === '/api/support/backup') {
      if (!SUPPORT || !eq(req.headers['x-support-key'] || '', SUPPORT)) throw new HttpErr(401, 'Support key required');
      const f = backup(); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="easytournament.db"' }); return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'GET' && STATIC[p]) { res.writeHead(200, { 'Content-Type': STATIC[p][0], 'X-Content-Type-Options': 'nosniff', ...STATIC[p][1] }); return fs.createReadStream(path.join(__dirname, STATIC[p][2])).pipe(res); }
    if (req.method === 'GET' && (p === '/' || /^\/l\/[A-Za-z0-9]+$/.test(p))) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...(PROD ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}), 'Content-Security-Policy': csp() }); return res.end(fs.readFileSync(INDEX)); }
    const ip = req.socket.remoteAddress || '';
    if (req.method === 'POST' && p === '/api/videos/upload') return await uploadVideo(req, res, url, send);
    const vm = /^\/api\/videos\/([a-f0-9]{24})\/file$/.exec(p); if (req.method === 'GET' && vm) return serveVideo(req, res, vm[1]);
    for (const r of routes) {
      if (r.m !== req.method) continue; const m = r.re.exec(p); if (!m) continue;
      const raw = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : ''; let b = {}; try { b = raw ? JSON.parse(raw) : {}; } catch { throw new HttpErr(400, 'Bad JSON'); }
      const u = r.auth ? await authUserA(req) : null; if (r.auth && !u) throw new HttpErr(401, 'Please sign in');
      { const out = await r.fn({ req, u, b, raw, p: m.groups || {}, ip }); flush(); return send(200, out); }
    }
    send(404, { error: 'Not found' });
  } catch (e) { POST = []; if (e instanceof HttpErr) send(e.s, { error: e.message }); else { console.error(e); send(500, { error: 'Server error' }); } }
}).listen(PORT, () => console.log('EasyTournament server on :' + PORT));
