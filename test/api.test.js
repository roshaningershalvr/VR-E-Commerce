const request = require('supertest');
const { app, initializeDatabase, db } = require('../server');

describe('E-commerce API', () => {
  const agent = request.agent(app);
  const randomEmail = `user_${Date.now()}@example.com`;
  let csrfToken = '';

  beforeAll(async () => {
    await initializeDatabase();
  });

  afterAll(done => {
    db.close(done);
  });

  test('registers user and accesses cart/orders flow', async () => {
    const healthRes = await agent.get('/api/health');
    const csrfCookie = (healthRes.headers['set-cookie'] || []).find(cookie => cookie.startsWith('csrf_token='));
    csrfToken = csrfCookie?.split(';')[0].split('=')[1] || '';

    const registerRes = await agent.post('/api/auth/register').send({
      name: 'Test User',
      email: randomEmail,
      password: 'password123'
    }).set('X-CSRF-Token', csrfToken);
    expect(registerRes.statusCode).toBe(201);
    expect(registerRes.body.user.email).toBe(randomEmail);
    const postRegisterCsrf = (registerRes.headers['set-cookie'] || []).find(cookie => cookie.startsWith('csrf_token='));
    if (postRegisterCsrf) csrfToken = postRegisterCsrf.split(';')[0].split('=')[1];

    const addRes = await agent.post('/api/cart/items').send({
      quantity: 1,
      product: {
        name: `API Test Product ${Date.now()}`,
        category: 'Test',
        price_inr: 1200
      }
    }).set('X-CSRF-Token', csrfToken);
    expect(addRes.statusCode).toBe(201);

    const cartRes = await agent.get('/api/cart');
    expect(cartRes.statusCode).toBe(200);
    expect(cartRes.body.items.length).toBeGreaterThan(0);

    const orderRes = await agent.post('/api/orders').send({
      shipping_name: 'Test User',
      shipping_address: '123 Test Street'
    }).set('X-CSRF-Token', csrfToken);
    expect(orderRes.statusCode).toBe(201);
    expect(orderRes.body.total_inr).toBeGreaterThan(0);
  });
});
