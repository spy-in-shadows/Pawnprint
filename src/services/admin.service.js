import * as adminRepo from '../repositories/admin.repo.js';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const RECENT_JOBS = 20;

export async function listUsers(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  // Page size is capped at 100.
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE));
  const { items, total } = await adminRepo.listUsers({ page, pageSize });
  return { items, page, pageSize, total };
}

export async function jobOverview() {
  return adminRepo.jobOverview({ recentLimit: RECENT_JOBS });
}

export const adminService = { listUsers, jobOverview };
export default adminService;
