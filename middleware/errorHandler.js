/**
 * Global error handler middleware
 */
const errorHandler = (err, req, res, next) => {
  console.error('[ERROR]', err.message, err.stack?.split('\n')[1]);

  // Zod validation error
  if (err.name === 'ZodError') {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: err.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
    });
  }

  // JWT error
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  // Supabase / database error
  if (err.code === 'PGRST') {
    return res.status(400).json({ success: false, message: err.message });
  }

  // Default
  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : 'Internal server error';
  res.status(status).json({ success: false, message });
};

/**
 * Async wrapper — catches thrown errors and passes to error handler
 */
const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { errorHandler, asyncHandler };
