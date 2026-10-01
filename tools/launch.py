#!/usr/bin/env python3
"""Choose an already installed rendering runtime; never install packages silently."""
import argparse,os,sys,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

# Explicit opt-in only. This parser never executes shell expressions or prints values.
LOCAL_ENV_KEYS = frozenset({
 'COURTLENS_STEPFUN_API_KEY', 'COURTLENS_STEPFUN_API_VARIANT',
 'COURTLENS_STEPFUN_MODEL', 'COURTLENS_STEPFUN_VOICE_ID',
 'COURTLENS_STEPFUN_LANGUAGES', 'COURTLENS_STEPFUN_VOICE_ID_EN', 'COURTLENS_STEPFUN_VOICE_ID_YUE',
 'COURTLENS_STEPFUN_VISION_MODEL', 'COURTLENS_STEPFUN_STORY_MODEL',
 'COURTLENS_MINIMAX_API_KEY', 'COURTLENS_MINIMAX_REGION',
 'COURTLENS_MINIMAX_MODEL', 'COURTLENS_MINIMAX_VOICE_ID',
 'COURTLENS_MINIMAX_VOICE_ID_EN', 'COURTLENS_MINIMAX_VOICE_ID_YUE',
 'COURTLENS_BEDROCK_REGION', 'COURTLENS_SEMANTIC_MODEL_ID',
 'COURTLENS_VISION_MODEL_ID', 'COURTLENS_STORY_MODEL_ID',
})

def load_local_config(filename):
 path=Path(filename).expanduser()
 if not path.is_file() or path.stat().st_size > 65536:
  raise ValueError('Local configuration must be a regular file no larger than 64 KiB.')
 values={}
 for line in path.read_text(encoding='utf-8').splitlines():
  line=line.strip()
  if not line or line.startswith('#'):continue
  key,sep,value=line.partition('=')
  key=key.strip();value=value.strip()
  if not sep or key not in LOCAL_ENV_KEYS or key in values:
   raise ValueError('Local configuration contains an unsupported or duplicate setting.')
  if len(value)>=2 and value[0]==value[-1] and value[0] in ('"', "'"):
   value=value[1:-1]
  if not value or any(ord(c)<32 for c in value):
   raise ValueError('Local configuration contains an empty or invalid value.')
  values[key]=value
 # Validate the whole file before changing process state; explicit environment wins.
 for key,value in values.items():os.environ.setdefault(key,value)


def choose_renderer():
 candidates=[os.environ.get('COURTLENS_RENDER_PYTHON'),str(ROOT/'.venv'/('Scripts/python.exe' if os.name=='nt' else 'bin/python3')),sys.executable,str(Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3')]
 for candidate in dict.fromkeys(c for c in candidates if c):
  if not Path(candidate).is_file():continue
  try:
   if subprocess.run([candidate,'-c','from PIL import Image,ImageDraw,ImageFont'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=8).returncode==0:return candidate
  except (OSError,subprocess.TimeoutExpired):continue
 return sys.executable
if __name__=='__main__':
 parser=argparse.ArgumentParser(description='启动 CourtLens Broadcast 本机制作台。')
 parser.add_argument('--port',type=int,default=8765)
 parser.add_argument('--workspace',default=str(ROOT/'workspace'))
 parser.add_argument('--env-file',help='Explicit local provider configuration; never committed or sent to the browser.')
 options,remaining=parser.parse_known_args()
 if options.env_file:
  try:load_local_config(options.env_file)
  except (OSError,UnicodeError,ValueError):parser.error('Unable to load local provider configuration; check file format and allowed setting names.')
 renderer=choose_renderer()
 from build_site import build
 build(ROOT/'site-dist')
 print(f'CourtLens Broadcast：http://127.0.0.1:{options.port}/broadcast/\n停止服务请按 Ctrl+C。项目保存在 {options.workspace}。',flush=True)
 os.execv(renderer,[renderer,str(ROOT/'server.py'),'--render-python',renderer,'--port',str(options.port),'--workspace',options.workspace,*remaining])
