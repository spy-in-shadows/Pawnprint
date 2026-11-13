import * as importService from '../services/import.service.js';

export async function create(req, res, next) {
  try {
    const job = await importService.createImportJob(req.user.id, req.body);
    res.status(202).json(job);
  } catch (err) {
    next(err);
  }
}

export async function status(req, res, next) {
  try {
    const jobId = Number(req.params.id);
    const jobStatus = await importService.getJobStatus(req.user.id, jobId);
    res.json(jobStatus);
  } catch (err) {
    next(err);
  }
}
