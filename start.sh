#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装：https://nodejs.org/"
  exit 1
fi

export PORT="${PORT:-11459}"
export HOST="${HOST:-127.0.0.1}"

echo "正在启动 MCDownTools..."
echo "访问地址：http://${HOST}:${PORT}"
echo "按 Ctrl+C 停止服务。"

exec node src/index.js
