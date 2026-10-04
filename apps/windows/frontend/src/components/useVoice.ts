import { useCallback, useRef, useState } from "react";

/**
 * Push-to-talk capture with MediaRecorder. Audio goes to the server for
 * transcription; the text then enters the same agent pipeline as typing.
 */
export function useVoice(onAudio: (base64: string, mimeType: string) => void, onError: (err: unknown) => void) {
  const recorder = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: "audio/webm" });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        onAudio(btoa(bin), "audio/webm");
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch (err) {
      onError({ code: "MIC", message: "Microphone access isn't available." , cause: err });
    }
  }, [onAudio, onError]);

  const stop = useCallback(() => {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  }, []);

  return { recording, start, stop };
}
