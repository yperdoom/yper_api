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

// Mapeia o "kind" do erro de validacao do mongoose para o codigo de i18n e seus params.
const FIELD_ERROR_CODES = {
  required: () => ['FIELD_REQUIRED', {}],
  enum: () => ['FIELD_ENUM', {}],
  min: (props) => ['FIELD_MIN', { min: props?.min }],
  max: (props) => ['FIELD_MAX', { max: props?.max }],
  minlength: (props) => ['FIELD_MINLENGTH', { min: props?.minlength }],
  maxlength: (props) => ['FIELD_MAXLENGTH', { max: props?.maxlength }],
};

function translateFieldMessage(locale, field, fieldError) {
  const [code, params] = (FIELD_ERROR_CODES[fieldError.kind] || (() => ['FIELD_INVALID', {}]))(
    fieldError.properties
  );
  return translate(locale, code, { field, ...params });
}

export function errorHandler(err, request, reply) {
  if (err instanceof HttpError) {
    return sendError(reply, request, err.statusCode, err.code, err.params);
  }

  if (err?.name === 'ValidationError') {
    const locale = resolveLocale(request);
    return sendError(reply, request, 400, 'VALIDATION_FAILED', undefined, {
      fields: Object.fromEntries(
        Object.entries(err.errors).map(([field, e]) => [field, translateFieldMessage(locale, field, e)])
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
