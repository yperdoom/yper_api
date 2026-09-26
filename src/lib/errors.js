import { resolveLocale, translate } from '../i18n/index.js';

/** Erro de negocio: o handler traduz o codigo para o idioma do request. */
export class HttpError extends Error {
  constructor(status, code, params) {
    super(code);
    // O Fastify usa statusCode; status fica por compatibilidade com quem so olha ele.
    this.statusCode = status;
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

export function httpError(status, code, params) {
  return new HttpError(status, code, params);
}

/** Corpo padrao de erro: { error, code, params?, ...extra }. */
export function sendError(reply, request, status, code, params, extra = {}) {
  const body = { error: translate(resolveLocale(request), code, params), code };
  if (params && Object.keys(params).length) body.params = params;
  return reply.code(status).send({ ...body, ...extra });
}

export function errorHandler(err, request, reply) {
  if (err instanceof HttpError) {
    return sendError(reply, request, err.statusCode, err.code, err.params);
  }

  if (err?.name === 'ValidationError') {
    return sendError(reply, request, 400, 'VALIDATION_FAILED', undefined, {
      fields: Object.fromEntries(
        Object.entries(err.errors).map(([field, e]) => [field, e.message])
      ),
    });
  }

  if (err?.name === 'CastError') {
    return sendError(reply, request, 400, 'INVALID_VALUE', { field: err.path });
  }

  if (err?.code === 11000) {
    return sendError(reply, request, 409, 'DUPLICATE_VALUE', undefined, {
      fields: Object.keys(err.keyPattern || {}),
    });
  }

  // Corpo malformado, content-type nao suportado e afins ja vem classificados.
  if (err?.statusCode && err.statusCode < 500) {
    return sendError(reply, request, err.statusCode, 'BAD_REQUEST');
  }

  request.log.error({ err }, 'unhandled error');
  return sendError(reply, request, 500, 'INTERNAL_ERROR');
}

export function notFoundHandler(request, reply) {
  sendError(reply, request, 404, 'ROUTE_NOT_FOUND', { method: request.method, url: request.url });
}
