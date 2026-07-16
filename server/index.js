import express from 'express';
import session from 'express-session';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import authRouter from './auth.js';
import documentsRouter from './routes/documents.js';
import auditRouter from './routes/audit.js';
import adminRouter from './routes/admin.js';
import metaRouter from './routes/meta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3003;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // atrás do Cloudflare Tunnel

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: 'fluxofiscal.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true', // true quando servido via HTTPS (túnel)
    maxAge: 1000 * 60 * 60 * 8, // 8h
  },
}));

// API
app.use('/api/auth', authRouter);
app.use('/api/meta', metaRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/audit', auditRouter);
app.use('/api/admin', adminRouter);

// Sempre revalidar HTML/CSS/JS: após um deploy (git pull) o navegador não pode
// servir asset velho em cache (causa mismatch HTML novo + JS antigo).
const noCache = res => res.setHeader('Cache-Control', 'no-cache');

// Tela de login (pública)
app.get('/login', (req, res) => { noCache(res); res.sendFile(path.join(PUBLIC_DIR, 'login.html')); });

// Saída de emergência: encerra a sessão e volta ao login (útil quando a UI trava).
app.get('/logout', (req, res) => {
  if (req.session) return req.session.destroy(() => res.redirect('/login'));
  res.redirect('/login');
});

// Guard da SPA: sem sessão => login.
app.get('/', (req, res) => {
  if (!req.session?.user) return res.redirect('/login');
  noCache(res);
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Assets estáticos (css/js/favicon). index:false pra não vazar index.html sem guard.
app.use(express.static(PUBLIC_DIR, { index: false, etag: true, setHeaders: noCache }));

// Erros do multer/upload
app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Arquivo excede 10 MB.' });
  console.error(err);
  res.status(500).json({ error: 'Erro interno.' });
});

app.listen(PORT, () => {
  console.log(`Fluxo Fiscal rodando em http://localhost:${PORT}`);
});
