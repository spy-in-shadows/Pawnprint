import * as trainingService from '../services/training.service.js';
import { parseIntId } from '../services/account.service.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

export async function list(req, res, next) {
  try {
    const plans = await trainingService.listPlans(req.user.id);
    res.json(plans);
  } catch (err) {
    next(err);
  }
}

export async function create(req, res, next) {
  try {
    const result = await trainingService.generatePlan(req.user.id);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateItem(req, res, next) {
  try {
    const planId = parseIntId(req.params.planId);
    if (!planId) {
      throw new NotFoundError('Training plan not found');
    }

    const itemId = parseIntId(req.params.itemId);
    if (!itemId) {
      throw new NotFoundError('Training plan item not found');
    }

    if (typeof req.body?.completed !== 'boolean') {
      throw new ValidationError('completed must be a boolean');
    }

    const result = await trainingService.setItemCompletion(
      req.user.id,
      planId,
      itemId,
      req.body.completed
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export const trainingController = {
  list,
  create,
  updateItem,
};

export default trainingController;
