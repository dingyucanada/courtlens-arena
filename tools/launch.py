#!/usr/bin/env python3
"""Choose an already installed rendering runtime; never install packages silently."""
import argparse,os,sys,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def choose_renderer():
 candidates=[os.environ.get('COURTLENS_RENDER_PYTHON'),str(ROOT/'.venv'/('Scripts/python.exe' if os.name=='nt' else 'bin/python3')),sys.executable,str(Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3')]
 for candidate in dict.fromkeys(c for c in candidates if c):
  if not Path(candidate).is_file():continue
  try:
   if subprocess.run([candidate,'-c','from PIL import Image,ImageDraw,ImageFont'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=8).returncode==0:return candidate
  except (OSError,subprocess.TimeoutExpired):continue
 return sys.executable
if __name__=='__main__':
 parser=argparse.ArgumentParser(description='启动 CourtLens Arena 与本机成片服务。')
 parser.add_argument('--port',type=int,default=8765)
 parser.add_argument('--workspace',default=str(ROOT/'workspace'))
 options,_=parser.parse_known_args()
 renderer=choose_renderer()
 from build_site import build
 presentation=ROOT/'docs/CourtLens-Arena-4.1-本地产品验收.pptx'
 if not presentation.is_file():presentation=ROOT/'docs/CourtLens-Arena-产品与参赛方案.pptx'
 build(ROOT/'site-dist', presentation)
 print(f'CourtLens Arena：http://127.0.0.1:{options.port}/arena/\nStudio v3：http://127.0.0.1:{options.port}/studio/\nFFmpeg / SQLite 本机工作区：http://127.0.0.1:{options.port}/projects.html\n停止服务请按 Ctrl+C。项目保存在 {options.workspace}。',flush=True)
 os.execv(sys.executable,[sys.executable,str(ROOT/'server.py'),'--render-python',renderer,*sys.argv[1:]])
