#!/usr/bin/env python3
"""Offline macOS TTS for verified timed cues. Does not truncate unannotated tails."""
import argparse,json,math,re,shutil,subprocess,tempfile
from pathlib import Path

def media_duration(path):
 value=float(subprocess.check_output(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration','-of','default=nw=1:nk=1',str(path)]))
 if not math.isfinite(value) or value<=0:raise ValueError('Invalid media duration')
 return value

def main():
 p=argparse.ArgumentParser();p.add_argument('--video',required=True);p.add_argument('--analysis',required=True);p.add_argument('--output',required=True);p.add_argument('--voice',default='Tingting');a=p.parse_args()
 if not shutil.which('say'):raise RuntimeError('macOS say required for offline TTS; use exported VTT with your approved TTS provider on other OSes')
 output=Path(a.output);output.parent.mkdir(parents=True,exist_ok=True)
 analysis=json.loads(Path(a.analysis).read_text());cues=sorted([c for possession in analysis['possessions'] for c in possession['cues']],key=lambda c:c['start']);end=media_duration(a.video)
 if not cues:raise ValueError('No verified cues are available for narration')
 if any(not 0<=c['start']<c['end']<=end+.05 for c in cues):raise ValueError('Cue timing exceeds video duration')
 logs=[];synthetic=analysis.get('provenance',{}).get('kind')=='synthetic'
 with tempfile.TemporaryDirectory(prefix='.courtlens-tts-',dir=output.parent) as tmp:
  args=['ffmpeg','-v','error','-y','-protocol_whitelist','file,pipe','-i',a.video];filters=[];mix=[]
  for i,c in enumerate(cues):
   text=c['text'].replace('Gravity','引力指标').replace('xFG','预期命中概率').replace('·','，')
   if synthetic:
    text=text.replace('HOU','红队').replace('DAL','蓝队')
    text=re.sub(r'\bH(\d)\b',lambda m:'红队'+m[1]+'号',text);text=re.sub(r'\bD(\d)\b',lambda m:'蓝队'+m[1]+'号',text)
   audio=Path(tmp)/f'{i}.aiff';subprocess.run(['say','-v',a.voice,'-r','250','-o',str(audio),'--',text],check=True)
   sec=media_duration(audio);avail=c['end']-c['start']-.08
   if avail<=0:raise ValueError(f'Cue {i} has no usable narration interval')
   tempo=max(1.0,sec/avail)
   if tempo>2:raise ValueError(f'Cue {i} too dense for narration: {tempo:.2f}x required. Review cue timing or export subtitles only.')
   args+=['-protocol_whitelist','file,pipe','-i',str(audio)];label=f'a{i}';delay=round(c['start']*1000)
   filters.append(f'[{i+1}:a]atempo={tempo:.5f},adelay={delay}|{delay}[{label}]');mix.append(f'[{label}]')
   logs.append({'start':c['start'],'end':c['end'],'text':c['text'],'speech_duration_original':sec,'tempo':round(tempo,4),'evidence_ids':c['evidence_ids']})
   print(json.dumps({'event':'voice_progress','completed':i+1,'total':len(cues)}),flush=True)
  filters.append(''.join(mix)+f'amix=inputs={len(mix)}:normalize=0,apad,atrim=0:{end}[audio]')
  args+=['-filter_complex',';'.join(filters),'-map','0:v:0','-map','[audio]','-c:v','copy','-c:a','aac','-b:a','128k','-t',str(end),'-movflags','+faststart',str(output)]
  subprocess.run(args,check=True)
 output.with_suffix('.voice.json').write_text(json.dumps({'provider':'macOS offline say','voice':a.voice,'video_duration':end,'cues':logs},ensure_ascii=False,indent=2));print(str(output))
if __name__=='__main__':main()
