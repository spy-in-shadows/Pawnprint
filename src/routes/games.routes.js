import express from 'express';
import * as gameController from '../controllers/game.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { listGamesQuery, gameIdParams } from '../validation/games.schemas.js';

const router = express.Router();

router.use(authenticate);

router.get('/', validate({ query: listGamesQuery }), gameController.list);
router.get('/:id', validate({ params: gameIdParams, paramsNotFound: 'Game not found' }), gameController.getDetail);

export default router;
