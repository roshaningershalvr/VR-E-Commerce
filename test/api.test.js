const request = require('supertest');
const { app, initializeDatabase, db } = require('../server');

describe('E-commerce API', () => {
  const agent = request.agent(app);
  const randomEmail = `user_${Date.now()}@example.com`;

  beforeAll(async () => {
    await initializeDatabase();
  });

  afterAll(done => {
    db.close(done);
  });

  test('registers user and accesses cart/orders flow', async () => {
    const registerRes = await agent.post('/api/auth/register').send({
      name: 'Test User',
      email: randomEmail,
      password: 'password123'
    });
    expect(registerRes.statusCode).toBe(201);
    expect(registerRes.body.user.email).toBe(randomEmail);

    const addRes = await agent.post('/api/cart/items').send({
      quantity: 1,
      product: {
        name: `API Test Product ${Date.now()}`,
        category: 'Test',
        price_inr: 1200
      }
    });
    expect(addRes.statusCode).toBe(201);

    const cartRes = await agent.get('/api/cart');
    expect(cartRes.statusCode).toBe(200);
    expect(cartRes.body.items.length).toBeGreaterThan(0);

    const orderRes = await agent.post('/api/orders').send({
      shipping_name: 'Test User',
      shipping_address: '123 Test Street'
    });
    expect(orderRes.statusCode).toBe(201);
    expect(orderRes.body.total_inr).toBeGreaterThan(0);
  });
});
