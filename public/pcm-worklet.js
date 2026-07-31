// ═══════════════════════════════════════════════════════════════
// PCM capture worklet — replaces the old ScriptProcessorNode tap in
// jarvis.js's cloud-mic pipeline. ScriptProcessorNode is deprecated
// and, on newer Chromium/Electron builds, its onaudioprocess callback
// can silently stop firing while the rest of the audio graph (the
// AnalyserNode used for VAD) keeps working fine — which is exactly
// the "hearing you… → transcribing… → listening…" with an empty
// capture buffer bug this file fixes. AudioWorkletNode runs on the
// dedicated audio rendering thread and doesn't have that failure mode.
//
// Every render quantum (128 samples) it posts a copy of the mono
// input channel back to the main thread via port.postMessage — the
// main-thread handler in jarvis.js pushes each chunk into the same
// _cloudPcmRing ring buffer the old onaudioprocess handler used, so
// nothing downstream (VAD, slicing, WAV encoding) needs to change.
// ═══════════════════════════════════════════════════════════════
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length) {
      // .slice(0) copies out of the reused render-quantum buffer —
      // without this the data could be overwritten before the main
      // thread reads it.
      this.port.postMessage(channel.slice(0));
    }
    return true; // keep the processor alive for the life of the node
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
