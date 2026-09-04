/** An error carrying an HTTP status code and a stable machine-readable code. */
export class AppError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** @param {string} message @param {Record<string, unknown>} [details] */
export const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
/** @param {string} [message] */
export const unauthorized = (message = 'Missing or invalid token') =>
  new AppError(401, 'unauthorized', message);
/** @param {string} [message] */
export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);
/** @param {string} what @param {string} id */
export const notFound = (what, id) => new AppError(404, 'not_found', `${what} ${id} not found`);
/** @param {string} message @param {Record<string, unknown>} [details] */
export const conflict = (message, details) => new AppError(409, 'conflict', message, details);
