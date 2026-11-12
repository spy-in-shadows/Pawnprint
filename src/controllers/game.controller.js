import * as gamesService from '../services/games.service.js';

export async function list(req, res, next) {
  try {
    const result = await gamesService.listGames(req.user.id, req.query);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getDetail(req, res, next) {
  try {
    const gameId = Number(req.params.id);
    const game = await gamesService.getGameDetail(req.user.id, gameId);
    res.status(200).json(game);
  } catch (err) {
    next(err);
  }
}

export const gameController = {
  list,
  getDetail,
};

export default gameController;
