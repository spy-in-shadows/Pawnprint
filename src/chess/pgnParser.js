import readline from 'readline';
import { Readable } from 'stream';
import crypto from 'crypto';
import { Chess } from 'chess.js';
import { classifyPhase } from './phase.js';
import { validateFen } from './fen.js';

export function parseClockToMs(clockStr) {
  if (!clockStr || typeof clockStr !== 'string') return null;
  const trimmed = clockStr.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]);
    const minutes = parseFloat(parts[1]);
    const seconds = parseFloat(parts[2]);
    if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  }
  if (parts.length === 2) {
    const minutes = parseFloat(parts[0]);
    const seconds = parseFloat(parts[1]);
    if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
    return Math.round((minutes * 60 + seconds) * 1000);
  }
  if (parts.length === 1) {
    const seconds = parseFloat(parts[0]);
    if (Number.isNaN(seconds)) return null;
    return Math.round(seconds * 1000);
  }
  return null;
}

export function parseTimeControl(tcStr) {
  if (!tcStr || typeof tcStr !== 'string') {
    return { baseSeconds: 0, incrementSeconds: 0, category: 'classical' };
  }
  const trimmed = tcStr.trim();
  if (trimmed === '-') {
    return { baseSeconds: 0, incrementSeconds: 0, category: 'correspondence' };
  }
  if (!trimmed || trimmed === '?') {
    return { baseSeconds: 0, incrementSeconds: 0, category: 'classical' };
  }

  const dailyMatch = trimmed.match(/^\d+\/(\d+)$/);
  if (dailyMatch) {
    const seconds = parseInt(dailyMatch[1], 10);
    return { baseSeconds: seconds, incrementSeconds: 0, category: 'correspondence' };
  }

  const [basePart, incPart] = trimmed.split('+');
  const baseSeconds = parseInt(basePart, 10);
  const incrementSeconds = incPart !== undefined ? (parseInt(incPart, 10) || 0) : 0;

  if (Number.isNaN(baseSeconds)) {
    return { baseSeconds: 0, incrementSeconds: 0, category: 'classical' };
  }

  const estimated = baseSeconds + 40 * incrementSeconds;
  let category;
  if (estimated < 180) {
    category = 'bullet';
  } else if (estimated < 480) {
    category = 'blitz';
  } else if (estimated < 1500) {
    category = 'rapid';
  } else {
    category = 'classical';
  }

  return { baseSeconds, incrementSeconds, category };
}

