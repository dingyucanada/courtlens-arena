#!/usr/bin/env python3
"""Export time-bound evidence overlays to a real MP4 + VTT + analysis JSON.
Pillow/FFmpeg are build dependencies; the video remains on the local machine.
"""
import argparse,json,math,subprocess,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from core.engine import analyze, camera_segment
from core.tracking import sample_track
from core.media import verify_video_coverage
from bind_media import sha256_file
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[1]
def font(size):
 for f in ['/System/Library/Fonts/Hiragino Sans GB.ttc','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:
  if Path(f).exists():return ImageFont.truetype(f,size)
 return ImageFont.load_default()
def stamp(t):
 ms=round(t*1000);return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02}.{ms%1000:03}'
def vtt(analysis):
 out=['WEBVTT','','NOTE '+analysis['provenance']['label'],'']
 for p in sorted(analysis['possessions'],key=lambda p:p['start']):
  for c in p['cues']:
   out.extend([f"{stamp(c['start'])} --> {stamp(c['end'])}",c['text'],''])
 return '\n'.join(out)
def wrap(text,draw,font,width):
 lines=[];line=''
 for ch in text:
  if draw.textlength(line+ch,font=font)>width and line:lines.append(line);line=ch
  else:line+=ch
 if line:lines.append(line)
 return lines

