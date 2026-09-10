# Reconstructed from `docker history rayf24241/n8-speed:latest` (see
# image-history.txt for the raw layers). Rebuilds the N8 Speed GPU service
# from scratch if the pod and the Docker Hub image are ever lost.
#   docker build -t rayf24241/n8-speed:latest .
FROM nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-dev python3-pip python3-venv \
        git wget curl build-essential ninja-build \
        libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cu124

RUN git clone --depth 1 https://github.com/Tencent/Hunyuan3D-2.git /app/Hunyuan3D-2
WORKDIR /app/Hunyuan3D-2

# Newer diffusers refuses the repo's remote pipeline code without this flag.
RUN grep -rl "DiffusionPipeline.from_pretrained(" hy3dgen/ | \
    xargs -r sed -i 's/torch_dtype=torch\.float16)/torch_dtype=torch.float16, trust_remote_code=True)/g'

RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir -e hy3dgen/texgen/custom_rasterizer \
    && pip install --no-cache-dir ./hy3dgen/texgen/differentiable_renderer
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" python-multipart pillow \
    diffusers accelerate huggingface_hub fast-simplification

COPY server.py /app/server.py
WORKDIR /app
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
