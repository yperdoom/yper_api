import { requireAuth, requireApp } from '../../hooks/auth.js';

import suppliers from './suppliers.routes.js';
import products from './products.routes.js';
import movements from './movements.routes.js';
import invoices from './invoices.routes.js';
import dashboard from './dashboard.routes.js';

export default async function movixRoutes(fastify) {
  fastify.addHook('onRequest', requireAuth);
  fastify.addHook('onRequest', requireApp('movix'));

  fastify.register(suppliers, { prefix: '/suppliers' });
  fastify.register(products, { prefix: '/products' });
  fastify.register(movements, { prefix: '/movements' });
  fastify.register(invoices, { prefix: '/invoices' });
  fastify.register(dashboard, { prefix: '/dashboard' });
}
