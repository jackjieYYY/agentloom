import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { errorLogFields } from '../../runtime/errors.js';

export function handleError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const status =
    error.statusCode && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;
  if (status === 500) {
    request.log.error(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        ...errorLogFields(error),
      },
      'Request failed',
    );
  }
  return reply
    .header('x-request-id', request.id)
    .code(status)
    .send({
      error: status === 500 ? 'Internal server error' : 'Invalid request',
      requestId: request.id,
    });
}
