import { requireAuth, requireApp } from '../../hooks/auth.js';

import customers from './customers.routes.js';
import ingredients from './ingredients.routes.js';
import recipes from './recipes.routes.js';
import orders from './orders.routes.js';
import settings from './settings.routes.js';
import dashboard from './dashboard.routes.js';

export default async function helakeRoutes(fastify) {
  fastify.addHook('onRequest', requireAuth);
  fastify.addHook('onRequest', requireApp('helake'));

  fastify.register(customers, { prefix: '/customers' });
  fastify.register(ingredients, { prefix: '/ingredients' });
  fastify.register(recipes, { prefix: '/recipes' });
  fastify.register(orders, { prefix: '/orders' });
  fastify.register(settings, { prefix: '/settings' });
  fastify.register(dashboard, { prefix: '/dashboard' });
}
