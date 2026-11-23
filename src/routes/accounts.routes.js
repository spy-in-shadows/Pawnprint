import express from 'express';
import { authenticate } from '../middleware/authenticate.js';
import * as accountController from '../controllers/account.controller.js';
import { validate } from '../middleware/validate.js';
import { linkAccountBody, accountIdParams } from '../validation/account.schemas.js';

const router = express.Router();

router.use(authenticate);

router.get('/', accountController.list);
router.post('/', validate({ body: linkAccountBody }), accountController.link);
router.delete(
  '/:id',
  validate({ params: accountIdParams, paramsNotFound: 'Player account not found' }),
  accountController.unlink
);

export default router;
