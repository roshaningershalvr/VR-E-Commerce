const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'store.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const INDEX_PATH = path.join(__dirname, 'index.html');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new sqlite3.Database(DB_PATH);

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

const defaultProducts = [
  { name: 'Shampoo Conditioner Packs', category: 'Cosmetics', price_inr: 12450, image: './assets/images/products/shampoo.jpg' },
  { name: 'Rose Gold Diamonds Earring', category: 'Jewellery', price_inr: 165170, image: './assets/images/products/jewellery-1.jpg' },
  { name: 'Mens Winter Leather Jacket', category: 'Jacket', price_inr: 3984, image: './assets/images/products/jacket-3.jpg' },
  { name: 'Pure Garment Dyed Cotton Shirt', category: 'Shirt', price_inr: 2739, image: './assets/images/products/shirt-1.jpg' },
  { name: 'Casual Mens Brown Shoes', category: 'Casual', price_inr: 4316, image: './assets/images/products/shoe-2.jpg' }
];

async function initializeDatabase() {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  await new Promise((resolve, reject) => {
    db.exec(schema, err => (err ? reject(err) : resolve()));
  });

  const existing = await get('SELECT COUNT(*) AS count FROM products');
  if (existing.count === 0) {
    for (const product of defaultProducts) {
      await run(
        'INSERT INTO products (name, category, price_inr, image, stock) VALUES (?, ?, ?, ?, ?)',
        [product.name, product.category, product.price_inr, product.image, 100]
      );
    }
  }

  await run('DELETE FROM sessions WHERE expires_at <= datetime("now")');
}

app.use(express.json());
app.use(cookieParser());
app.use('/assets', express.static(path.join(__dirname, 'assets'), { index: false }));

