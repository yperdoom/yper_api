export function httpError(status, message) {
  const err = new Error(message);
  // O Fastify usa statusCode; status fica por compatibilidade com quem so olha ele.
  err.statusCode = status;
  err.status = status;
  return err;
}

export function errorHandler(err, request, reply) {
  if (err?.name === 'ValidationError') {
    return reply.code(400).send({
      error: 'Validation failed',
      fields: Object.fromEntries(
        Object.entries(err.errors).map(([field, e]) => [field, e.message])
      ),
    });
  }

  if (err?.name === 'CastError') {
    return reply.code(400).send({ error: `Invalid value for ${err.path}` });
  }

  if (err?.code === 11000) {
    return reply.code(409).send({
      error: 'Duplicate value',
      fields: Object.keys(err.keyPattern || {}),
    });
  }

  // Corpo malformado, content-type nao suportado e afins ja vem classificados.
  if (err?.statusCode && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: err.message });
  }

  request.log.error({ err }, 'unhandled error');
  return reply.code(500).send({ error: 'Internal server error' });
}

export function notFoundHandler(request, reply) {
  reply.code(404).send({ error: `Route not found: ${request.method} ${request.url}` });
}
