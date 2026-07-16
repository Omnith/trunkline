export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'NAME_TAKEN'
  | 'INVITE_INVALID'
  | 'VALIDATION_ERROR'
  | 'AMBIGUOUS_THREAD'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL'

export class PhoneError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'PhoneError'
  }
}

export const httpStatus: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  NAME_TAKEN: 409,
  INVITE_INVALID: 410,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_ERROR: 422,
  AMBIGUOUS_THREAD: 409,
  INTERNAL: 500,
}
