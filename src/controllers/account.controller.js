import * as accountService from '../services/account.service.js';

export async function list(req, res, next) {
  try {
    const accounts = await accountService.listAccounts(req.user.id);
    res.json(accounts);
  } catch (err) {
    next(err);
  }
}

export async function link(req, res, next) {
  try {
    const account = await accountService.linkAccount(req.user.id, req.body);
    res.status(201).json(account);
  } catch (err) {
    next(err);
  }
}

export async function unlink(req, res, next) {
  try {
    await accountService.deleteAccount(req.user.id, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
