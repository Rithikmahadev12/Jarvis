from fastapi import FastAPI, Response
from pydantic import BaseModel
from piper import PiperVoice
import io, wave

app = FastAPI()

MODEL_PATH = "voice-server/voices/en_US-ryan-low.onnx"
voice = PiperVoice.load(MODEL_PATH)

class SynthRequest(BaseModel):
    text: str

@app.post("/synthesize")
def synthesize(req: SynthRequest):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        voice.synthesize_wav(req.text, wav_file)
    return Response(content=buf.getvalue(), media_type="audio/wav")

@app.get("/health")
def health():
    return {"ready": True}
