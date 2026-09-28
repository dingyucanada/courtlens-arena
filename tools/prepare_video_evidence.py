#!/usr/bin/env python3
"""Extract actual decoded video frames for a provider-neutral evidence packet.
No model inference, identity recognition or NBA data is fabricated here.
"""
import argparse, hashlib, json, math, os, shutil, subprocess, tempfile
from pathlib import Path

def run(args, timeout=90):
    try: return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout).stdout
    except subprocess.CalledProcessError as e: raise ValueError(e.stderr.decode(errors='replace')[-1200:]) from e

def prepare(video, output, times, *, source_label, max_frames=24):
    video=Path(video).resolve(); output=Path(output)
    if not video.is_file() or video.stat().st_size<=0 or video.stat().st_size>512*1024**2: raise ValueError('Video must be a nonempty local file up to 512 MiB')
    if not source_label.strip(): raise ValueError('An explicit source label is required')
    if output.exists(): raise ValueError('Output must be a new directory; preserve existing evidence')
    if not times or len(times)>max_frames or any(not isinstance(t,(int,float)) or isinstance(t,bool) or not math.isfinite(t) or t<0 for t in times): raise ValueError('Provide 1–24 finite nonnegative source-video seconds')
    if len(set(times))!=len(times): raise ValueError('Duplicate requested times')
    ffmpeg=shutil.which('ffmpeg');ffprobe=shutil.which('ffprobe')
    if not ffmpeg or not ffprobe: raise ValueError('FFmpeg and FFprobe are required')
    source_hash=hashlib.sha256(video.read_bytes()).hexdigest()
    info=json.loads(run([ffprobe,'-v','error','-select_streams','v:0','-show_entries','stream=width,height,codec_name:format=duration','-of','json',str(video)]))
    stream=info['streams'][0];duration=float(info['format']['duration'])
    if not math.isfinite(duration) or not 0<duration<=600 or stream['width']*stream['height']>3840*2160: raise ValueError('Clip must be at most 600s and 4K')
    if any(t>=duration for t in times): raise ValueError('Requested timestamp outside video duration')
    frameinfo=json.loads(run([ffprobe,'-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',str(video)],timeout=120))
    pts=[float(f['best_effort_timestamp_time']) for f in frameinfo['frames']]
    if not pts or any(not math.isfinite(t) for t in pts) or any(b<a for a,b in zip(pts,pts[1:])): raise ValueError('Decoded presentation timestamps are invalid')
    rows=[]
    output.parent.mkdir(parents=True,exist_ok=True)
    staging=Path(tempfile.mkdtemp(prefix='.frame-packet-',dir=output.parent))
    try:
        for i,t in enumerate(sorted(times)):
            # Pick nearest decoded frame, with index and actual PTS kept for audit.
            index=min(range(len(pts)),key=lambda j:(abs(pts[j]-t),j)); name=f'frame-{i:02}.png';dest=staging/name
            run([ffmpeg,'-nostdin','-v','error','-i',str(video),'-vf',f'select=eq(n\\,{index}),scale=1280:-2','-frames:v','1','-threads','1',str(dest)],timeout=120)
            if not dest.is_file() or not dest.stat().st_size: raise ValueError('Frame extraction produced no image')
            rows.append({'id':f'frame-{i:02}','requestedTime':t,'sourcePTS':pts[index],'decodedFrameIndex':index,'timingErrorSeconds':abs(pts[index]-t),'image':name,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'source':'decoded-video-frame','identityVerified':False})
        packet={'schema':'courtlens-video-evidence/1','source':{'sha256':source_hash,'bytes':video.stat().st_size,'label':source_label,'authenticated':False},'video':{'duration':duration,**stream},'frames':rows,'scope':'Actual decoded frames; no model inference or event/player identity certification','providerContract':{'tool':'read_video_frame','requestFields':['frameId','sourceSha256'],'responseFields':['sourcePTS','sha256','image'],'instructions':'Use only supplied video observations and dictionary-backed metric records. Missing identity/causality stays uncertain. Proposed StoryPlan requires validation and human review.'}}
        (staging/'packet.json').write_text(json.dumps(packet,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
        os.rename(staging,output)
        return packet
    except BaseException:
        shutil.rmtree(staging,ignore_errors=True);raise

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--video',required=True);parser.add_argument('--output',required=True);parser.add_argument('--times',required=True,help='Comma-separated video seconds');parser.add_argument('--source-label',required=True)
    a=parser.parse_args();packet=prepare(a.video,a.output,[float(s) for s in a.times.split(',')],source_label=a.source_label);print(json.dumps({'frames':len(packet['frames']),'sourceSha256':packet['source']['sha256'],'output':str(Path(a.output).resolve())}))
if __name__=='__main__':main()
