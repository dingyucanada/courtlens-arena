# CourtLens Broadcast development

The primary product is `/broadcast/`: source video → frame evidence → reviewed observations → official event metric bindings → up to three commentary beats → review → actual MP4/VTT and immutable release. `/arena/` is archived functionality.

- Read `docs/Broadcast-设计裁决.md`, `docs/Broadcast-架构设计.md`, and `docs/Broadcast-AWS部署.md` before architectural changes.
- Keep official metric definitions, event timestamps, units and provenance intact. Never synthesize missing NBA metrics or label fixture footage as real NBA evidence.
- Model outputs remain proposals until reviewed. Changes invalidate review; stale or cancelled jobs cannot replace newer edits. Keep released artifacts immutable.
- Keep credentials server-side and Git/Docker-excluded. `.env.example` has no key. Do not log request authorization or model hidden reasoning.
- Validate relevant Python, Node and infrastructure tests. For video/UI changes, actually inspect rendered media and browser behavior; test count alone is insufficient.
- AWS deployability requires actual account, model and region authorization. CDK synth and mocked tests are not cloud acceptance. Final contest URL must be CloudFront; repository must remain private and be bound in the Portal.
- Document limits of unsupported footage, missing official data, provider access and untested cloud behavior accurately.
