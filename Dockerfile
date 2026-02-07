FROM python:3.11-slim

WORKDIR /app

# Install dependencies first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY rag/ rag/
COPY web/ web/
COPY scraper/ scraper/

# ChromaDB data is mounted as a volume at /app/data/chromadb
# It is NOT baked into the image

EXPOSE 8000

CMD ["uvicorn", "web.app:app", "--host", "0.0.0.0", "--port", "8000"]
