#!/usr/bin/env python3
"""Create an explicit, audited import copy; never rewrite the supplied source.

Example: python tools/normalize_broadcast_media.py input.mov --output copy.mp4 --fps 30
The sidecar is required provenance, not a promise of exact frame correspondence
when CFR resampling drops or duplicates source frames.
"""
import argparse
import bisect
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from core.broadcast.media import FFMPEG, FFPROBE, probe, run


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def inspect_source(path):
    info = json.loads(run([FFPROBE, '-v', 'error', '-protocol_whitelist', 'file',
                          '-show_streams', '-show_format', '-of', 'json', str(path)], timeout=30).stdout)
    video = next((row for row in info.get('streams', []) if row.get('codec_type') == 'video'), None)
    if video is None or info.get('format', {}).get('format_name', '').split(',')[0] not in {'mov', 'matroska', 'avi', 'mpegts'}:
        raise ValueError('Input must be a self-contained video container.')
    duration = float(video.get('duration') or info['format']['duration'])
    if not math.isfinite(duration) or not 0 < duration <= 180:
        raise ValueError('Input duration must be between zero and 180 seconds.')
    frame_info = json.loads(run([FFPROBE, '-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0',
                                '-show_frames', '-show_entries', 'frame=best_effort_timestamp,best_effort_timestamp_time',
                                '-of', 'json', str(path)], timeout=120).stdout)
    frames = [{"pts": int(row['best_effort_timestamp']), "seconds": float(row['best_effort_timestamp_time'])}
              for row in frame_info['frames'] if 'best_effort_timestamp' in row and 'best_effort_timestamp_time' in row]
    if not frames or any(not math.isfinite(row['seconds']) for row in frames) or any(b['seconds'] <= a['seconds'] for a,b in zip(frames, frames[1:])):
        raise ValueError('Source presentation timestamps must be finite and strictly increasing.')
    avg = Fraction(video['avg_frame_rate'])
    nominal = float(1 / avg) if avg > 0 else 0
    vfr = not nominal or any(abs(b['seconds'] - a['seconds'] - nominal) > max(.002, nominal * .08) for a,b in zip(frames, frames[1:]))
    return info, frames, bool(vfr)


def normalize_media(source, output, fps=30):
    source, output = Path(source).resolve(), Path(output).absolute()
    sidecar = output.with_suffix(output.suffix + '.normalization.json')
    if fps not in (25,30,60):
        raise ValueError('Choose 25, 30 or 60 CFR frames per second.')
    if not source.is_file() or source == output.resolve():
        raise ValueError('Source must exist and output must be a distinct file.')
    if output.exists() or sidecar.exists() or output.is_symlink() or sidecar.is_symlink():
        raise ValueError('Output or sidecar already exists; choose a fresh output path.')
    output.parent.mkdir(parents=True,exist_ok=True)
    original_hash = sha256(source)
    info, frames, vfr = inspect_source(source)
    first = frames[0]['seconds']
    # ffmpeg autorotation bakes the display matrix into decoded pixels. Preserve
    # display aspect ratio by widening square pixels before clearing SAR.
    vf = f"setpts=PTS-STARTPTS,fps={fps},scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1"
    has_audio = any(row.get('codec_type') == 'audio' for row in info['streams'])
    with tempfile.TemporaryDirectory(prefix='.normalizing-',dir=output.parent) as tmp:
        candidate = Path(tmp)/'normalized.mp4'
        args = [FFMPEG,'-v','error','-nostdin','-protocol_whitelist','file','-copyts','-i',str(source),
                '-map','0:v:0','-vf',vf,'-c:v','libx264','-crf','20','-pix_fmt','yuv420p','-map_metadata','-1',
                '-metadata:s:v:0','rotate=0']
        if has_audio:
            # Align audio to the first displayed VIDEO frame, not its own start.
            args += ['-map','0:a:0','-af',f'asetpts=PTS-({first:.9f})/TB,aresample=async=1:first_pts=0',
                     '-c:a','aac','-b:a','128k']
        else:
            args += ['-an']
        args += ['-movflags','+faststart','-y',str(candidate)]
        run(args,timeout=240)
        meta = probe(candidate)
        if meta['variableFrameRate'] or meta['firstFramePts'] != 0 or Fraction(meta['fpsNumerator'],meta['fpsDenominator']) != fps:
            raise ValueError('Normalized output did not establish the requested zero-origin CFR clock.')
        if abs(meta['duration']-(frames[-1]['seconds']-first + 1/fps)) > max(.2,2/fps):
            raise ValueError('Normalized output duration differs from the source presentation span.')
        if sha256(source) != original_hash:
            raise ValueError('Source changed during normalization; no output published.')
        times = [row['seconds']-first for row in frames]
        mapping=[]
        for index,t in enumerate(meta['frameTimes']):
            right = bisect.bisect_left(times,t)
            candidates = [i for i in (right-1,right) if 0 <= i < len(times)]
            nearest = min(candidates,key=lambda i:abs(times[i]-t))
            mapping.append({'outputFrameIndex':index,'outputPts':meta['framePts'][index],'outputSeconds':t,
                            'nearestSourceFrameIndex':nearest,'nearestSourcePts':frames[nearest]['pts'],
                            'nearestSourceSeconds':frames[nearest]['seconds'],
                            'nearestTimestampErrorSeconds':abs(times[nearest]-t)})
        output_info = json.loads(run([FFPROBE,'-v','error','-show_streams','-show_format','-of','json',str(candidate)]).stdout)
        report={'schema':'courtlens-media-normalization/1','original':{'path':str(source),'sha256':original_hash,
                  'ffprobe':info,'variableFrameRate':vfr,'framePts':[row['pts'] for row in frames]},
                'output':{'path':str(output),'sha256':sha256(candidate),'ffprobe':output_info,
                          'fps':fps,'firstFramePts':0,'duration':meta['duration']},
                'conversion':{'argv':[str(output) if arg==str(candidate) else arg for arg in args],
                              'videoFilter':vf,'autorotation':True,'audioAlignedToVideoFirstPtsSeconds':first if has_audio else None},
                'timeMapping':{'sourceFirstPresentationSeconds':first,'sourceTimeBase':next(row for row in info['streams'] if row.get('codec_type')=='video')['time_base'],
                  'outputTimeBase':meta['timeBase'],
                  'description':'Nominal outputTime=originalPresentationSeconds-sourceFirstPresentationSeconds. CFR resampling may duplicate/drop frames; nearest source timestamp records are audit candidates, not exact content correspondence. Re-extract and review evidence from the normalized copy; never reuse original observation/frame IDs or timestamps as copy evidence.',
                  'frames':mapping}}
        # Hard links publish without replacement even when another writer wins.
        published=False
        try:
            os.link(candidate,output)
            published=True
            with sidecar.open('x',encoding='utf-8') as file:
                json.dump(report,file,ensure_ascii=False,indent=2,allow_nan=False)
                file.write('\n')
        except BaseException:
            if published:
                output.unlink(missing_ok=True)
            raise
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--fps',type=int,choices=(25,30,60),default=30)
    args=parser.parse_args()
    try:
        report=normalize_media(args.source,args.output,args.fps)
    except Exception as exc:
        parser.exit(1,'Normalization failed: '+str(exc)+'\n')
    print(json.dumps({'output':report['output']['path'],'sha256':report['output']['sha256'],
                      'sidecar':str(args.output.absolute().with_suffix(args.output.suffix+'.normalization.json'))}))


if __name__=='__main__':
    main()
