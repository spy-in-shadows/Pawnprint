import * as adminService from '../services/admin.service.js';

export async function listUsers(req, res, next) {
  try {
    res.status(200).json(await adminService.listUsers(req.query));
  } catch (err) {
    next(err);
  }
}

export async function jobOverview(req, res, next) {
  try {
    res.status(200).json(await adminService.jobOverview());
  } catch (err) {
    next(err);
  }
}

export const adminController = { listUsers, jobOverview };
export default adminController;
