import { spawn } from 'node:child_process';
import { join } from 'node:path';

function javaExecutable() {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

/** 尝试执行 java -version，成功返回 true */
function canRunJava(command) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    const child = spawn(command, ['-version'], { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 5000);

    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/**
 * 查找可用的 Java，优先使用 JAVA_HOME
 * @returns {Promise<string>}
 */
export async function detectJava() {
  const candidates = [];
  if (process.env.JAVA_HOME) {
    candidates.push(join(process.env.JAVA_HOME, 'bin', javaExecutable()));
  }
  candidates.push(javaExecutable());

  for (const candidate of candidates) {
    if (await canRunJava(candidate)) return candidate;
  }

  throw new Error('未找到 Java，安装加载器需要本机安装 JDK 17 或更高版本');
}

/**
 * 执行 Java 进程并实时输出日志
 * @param {string} javaPath
 * @param {string[]} args
 * @param {{ onLog?: (line: string) => void }} [options]
 */
export function runJava(javaPath, args, { onLog } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { windowsHide: true });
    const emit = (chunk) => {
      const text = chunk.toString().trimEnd();
      if (text) onLog?.(text);
    };

    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', (err) => reject(new Error(`无法启动 Java: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`安装器执行失败，退出码 ${code}`));
    });
  });
}
