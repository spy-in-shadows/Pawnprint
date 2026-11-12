import express from 'express';
import * as gameController from '../controllers/game.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = express.Router();

router.use(authenticate);

router.get('/', gameController.list);
router.get('/:id', gameController.getDetail);

export default router;
