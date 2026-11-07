#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python_bin="${YOUTUBE_PYTHON:-python3}"
"$python_bin" -c 'import sys; sys.exit("YouTube 模块需要 Python 3.11+（yt-dlp 2026.10.26 起不再支持 3.10），可用 YOUTUBE_PYTHON 指定") if sys.version_info < (3,11) else None'
"$python_bin" -m venv .runtime/youtube
.runtime/youtube/bin/python -m pip install --disable-pip-version-check -r extractors/youtube-live/requirements.txt
.runtime/youtube/bin/yt-dlp --version
