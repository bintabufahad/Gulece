// Gulece backend — real signup, real manual verification review, real sessions.
// No fake AI, no fake timers. Data lives in Supabase (Postgres + Storage) so
// this process can be scaled horizontally without any server-local state.

require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
if (ADMIN_PASSWORD === 'change-me-now') {
    console.warn('\n⚠️  ADMIN_PASSWORD is not set — using the insecure default. Set it in .env before deploying.\n');
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('\n❌ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.\n   Copy .env.example to .env and fill them in — see README.md for setup steps.\n');
    process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
});

const logger = pino();
const app = express();
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' } }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting: signup/login/admin-login are the endpoints worth
// protecting from brute-force and spam at any real scale. ──
const signupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please try again later.' } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please try again later.' } });
const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please try again later.' } });

function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    header.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    });
    return out;
}
function setCookie(res, name, value, maxAgeMs) {
    res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; SameSite=Lax`);
}
function clearCookie(res, name) {
    res.setHeader('Set-Cookie', `${name}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

async function requireAuth(req, res, next) {
    const token = parseCookies(req).gulece_session;
    if (!token) return res.status(401).json({ error: 'not_authenticated' });
    const { data: session } = await supabase.from('app_sessions').select('user_id, expires_at').eq('token', token).maybeSingle();
    if (!session || new Date(session.expires_at) < new Date()) return res.status(401).json({ error: 'not_authenticated' });
    const { data: user } = await supabase.from('app_users').select('id, name, email, status').eq('id', session.user_id).maybeSingle();
    if (!user || user.status !== 'verified') return res.status(401).json({ error: 'not_authenticated' });
    req.user = user;
    next();
}
async function requireAdmin(req, res, next) {
    const token = parseCookies(req).gulece_admin;
    if (!token) return res.status(401).json({ error: 'not_admin' });
    const { data: session } = await supabase.from('admin_sessions').select('expires_at').eq('token', token).maybeSingle();
    if (!session || new Date(session.expires_at) < new Date()) return res.status(401).json({ error: 'not_admin' });
    next();
}

// Files are held in memory just long enough to stream to Supabase Storage —
// nothing touches local disk, so this works the same on any number of
// horizontally-scaled instances.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// ── Signup: creates a PENDING account. Nothing is "verified" here. ──
app.post('/api/signup', signupLimiter,
    upload.fields([{ name: 'video', maxCount: 1 }, { name: 'idDoc', maxCount: 1 }]),
    async (req, res) => {
        const { name, email, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ error: 'Missing required fields.' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        const videoFile = req.files?.video?.[0];
        if (!videoFile) return res.status(400).json({ error: 'A face verification video is required.' });

        const normalizedEmail = email.trim().toLowerCase();
        const { data: existing } = await supabase.from('app_users').select('id').eq('email', normalizedEmail).maybeSingle();
        if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

        const userId = crypto.randomUUID();
        const videoPath = `${userId}.webm`;
        const { error: videoErr } = await supabase.storage.from('verification-videos')
            .upload(videoPath, videoFile.buffer, { contentType: 'video/webm', upsert: false });
        if (videoErr) { req.log.error(videoErr); return res.status(500).json({ error: 'Could not upload video. Please try again.' }); }

        const idFile = req.files?.idDoc?.[0];
        let idPath = null;
        if (idFile) {
            const ext = path.extname(idFile.originalname) || '';
            idPath = `${userId}${ext}`;
            const { error: idErr } = await supabase.storage.from('verification-ids')
                .upload(idPath, idFile.buffer, { contentType: idFile.mimetype, upsert: false });
            if (idErr) { req.log.error(idErr); idPath = null; } // ID upload is optional — don't fail signup over it.
        }

        const passwordHash = bcrypt.hashSync(password, 10);
        const { data: inserted, error: insertErr } = await supabase.from('app_users').insert({
            id: userId, name, email: normalizedEmail, password_hash: passwordHash,
            status: 'pending', has_id: !!idPath, video_path: videoPath, id_path: idPath
        }).select('pending_token').single();
        if (insertErr) { req.log.error(insertErr); return res.status(500).json({ error: 'Something went wrong. Please try again.' }); }

        res.json({ ok: true, pendingToken: inserted.pending_token });
    }
);

// Status is looked up by a private token (issued only to the signer-upper), not by email,
// so this endpoint can't be used to enumerate who has an account.
app.get('/api/status', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'missing_token' });
    const { data: user } = await supabase.from('app_users').select('status, name, email, has_id').eq('pending_token', token).maybeSingle();
    if (!user) return res.status(404).json({ error: 'not_found' });
    res.json({ status: user.status, name: user.name, email: user.email, hasId: user.has_id });
});

