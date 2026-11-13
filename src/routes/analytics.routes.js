import express from 'express';
import * as analyticsController from '../controllers/analytics.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = express.Router();

router.use(authenticate);

router.get('/openings', analyticsController.openings);
router.get('/phases', analyticsController.phases);
router.get('/time-pressure', analyticsController.timePressure);
router.get('/trend', analyticsController.trend);
router.get('/motifs', analyticsController.motifs);

export default router;
