import crypto from 'crypto';
import { requestContext } from '../utils/requestContext.js';

// A fresh id for every request. An incoming X-Request-Id is not reused: clients could otherwise
// put arbitrary text into the logs or make two requests share an id.
export function requestId(req, res, next) {
  const id = crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  requestContext.run({ requestId: id }, next);
}

export default requestId;
