import { prisma } from '../config/db.js';

export async function findByEmail(email) {
  return prisma.user.findUnique({
    where: { email },
  });
}

export async function findById(id) {
  return prisma.user.findUnique({
    where: { id },
  });
}

export async function create({ email, passwordHash }) {
  return prisma.user.create({
    data: {
      email,
      passwordHash,
    },
  });
}

export const userRepo = {
  findByEmail,
  findById,
  create,
};

export default userRepo;
