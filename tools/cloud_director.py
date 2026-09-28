#!/usr/bin/env python3
"""Optional cloud run, sends selected structured evidence to Amazon Bedrock.
Requires explicit --enable-cloud; no video or credential contents are sent.
"""
import argparse,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from core.model_agent import direct
p=argparse.ArgumentParser();p.add_argument('--data',required=True);p.add_argument('--possession',required=True);p.add_argument('--question',required=True);p.add_argument('--output',required=True);p.add_argument('--enable-cloud',action='store_true');a=p.parse_args()
if not a.enable_cloud:p.error('Specify --enable-cloud only after confirming data may be sent to Amazon Bedrock')
r=direct(json.loads(Path(a.data).read_text()),a.question,a.possession)
Path(a.output).write_text(json.dumps(r,ensure_ascii=False,indent=2));print('Cloud result written with evidence ids.')
