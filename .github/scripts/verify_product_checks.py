"""Publish only a commit whose dedicated Product checks workflow succeeded."""
import json
import os
import re
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def verdict(runs, commit):
    matching = [run for run in runs if run.get('head_sha') == commit and run.get('event') == 'push']
    if not matching:
        return 'wait'
    latest = max(matching, key=lambda run: run.get('run_number', 0))
    if latest.get('status') != 'completed':
        return 'wait'
    return 'success' if latest.get('conclusion') == 'success' else 'failed'


def main():
    repo = os.environ['GITHUB_REPOSITORY']
    commit = os.environ['GITHUB_SHA']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise SystemExit('Invalid repository or commit')
    url = f'https://api.github.com/repos/{repo}/actions/workflows/checks.yml/runs?' + urlencode({'head_sha': commit, 'event': 'push', 'per_page': 20})
    deadline = time.monotonic() + 450
    while time.monotonic() < deadline:
        request = Request(url, headers={'Authorization': f'Bearer {os.environ["GH_TOKEN"]}', 'Accept': 'application/vnd.github+json', 'User-Agent': 'CourtLens-release-gate'})
        with urlopen(request, timeout=20) as response:
            state = verdict(json.load(response)['workflow_runs'], commit)
        if state == 'success':
            print(f'Product checks passed for {commit}')
            return
        if state == 'failed':
            raise SystemExit('Product checks did not pass; publication is blocked')
        time.sleep(10)
    raise SystemExit('Product checks did not complete within the publication window')


if __name__ == '__main__':
    main()
