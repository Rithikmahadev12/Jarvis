# voice-server/server.py
from fastapi import FastAPI, Response
from pydantic import BaseModel
from TTS.api import TTS
import io, soundfile as sf

app = FastAPI()
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cuda")  # use "cpu" if no GPU

SPEAKER_WAV = "voices/clone/reference.wav"  # <-- update to your actual filename

class SynthRequest(BaseModel):
    text: str

@app.post("/synthesize")
def synthesize(req: SynthRequest):
    wav = tts.tts(text=req.text, speaker_wav=SPEAKER_WAV, language="en")
    buf = io.BytesIO()
    sf.write(buf, wav, 24000, format="WAV")
    return Response(content=buf.getvalue(), media_type="audio/wav")

@app.get("/health")
def health():
    return {"ready": True}
