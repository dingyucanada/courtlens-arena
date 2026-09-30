#!/usr/bin/env python3
"""Build the network-independent Pages demo from the production evidence engine."""
from pathlib import Path
import argparse, hashlib, json, shutil, sys, os, tempfile
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core.engine import analyze, ask
from core.validation import validate_dataset
QUESTIONS = {
    'selection': '为什么选择这个回合？',
    'xfg': 'Shot xFG 是什么意思？',
    'gravity': 'Gravity 是什么意思？',
    'leverage': '回合胜率机会差是什么意思？',
    'compare': '比较全部回合的 xFG、Gravity、回合胜率机会差',
    'causal': 'Gravity 能证明牵制导致命中吗？',
    'sources': '列出这个回合的证据',
}
def copy_file(source,target):
    """Write atomically without macOS fcopyfile hydration stalls on cloud placeholders."""
    source,target=Path(source),Path(target)
    raw=source.read_bytes()
    with tempfile.NamedTemporaryFile(dir=target.parent,prefix='.copy-',delete=False) as f:
        temp=Path(f.name);f.write(raw)
    try:
        os.replace(temp,target)
    finally:
        temp.unlink(missing_ok=True)
def build(output, presentation=None, repo='dingyucanada/courtlens'):
    if Path(output).is_symlink():
        raise ValueError('Publication output must not be a symbolic link')
    output = Path(output).resolve()
    if output == ROOT or ROOT in output.parents and output.name not in ('site-dist','dist'):
        raise ValueError('Use a separate site-dist or dist directory')
    # Fail closed rather than deleting or accidentally deploying unrelated files.
    pro_files = ('styles.css','app.mjs','model.mjs','store.mjs','analytics.mjs','calibration.mjs','render.mjs','director.mjs','agent-contract.mjs','export-video.mjs','delivery.mjs','playback.mjs','spectator.mjs','readiness.mjs','metrics-v2.mjs','story-plan.mjs','camera-view.mjs')
    broadcast_files = ('index.html','styles.css','app.mjs','api.mjs','auth.mjs','capability_ui.mjs')
    allowed_files = {'index.html','arena.html','studio.html','demo.html','styles.css','app.js','logic.mjs','favicon.svg',
        'studio/styles.css','studio/app.mjs','studio/domain.mjs','studio/store.mjs','studio/export.mjs',
        'data/analysis.json','data/demo.json','data/metrics-v2-example.json','media/demo.mp4',
        'media/narrated-demo.mp4','media/annotated-demo.vtt','media/arena-story.mp4','media/arena-story.mp4.voice.json','media/arena-browser-story.mp4','media/arena-local-4.1.mp4','media/arena-local-4.1.vtt',
        'media/arena-story-silent.mp4.vtt','media/arena-story-silent.mp4.json',
        'presentation.pptx','.nojekyll','manifest.json'} | {'pro/'+name for name in pro_files} | {'broadcast/'+name for name in broadcast_files}
    if output.exists():
        for entry in output.rglob('*'):
            relative = entry.relative_to(output).as_posix()
            if entry.is_symlink() or (entry.is_dir() and relative not in {'data','media','studio','pro','broadcast'}) or (entry.is_file() and relative not in allowed_files):
                raise ValueError(f'Unexpected publication output entry: {relative}; choose a clean directory')
    output.mkdir(parents=True, exist_ok=True)
    for name in ('index.html','styles.css','app.js','logic.mjs','favicon.svg'):
        copy_file(ROOT/'site'/name, output/('demo.html' if name=='index.html' else name))
    copy_file(ROOT/'studio/index.html',output/'studio.html')
    copy_file(ROOT/'pro/index.html',output/'arena.html')
    (output/'index.html').write_text('''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=broadcast/"><title>CourtLens Broadcast</title>
</head>
<body><p>正在进入 CourtLens Broadcast… <a href="broadcast/">打开制作台</a></p></body></html>\n''',encoding='utf-8')
    (output/'pro').mkdir(exist_ok=True)
    for name in pro_files:
        copy_file(ROOT/'pro'/name,output/'pro'/name)
    (output/'studio').mkdir(exist_ok=True)
    for name in ('styles.css','app.mjs','domain.mjs','store.mjs','export.mjs'):
        copy_file(ROOT/'studio'/name, output/'studio'/name)
    (output/'broadcast').mkdir(exist_ok=True)
    for name in broadcast_files:
        copy_file(ROOT/'broadcast'/name, output/'broadcast'/name)
    data_dir, media_dir = output/'data', output/'media'
    data_dir.mkdir(exist_ok=True); media_dir.mkdir(exist_ok=True)
    dataset = validate_dataset(json.loads((ROOT/'data/demo.json').read_text()))
    if dataset['provenance']['kind'] != 'synthetic':
        raise ValueError('The public rehearsal site accepts only its synthetic fixture')
    if len(dataset['possessions']) != 3 or dataset['video']['duration'] != 36:
        raise ValueError('Public demo copy expects the reviewed 3-possession, 36-second fixture')
    raw_media = ROOT/'media/demo.mp4'
    digest = hashlib.sha256(raw_media.read_bytes()).hexdigest()
    if digest != dataset['video']['sha256']:
        raise ValueError('Demo video and input digest differ; refusing unpaired public demo')
    analyses = {mode: analyze(dataset, mode) for mode in ('fan','analyst')}
    if any(sum(len(p['cues']) for p in analysis['possessions']) != 12 for analysis in analyses.values()):
        raise ValueError('Public demo copy expects 12 timed commentary cues')
    answers = {mode: {p['id']: {key: ask(dataset, q, p['id'], mode) for key,q in QUESTIONS.items()} for p in dataset['possessions']} for mode in analyses}
    # Relative URL is essential for project Pages under /<repository>/.
    dataset['video']['url'] = 'media/demo.mp4'
    bundle = {'schema_version':1, 'dataset':dataset, 'analyses':analyses, 'questions':QUESTIONS, 'answers':answers,
        'publication': {'repository':f'https://github.com/{repo}', 'mode':'static-evidence-demo', 'media_sha256':digest,
            'analysis_source':'core.engine.analyze / core.engine.ask', 'presentation_available':bool(presentation)}}
    (data_dir/'analysis.json').write_text(json.dumps(bundle,ensure_ascii=False,separators=(',',':'))+'\n')
    if (ROOT/'pro/fixtures/metrics-v2-sample.json').exists(): copy_file(ROOT/'pro/fixtures/metrics-v2-sample.json',data_dir/'metrics-v2-example.json')
    (data_dir/'demo.json').write_text(json.dumps(dataset,ensure_ascii=False,indent=2)+'\n')
    for name in ('demo.mp4','narrated-demo.mp4','annotated-demo.vtt','arena-story.mp4','arena-story.mp4.voice.json','arena-browser-story.mp4','arena-local-4.1.mp4','arena-local-4.1.vtt','arena-story-silent.mp4.vtt','arena-story-silent.mp4.json'):
        copy_file(ROOT/'media'/name, media_dir/name)
    if presentation:
        p=Path(presentation)
        if not p.is_file(): raise FileNotFoundError(p)
        copy_file(p,output/'presentation.pptx')
        index=output/'arena.html'
        index.write_text(index.read_text().replace('href="presentation.pptx" hidden','href="presentation.pptx"'),encoding='utf8')
    else:
        if (output/'presentation.pptx').exists(): (output/'presentation.pptx').unlink()
        index=output/'arena.html'
        index.write_text(index.read_text().replace('<a id="presentation-link" href="presentation.pptx" hidden>产品与参赛方案 ↗</a>',''),encoding='utf8')
    (output/'.nojekyll').touch()
    manifest={str(p.relative_to(output)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(output.rglob('*')) if p.is_file() and p.name!='manifest.json'}
    (output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    return bundle
if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--output',default=str(ROOT/'site-dist')); parser.add_argument('--presentation'); parser.add_argument('--repo',default='dingyucanada/courtlens')
    args=parser.parse_args(); result=build(args.output,args.presentation,args.repo)
    print(json.dumps({'output':str(Path(args.output).resolve()),'possessions':len(result['dataset']['possessions']),'modes':list(result['analyses']),'questions_per_possession':len(QUESTIONS),'media_sha256':result['publication']['media_sha256']},ensure_ascii=False))
