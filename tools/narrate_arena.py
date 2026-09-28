#!/usr/bin/env python3
"""Add local cue-anchored Chinese speech to an offline Arena artifact.

macOS say/Tingting and ffmpeg are required. This never calls a cloud provider.
The source video audio is intentionally omitted, as documented by the service.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core.arena_voice import narrate, MAX_VIDEO_BYTES


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video', type=Path, default=ROOT / 'media/arena-story-silent.mp4')
    parser.add_argument('--report', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'media/arena-story.mp4')
    args = parser.parse_args()
    source = args.video.resolve()
    if not source.is_file() or source.stat().st_size > MAX_VIDEO_BYTES:
        raise ValueError('输入成片必须存在且不超过 64 MiB。')
    report_path = args.report or Path(str(source) + '.json')
    metadata = json.loads(report_path.read_text(encoding='utf8'))
    with tempfile.TemporaryDirectory(prefix='courtlens-arena-voice-input-') as work:
        webm = Path(work) / 'input.webm'
        subprocess.run(['ffmpeg', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', str(source),
                        '-map', '0:v:0', '-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-an', str(webm)],
                       check=True, timeout=120, stdin=subprocess.DEVNULL)
        if webm.stat().st_size > MAX_VIDEO_BYTES:
            raise ValueError('转码成片超过配音容量。')
        result = narrate({'videoBase64': base64.b64encode(webm.read_bytes()).decode('ascii'),
                          'cues': metadata['cues'], 'duration': metadata['plannedDurationSeconds'],
                          'provenance': metadata.get('sourceProvenance', {'kind': 'user'})})
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(result.video_bytes)
    Path(str(output) + '.voice.json').write_text(json.dumps(result.report, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps({'output': str(output), 'bytes': len(result.video_bytes),
                      'sha256': hashlib.sha256(result.video_bytes).hexdigest(),
                      'durationSeconds': result.report['durationSeconds'],
                      'provider': result.report['provider'], 'sourceAuthenticated': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
