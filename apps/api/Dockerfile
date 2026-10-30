FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libtommath1 git && rm -rf /var/lib/apt/lists/*
COPY apps/api/requirements.lock.txt .
RUN pip install --no-cache-dir -r requirements.lock.txt
COPY apps/api .
COPY contexts ./contexts
COPY skills ./skills
RUN useradd -m control && mkdir -p /data/workspaces && chown -R control:control /app /data /usr/local/lib/python3.12/site-packages/firebird/embedded/runtime
USER control
EXPOSE 8000
CMD ["sh", "-c", "python -m control.bootstrap && uvicorn control.main:app --host 0.0.0.0 --port 8000"]