function computeExternalId(headers, moveText) {
  if (headers.Site && typeof headers.Site === 'string') {
    const site = headers.Site.trim();
    if (site.startsWith('http://') || site.startsWith('https://')) {
      try {
        const url = new URL(site);
        const segments = url.pathname.split('/').filter(Boolean);
        if (segments.length > 0) {
          return segments[segments.length - 1];
        }
      } catch {
        const parts = site.split('/').filter(Boolean);
        if (parts.length > 1) {
          return parts[parts.length - 1];
        }
      }
    }
  }

  const hash = crypto.createHash('sha256');
  const sortedHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}`)
    .join('|');
  hash.update(`${sortedHeaders}||${moveText.trim()}`);
  return hash.digest('hex').slice(0, 32);
}

export function tokenizeMoveText(moveText) {
  const tokens = [];
  let inComment = false;
  let commentBuffer = '';
  let variationDepth = 0;
  let currentToken = '';

  for (let i = 0; i < moveText.length; i++) {
    const ch = moveText[i];

    if (inComment) {
      if (ch === '}') {
        inComment = false;
        if (variationDepth === 0) {
          tokens.push({ type: 'comment', text: commentBuffer.trim() });
        }
        commentBuffer = '';
      } else {
        commentBuffer += ch;
      }
      continue;
    }

    if (ch === '{') {
      if (currentToken.trim()) {
        if (variationDepth === 0) {
          tokens.push({ type: 'word', text: currentToken.trim() });
        }
        currentToken = '';
      }
      inComment = true;
      commentBuffer = '';
      continue;
    }

    if (ch === '(') {
      if (currentToken.trim()) {
        if (variationDepth === 0) {
          tokens.push({ type: 'word', text: currentToken.trim() });
        }
        currentToken = '';
      }
      variationDepth += 1;
      continue;
    }

    if (ch === ')') {
      if (currentToken.trim()) {
        currentToken = '';
      }
      if (variationDepth > 0) {
        variationDepth -= 1;
      }
      continue;
    }

    if (variationDepth > 0) {
      continue;
    }

    if (/\s/.test(ch)) {
      if (currentToken.trim()) {
        tokens.push({ type: 'word', text: currentToken.trim() });
        currentToken = '';
      }
    } else {
      currentToken += ch;
    }
  }

  if (currentToken.trim() && variationDepth === 0 && !inComment) {
    tokens.push({ type: 'word', text: currentToken.trim() });
  } else if (inComment && commentBuffer.trim() && variationDepth === 0) {
    tokens.push({ type: 'comment', text: commentBuffer.trim() });
  }

  return tokens;
}

function processMoves(tokens, headers, timeControl) {
  let chess;
  if (headers.SetUp === '1') {
    const fen = headers.FEN;
    if (!fen) {
      return {
        moves: [],
        parseError: `Invalid start FEN: ${fen}`,
        resultRawFromMoves: null,
      };
    }
    const fenCheck = validateFen(fen);
    if (!fenCheck.ok) {
      return {
        moves: [],
        parseError: `Invalid start FEN: ${fen}`,
        resultRawFromMoves: null,
      };
    }
    try {
      chess = new Chess(fen);
    } catch {
      return {
        moves: [],
        parseError: `Invalid start FEN: ${fen}`,
        resultRawFromMoves: null,
      };
    }
  } else {
    chess = new Chess();
  }

  const moves = [];
  let parseError = null;
  let resultRawFromMoves = null;
  let plyCount = 0;

  const baseMs = timeControl.baseSeconds > 0 ? timeControl.baseSeconds * 1000 : null;
  const incrementMs = (timeControl.incrementSeconds || 0) * 1000;

  let lastWhiteClock = baseMs;
  let lastBlackClock = baseMs;

  let i = 0;
  while (i < tokens.length) {
    const item = tokens[i];
    if (item.type !== 'word') {
      i++;
      continue;
    }

    let word = item.text.trim();

    if (/^\d+\.+$/.test(word)) {
      i++;
      continue;
    }

    if (/^\$\d+$/.test(word)) {
      i++;
      continue;
    }

    if (['1-0', '0-1', '1/2-1/2', '*'].includes(word)) {
      resultRawFromMoves = word;
      break;
    }

    if (/^\d+\.+/.test(word)) {
      word = word.replace(/^\d+\.+/, '');
    }

    if (!word) {
      i++;
      continue;
    }

    if (['1-0', '0-1', '1/2-1/2', '*'].includes(word)) {
      resultRawFromMoves = word;
      break;
    }

    let clockRemainingMs = null;
    let nextIdx = i + 1;
    while (nextIdx < tokens.length && tokens[nextIdx].type === 'comment') {
      const commentText = tokens[nextIdx].text;
      const clkMatch = commentText.match(/%clk\s+([0-9:.]+)/);
      if (clkMatch) {
        clockRemainingMs = parseClockToMs(clkMatch[1]);
      }
      nextIdx++;
    }
    i = nextIdx;

    const fenBefore = chess.fen();
    const moverColor = chess.turn() === 'w' ? 'white' : 'black';
    const currentPly = plyCount + 1;
    const phase = classifyPhase(fenBefore, currentPly);

    const normalizedWord = word.replace(/=([qrbn])/i, (_, p) => `=${p.toUpperCase()}`);

    let moveResult = null;
    try {
      moveResult = chess.move(normalizedWord);
    } catch {
      parseError = `Illegal move at ply ${currentPly}: ${word}`;
      break;
    }

    if (!moveResult) {
      parseError = `Illegal move at ply ${currentPly}: ${word}`;
      break;
    }

    plyCount++;
    const ply = plyCount;
    const san = moveResult.san;
    const uci = `${moveResult.from}${moveResult.to}${moveResult.promotion || ''}`;

    let timeSpentMs = null;
    if (clockRemainingMs !== null) {
      const prevClock = moverColor === 'white' ? lastWhiteClock : lastBlackClock;
      if (prevClock !== null) {
        timeSpentMs = Math.max(0, prevClock - clockRemainingMs + incrementMs);
      }
      if (moverColor === 'white') {
        lastWhiteClock = clockRemainingMs;
      } else {
        lastBlackClock = clockRemainingMs;
      }
    } else {
      if (moverColor === 'white') {
        lastWhiteClock = null;
      } else {
        lastBlackClock = null;
      }
    }

    moves.push({
      ply,
      san,
      uci,
      fenBefore,
      moverColor,
      phase,
      clockRemainingMs,
      timeSpentMs,
    });
  }

  return { moves, parseError, resultRawFromMoves };
}

function buildParsedGame(headers, moveText) {
  const timeControl = parseTimeControl(headers.TimeControl);
  const tokens = tokenizeMoveText(moveText);
  const { moves, parseError, resultRawFromMoves } = processMoves(tokens, headers, timeControl);

  let resultRaw = '*';
  if (headers.Result && ['1-0', '0-1', '1/2-1/2', '*'].includes(headers.Result.trim())) {
    resultRaw = headers.Result.trim();
  } else if (resultRawFromMoves) {
    resultRaw = resultRawFromMoves;
  }

  const whiteElo = headers.WhiteElo && !Number.isNaN(parseInt(headers.WhiteElo, 10))
    ? parseInt(headers.WhiteElo, 10)
    : null;
  const blackElo = headers.BlackElo && !Number.isNaN(parseInt(headers.BlackElo, 10))
    ? parseInt(headers.BlackElo, 10)
    : null;

  let playedAt = new Date();
  if (headers.UTCDate && headers.UTCTime) {
    const d = new Date(`${headers.UTCDate.replace(/\./g, '-')}T${headers.UTCTime}Z`);
    if (!Number.isNaN(d.getTime())) playedAt = d;
  } else if (headers.UTCDate) {
    const d = new Date(`${headers.UTCDate.replace(/\./g, '-')}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) playedAt = d;
  } else if (headers.Date && headers.Date !== '????.??.??') {
    const normalized = headers.Date.replace(/\?/g, '01').replace(/\./g, '-');
    const d = new Date(`${normalized}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) playedAt = d;
  }

  const externalId = computeExternalId(headers, moveText);

  return {
    externalId,
    white: headers.White || '?',
    black: headers.Black || '?',
    whiteElo,
    blackElo,
    resultRaw,
    eco: headers.ECO || null,
    openingName: headers.Opening || headers.OpeningName || null,
    timeControl,
    playedAt,
    totalPlies: moves.length,
    parseError,
    moves,
  };
}

function isResultToken(word) {
  return word === '1-0' || word === '0-1' || word === '1/2-1/2' || word === '*';
}

function checkLineEndsGame(line, state) {
  let inComment = state.inComment;
  let variationDepth = state.variationDepth;
  let hasResult = false;
  let currentWord = '';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inComment) {
      if (ch === '}') inComment = false;
      continue;
    }

    if (ch === '{') {
      if (variationDepth === 0 && isResultToken(currentWord.trim())) {
        hasResult = true;
      }
      currentWord = '';
      inComment = true;
      continue;
    }

    if (ch === '(') {
      if (variationDepth === 0 && isResultToken(currentWord.trim())) {
        hasResult = true;
      }
      currentWord = '';
      variationDepth++;
      continue;
    }

    if (ch === ')') {
      currentWord = '';
      if (variationDepth > 0) variationDepth--;
      continue;
    }

    if (variationDepth > 0) {
      continue;
    }

    if (/\s/.test(ch)) {
      if (isResultToken(currentWord.trim())) {
        hasResult = true;
      }
      currentWord = '';
    } else {
      currentWord += ch;
    }
  }

  if (variationDepth === 0 && !inComment && isResultToken(currentWord.trim())) {
    hasResult = true;
  }

  state.inComment = inComment;
  state.variationDepth = variationDepth;
  return hasResult;
}

export async function* parsePgnStream(readable) {
  const streamInput = typeof readable === 'string' ? Readable.from([readable]) : readable;
  const rl = readline.createInterface({
    input: streamInput,
    crlfDelay: Infinity,
  });

  let currentHeaders = {};
  let currentMoveLines = [];
  let inMoveSection = false;
  let gameEnded = false;
  let seenBlankAfterHeaders = false;
  let state = { inComment: false, variationDepth: 0 };

  for await (const rawLine of rl) {
    const line = rawLine.trim();

    if (!state.inComment && state.variationDepth === 0 && line.startsWith('[')) {
      const headerMatch = line.match(/^\[([A-Za-z0-9_]+)\s+"((?:\\.|[^"\\])*)"\]\s*$/);
      if (headerMatch) {
        if (inMoveSection || gameEnded || (seenBlankAfterHeaders && Object.keys(currentHeaders).length > 0)) {
          const game = buildParsedGame(currentHeaders, currentMoveLines.join(' '));
          if (game) yield game;

          currentHeaders = {};
          currentMoveLines = [];
          inMoveSection = false;
          gameEnded = false;
          seenBlankAfterHeaders = false;
          state = { inComment: false, variationDepth: 0 };
        }

        const key = headerMatch[1];
        const val = headerMatch[2].replace(/\\"/g, '"');
        currentHeaders[key] = val;
        continue;
      }
    }

    if (line.length === 0) {
      if (inMoveSection && gameEnded) {
        const game = buildParsedGame(currentHeaders, currentMoveLines.join(' '));
        if (game) yield game;

        currentHeaders = {};
        currentMoveLines = [];
        inMoveSection = false;
        gameEnded = false;
        seenBlankAfterHeaders = false;
        state = { inComment: false, variationDepth: 0 };
      } else if (!inMoveSection && Object.keys(currentHeaders).length > 0) {
        seenBlankAfterHeaders = true;
      }
      continue;
    }

    if (gameEnded) {
      const game = buildParsedGame(currentHeaders, currentMoveLines.join(' '));
      if (game) yield game;

      currentHeaders = {};
      currentMoveLines = [];
      inMoveSection = false;
      gameEnded = false;
      seenBlankAfterHeaders = false;
      state = { inComment: false, variationDepth: 0 };
    }

    inMoveSection = true;
    currentMoveLines.push(line);

    if (checkLineEndsGame(line, state)) {
      gameEnded = true;
    }
  }

  if (Object.keys(currentHeaders).length > 0 || currentMoveLines.length > 0) {
    const game = buildParsedGame(currentHeaders, currentMoveLines.join(' '));
    if (game) yield game;
  }
}

export async function parsePgnString(str) {
  if (typeof str !== 'string' || !str.trim()) {
    return [];
  }
  const games = [];
  for await (const game of parsePgnStream(str)) {
    games.push(game);
  }
  return games;
}
