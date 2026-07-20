import express from 'express';
import session from 'express-session';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import authRouter from './auth.js';
import documentsRouter from './routes/documents.js';
import notasRouter from './routes/notas.js';
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
app.use('/api/documents', documentsRouter);   // legado (SQLite) — sai na conclusão da fase 3
app.use('/api/notas', notasRouter);           // notas vindas do Linx (SQL Server)
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

// Versão dos assets = maior mtime de app.js/styles.css. Injetada como ?v= no
// index.html para forçar o navegador a rebaixar JS/CSS novos após cada deploy
// (a SPA não recarrega app.js sozinha; sem isso fica HTML novo + JS velho).
function assetVersion() {
  let v = 0;
  for (const f of ['app.js', 'styles.css']) {
    try { v = Math.max(v, fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs); } catch {}
  }
  return String(Math.floor(v));
}

// Guard da SPA: sem sessão => login.
app.get('/', (req, res) => {
  if (!req.session?.user) return res.redirect('/login');
  noCache(res);
  const v = assetVersion();
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('href="styles.css"', `href="styles.css?v=${v}"`)
    .replace('src="app.js"', `src="app.js?v=${v}"`);
  res.type('html').send(html);
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
