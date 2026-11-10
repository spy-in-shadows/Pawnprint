export class AppError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, message, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request') {
    super(400, message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, message, 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(409, message, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

// Bad input data (illegal move, corrupt FEN): the worker fails that one game and moves on.
export class DataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataError';
    this.isDataError = true;
  }
}

// Engine timeout or crash: the worker retries the whole job.
export class EngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineError';
    this.isEngineError = true;
  }
}
