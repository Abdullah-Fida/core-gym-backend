/**
 * Global error handler.
 */

/**
 * Postgres error codes that mean "the caller sent something invalid", not
 * "the server broke". These used to fall through to a blanket 500 with the
 * message "Internal server error", which told the user nothing — a gym created
 * without a phone number simply failed with no explanation.
 */
const PG_CLIENT_ERRORS = {
  '23502': 'notNull',
  '23503': 'foreignKey',
  '23505': 'unique',
  '23514': 'check',
  '22001': 'tooLong',
  '22007': 'badDate',
  '22P02': 'badInput',
};

/** Pull the column name out of a Postgres message, for a readable reply. */
function columnFrom(message) {
  const match = String(message || '').match(/column "([^"]+)"/);
  return match ? match[1].replace(/_/g, ' ') : null;
}

function describePgError(err) {
  const kind = PG_CLIENT_ERRORS[err.code];
  if (!kind) return null;

  const column = columnFrom(err.message);

  switch (kind) {
    case 'notNull':
      return column ? `${column} is required.` : 'A required field was missing.';
    case 'unique':
      return 'That record already exists.';
    case 'foreignKey':
      return 'That refers to something which no longer exists.';
    case 'check':
      return 'One of those values is not allowed.';
    case 'tooLong':
      return 'One of those values is too long.';
    case 'badDate':
    case 'badInput':
      return 'One of those values could not be read.';
    default:
      return null;
  }
}

const errorHandler = (err, req, res, _next) => {
  console.error('[ERROR]', err.message, err.stack?.split('\n')[1]);

  // Zod validation error
  if (err.name === 'ZodError') {
    const errors = err.errors.map((e) => ({ field: e.path.join('.'), message: e.message }));
    return res.status(400).json({
      success: false,
      // Name the offending field in the message itself; a bare "Validation
      // error" left the UI with nothing useful to show in a toast.
      message: errors.length
        ? `${errors[0].field ? `${errors[0].field.replace(/_/g, ' ')}: ` : ''}${errors[0].message}`
        : 'Validation error',
      errors,
    });
  }

  // JWT error
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  // Supabase / PostgREST
  if (err.code === 'PGRST') {
    return res.status(400).json({ success: false, message: err.message });
  }

  const described = describePgError(err);
  if (described) {
    return res.status(400).json({ success: false, message: described });
  }

  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : 'Internal server error';
  res.status(status).json({ success: false, message });
};

/**
 * Async wrapper — catches thrown errors and passes to error handler
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { errorHandler, asyncHandler };
