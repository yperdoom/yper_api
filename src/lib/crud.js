import { httpError } from './errors.js';

/**
 * Devolve um plugin Fastify com o REST padrao de um model.
 *
 *   GET    /      lista
 *   POST   /      cria
 *   GET    /:id   busca um
 *   PUT    /:id   atualiza
 *   DELETE /:id   remove
 *
 * @param {import('mongoose').Model} Model
 * @param {object} options
 * @param {string} options.plural   chave da resposta da listagem (ex: 'products')
 * @param {string} options.single   chave das respostas de um item (ex: 'product')
 * @param {object} options.sort     ordenacao da listagem
 * @param {string[]} options.populate  caminhos populados na listagem e no get
 * @param {boolean} options.scoped  quando true, filtra e grava sempre com user = request.user.userId
 * @param {Function} options.list   substitui o handler da listagem quando a rota precisa de agregacao
 * @param {Function} options.beforeUpdate  preHandler do PUT; lance um erro para bloquear
 * @param {Function} options.beforeDelete  preHandler do DELETE; lance um erro para bloquear
 */
export function crudRoutes(Model, options = {}) {
  const {
    plural,
    single,
    sort = { createdAt: -1 },
    populate = [],
    scoped = false,
    list,
    beforeUpdate,
    beforeDelete,
  } = options;

  const scopeOf = (request) => (scoped ? { user: request.user.userId } : {});
  const withPopulate = (query) => populate.reduce((q, path) => q.populate(path), query);
  const guard = (hook) => (hook ? { preHandler: hook } : {});

  return async function crudPlugin(fastify) {
    fastify.get(
      '/',
      list ||
        (async (request) => {
          const docs = await withPopulate(Model.find(scopeOf(request)).sort(sort)).lean();
          return { [plural]: docs };
        })
    );

    fastify.post('/', async (request, reply) => {
      const doc = await Model.create({ ...request.body, ...scopeOf(request) });
      return reply.code(201).send({ [single]: doc });
    });

    fastify.get('/:id', async (request) => {
      const doc = await withPopulate(
        Model.findOne({ _id: request.params.id, ...scopeOf(request) })
      ).lean();
      if (!doc) throw httpError(404, 'NOT_FOUND');
      return { [single]: doc };
    });

    fastify.put('/:id', guard(beforeUpdate), async (request) => {
      const payload = { ...request.body };
      delete payload.user;

      const doc = await Model.findOneAndUpdate(
        { _id: request.params.id, ...scopeOf(request) },
        payload,
        { new: true, runValidators: true }
      );
      if (!doc) throw httpError(404, 'NOT_FOUND');
      return { [single]: doc };
    });

    fastify.delete('/:id', guard(beforeDelete), async (request) => {
      const doc = await Model.findOneAndDelete({ _id: request.params.id, ...scopeOf(request) });
      if (!doc) throw httpError(404, 'NOT_FOUND');
      return { success: true };
    });
  };
}
