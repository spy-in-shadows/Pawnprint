import * as analyticsService from '../services/analytics.service.js';

export async function openings(req, res, next) {
  try {
    const data = await analyticsService.getOpenings(req.user.id, req.query);
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
}

export async function phases(req, res, next) {
  try {
    const data = await analyticsService.getPhases(req.user.id, req.query);
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
}

export async function timePressure(req, res, next) {
  try {
    const data = await analyticsService.getTimePressure(req.user.id, req.query);
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
}

export const analyticsController = {
  openings,
  phases,
  timePressure,
};

export default analyticsController;
