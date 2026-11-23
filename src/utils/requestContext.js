import { AsyncLocalStorage } from 'async_hooks';

// Per-request context (currently the request id). Everything that runs as part of handling a
// request, including awaited service and repository calls, sees the same store, so the logger
// can stamp the id on every line without passing it around.
export const requestContext = new AsyncLocalStorage();

export function currentRequestId() {
  return requestContext.getStore()?.requestId;
}
