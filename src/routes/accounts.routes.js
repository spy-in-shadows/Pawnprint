import express from 'express';
import { authenticate } from '../middleware/authenticate.js';
import * as accountController from '../controllers/account.controller.js';

const router = express.Router();

router.use(authenticate);

router.get('/', accountController.list);
router.post('/', accountController.link);
router.delete('/:id', accountController.unlink);

export default router;
