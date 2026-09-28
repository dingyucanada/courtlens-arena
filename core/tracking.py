"""Interpolate supported identities inside one calibrated camera segment only."""

def sample_track(possession, t):
    segment=next((s for s in possession.get('camera_segments',[]) if s['start']<=t<s['end']),None)
    if not segment or not segment['calibrated'] or not possession['start']<=t<possession['end']:
        return None
    frames=sorted((f for f in possession.get('tracks',[]) if segment['start']<=f['t']<segment['end'] or (f['t']==segment['end']==possession['end'])),key=lambda f:f['t'])
    before=next((f for f in reversed(frames) if f['t']<=t),None)
    after=next((f for f in frames if f['t']>=t),None)
    if before is None or after is None or after['t']-before['t']>1:
        return None
    ratio=0 if after['t']==before['t'] else (t-before['t'])/(after['t']-before['t'])
    def xy(a,b):return {k:a[k]+(b[k]-a[k])*ratio for k in ('x','y')}
    right={(p['id'],p['team']):p for p in after['players']}
    players=[dict(p,**xy(p,right[(p['id'],p['team'])])) for p in before['players'] if (p['id'],p['team']) in right]
    ball=xy(before['ball'],after['ball']) if before.get('ball') and after.get('ball') else None
    return {'t':t,'players':players,'ball':ball}
