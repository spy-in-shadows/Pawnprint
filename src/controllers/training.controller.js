import * as trainingService from '../services/training.service.js';

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
    // planId, itemId and completed are validated in training.routes.js.
    const { planId, itemId } = req.params;
    const result = await trainingService.setItemCompletion(req.user.id, planId, itemId, req.body.completed);
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
