import bcrypt from 'bcryptjs';

import { APPS } from '../models/User.js';
import { httpError } from './errors.js';

export const MIN_PASSWORD_LENGTH = 6;

export const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  apps: user.apps,
  role: user.role,
  active: user.active,
});

export function sanitizeApps(apps) {
  if (!Array.isArray(apps) || apps.length === 0) return [...APPS];
  const valid = apps.filter((app) => APPS.includes(app));
  return valid.length ? valid : [...APPS];
}

/** Valida o tamanho e devolve o hash. */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, `Password must have at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return bcrypt.hash(password, 10);
}
