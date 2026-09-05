const { normalisePhone, isSendable, renderTemplate, buildWaLink } = require('../services/messaging/render');

describe('normalisePhone', () => {
  it('converts a local Pakistani number', () => {
    expect(normalisePhone('03001234567', '92')).toBe('923001234567');
  });

  it('leaves an already-international number alone', () => {
    expect(normalisePhone('923001234567', '92')).toBe('923001234567');
    expect(normalisePhone('+92 300 123 4567', '92')).toBe('923001234567');
  });

  it('uses the gym dial code, not a hardcoded 92', () => {
    // The old client helper prefixed every 10-digit number with 92, so a US
    // gym's member number became 92xxxxxxxxxx and the message went elsewhere.
    expect(normalisePhone('5551234567', '1')).toBe('15551234567');
    expect(normalisePhone('(555) 123-4567', '1')).toBe('15551234567');
    expect(normalisePhone('07700900123', '44')).toBe('447700900123');
    expect(normalisePhone('09876543210', '91')).toBe('919876543210');
  });

  it('strips punctuation and spaces', () => {
    expect(normalisePhone('0300-555 4444', '92')).toBe('923005554444');
  });

  it('returns null for an empty or non-numeric value', () => {
    expect(normalisePhone('', '92')).toBeNull();
    expect(normalisePhone(null, '92')).toBeNull();
    expect(normalisePhone('abc', '92')).toBeNull();
  });

  it('does not rewrite a number that already carries another country code', () => {
    // Redirecting a message to a different country is worse than not sending.
    expect(normalisePhone('447700900123', '92')).toBe('447700900123');
  });
});

describe('isSendable', () => {
  it('accepts a plausible international number', () => {
    expect(isSendable('923001234567')).toBe(true);
  });

  it('rejects something too short or too long', () => {
    expect(isSendable('123')).toBe(false);
    expect(isSendable('1234567890123456789')).toBe(false);
    expect(isSendable(null)).toBe(false);
  });
});

describe('renderTemplate', () => {
  const gym = { gym_name: 'Iron Temple', phone: '0211234567', currency: 'PKR', locale: 'en-PK', default_monthly_fee: 3000 };
  const member = { name: 'Ali Hassan' };

  it('fills every placeholder', () => {
    const out = renderTemplate(
      'Hi [Name], [GymName] expires in [Days] days on [ExpiryDate]. Pay [Amount]. Call [Phone].',
      { member, gym, days: 7, expiryDate: '2026-09-12' }
    );
    expect(out).toContain('Ali Hassan');
    expect(out).toContain('Iron Temple');
    expect(out).toContain('7');
    // Date wording follows the gym's locale (en-PK renders "12-Sept-2026",
    // en-GB "12 Sep 2026"), so assert on the parts rather than one spelling.
    expect(out).toMatch(/12.{0,2}Sep\w*.{0,2}2026/);
    expect(out).toContain('0211234567');
    expect(out).not.toContain('[');
  });

  it('is case-insensitive on placeholders', () => {
    expect(renderTemplate('Hi [name] at [GYMNAME]', { member, gym })).toBe('Hi Ali Hassan at Iron Temple');
  });

  it('uses the gym currency, not a hardcoded rupee', () => {
    const usd = renderTemplate('[Amount]', { member, gym: { ...gym, currency: 'USD', locale: 'en-US', default_monthly_fee: 49 } });
    expect(usd).toContain('49');
    expect(usd).not.toContain('PKR');
  });

  it('shows an absolute day count for a past date', () => {
    // "expired 3 days ago" should read 3, not -3.
    expect(renderTemplate('[Days]', { member, gym, days: -3 })).toBe('3');
  });

  it('handles a missing template and missing values', () => {
    expect(renderTemplate(null, { member, gym })).toBe('');
    expect(renderTemplate('Hi [Name]', { member: {}, gym: {} })).toBe('Hi');
  });
});

describe('buildWaLink', () => {
  it('builds an encoded wa.me link', () => {
    const link = buildWaLink('03001234567', 'Hi there & welcome', '92');
    expect(link).toBe('https://wa.me/923001234567?text=Hi%20there%20%26%20welcome');
  });

  it('returns null when the number cannot be read', () => {
    expect(buildWaLink('', 'x', '92')).toBeNull();
  });
});
