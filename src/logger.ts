import type { LogLevel } from './config.js';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// stdout зарезервирован протоколом MCP в stdio-режиме — sink по умолчанию пишет в stderr.
export function createLogger(
  level: LogLevel,
  sink: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): Logger {
  const min = LEVEL_ORDER[level];
  const log = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lvl] < min) return;
    const suffix = fields ? ' ' + JSON.stringify(fields) : '';
    sink(`${new Date().toISOString()} [${lvl}] ${message}${suffix}`);
  };
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}
