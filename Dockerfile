# Lightweight Python image (no Playwright needed)
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Expose the port Hugging Face Spaces expects (7860)
EXPOSE 7860

CMD ["python", "-m", "flask", "run", "--host=0.0.0.0", "--port=7860"]
