import * as healthService from '../services/health.service.js';

export async function check(req, res, next) {
  try {
    const result = await healthService.check(req.app.locals?.healthOverrides);
    if (result.status !== 'ok') {
      return res.status(503).json(result);
    }
    return res.status(200).json(result);
  } catch {
    return res.status(503).json({
      status: 'degraded',
      database: {
        pgPool: 'disconnected',
        prisma: 'disconnected',
      },
    });
  }
}

export const healthController = {
  check,
};

export default healthController;
