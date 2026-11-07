# -*- coding: utf-8 -*-
"""AO 语义路由服务 · 无窗口启动器（替代 AO-SemanticRouter.vbs）

VBScript 在 Win11 26200 已进入弃用流程（事件 VBScriptDeprecationAlert 4096）。
这里用 pythonw.exe 直接拉起 server.py：pythonw 本身没有控制台窗口，
因此不需要 wscript，也不依赖任何将被移除的组件。

日志：%TEMP%\ao-semantic-router.log（追加）
用法：pythonw.exe run_hidden.pyw
"""

import os
import runpy
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOG = Path(tempfile.gettempdir()) / "ao-semantic-router.log"


def main():
    # 单实例：8765 已在监听就不重复起
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1)
    if s.connect_ex(("127.0.0.1", 8765)) == 0:
        s.close()
        with LOG.open("a", encoding="utf-8", errors="replace") as f:
            f.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] 8765 已占用，跳过启动\n")
        return
    s.close()

    f = LOG.open("a", encoding="utf-8", errors="replace", buffering=1)
    f.write(f"\n{'=' * 60}\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] pythonw 启动 server.py\n")
    sys.stdout = f
    sys.stderr = f
    os.chdir(HERE)
    try:
        runpy.run_path(str(HERE / "server.py"), run_name="__main__")
    except BaseException:
        import traceback
        traceback.print_exc()
        f.flush()
        raise


if __name__ == "__main__":
    main()