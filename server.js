const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  products: path.join(DATA_DIR, 'products.json'),
  cart: path.join(DATA_DIR, 'cart.json'),
  orders: path.join(DATA_DIR, 'orders.json'),
};
const CATEGORIES = ['Clothing', 'Footwear', 'Accessories'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function readJSON(file, fallback = []) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(data)) throw new Error('array expected');
    return data;
  } catch (e) {
    console.warn(`[WARN] Could not read ${path.basename(file)}: ${e.message}. Using default value.`);
    return fallback;
  }
}

async function writeJSON(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

function validateProduct(body) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const brand = typeof b.brand === 'string' ? b.brand.trim() : '';
  const category = typeof b.category === 'string' ? b.category.trim() : '';
  const size = typeof b.size === 'string' ? b.size.trim() : String(b.size ?? '').trim();
  const price = Number(b.price);
  const stock = Number(b.stock);

  if (!name || !brand || !size || b.price === '' || b.price == null || b.stock === '' || b.stock == null) {
    throw new HttpError(400, 'Fill in all fields: name, brand, size, price, stock');
  }
  if (name.length > 100 || brand.length > 50 || size.length > 20) throw new HttpError(400, 'One of the fields is too long');
  if (!CATEGORIES.includes(category)) throw new HttpError(400, `category must be one of: ${CATEGORIES.join(', ')}`);
  if (!Number.isFinite(price) || price <= 0) throw new HttpError(400, 'price must be a number greater than 0');
  if (!Number.isInteger(stock) || stock < 0) throw new HttpError(400, 'stock must be an integer >= 0');
  return { name, brand, category, size, price, stock };
}

function parseId(value, label = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `${label} must be a positive integer`);
  return id;
}

function buildCart(cartRaw, products) {
  const items = [];
  for (const row of cartRaw) {
    const p = products.find((x) => x.id === row.productId);
    if (!p) continue;
    items.push({
      productId: p.id, name: p.name, brand: p.brand, size: p.size, price: p.price,
      quantity: row.quantity, subtotal: p.price * row.quantity,
    });
  }
  return {
    items,
    count: items.reduce((s, i) => s + i.quantity, 0),
    total: items.reduce((s, i) => s + i.subtotal, 0),
  };
}

