import express from 'express';
import { authenticate } from '../middleware/authenticate.js';
import * as importController from '../controllers/import.controller.js';

const router = express.Router();

router.use(authenticate);

router.post('/', importController.create);
router.get('/:id', importController.status);

export default router;