def overlay(im,ds,analysis,t):
 w,h=im.size;scale=w/1280;d=ImageDraw.Draw(im,'RGBA');f=font(round(21*scale));small=font(round(15*scale));large=font(round(26*scale))
 p=next((p for p in ds['possessions'] if p['start']<=t<p['end']),None)
 if not p:return im
 ap=next(p2 for p2 in analysis['possessions'] if p2['id']==p['id'])
 _,seg=camera_segment(p,t)
 fr=sample_track(p,t)
 manual=any(a.get('origin')=='manual' and a.get('frame_reviewed') is True and a['start']<=t<a['end'] for a in p['annotations'])
 if seg and (fr or manual):
  for a in p['annotations']:
   if not a['start']<=t<a['end'] or (a.get('origin')=='manual' and a.get('frame_reviewed') is not True) or (not fr and a.get('origin')!='manual'):continue
   pts=[(x*w,y*h) for x,y in a['points']]
   if a['kind']=='zone':
    if len(pts)==2:pts=[pts[0],(pts[1][0],pts[0][1]),pts[1],(pts[0][0],pts[1][1])]
    d.polygon(pts,fill=(214,242,79,36));d.line(pts+[pts[0]],fill=(214,242,79,230),width=3)
   elif a['kind']=='arrow':
    d.line(pts,fill=(214,242,79,255),width=4)
    x,y=pts[-1];px,py=pts[-2];ang=math.atan2(y-py,x-px)
    d.polygon([(x,y),(x-15*math.cos(ang-.45),y-15*math.sin(ang-.45)),(x-15*math.cos(ang+.45),y-15*math.sin(ang+.45))],fill=(214,242,79,255))
   x,y=pts[0];label=('人工 · ' if a.get('origin')=='manual' else '')+a['label'];tw=d.textlength(label,font=small)
   x=min(max(x,8),w-tw-20);y=max(110*scale,y-35*scale)
   d.rectangle((x-7,y-3,x+tw+7,y+24*scale),fill=(15,26,28,235));d.text((x,y),label,font=small,fill=(224,246,140,255))
  if fr:
   for player in fr['players']:
    if player['id']!=p['shooter']:continue
    x,y=player['x']*w,player['y']*h
    d.ellipse((x-24*scale,y-9*scale,x+24*scale,y+11*scale),outline=(219,245,96,250),width=3)
    d.text((x+26*scale,y-10*scale),player['id'],font=small,fill=(222,247,114,255))
 else:
  d.text((30*scale,120*scale),'无有效轨迹或镜头未校准 · 空间标注暂停',font=f,fill=(255,210,120,255))
 # Compact xFG panel avoids the players. Values come from the validated source.
 left,top=28*scale,145*scale
 d.rounded_rectangle((left,top,left+225*scale,top+125*scale),radius=8*scale,fill=(13,24,28,238))
 d.text((left+16*scale,top+12*scale),'出手前预期 / xFG',font=small,fill=(175,190,194,255))
 val=p['metrics']['xfg_pct'];value='缺失' if val is None else f'{val*100:.1f}%'
 d.text((left+16*scale,top+43*scale),value,font=large,fill=(221,244,108,255))
 d.text((left+16*scale,top+86*scale),'预测概率 ≠ 实际结果',font=small,fill=(176,188,191,255))
 cue=next((c for c in ap['cues'] if c['start']<=t<c['end']),None)
 d.rectangle((0,h-96*scale,w,h),fill=(11,18,22,255))
 if cue:
  lines=wrap(cue['text'],d,f,w-80*scale)
  for i,line in enumerate(lines[:2]):d.text((40*scale,h-82*scale+i*27*scale),line,font=f,fill=(243,242,224,255))
  d.text((40*scale,h-28*scale),'证据 '+', '.join(cue['evidence_ids']),font=small,fill=(143,161,167,255))
 label=ds['provenance']['label'];d.rectangle((w-390*scale,0,w,42*scale),fill=(15,25,29,255));d.text((w-377*scale,12*scale),label,font=small,fill=(215,239,98,255))
 return im

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--data',default=str(ROOT/'data/demo.json'));ap.add_argument('--video',default=str(ROOT/'media/demo.mp4'));ap.add_argument('--output',required=True);ap.add_argument('--audience',choices=['fan','analyst'],default='fan');ap.add_argument('--fps',type=int,default=25);a=ap.parse_args()
 if not 1<=a.fps<=60:raise ValueError('FPS must be between 1 and 60')
 ds=json.loads(Path(a.data).read_text());analysis=analyze(ds,a.audience)
 digest=sha256_file(a.video)
 if ds['video'].get('sha256','').lower()!=digest:raise ValueError('Video SHA-256 is missing or mismatched; calibrate then bind_media before exporting')
 info=json.loads(subprocess.check_output(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',a.video]))
 vs=next(s for s in info['streams'] if s['codec_type']=='video');w,h=vs['width'],vs['height']
 if (w,h)!=(ds['video']['width'],ds['video']['height']):raise ValueError('Video dimensions do not match dataset; recalibrate before exporting')
 duration=float(info['format']['duration'])
 if abs(duration-ds['video']['duration'])>.1:raise ValueError('Video duration does not match data timeline')
 verify_video_coverage(a.video,vs,ds['video']['duration'],fps=a.fps)
 analysis['media_binding']={'sha256':digest,'width':w,'height':h,'duration':duration,'meaning':'File identity checked; calibration and source authenticity are not certified'}
 out=Path(a.output);out.parent.mkdir(parents=True,exist_ok=True)
 dec=subprocess.Popen(['ffmpeg','-v','error','-protocol_whitelist','file,pipe','-i',a.video,'-vf',f'fps={a.fps}','-f','rawvideo','-pix_fmt','rgb24','-'],stdout=subprocess.PIPE)
 enc=subprocess.Popen(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{w}x{h}','-r',str(a.fps),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(out)],stdin=subprocess.PIPE)
 count=0;total=round(ds['video']['duration']*a.fps)
 try:
  for i in range(round(ds['video']['duration']*a.fps)):
   raw=dec.stdout.read(w*h*3)
   if len(raw)!=w*h*3:raise ValueError('Unexpected video EOF')
   enc.stdin.write(overlay(Image.frombytes('RGB',(w,h),raw),ds,analysis,i/a.fps).tobytes());count+=1
   if count%25==0 or count==total:print(json.dumps({'event':'progress','completed':count,'total':total,'progress':count/total}),flush=True)
 finally:
  dec.stdout.close();dec.terminate();dec.wait();enc.stdin.close()
 if enc.wait():raise RuntimeError('Video encoder failed')
 out.with_suffix('.vtt').write_text(vtt(analysis),encoding='utf-8');out.with_suffix('.analysis.json').write_text(json.dumps(analysis,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps({'output':str(out),'frames':count,'fps':a.fps,'duration':count/a.fps,'source_kind':ds['provenance']['kind']},ensure_ascii=False))
if __name__=='__main__':main()
