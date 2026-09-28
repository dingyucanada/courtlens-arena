#!/usr/bin/env python3
"""Render the synthetic tracking fixture to MP4. This is not NBA footage.
Requires Pillow and system FFmpeg. Runtime app itself has no third-party deps.
"""
import argparse,json,math,subprocess,sys
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[1]
W,H=1280,720
FONT='/System/Library/Fonts/Supplemental/Arial.ttf'
CJK='/System/Library/Fonts/Hiragino Sans GB.ttc'
def font(n):
 for name in [CJK,'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',FONT]:
  if Path(name).exists():return ImageFont.truetype(name,n)
 return ImageFont.load_default()
F={n:font(n) for n in [13,15,17,20,23,26,34,50]}
def court(x,y):
 # Perspective field: near baseline wider than far baseline.
 return (W*(.28+.44*x+.18*y*(2*x-1)),H*(.20+.64*y))
def poly(d,pts,**kw):d.line([court(x,y) for x,y in pts],**kw)
def background():
 im=Image.new('RGB',(W,H),'#141b22');d=ImageDraw.Draw(im)
 # Original data substrate, not a photograph or recreation of licensed footage.
 d.rectangle((0,92,W,655),fill='#18212a')
 d.polygon([court(0,0),court(1,0),court(1,1),court(0,1)],fill='#ad8d65')
 for i in range(24):
  xa=i/24;xb=(i+1)/24
  d.polygon([court(xa,0),court(xb,0),court(xb,1),court(xa,1)],fill=('#ae8f67' if i%2 else '#aa8962'))
 for i in range(12):poly(d,[(0,i/12),(1,i/12)],fill='#9c7f5d',width=1)
 d.polygon([court(.34,0),court(.66,0),court(.66,.43),court(.34,.43)],fill='#41575c')
 for pts in [[(0,0),(1,0),(1,1),(0,1),(0,0)],[(.34,0),(.34,.43),(.66,.43),(.66,0)],[(.09,0),(.09,.20)],[(.91,0),(.91,.20)]]:poly(d,pts,fill='#f4e5c7',width=3)
 poly(d,[(.5+.41*math.cos(math.pi*i/90),.18+.49*math.sin(math.pi*i/90)) for i in range(91)],fill='#f4e5c7',width=3)
 poly(d,[(.5+.16*math.cos(2*math.pi*i/90),.43+.13*math.sin(2*math.pi*i/90)) for i in range(91)],fill='#f4e5c7',width=2)
 poly(d,[(.5+.17*math.cos(math.pi+math.pi*i/90),1+.13*math.sin(math.pi+math.pi*i/90)) for i in range(91)],fill='#f4e5c7',width=3)
 bx,by=court(.5,.12)
 d.line([(bx-45,by-18),(bx+45,by-18)],fill='#f3f1e8',width=5)
 d.ellipse((bx-14,by-9,bx+14,by+3),outline='#eb804b',width=4)
 d.text((38,23),'COURTLENS / TRACKING REHEARSAL',font=F[20],fill='#edf1e8')
 d.text((W-345,27),'合成演练 · 非真实 NBA 比赛',font=F[17],fill='#d7ef62')
 d.text((40,675),'Original synthetic scene · 10 players · video coordinates · 25 fps',font=F[15],fill='#97a4ad')
 return im
BASE=background()
def track_at(p,t):
 tracks=p['tracks'];a=tracks[0];b=tracks[-1]
 for i in range(len(tracks)-1):
  if tracks[i]['t']<=t<=tracks[i+1]['t']:a,b=tracks[i:i+2];break
 f=max(0,min(1,(t-a['t'])/max(.001,b['t']-a['t'])))
 bps={v['id']:v for v in b['players']}
 players=[]
 for v in a['players']:
  z=bps[v['id']];players.append({**v,'x':v['x']+(z['x']-v['x'])*f,'y':v['y']+(z['y']-v['y'])*f})
 ball={k:a['ball'][k]+(b['ball'][k]-a['ball'][k])*f for k in ['x','y']}
 return players,ball

def draw_frame(ds,t):
 im=BASE.copy();d=ImageDraw.Draw(im)
 p=next((p for p in ds['possessions'] if p['start']<=t<p['end']),ds['possessions'][-1])
 d.text((40,65),f"HOU   {ds['game']['score']}   DAL     /     {p['clock']}     /     {p['id'].upper()}",font=F[17],fill='#b0b9bb')
 d.text((930,65),f"REPLAY   {t:05.2f} / {ds['video']['duration']:.0f} s",font=F[17],fill='#b0b9bb')
 ps,ball=track_at(p,t)
 for v in sorted(ps,key=lambda v:v['y']):
  x,y=v['x']*W,v['y']*H;r=13+v['y']*8
  d.ellipse((x-r*1.1,y-2,x+r*1.3,y+10),fill='#6b5e4c')
  c='#f58256' if v['team']=='HOU' else '#70b8e5'
  d.line((x-6,y,x-8,y-12),fill='#17242c',width=6);d.line((x+6,y,x+8,y-12),fill='#17242c',width=6)
  d.rounded_rectangle((x-r*.65,y-r*2,x+r*.65,y-8),radius=6,fill=c,outline='#e2dbbf',width=1)
  d.ellipse((x-7,y-r*2-10,x+7,y-r*2+3),fill='#ccab83')
  box=d.textbbox((0,0),v['id'][-1],font=F[13]);d.text((x-(box[2]-box[0])/2,y-r*1.65),v['id'][-1],font=F[13],fill='#15212b')
 x,y=ball['x']*W,ball['y']*H
 # Ball animation is entirely fixture-driven.
 d.ellipse((x-6,y-6,x+6,y+6),fill='#ffa24b',outline='#653918',width=2)
 return im

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--data',default=str(ROOT/'data/demo.json'));ap.add_argument('--output',default=str(ROOT/'media/demo.mp4'));ap.add_argument('--fps',type=int,default=25);a=ap.parse_args()
 ds=json.loads(Path(a.data).read_text());Path(a.output).parent.mkdir(parents=True,exist_ok=True)
 cmd=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-vcodec','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(a.fps),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','22','-pix_fmt','yuv420p','-movflags','+faststart',a.output]
 proc=subprocess.Popen(cmd,stdin=subprocess.PIPE)
 for i in range(round(ds['video']['duration']*a.fps)):proc.stdin.write(draw_frame(ds,i/a.fps).tobytes())
 proc.stdin.close();code=proc.wait()
 if code:sys.exit(code)
 from bind_media import sha256_file
 ds["video"]["sha256"]=sha256_file(a.output)
 Path(a.data).write_text(json.dumps(ds,ensure_ascii=False,indent=2)+"\n")
 print(a.output)
if __name__=='__main__':main()
