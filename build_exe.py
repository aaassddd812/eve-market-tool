#!/usr/bin/env python3
"""打包单文件 exe（产物 dist/EVE辅助工具.exe）。

用法：python build_exe.py        （需要 pip install pyinstaller）
前端静态文件、两个后端服务与 Python 运行时全部打进一个 exe，
目标机器无需安装任何东西，双击即可运行。
"""

import glob
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
FE = os.path.join(ROOT, "eve-overview-clone")
EXE_NAME = "EVE辅助工具"

# 前端需要打进 exe 的内容：入口页、开放 API 文档、静态资源、根目录数据 JSON、翻译与教程
# （README 截图 *.png 与 server/ 不需要）
# 注意：--add-data 对目录是把"目录内容"放进目标，因此目录的目标要写成 web/<目录名>
frontend_files = ["index-v2.html", "api.html"] + sorted(
    os.path.basename(p) for p in glob.glob(os.path.join(FE, "*.json")))
frontend_dirs = ["assets", "css", "js", "i18n", "guides"]

add_data = [os.path.join(FE, item) + ";web" for item in frontend_files]
add_data += [os.path.join(FE, item) + f";web/{item}" for item in frontend_dirs]
add_data.append(os.path.join(FE, "server", "system_regions.json") + ";.")

cmd = [sys.executable, "-m", "PyInstaller",
       "--noconfirm", "--clean", "--onefile", "--console",
       "--name", EXE_NAME,
       "--paths", os.path.join(FE, "server"),
       "--hidden-import", "kb_service",
       "--hidden-import", "esi_service",
       ] + sum([["--add-data", pair] for pair in add_data], []) + [
       os.path.join(FE, "server", "local_launcher.py")]

print(" ".join(cmd))
subprocess.run(cmd, cwd=ROOT, check=True)

exe = os.path.join(ROOT, "dist", EXE_NAME + ".exe")
size = os.path.getsize(exe) / 1_048_576
print(f"\n完成：{exe}（{size:.1f} MB）")
