import express from 'express';
import * as authController from '../controllers/auth.controller.js';
import { requireSameOriginFetch } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { registerBody, loginBody } from '../validation/auth.schemas.js';

const router = express.Router();

router.post('/register', validate({ body: registerBody }), authController.register);
router.post('/login', validate({ body: loginBody }), authController.login);
router.post('/refresh', requireSameOriginFetch, authController.refresh);
router.post('/logout', requireSameOriginFetch, authController.logout);

export default router;
