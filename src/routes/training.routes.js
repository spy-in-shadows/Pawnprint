import express from 'express';
import { authenticate } from '../middleware/authenticate.js';
import * as trainingController from '../controllers/training.controller.js';
import { validate } from '../middleware/validate.js';
import { planIdParams, itemIdParams, updateItemBody } from '../validation/training.schemas.js';

const router = express.Router();

router.use(authenticate);

router.get('/plans', trainingController.list);
router.post('/plans', trainingController.create);
router.patch(
  '/plans/:planId/items/:itemId',
  validate({ params: planIdParams, paramsNotFound: 'Training plan not found' }),
  validate({ params: itemIdParams, paramsNotFound: 'Training plan item not found' }),
  validate({ body: updateItemBody }),
  trainingController.updateItem
);

export default router;
