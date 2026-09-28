#!/usr/bin/env python3
"""Bind a manually calibrated dataset to exact media bytes, dimensions and duration.
This does NOT create or validate temporal/spatial calibration or ownership.
"""
import argparse, hashlib, json, subprocess, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from core.validation import validate_dataset

def sha256_file(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data',required=True);p.add_argument('--video',required=True)
    p.add_argument('--output',required=True);a=p.parse_args()
    d=validate_dataset(json.loads(Path(a.data).read_text()))
    info=json.loads(subprocess.check_output(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',a.video]))
    v=next(s for s in info['streams'] if s['codec_type']=='video')
    if (v['width'],v['height']) != (d['video']['width'],d['video']['height']):
        raise ValueError('尺寸不一致；请先重新校准标注，不能仅换指纹')
    if abs(float(info['format']['duration'])-d['video']['duration'])>.1:
        raise ValueError('时长不一致；请先重新对齐时间，不能仅换指纹')
    d['video']['sha256']=sha256_file(a.video)
    Path(a.output).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
    print('已绑定指定视频字节。此操作不证明标注、时间校准或来源声明正确。')
if __name__=='__main__':main()
