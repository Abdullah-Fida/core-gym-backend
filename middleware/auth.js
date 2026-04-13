const jwt = require('jsonwebtoken');
const { supabase } = require('../db/supabase');

/**
 * Verify JWT and attach user to request
 */
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

/**
 * Require Super Admin role
 */
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Super Admin access required' });
  }
  next();
};

/**
 * Require Gym Owner role or Admin
 */
const requireGymOwner = (req, res, next) => {
  if (!['gym_owner', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

/**
 * Ensure gym_id in params/body matches authenticated user's gym
 */
const ownGymOnly = (req, res, next) => {
  if (req.user?.role === 'admin') return next(); // Admin can access all
  const gymId = req.params.gymId || req.body.gym_id || req.query.gym_id;
  if (gymId && gymId !== req.user?.gym_id) {
    return res.status(403).json({ success: false, message: 'Access denied to this gym\'s data' });
  }
  next();
};

module.exports = { authenticate, requireAdmin, requireGymOwner, ownGymOnly };
