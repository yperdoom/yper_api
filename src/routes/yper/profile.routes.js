import Profile from '../../models/yper/Profile.js';

export default async function profileRoutes(fastify) {
  fastify.get('/', async (request) => ({
    profile: await Profile.getOrCreate(request.user.userId),
  }));

  fastify.put('/', async (request) => {
    const payload = { ...request.body };
    delete payload._id;
    delete payload.user;

    const profile = await Profile.findOneAndUpdate({ user: request.user.userId }, payload, {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    });

    return { profile };
  });
}
