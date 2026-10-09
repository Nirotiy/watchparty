#!/bin/bash
# 本机全套开发栈一键启停（Windows / Git Bash）。
#
#   dev/local-stack.sh start    拉起 OpenList core、CORS shim、后端、Next dev
#   dev/local-stack.sh stop     按 pid 文件停掉（用 taskkill /T 连子进程一起）
#   dev/local-stack.sh status   看四个端口的存活情况
#
# 端口：OpenList 5349，CORS shim 5350，后端 8080，Next 4000。
# 这几个值是本机 data/watchparty-library.sqlite 的 media_sources 行钉死的
# （internal 5349 / public 5350），改端口等于改那份片源配置，别乱动。
#
# 注意：这里起的是 OpenList core 本体。别再开 OpenList Desktop 的窗口，
# 它也会来抢 5349。要开它先执行 stop。
#
# 注意：从 agent/CI 那种非交互 shell 里调 start 时，调用方可能一直等到超时
# （子进程继承了它的管道句柄），服务实际上已经起来了 —— 用 status 确认即可。
# 在自己终端里直接跑没有这个问题。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$REPO_ROOT/data/dev-stack"

OPENLIST_PORT=${OPENLIST_PORT:-5349}
SHIM_PORT=${SHIM_PORT:-5350}
BACKEND_PORT=${BACKEND_PORT:-8080}
WEB_PORT=${WEB_PORT:-4000}

# OpenList Desktop 的默认安装位置与数据目录，可用环境变量覆盖。
# 二进制走 Git Bash 的 /c/... 形式（bash 要 exec 它）；--data 走 Windows 反斜杠
# 形式（那个 exe 自己认），两者不能混。
: "${APPDATA:=$USERPROFILE\\AppData\\Roaming}"
OPENLIST_BIN=${OPENLIST_BIN:-/c/Program\ Files\ \(x86\)/OpenList-Desktop/openlist.exe}
OPENLIST_DATA=${OPENLIST_DATA:="$APPDATA\\OpenList Desktop\\data"}

port_listening() {
  netstat -ano 2>/dev/null | grep -qE ":$1[[:space:]]+.*LISTENING"
}

# 端口对应的 Windows PID。stop 必须走这个，不能用 $!：MSYS 的 $! 是 MSYS 自己的
# pid，跟 Windows pid 是两套编号，拿它给 taskkill 会杀错人。
port_pid() {
  netstat -ano 2>/dev/null | grep -E ":$1[[:space:]]+.*LISTENING" | head -1 | awk '{print $NF}'
}

# 轮询等端口就绪，避免脚本一返回就让人去点页面。
wait_for_port() {
  local port=$1 name=$2 seconds=${3:-60} waited=0
  while [ "$waited" -lt "$seconds" ]; do
    port_listening "$port" && { printf '  %-14s :%s 就绪\n' "$name" "$port"; return 0; }
    sleep 1
    waited=$((waited + 1))
  done
  printf '  %-14s :%s 超时未就绪，看日志：%s/%s.log\n' "$name" "$port" "$RUN_DIR" "$name" >&2
  return 1
}

# 后台起一个服务并把 MSYS pid 落盘（只当"是本脚本拉起来的"的凭据，stop 靠端口
# 反查真实 pid）。$1=服务名 $2=工作目录，其余=命令。
spawn() {
  local name=$1 dir=$2
  shift 2
  ( cd "$dir" && nohup "$@" >"$RUN_DIR/$name.log" 2>&1 </dev/null & echo $! >"$RUN_DIR/$name.pid" )
}

wait_for_core() {
  # OpenList core 是端口先通、HTTP 才可用，这里只探端口够了。
  wait_for_port "$OPENLIST_PORT" openlist-core 60
}

cmd_start() {
  mkdir -p "$RUN_DIR"
  echo "日志与 pid 目录：$RUN_DIR"

  if port_listening "$OPENLIST_PORT"; then
    echo "  OpenList       :$OPENLIST_PORT 已在运行，跳过"
  elif [ ! -f "$OPENLIST_BIN" ]; then
    echo "找不到 OpenList 可执行文件：$OPENLIST_BIN" >&2
    echo "用 OPENLIST_BIN=... 指定路径后再试。" >&2
    return 1
  else
    # 工作目录给仓库根就够，OpenList 的日志/临时目录都来自 config.json 的绝对路径。
    spawn openlist "$REPO_ROOT" "$OPENLIST_BIN" server --data "$OPENLIST_DATA"
    wait_for_core || return 1
  fi

  if port_listening "$SHIM_PORT"; then
    echo "  CORS shim      :$SHIM_PORT 已在运行，跳过"
  else
    spawn openlist-shim "$REPO_ROOT" node "$REPO_ROOT/temp-html/openlist-cors-shim.mjs"
    wait_for_port "$SHIM_PORT" openlist-shim 20 || return 1
  fi

  if port_listening "$BACKEND_PORT"; then
    echo "  后端           :$BACKEND_PORT 已在运行，跳过"
  else
    spawn backend "$REPO_ROOT" npm run dev
    wait_for_port "$BACKEND_PORT" backend 60 || return 1
  fi

  if port_listening "$WEB_PORT"; then
    echo "  Next dev       :$WEB_PORT 已在运行，跳过"
  else
    # 走 npm run dev 让 predev 生成 JASSUB/libav 资源；-- 之后的参数转给 next。
    spawn web "$REPO_ROOT/web" npm run dev -- --port "$WEB_PORT"
    wait_for_port "$WEB_PORT" web 120 || return 1
  fi

  echo
  echo "浏览器端  http://127.0.0.1:$WEB_PORT"
  echo "后端接口  http://127.0.0.1:$BACKEND_PORT"
  echo "OpenList  http://127.0.0.1:$OPENLIST_PORT  （浏览器播放走 shim :$SHIM_PORT）"
}

cmd_stop() {
  local pair name port pid
  for pair in "openlist:$OPENLIST_PORT" "openlist-shim:$SHIM_PORT" "backend:$BACKEND_PORT" "web:$WEB_PORT"; do
    name=${pair%%:*}
    port=${pair##*:}
    pid=$(port_pid "$port")
    if [ -z "$pid" ]; then
      echo "  $name (:$port) 未在运行"
      rm -f "$RUN_DIR/$name.pid"
      continue
    fi
    # npm/node 会再 spawn 子进程，必须连子树一起收；taskkill 要用 Windows pid。
    if taskkill //PID "$pid" //T //F >/dev/null 2>&1; then
      echo "  $name (:$port) 已停（Windows pid $pid）"
    else
      echo "  $name (:$port) 停止失败（pid $pid），手动处理一下" >&2
    fi
    rm -f "$RUN_DIR/$name.pid"
  done
}

cmd_status() {
  printf '  %-14s :%s  %s\n' OpenList "$OPENLIST_PORT" "$(port_listening "$OPENLIST_PORT" && echo 运行中 || echo 未运行)"
  printf '  %-14s :%s  %s\n' CORS-shim "$SHIM_PORT" "$(port_listening "$SHIM_PORT" && echo 运行中 || echo 未运行)"
  printf '  %-14s :%s  %s\n' 后端 "$BACKEND_PORT" "$(port_listening "$BACKEND_PORT" && echo 运行中 || echo 未运行)"
  printf '  %-14s :%s  %s\n' Next "$WEB_PORT" "$(port_listening "$WEB_PORT" && echo 运行中 || echo 未运行)"
}

case "${1:-start}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *) echo "用法：$(basename "$0") [start|stop|status]" >&2; exit 2 ;;
esac
