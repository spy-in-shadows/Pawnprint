import express from 'express';
import * as authController from '../controllers/auth.controller.js';
import { requireSameOriginFetch } from '../middleware/csrf.js';

const router = express.Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/refresh', requireSameOriginFetch, authController.refresh);
router.post('/logout', requireSameOriginFetch, authController.logout);

export default router;
