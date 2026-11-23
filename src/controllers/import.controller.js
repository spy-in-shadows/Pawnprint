import * as importService from '../services/import.service.js';
import { parseIntId } from '../services/account.service.js';
import { NotFoundError } from '../utils/errors.js';

export async function create(req, res, next) {
  try {
    // createImportBody guarantees an integer; one that cannot be an id is a missing account.
    const parsedAccountId = parseIntId(req.body.accountId);
    if (!parsedAccountId) {
      throw new NotFoundError('Player account not found');
    }

    const job = await importService.createImportJob(req.user.id, {
      ...req.body,
      accountId: parsedAccountId,
    });
    res.status(202).json(job);
  } catch (err) {
    next(err);
  }
}

export async function status(req, res, next) {
  try {
    const jobStatus = await importService.getJobStatus(req.user.id, req.params.id);
    res.json(jobStatus);
  } catch (err) {
    next(err);
  }
}