const rateLimitBucket = new Map();
function rateLimit({ windowMs, maxRequests }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = rateLimitBucket.get(key) || { count: 0, expiresAt: now + windowMs };
    if (now > entry.expiresAt) {
      entry.count = 0;
      entry.expiresAt = now + windowMs;
    }
    entry.count += 1;
    rateLimitBucket.set(key, entry);
    if (entry.count > maxRequests) return res.status(429).json({ error: 'Too many requests' });
    return next();
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const cachedIndexHtml = fs.readFileSync(INDEX_PATH, 'utf8');
app.get('/', (_req, res) => {
  res.type('html');
  res.send(cachedIndexHtml);
});

function createSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function authRequired(optional = false) {
  return async (req, res, next) => {
    const token = req.cookies.auth_token;
    if (!token) {
      if (optional) return next();
      return res.status(401).json({ error: 'Authentication required' });
    }
    const tokenHash = sha256(token);
    const session = await get(
      `SELECT s.id, s.user_id, u.email
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
      [tokenHash]
    );
    if (!session) {
      if (optional) return next();
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    req.user = { id: session.user_id, email: session.email };
    return next();
  };
}

function issueCsrfToken(req, res) {
  let csrfToken = req.cookies.csrf_token;
  if (!csrfToken) {
    csrfToken = crypto.randomBytes(16).toString('hex');
    res.cookie('csrf_token', csrfToken, { httpOnly: false, sameSite: 'lax', secure: false, maxAge: 7 * 24 * 3600 * 1000 });
  }
  return csrfToken;
}

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const csrfCookie = req.cookies.csrf_token;
  const csrfHeader = req.get('x-csrf-token');
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  return next();
}

app.use(authRequired(true));
app.use((req, res, next) => {
  issueCsrfToken(req, res);
  next();
});
app.use(csrfProtection);

async function setSessionCookies(res, user) {
  const token = createSessionToken();
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  await run('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)', [user.id, tokenHash, expiresAt]);
  res.cookie('auth_token', token, { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 7 * 24 * 3600 * 1000 });
  issueCsrfToken({ cookies: {} }, res);
}

async function clearSession(req) {
  const token = req.cookies.auth_token;
  if (!token) return false;
  const tokenHash = sha256(token);
  await run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  return true;
}

function normalizePrice(value) {
  if (value === undefined || value === null) return NaN;
  if (typeof value === 'number') return Math.round(value);
  const parsed = Number(String(value).replace(/[^\d.-]/g, ''));
  return Math.round(parsed);
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/register', rateLimit({ windowMs: 60_000, maxRequests: 10 }), async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Valid name, email and password (min 6 chars) are required' });
    }
    const existing = await get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 10);
    const created = await run(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name.trim(), email.toLowerCase().trim(), passwordHash]
    );
    const user = await get('SELECT id, name, email FROM users WHERE id = ?', [created.lastID]);
    await setSessionCookies(res, user);
    return res.status(201).json({ user });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to register user' });
  }
});

app.post('/api/auth/login', rateLimit({ windowMs: 60_000, maxRequests: 20 }), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const userRow = await get('SELECT id, name, email, password_hash FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!userRow) return res.status(401).json({ error: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, userRow.password_hash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    const user = { id: userRow.id, name: userRow.name, email: userRow.email };
    await setSessionCookies(res, user);
    return res.json({ user });
  } catch {
    return res.status(500).json({ error: 'Failed to login user' });
  }
});

app.post('/api/auth/logout', authRequired(), async (req, res) => {
  await clearSession(req);
  res.clearCookie('auth_token');
  return res.json({ ok: true });
});

app.get('/api/auth/me', authRequired(), async (req, res) => {
  const user = await get('SELECT id, name, email FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(401).json({ error: 'User not found' });
  return res.json({ user });
});

app.get('/api/products', async (req, res) => {
  const query = (req.query.q || '').toString().trim().toLowerCase();
  let products = [];
  if (query) {
    products = await all(
      'SELECT id, name, category, price_inr, image, stock FROM products WHERE lower(name) LIKE ? OR lower(category) LIKE ? ORDER BY id DESC',
      [`%${query}%`, `%${query}%`]
    );
  } else {
    products = await all('SELECT id, name, category, price_inr, image, stock FROM products ORDER BY id DESC');
  }
  return res.json({ products });
});

app.get('/api/cart', authRequired(), rateLimit({ windowMs: 60_000, maxRequests: 120 }), async (req, res) => {
  const items = await all(
    `SELECT ci.id, ci.quantity, p.id AS product_id, p.name, p.category, p.price_inr, p.image
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.user_id = ?
     ORDER BY ci.id DESC`,
    [req.user.id]
  );
  const total = items.reduce((sum, item) => sum + item.price_inr * item.quantity, 0);
  return res.json({ items, total_inr: total });
});

app.post('/api/cart/items', authRequired(), rateLimit({ windowMs: 60_000, maxRequests: 120 }), async (req, res) => {
  try {
    const { productId, quantity, product } = req.body || {};
    const qty = Number(quantity || 1);
    if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: 'Quantity must be a positive integer' });

    let targetProductId = Number(productId);
    if (!Number.isInteger(targetProductId) || targetProductId < 1) {
      if (!product || !product.name) return res.status(400).json({ error: 'Valid product data is required' });
      const priceInr = normalizePrice(product.price_inr);
      if (!Number.isFinite(priceInr) || priceInr < 0) return res.status(400).json({ error: 'Valid product price is required' });
      const normalizedName = product.name.trim();
      const existing = await get('SELECT id FROM products WHERE name = ? AND price_inr = ?', [normalizedName, priceInr]);
      if (existing) {
        targetProductId = existing.id;
      } else {
        const created = await run(
          'INSERT INTO products (name, category, price_inr, image, stock) VALUES (?, ?, ?, ?, ?)',
          [normalizedName, product.category || 'General', priceInr, product.image || null, 100]
        );
        targetProductId = created.lastID;
      }
    }

    const productRow = await get('SELECT id, stock FROM products WHERE id = ?', [targetProductId]);
    if (!productRow) return res.status(404).json({ error: 'Product not found' });

    const existingCartItem = await get(
      'SELECT id, quantity FROM cart_items WHERE user_id = ? AND product_id = ?',
      [req.user.id, targetProductId]
    );

    if (existingCartItem) {
      const nextQty = existingCartItem.quantity + qty;
      if (nextQty > productRow.stock) return res.status(400).json({ error: 'Quantity exceeds stock' });
      await run('UPDATE cart_items SET quantity = ? WHERE id = ?', [nextQty, existingCartItem.id]);
    } else {
      if (qty > productRow.stock) return res.status(400).json({ error: 'Quantity exceeds stock' });
      await run('INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)', [req.user.id, targetProductId, qty]);
    }

    return res.status(201).json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Failed to add item to cart' });
  }
});

app.patch('/api/cart/items/:id', authRequired(), rateLimit({ windowMs: 60_000, maxRequests: 120 }), async (req, res) => {
  const itemId = Number(req.params.id);
  const quantity = Number(req.body?.quantity);
  if (!Number.isInteger(itemId) || itemId < 1) return res.status(400).json({ error: 'Invalid cart item ID' });
  if (!Number.isInteger(quantity) || quantity < 1) return res.status(400).json({ error: 'Quantity must be a positive integer' });

  const item = await get(
    `SELECT ci.id, p.stock FROM cart_items ci JOIN products p ON p.id = ci.product_id
     WHERE ci.id = ? AND ci.user_id = ?`,
    [itemId, req.user.id]
  );
  if (!item) return res.status(404).json({ error: 'Cart item not found' });
  if (quantity > item.stock) return res.status(400).json({ error: 'Quantity exceeds stock' });

  await run('UPDATE cart_items SET quantity = ? WHERE id = ?', [quantity, itemId]);
  return res.json({ ok: true });
});

app.delete('/api/cart/items/:id', authRequired(), rateLimit({ windowMs: 60_000, maxRequests: 120 }), async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId) || itemId < 1) return res.status(400).json({ error: 'Invalid cart item ID' });
  const result = await run('DELETE FROM cart_items WHERE id = ? AND user_id = ?', [itemId, req.user.id]);
  if (!result.changes) return res.status(404).json({ error: 'Cart item not found' });
  return res.json({ ok: true });
});

app.post('/api/orders', authRequired(), rateLimit({ windowMs: 60_000, maxRequests: 60 }), async (req, res) => {
  try {
    const shippingName = (req.body?.shipping_name || '').toString().trim();
    const shippingAddress = (req.body?.shipping_address || '').toString().trim();
    if (!shippingName || !shippingAddress) {
      return res.status(400).json({ error: 'Shipping name and address are required' });
    }

    const cartItems = await all(
      `SELECT ci.id, ci.quantity, p.id AS product_id, p.price_inr, p.stock
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = ?`,
      [req.user.id]
    );
    if (!cartItems.length) return res.status(400).json({ error: 'Cart is empty' });

    for (const item of cartItems) {
      if (item.quantity > item.stock) return res.status(400).json({ error: 'One or more items exceed stock' });
    }

    const total = cartItems.reduce((sum, item) => sum + item.price_inr * item.quantity, 0);
    const order = await run(
      'INSERT INTO orders (user_id, shipping_name, shipping_address, total_inr) VALUES (?, ?, ?, ?)',
      [req.user.id, shippingName, shippingAddress, total]
    );

    for (const item of cartItems) {
      await run(
        'INSERT INTO order_items (order_id, product_id, quantity, price_inr) VALUES (?, ?, ?, ?)',
        [order.lastID, item.product_id, item.quantity, item.price_inr]
      );
      await run('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.product_id]);
    }
    await run('DELETE FROM cart_items WHERE user_id = ?', [req.user.id]);

    return res.status(201).json({ order_id: order.lastID, total_inr: total, status: 'placed' });
  } catch {
    return res.status(500).json({ error: 'Failed to create order' });
  }
});

app.get('/api/orders', authRequired(), rateLimit({ windowMs: 60_000, maxRequests: 120 }), async (req, res) => {
  const orders = await all(
    'SELECT id, shipping_name, shipping_address, status, total_inr, created_at FROM orders WHERE user_id = ? ORDER BY id DESC',
    [req.user.id]
  );
  return res.json({ orders });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error' });
});

async function startServer() {
  await initializeDatabase();
  return app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = { app, startServer, initializeDatabase, db };
