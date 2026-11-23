import express from 'express';
import * as adminController from '../controllers/admin.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';

const router = express.Router();

router.use(authenticate, requireRole('admin'));

router.get('/users', adminController.listUsers);
router.get('/jobs', adminController.jobOverview);

export default router;
