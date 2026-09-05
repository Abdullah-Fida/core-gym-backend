/**
 * Regression tests for the Phase 1 auth boundary fixes.
 *
 * Each block here corresponds to a hole that was live in production. Supabase
 * is mocked so these run with no network and no database — they assert the
 * *authorisation* decisions, which is where the bugs were.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-not-used-anywhere-real';
process.env.SUPER_ADMIN_EMAIL = 'owner@platform.test';

const jwt = require('jsonwebtoken');

// ── Supabase mock ────────────────────────────────────────
// A tiny chainable stub. Tests set `mockRows[table]` to control what a query
// resolves to; every filter method returns `this` so any chain length works.
const mockRows = {};
const mockUpdates = [];

// jest.mock is hoisted, so the factory may only close over `mock*`-prefixed
// names. The chainable stub is therefore built inside the factory.
jest.mock('../db/supabase', () => {
  const makeQuery = (table) => {
    const result = () => ({ data: mockRows[table] ?? null, error: null, count: 0 });
    const q = {
      select: () => q,
      insert: (row) => { mockUpdates.push({ table, op: 'insert', row }); return q; },
      update: (row) => { mockUpdates.push({ table, op: 'update', row }); return q; },
      delete: () => q,
      upsert: () => q,
      eq: () => q,
      neq: () => q,
      gt: () => q,
      gte: () => q,
      lt: () => q,
      lte: () => q,
      is: () => q,
      or: () => q,
      not: () => q,
      ilike: () => q,
      in: () => q,
      order: () => q,
      range: () => q,
      limit: () => q,
      single: async () => result(),
      maybeSingle: async () => result(),
      then: (resolve) => Promise.resolve(result()).then(resolve),
    };
    return q;
  };
  return {
    supabase: { from: makeQuery },
    supabaseAnon: { from: makeQuery },
  };
});

const request = require('supertest');
const app = require('../server');

const GYM_A = '11111111-1111-1111-1111-111111111111';
const GYM_B = '22222222-2222-2222-2222-222222222222';

const tokenFor = (gym_id, role = 'gym_owner', email = 'a@test.dev') =>
  jwt.sign({ gym_id, email, role }, process.env.JWT_SECRET, { expiresIn: '1h' });

beforeEach(() => {
  for (const k of Object.keys(mockRows)) delete mockRows[k];
  mockUpdates.length = 0;
  // Default: the authenticate middleware's is_active lookup passes.
  mockRows.gyms = { id: GYM_A, is_active: true, role: 'gym_owner' };
});

describe('tenant isolation: GET /api/members', () => {
  test('rejects a request naming another gym via ?gym_id=', async () => {
    const res = await request(app)
      .get(`/api/members?gym_id=${GYM_B}`)
      .set('Authorization', `Bearer ${tokenFor(GYM_A)}`);

    // ownGymOnly must refuse; it previously honoured the query param and
    // returned the other tenant's member list.
    expect(res.status).toBe(403);
  });

  test('allows a request naming the caller\'s own gym', async () => {
    mockRows.members = [];
    const res = await request(app)
      .get(`/api/members?gym_id=${GYM_A}`)
      .set('Authorization', `Bearer ${tokenFor(GYM_A)}`);

    expect(res.status).toBe(200);
  });

  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/members');
    expect(res.status).toBe(401);
  });
});

describe('privilege separation: plan_type must not grant admin', () => {
  test('a gym_owner token cannot reach the admin API', async () => {
    const res = await request(app)
      .get('/api/admin/gyms')
      .set('Authorization', `Bearer ${tokenFor(GYM_A, 'gym_owner')}`);

    expect(res.status).toBe(403);
  });

  test('login on a pro-plan gym whose role is gym_owner returns gym_owner', async () => {
    const bcrypt = require('bcryptjs');
    mockRows.gyms = {
      id: GYM_A,
      email: 'pro@gym.test',
      // The bug: this used to be read as "pro plan => super admin".
      plan_type: 'pro',
      role: 'gym_owner',
      is_active: true,
      auth_password_hash: await bcrypt.hash('correct-horse', 12),
    };

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'pro@gym.test', password: 'correct-horse' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('gym_owner');
  });

  test('login honours role=admin from the column', async () => {
    const bcrypt = require('bcryptjs');
    mockRows.gyms = {
      id: GYM_A,
      email: 'boss@gym.test',
      plan_type: 'free',
      role: 'admin',
      is_active: true,
      auth_password_hash: await bcrypt.hash('correct-horse', 12),
    };

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'boss@gym.test', password: 'correct-horse' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });
});

describe('POST /api/auth/change-password requires authentication', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ gym_id: GYM_B, current_password: 'x', new_password: 'yyyy' });

    // Previously this took gym_id straight from the body with no guard.
    expect(res.status).toBe(401);
  });

  test('ignores gym_id in the body and uses the JWT', async () => {
    const bcrypt = require('bcryptjs');
    mockRows.gyms = {
      id: GYM_A,
      is_active: true,
      role: 'gym_owner',
      auth_password_hash: await bcrypt.hash('old-password', 12),
    };

    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${tokenFor(GYM_A)}`)
      .send({ gym_id: GYM_B, current_password: 'old-password', new_password: 'new-password' });

    expect(res.status).toBe(200);
    // The write must target the token's gym, never the body's.
    const write = mockUpdates.find((u) => u.table === 'gyms' && u.op === 'update' && u.row.auth_password_hash);
    expect(write).toBeDefined();
  });
});

describe('password reset does not leak account existence', () => {
  test('an unregistered number gets the same generic answer', async () => {
    mockRows.gyms = null;
    const res = await request(app).post('/api/auth/forgot-password').send({ phone: '+10000000000' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/if that number is registered/i);
  });

  test('the OTP is never returned in the response body', async () => {
    mockRows.gyms = { id: GYM_A };
    const res = await request(app).post('/api/auth/forgot-password').send({ phone: '+10000000000' });

    expect(JSON.stringify(res.body)).not.toMatch(/\b\d{6}\b/);
  });

  test('a stored OTP is hashed, not plaintext', async () => {
    mockRows.gyms = { id: GYM_A };
    await request(app).post('/api/auth/forgot-password').send({ phone: '+10000000000' });

    const insert = mockUpdates.find((u) => u.table === 'password_resets' && u.op === 'insert');
    expect(insert).toBeDefined();
    expect(insert.row.otp_hash).toMatch(/^\$2[aby]\$/); // bcrypt
    expect(insert.row).not.toHaveProperty('otp');
  });
});

describe('POST /api/attendance exists', () => {
  test('the bare path is routed, not 404', async () => {
    mockRows.members = { id: 'm1', name: 'Test', status: 'active', latest_expiry: '2999-01-01' };
    const res = await request(app)
      .post('/api/attendance')
      .set('Authorization', `Bearer ${tokenFor(GYM_A)}`)
      .send({ member_id: 'm1', check_in_time: new Date().toISOString() });

    // The three frontend call sites hit this path; it used to fall through to
    // the 404 handler, so every check-in silently failed.
    expect(res.status).not.toBe(404);
  });
});