app.post('/api/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    const normalizedEmail = (email || '').trim().toLowerCase();
    const { data: user } = await supabase.from('app_users').select('*').eq('email', normalizedEmail).maybeSingle();
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
        return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (user.status !== 'verified') return res.status(403).json({ error: 'pending', status: user.status });

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const { error: sessErr } = await supabase.from('app_sessions').insert({ token, user_id: user.id, expires_at: expiresAt });
    if (sessErr) { req.log.error(sessErr); return res.status(500).json({ error: 'Could not sign in. Please try again.' }); }
    setCookie(res, 'gulece_session', token, 30 * 24 * 3600 * 1000);
    res.json({ ok: true, name: user.name, email: user.email });
});

app.post('/api/logout', async (req, res) => {
    const token = parseCookies(req).gulece_session;
    if (token) await supabase.from('app_sessions').delete().eq('token', token);
    clearCookie(res, 'gulece_session');
    res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ name: req.user.name, email: req.user.email });
});

// ── Admin: manual human review. This is the only real "verification". ──
app.post('/api/admin/login', adminLoginLimiter, async (req, res) => {
    if ((req.body || {}).password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong admin password.' });
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    const { error } = await supabase.from('admin_sessions').insert({ token, expires_at: expiresAt });
    if (error) { req.log.error(error); return res.status(500).json({ error: 'Could not sign in.' }); }
    setCookie(res, 'gulece_admin', token, 12 * 3600 * 1000);
    res.json({ ok: true });
});

app.get('/api/admin/pending', requireAdmin, async (req, res) => {
    const { data, error } = await supabase.from('app_users').select('id, name, email, has_id, created_at')
        .eq('status', 'pending').order('created_at', { ascending: true });
    if (error) { req.log.error(error); return res.status(500).json({ error: 'server_error' }); }
    res.json(data.map(u => ({ id: u.id, name: u.name, email: u.email, hasId: u.has_id, createdAt: new Date(u.created_at).getTime() })));
});

// Redirect to a short-lived signed URL rather than proxying the file — this
// keeps Range requests (video scrubbing) working for free, and the bucket
// itself is private so the raw file is never guessable/public.
app.get('/api/admin/video/:id', requireAdmin, async (req, res) => {
    const { data: user } = await supabase.from('app_users').select('video_path').eq('id', req.params.id).maybeSingle();
    if (!user) return res.status(404).end();
    const { data, error } = await supabase.storage.from('verification-videos').createSignedUrl(user.video_path, 120);
    if (error) { req.log.error(error); return res.status(404).end(); }
    res.redirect(data.signedUrl);
});

app.get('/api/admin/id/:id', requireAdmin, async (req, res) => {
    const { data: user } = await supabase.from('app_users').select('id_path').eq('id', req.params.id).maybeSingle();
    if (!user || !user.id_path) return res.status(404).end();
    const { data, error } = await supabase.storage.from('verification-ids').createSignedUrl(user.id_path, 120);
    if (error) { req.log.error(error); return res.status(404).end(); }
    res.redirect(data.signedUrl);
});

app.post('/api/admin/approve/:id', requireAdmin, async (req, res) => {
    const { error } = await supabase.from('app_users').update({ status: 'verified', reviewed_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) { req.log.error(error); return res.status(500).json({ error: 'server_error' }); }
    res.json({ ok: true });
});

app.post('/api/admin/reject/:id', requireAdmin, async (req, res) => {
    const { error } = await supabase.from('app_users').update({ status: 'rejected', reviewed_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) { req.log.error(error); return res.status(500).json({ error: 'server_error' }); }
    res.json({ ok: true });
});

// Lets a hosting platform (or you) confirm the app can actually reach its database.
app.get('/healthz', async (req, res) => {
    const { error } = await supabase.from('app_users').select('id').limit(1);
    if (error) return res.status(503).json({ ok: false });
    res.json({ ok: true });
});

const server = app.listen(PORT, () => logger.info(`🌸 Gulece running at http://localhost:${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
