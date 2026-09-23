import { requireAuth, requireApp } from '../../hooks/auth.js';

import exercises from './exercises.routes.js';
import workouts from './workouts.routes.js';
import logs from './logs.routes.js';
import foods from './foods.routes.js';
import meals from './meals.routes.js';
import measurements from './measurements.routes.js';
import profile from './profile.routes.js';
import dashboard from './dashboard.routes.js';

export default async function yperRoutes(fastify) {
  fastify.addHook('onRequest', requireAuth);
  fastify.addHook('onRequest', requireApp('yper'));

  fastify.register(exercises, { prefix: '/exercises' });
  fastify.register(workouts, { prefix: '/workouts' });
  fastify.register(logs, { prefix: '/logs' });
  fastify.register(foods, { prefix: '/foods' });
  fastify.register(meals, { prefix: '/meals' });
  fastify.register(measurements, { prefix: '/measurements' });
  fastify.register(profile, { prefix: '/profile' });
  fastify.register(dashboard, { prefix: '/dashboard' });
}
