import express from 'express';
import * as analyticsController from '../controllers/analytics.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { analyticsQuery, summaryQuery } from '../validation/analytics.schemas.js';

const router = express.Router();

router.use(authenticate);

const filters = validate({ query: analyticsQuery });

router.get('/openings', filters, analyticsController.openings);
router.get('/phases', filters, analyticsController.phases);
router.get('/time-pressure', filters, analyticsController.timePressure);
router.get('/trend', filters, analyticsController.trend);
router.get('/motifs', filters, analyticsController.motifs);
router.get('/summary', validate({ query: summaryQuery }), analyticsController.summary);

export default router;