function buildStats(products) {
  const byBrand = {};
  for (const p of products) {
    const b = byBrand[p.brand] || (byBrand[p.brand] = { brand: p.brand, count: 0, stock: 0, value: 0 });
    b.count += 1;
    b.stock += p.stock;
    b.value += p.price * p.stock;
  }
  return {
    totalProducts: products.length,
    totalStock: products.reduce((s, p) => s + p.stock, 0),
    totalValue: products.reduce((s, p) => s + p.price * p.stock, 0),
    byBrand: Object.values(byBrand),
  };
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function toXML({ generatedAt, stats, products }) {
  const brands = stats.byBrand
    .map((b) => `    <brand name="${esc(b.brand)}" count="${b.count}" stock="${b.stock}" value="${b.value}"/>`)
    .join('\n');
  const items = products
    .map((p) => `    <product id="${p.id}">
      <name>${esc(p.name)}</name>
      <brand>${esc(p.brand)}</brand>
      <category>${esc(p.category)}</category>
      <size>${esc(p.size)}</size>
      <price>${p.price}</price>
      <stock>${p.stock}</stock>
    </product>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<catalog shop="DEEPMAG" generatedAt="${generatedAt}">
  <statistics>
    <totalProducts>${stats.totalProducts}</totalProducts>
    <totalStock>${stats.totalStock}</totalStock>
    <totalValue>${stats.totalValue}</totalValue>
${brands}
  </statistics>
  <products>
${items}
  </products>
</catalog>`;
}

function toHTML({ generatedAt, stats, products }) {
  const rows = products
    .map((p) => `<tr><td>${p.id}</td><td>${esc(p.name)}</td><td>${esc(p.brand)}</td><td>${esc(p.category)}</td><td>${esc(p.size)}</td><td>${p.price}</td><td>${p.stock}</td></tr>`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>DEEPMAG - Catalog</title>
<style>body{font-family:Arial,sans-serif;margin:30px}table{border-collapse:collapse}th,td{border:1px solid #999;padding:6px 10px;text-align:left}th{background:#111;color:#fff}</style>
</head><body>
<h1>DEEPMAG - Catalog</h1>
<p>Generated: ${esc(generatedAt)}</p>
<p>Products: <b>${stats.totalProducts}</b> | Units in stock: <b>${stats.totalStock}</b> | Stock value: <b>$${stats.totalValue}</b></p>
<table><tr><th>ID</th><th>Name</th><th>Brand</th><th>Category</th><th>Size</th><th>Price, $</th><th>Stock</th></tr>
${rows}
</table></body></html>`;
}

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/products', wrap(async (req, res) => {
  let products = await readJSON(FILES.products);
  const { q, category } = req.query;
  if (category) products = products.filter((p) => p.category === category);
  if (q) {
    const s = String(q).toLowerCase();
    products = products.filter((p) => `${p.name} ${p.brand}`.toLowerCase().includes(s));
  }
  res.json(products);
}));

app.get('/api/products/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const product = (await readJSON(FILES.products)).find((p) => p.id === id);
  if (!product) throw new HttpError(404, `Product with id=${id} not found`);
  res.json(product);
}));

app.post('/api/products', wrap(async (req, res) => {
  const product = await withLock(async () => {
    const data = validateProduct(req.body);
    const products = await readJSON(FILES.products);
    const created = { id: products.reduce((m, p) => Math.max(m, p.id), 0) + 1, ...data };
    products.push(created);
    await writeJSON(FILES.products, products);
    return created;
  });
  res.status(201).json({ message: 'Product added', product });
}));

app.delete('/api/products/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  await withLock(async () => {
    const products = await readJSON(FILES.products);
    const idx = products.findIndex((p) => p.id === id);
    if (idx === -1) throw new HttpError(404, `Product with id=${id} not found`);
    products.splice(idx, 1);
    const cart = (await readJSON(FILES.cart)).filter((c) => c.productId !== id);
    await writeJSON(FILES.products, products);
    await writeJSON(FILES.cart, cart);
  });
  res.json({ message: `Product ${id} deleted` });
}));

app.get('/api/cart', wrap(async (req, res) => {
  res.json(buildCart(await readJSON(FILES.cart), await readJSON(FILES.products)));
}));

app.post('/api/cart', wrap(async (req, res) => {
  const cart = await withLock(async () => {
    const productId = parseId(req.body?.productId, 'productId');
    const quantity = req.body?.quantity === undefined ? 1 : Number(req.body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw new HttpError(400, 'quantity must be an integer >= 1');

    const products = await readJSON(FILES.products);
    const product = products.find((p) => p.id === productId);
    if (!product) throw new HttpError(404, `Product with id=${productId} does not exist`);

    const cartRaw = await readJSON(FILES.cart);
    const row = cartRaw.find((c) => c.productId === productId);
    const newQty = (row ? row.quantity : 0) + quantity;
    if (newQty > product.stock) throw new HttpError(409, `Not enough items in stock (available: ${product.stock})`);

    if (row) row.quantity = newQty;
    else cartRaw.push({ productId, quantity });
    await writeJSON(FILES.cart, cartRaw);
    return buildCart(cartRaw, products);
  });
  res.status(201).json(cart);
}));

app.delete('/api/cart/:productId', wrap(async (req, res) => {
  const productId = parseId(req.params.productId, 'productId');
  const cart = await withLock(async () => {
    const cartRaw = await readJSON(FILES.cart);
    if (!cartRaw.some((c) => c.productId === productId)) throw new HttpError(404, 'This product is not in the cart');
    const next = cartRaw.filter((c) => c.productId !== productId);
    await writeJSON(FILES.cart, next);
    return buildCart(next, await readJSON(FILES.products));
  });
  res.json(cart);
}));

app.delete('/api/cart', wrap(async (req, res) => {
  await withLock(() => writeJSON(FILES.cart, []));
  res.json(buildCart([], []));
}));

app.post('/api/checkout', wrap(async (req, res) => {
  const order = await withLock(async () => {
    const products = await readJSON(FILES.products);
    const cartRaw = await readJSON(FILES.cart);
    const cart = buildCart(cartRaw, products);
    if (cart.items.length === 0) throw new HttpError(400, 'Cart is empty');

    for (const item of cart.items) {
      const p = products.find((x) => x.id === item.productId);
      if (item.quantity > p.stock) throw new HttpError(409, `Only ${p.stock} of "${p.name}" left in stock`);
    }
    for (const item of cart.items) products.find((x) => x.id === item.productId).stock -= item.quantity;

    const orders = await readJSON(FILES.orders);
    const customer = typeof req.body?.customer === 'string' && req.body.customer.trim() ? req.body.customer.trim().slice(0, 100) : 'Guest';
    const created = {
      id: orders.reduce((m, o) => Math.max(m, o.id), 0) + 1,
      createdAt: new Date().toISOString(),
      customer,
      items: cart.items,
      total: cart.total,
    };
    orders.push(created);
    await writeJSON(FILES.orders, orders);
    await writeJSON(FILES.products, products);
    await writeJSON(FILES.cart, []);
    return created;
  });
  res.status(201).json({ message: 'Order placed', order });
}));

app.get('/api/orders', wrap(async (req, res) => res.json(await readJSON(FILES.orders))));

app.delete('/api/orders/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  await withLock(async () => {
    const orders = await readJSON(FILES.orders);
    const idx = orders.findIndex((o) => o.id === id);
    if (idx === -1) throw new HttpError(404, `Order ${id} not found`);
    const products = await readJSON(FILES.products);
    for (const item of orders[idx].items) {
      const p = products.find((x) => x.id === item.productId);
      if (p) p.stock += item.quantity;
    }
    orders.splice(idx, 1);
    await writeJSON(FILES.orders, orders);
    await writeJSON(FILES.products, products);
  });
  res.json({ message: `Order ${id} cancelled` });
}));

app.get('/api/catalog', wrap(async (req, res) => {
  const formats = { json: 'application/json', xml: 'application/xml', html: 'text/html' };
  if (req.query.format) {
    if (!formats[req.query.format]) throw new HttpError(400, 'format must be json, xml or html');
    req.headers.accept = formats[req.query.format];
  }
  const products = await readJSON(FILES.products);
  const payload = { generatedAt: new Date().toISOString(), stats: buildStats(products), products };

  res.format({
    'application/json': () => res.json(payload),
    'application/xml': () => res.type('application/xml').send(toXML(payload)),
    'text/xml': () => res.type('application/xml').send(toXML(payload)),
    'text/html': () => res.type('text/html').send(toHTML(payload)),
    default: () => res.status(406).json({ error: 'Supported Accept values: application/json, application/xml, text/html' }),
  });
}));

app.use('/api', (req, res) => res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON in request body' });
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

app.listen(PORT, () => console.log(`DEEPMAG is running: http://localhost:${PORT}`));