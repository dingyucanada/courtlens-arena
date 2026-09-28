"""Explicit camera/clock adapters. No automatic vision or identity claims."""
import math

def _number(value):
 if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):raise ValueError('Expected finite number')
 return float(value)

def solve(matrix,vector):
 n=len(vector);a=[[float(v) for v in row]+[float(y)] for row,y in zip(matrix,vector)]
 for col in range(n):
  pivot=max(range(col,n),key=lambda i:abs(a[i][col]))
  if abs(a[pivot][col])<1e-10:raise ValueError('Degenerate calibration: four non-collinear correspondences required')
  a[col],a[pivot]=a[pivot],a[col];s=a[col][col];a[col]=[v/s for v in a[col]]
  for i in range(n):
   if i!=col:
    m=a[i][col];a[i]=[x-m*y for x,y in zip(a[i],a[col])]
 return [row[-1] for row in a]

def homography(source,target):
 """Four court-plane points -> normalized image coordinates in one camera shot."""
 if len(source)!=4 or len(target)!=4:raise ValueError('Exactly four point correspondences required')
 m=[];v=[]
 for s,t in zip(source,target):
  if len(s)!=2 or len(t)!=2:raise ValueError('Points must have two coordinates')
  x,y=map(_number,s);u,w=map(_number,t)
  if not 0<=u<=1 or not 0<=w<=1:raise ValueError('Image target must be normalized 0..1')
  m.extend([[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-w*x,-w*y]]);v.extend([u,w])
 return solve(m,v)+[1.0]

def project(h,x,y):
 x,y=_number(x),_number(y);den=h[6]*x+h[7]*y+h[8]
 if abs(den)<1e-10:raise ValueError('Point projects to infinity')
 return ((h[0]*x+h[1]*y+h[2])/den,(h[3]*x+h[4]*y+h[5])/den)

def time_map(source_t,anchors):
 """Piecewise linear timestamp mapping. Never bridge stoppages without anchors.
 Anchors [{source:...,video:...}] must be strictly increasing both axes.
 A single anchor permits explicit constant-offset mapping only.
 """
 t=_number(source_t)
 if not anchors:raise ValueError('At least one verified sync anchor is required')
 a=[(_number(k['source']),_number(k['video'])) for k in anchors]
 if len(a)==1:return t+a[0][1]-a[0][0]
 if any(a[i][0]>=a[i+1][0] or a[i][1]>=a[i+1][1] for i in range(len(a)-1)):raise ValueError('Sync anchors must be strictly increasing')
 if t<a[0][0] or t>a[-1][0]:raise ValueError('Timestamp outside calibrated interval; no extrapolation')
 for (s0,v0),(s1,v1) in zip(a,a[1:]):
  if s0<=t<=s1:return v0+(t-s0)/(s1-s0)*(v1-v0)
 raise ValueError('No calibrated interval')
