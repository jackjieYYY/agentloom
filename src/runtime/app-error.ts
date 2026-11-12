export class AppError extends Error {
  override name = 'AppError';

  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
