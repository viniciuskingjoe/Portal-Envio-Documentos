import express from 'express';
import db from '../db.js';
import { requireAuth } from '../auth.js';

const router = express.Router();
router.use(requireAuth);

router.get('/branches', (req, res) => {
  res.json({ items: db.prepare('SELECT id, name FROM branches WHERE active = 1 ORDER BY name').all() });
});

router.get('/sectors', (req, res) => {
  res.json({ items: db.prepare('SELECT id, name FROM sectors WHERE active = 1 ORDER BY name').all() });
});

export default router;
