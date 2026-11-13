import * as importService from '../services/import.service.js';
import { parseIntId } from '../services/account.service.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

export async function create(req, res, next) {
  try {
    const rawAccountId = req.body?.accountId;
    if (rawAccountId === undefined || rawAccountId === null || rawAccountId === '') {
      throw new ValidationError('accountId is required');
    }

    if (typeof rawAccountId === 'boolean' || typeof rawAccountId === 'object') {
      throw new ValidationError('accountId must be an integer');
    }

    const num = Number(rawAccountId);
    if (!Number.isInteger(num)) {
      throw new ValidationError('accountId must be an integer');
    }

    const parsedAccountId = parseIntId(rawAccountId);
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
    const parsedId = parseIntId(req.params.id);
    if (!parsedId) {
      throw new NotFoundError('Import job not found');
    }

    const jobStatus = await importService.getJobStatus(req.user.id, parsedId);
    res.json(jobStatus);
  } catch (err) {
    next(err);
  }
}
