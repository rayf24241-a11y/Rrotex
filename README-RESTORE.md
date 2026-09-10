# N8 Speed (Exact3D) GPU service — backup

Everything needed to bring the 3D generation service back on a brand new pod.

## What's here
- `server.py` — the whole N8 Speed API (FastAPI: `/generate`, `/texture/{job_id}`,
  `/status/{job_id}`, `/result/{job_id}`, `/health`). This is the only
  hand-written file in the image; extracted from `rayf24241/n8-speed:latest`.
- `Dockerfile` — reconstructed build recipe (CUDA 12.4 + Torch + Hunyuan3D-2 + server.py).
- `image-history.txt` / `image-config.json` — raw `docker history` / `docker inspect`
  output the Dockerfile was reconstructed from.
- Hunyuan3D-2 itself is not included: it's a public repo the Dockerfile clones
  (`https://github.com/Tencent/Hunyuan3D-2`).
- Model weights are not included either — they download from Hugging Face on
  first run into the pod volume at `/app/hf-cache`.

## Restore on a new pod
1. Image: `rayf24241/n8-speed:latest` (or `docker build -t you/n8-speed .` from
   this folder and push, if the Docker Hub image is gone).
2. GPU: RTX 4090, 40 GB container disk, 100 GB volume mounted at `/app/hf-cache`.
3. Expose HTTP port `8000`.
4. Env: `N8_SPEED_API_KEY=<the key the website sends as X-API-Key>`,
   `U2NET_HOME=/app/hf-cache/u2net`.
5. First boot downloads the weights (several minutes); `/health` returns
   `{"status":"ok"}` when it's ready.
6. Point the website at it: set the Vercel env var `N8_SPEED_API_URL` on the
   `rrotex` project to `https://<pod-id>-8000.proxy.runpod.net`, then redeploy.
