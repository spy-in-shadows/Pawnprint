import express from 'express';
import authRoutes from '../auth.routes.js';
import accountsRoutes from '../accounts.routes.js';
import importsRoutes from '../imports.routes.js';
import uploadsRoutes from '../uploads.routes.js';
import gamesRoutes from '../games.routes.js';
import analyticsRoutes from '../analytics.routes.js';
import trainingRoutes from '../training.routes.js';
import * as authController from '../../controllers/auth.controller.js';
import * as healthController from '../../controllers/health.controller.js';
import { authenticate } from '../../middleware/authenticate.js';

const router = express.Router();

router.get('/health', healthController.check);
router.use('/auth', authRoutes);
router.get('/me', authenticate, authController.me);
router.use('/accounts', accountsRoutes);
router.use('/imports', importsRoutes);
router.use('/uploads', uploadsRoutes);
router.use('/games', gamesRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/training', trainingRoutes);

export default router;
