/** 极简日志工具 */
const LEVELS = { info: 'INFO', warn: 'WARN', error: 'ERROR' };

function write(level, message) {
  const time = new Date().toISOString();
  const line = `[${time}] [${LEVELS[level]}] ${message}`;
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message) => write('info', message),
  warn: (message) => write('warn', message),
  error: (message) => write('error', message),
};
