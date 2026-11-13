import express from 'express';
import { authenticate } from '../middleware/authenticate.js';
import * as trainingController from '../controllers/training.controller.js';

const router = express.Router();

router.use(authenticate);

router.get('/plans', trainingController.list);
router.post('/plans', trainingController.create);
router.patch('/plans/:planId/items/:itemId', trainingController.updateItem);

export default router;
