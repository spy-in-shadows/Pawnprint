import express from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate.js';
import * as uploadController from '../controllers/upload.controller.js';
import { ValidationError } from '../utils/errors.js';

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const isPgnExt = file.originalname && file.originalname.toLowerCase().endsWith('.pgn');
    const isAllowedMime =
      file.mimetype === 'application/x-chess-pgn' ||
      file.mimetype === 'text/plain' ||
      file.mimetype === 'application/octet-stream' ||
      file.mimetype === '';

    if (isPgnExt || isAllowedMime) {
      cb(null, true);
    } else {
      cb(new ValidationError('Only PGN or plain text files are allowed'));
    }
  },
});

const router = express.Router();

router.use(authenticate);

router.post(
  '/pgn',
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return next(new ValidationError('File size exceeds 5MB limit'));
        }
        return next(err);
      }
      next();
    });
  },
  uploadController.uploadPgn
);

export default router;
