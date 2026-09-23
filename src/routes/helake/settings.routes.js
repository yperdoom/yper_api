import Settings from '../../models/helake/Settings.js';

export default async function settingsRoutes(fastify) {
  fastify.get('/', async () => ({ settings: await Settings.getOrCreate() }));

  fastify.put('/', async (request) => {
    const payload = { ...request.body };
    delete payload._id;

    const settings = await Settings.findByIdAndUpdate('global', payload, {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    });

    return { settings };
  });
}
