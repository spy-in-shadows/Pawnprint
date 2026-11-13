import * as uploadService from '../services/upload.service.js';

export async function uploadPgn(req, res, next) {
  try {
    const result = await uploadService.processPgnUpload(req.user, {
      file: req.file,
      accountId: req.body?.accountId,
    });
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
}
