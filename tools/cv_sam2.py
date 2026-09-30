"""Refine executed RF-DETR boxes with the official SAM2 video implementation.

Bounded single-shot evidence tool, not a full-game identity service. Requires
local checkpoint files; inference never downloads code or weights. Outputs the
same CV evidence schema accepted by Broadcast's CV import/review workflow.
"""
import argparse
import copy
import json
import math
from pathlib import Path
import time

from cv_rfdetr import file_hash, _frame_times, _selected


def select_window(data, start, end, max_objects):
    if not all(isinstance(v, (float, int)) and not isinstance(v, bool) and math.isfinite(v) for v in (start, end)) or not 0 <= start < end <= start + 6:
        raise ValueError('SAM2 window must be finite and at most six seconds')
    rows = [s for s in data['samples'] if start <= s['frameTime'] <= end]
    if len(rows) < 2 or len({s['segmentId'] for s in rows}) != 1:
        raise ValueError('Need at least two detection samples in one shot; never track across a cut')
    if abs(rows[0]['frameTime'] - start) > .05:
        raise ValueError('Window start must match an executed detector frame')
    if not isinstance(max_objects, int) or not 1 <= max_objects <= 10:
        raise ValueError('max_objects must be 1..10')
    seeds = sorted([o for o in rows[0]['objects'] if o['classId'] in ('player', 'person') and o['score'] >= .3], key=lambda o: -o['score'])[:max_objects]
    if not seeds:
        raise ValueError('No player detection to prompt SAM2')
    return rows, seeds


def mask_object(mask, seed):
    import cv2
    import numpy as np
    # Retain the largest connected component, never bridge separate players.
    binary = np.asarray(mask, dtype=np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    if n < 2:
        return None
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, w, h, area = stats[best]
    height, width = binary.shape
    if area < 12 or area > width * height * .35:
        return None
    obj = copy.deepcopy(seed)
    obj.update(bbox=[float(x/width), float(y/height), float(w/width), float(h/height)],
               geometryMethod='sam2-mask-largest-component', maskAreaPixels=int(area))
    # Seed detector score is not a tracking confidence probability.
    obj['scoreMeaning'] = 'seed-detector-score-not-tracking-confidence'
    obj['jerseyText'], obj['jerseyScore'], obj['keypoints'] = None, None, []
    return obj


def refine(video, detections, checkpoint, start, end, max_objects=3, fps=5):
    import cv2
    import numpy as np
    import torch
    from PIL import Image
    from transformers import Sam2VideoModel, Sam2VideoProcessor
    from core.broadcast.providers.cv_command import validate_result
    data = json.loads(Path(detections).read_text())
    if file_hash(Path(video)) != data.get('mediaSha256'):
        raise ValueError('Detections belong to another video')
    times = _frame_times(Path(video))
    validate_result(data, {'media':{'sha256':data['mediaSha256']}}, {'start':0, 'end':times[-1]})
    rows, seeds = select_window(data, start, end, max_objects)
    if not .5 <= fps <= 10:
        raise ValueError('fps must be .5..10')
    checkpoint = Path(checkpoint)
    weights = checkpoint / 'model.safetensors'
    if not weights.is_file():
        raise ValueError('Local SAM2 checkpoint missing')
    selected = _selected(times, start, end, 61, fps)
    if not selected or abs(selected[0][1] - rows[0]['frameTime']) > .00001:
        raise ValueError('Seed timestamp is not a decoded source frame')
    frames = []
    cap = cv2.VideoCapture(str(video))
    last_hist = None
    try:
        for idx, _ in selected:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            if not ok:
                raise ValueError('Video decode failed')
            hist = cv2.calcHist([cv2.cvtColor(cv2.resize(frame,(64,36)),cv2.COLOR_BGR2HSV)],[0,1],None,[24,16],[0,180,0,256])
            cv2.normalize(hist,hist)
            if last_hist is not None and cv2.compareHist(last_hist,hist,cv2.HISTCMP_BHATTACHARYYA) > .27:
                raise ValueError('Potential camera cut: shorten the window and re-seed')
            last_hist = hist
            frames.append(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
    finally:
        cap.release()
    t0 = time.monotonic()
    torch.set_num_threads(4)
    model = Sam2VideoModel.from_pretrained(str(checkpoint), local_files_only=True).eval()
    processor = Sam2VideoProcessor.from_pretrained(str(checkpoint), local_files_only=True)
    session = processor.init_video_session(video=frames, inference_device='cpu')
    width,height = frames[0].size
    boxes = [[o['bbox'][0]*width,o['bbox'][1]*height,(o['bbox'][0]+o['bbox'][2])*width,(o['bbox'][1]+o['bbox'][3])*height] for o in seeds]
    processor.add_inputs_to_inference_session(session, frame_idx=0, obj_ids=list(range(1,len(seeds)+1)),input_boxes=[boxes])
    samples=[]
    with torch.inference_mode():
        model(inference_session=session, frame_idx=0)
        for output in model.propagate_in_video_iterator(session, start_frame_idx=0, max_frame_num_to_track=len(frames)):
            masks = processor.post_process_masks([output.pred_masks],original_sizes=[[height,width]],binarize=True)[0]
            objects=[]
            for i,seed in enumerate(seeds):
                obj=mask_object(masks[i].squeeze().cpu().numpy(),seed)
                if obj: objects.append(obj)
            samples.append({'frameTime':selected[output.frame_idx][1], 'segmentId':rows[0]['segmentId'],'objects':objects})
    return {'schema':'courtlens-cv-result/1','mediaSha256':data['mediaSha256'],
            'provider':{'id':'rfdetr-seeded-sam2-video','version':'1','weightsSha256':file_hash(weights)},
            'samples':samples,'events':[],
            'diagnostics':{'framesProcessed':len(samples),'elapsedMs':round((time.monotonic()-t0)*1000),
            'seedProvider':data['provider'],'seedResultSha256':file_hash(Path(detections)),
            'checkpointSource':'https://huggingface.co/facebook/sam2.1-hiera-tiny',
            'implementation':'transformers.Sam2VideoModel','checkpointLicenseClaim':'Apache-2.0',
            'scope':[start,end],'sampleFps':fps,'seedTrackIds':[s['trackId'] for s in seeds],
            'limitations':['sampled frames only; no interpolated boxes','seeded players only; new entrants not detected','shot boundary heuristic is not a guarantee','scores inherited from seed detector, not calibrated tracking probabilities'],
            'unsupportedTasks':['jersey','player-identity','team-identity','court-keypoints','action-recognition']}}


if __name__ == '__main__':
    import sys
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--video',type=Path,required=True);p.add_argument('--detections',type=Path,required=True)
    p.add_argument('--checkpoint',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--start',type=float,required=True);p.add_argument('--end',type=float,required=True)
    p.add_argument('--max-objects',type=int,default=3);p.add_argument('--fps',type=float,default=5)
    a=p.parse_args()
    result=refine(a.video,a.detections,a.checkpoint,a.start,a.end,a.max_objects,a.fps)
    a.output.parent.mkdir(parents=True,exist_ok=True)
    temp=a.output.with_suffix('.tmp');temp.write_text(json.dumps(result,ensure_ascii=False));temp.replace(a.output)
    print(json.dumps(result['diagnostics'],ensure_ascii=False))
