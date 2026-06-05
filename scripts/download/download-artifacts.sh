#!/usr/bin/env bash
#
# download-artifacts.sh — 下载某次 GitHub Actions run 构建的所有产物
#
# 用法:
#   scripts/download/download-artifacts.sh <github-run-id>
#
# 产物会按版本号解压到仓库根的 dist/release-artifacts/<version>/<artifact-name>/ 下,
# 版本号取自产物内的 manifest.json。
# 依赖:已安装并登录的 gh CLI。

set -euo pipefail

RUN_ID="${1:-}"
REPO="sequencestream/claude-code-center"

if [[ -z "$RUN_ID" ]]; then
  echo "用法: $0 <github-run-id>" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "错误: 未找到 gh CLI,请先安装并执行 gh auth login" >&2
  exit 1
fi

# 仓库根目录(脚本位于 scripts/download/ 下)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="$ROOT/dist/release-artifacts"

# 先下载到临时目录,读出版本号后再归位到 <version>/
TMP="$BASE/.tmp-$RUN_ID"
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

echo "==> 下载 run $RUN_ID 的全部产物"
gh run download "$RUN_ID" --repo "$REPO" --dir "$TMP"

# 从任一 manifest.json 解析版本号
MANIFEST="$(find "$TMP" -name manifest.json -print -quit)"
if [[ -z "$MANIFEST" ]]; then
  echo "错误: 产物中未找到 manifest.json,无法确定版本号" >&2
  exit 1
fi
VERSION="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$MANIFEST" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
if [[ -z "$VERSION" ]]; then
  echo "错误: 无法从 manifest.json 解析版本号" >&2
  exit 1
fi

DEST="$BASE/$VERSION"
echo "==> 版本 $VERSION,归位到 $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
mv "$TMP"/* "$DEST"/

echo "==> 完成。产物列表:"
ls -1 "$DEST"
