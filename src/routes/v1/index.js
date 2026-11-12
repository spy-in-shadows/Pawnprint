import express from 'express';
import authRoutes from '../auth.routes.js';
import * as authController from '../../controllers/auth.controller.js';
import { authenticate } from '../../middleware/authenticate.js';

const router = express.Router();

router.use('/auth', authRoutes);
router.get('/me', authenticate, authController.me);

export default router;
