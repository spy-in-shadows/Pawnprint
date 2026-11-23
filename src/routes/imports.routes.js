import express from 'express';
import { authenticate } from '../middleware/authenticate.js';
import * as importController from '../controllers/import.controller.js';
import { validate } from '../middleware/validate.js';
import { createImportBody, importIdParams } from '../validation/import.schemas.js';

const router = express.Router();

router.use(authenticate);

router.post('/', validate({ body: createImportBody }), importController.create);
router.get(
  '/:id',
  validate({ params: importIdParams, paramsNotFound: 'Import job not found' }),
  importController.status
);

export default router;
