"use client";

import { useEffect, useState } from "react";

/** O chamado: com urgência (alarme agudo) ou sem (dois bipes graves, bem espaçados). */
type AlarmKind = "urgent" | "quiet";

const REPEAT_MS: Record<AlarmKind, number> = { urgent: 1_500, quiet: 30_000 };

/**
 * Aviso de "chamando o atendente", repetido enquanto `ringing`. Com urgência: dois tons agudos alternados, sem parar.
 * Sem urgência (entregador com outro assunto): dois bipes graves e baixos a cada meio minuto, para não incomodar.
 * O navegador só libera o som depois de um clique na página; até lá, `blocked` avisa a tela.
 */
export function useAgentAlarm(ringing: boolean, kind: AlarmKind = "urgent"): { blocked: boolean } {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!ringing) return;
    let audio: AudioContext;
    try {
      audio = new AudioContext();
    } catch {
      return; // sem áudio disponível: a lista ainda destaca a conversa
    }
    const ring = () => {
      if (audio.state !== "running") {
        void audio.resume();
        setBlocked(true);
        return;
      }
      setBlocked(false);
      if (kind === "quiet") for (const delay of [0, 0.32]) tone(audio, 523, audio.currentTime + delay, 0.2, "sine", 0.18);
      else for (let i = 0; i < 6; i++) tone(audio, i % 2 === 0 ? 988 : 740, audio.currentTime + i * 0.17, 0.15);
    };
    const unlock = () => void audio.resume().then(ring);
    const first = setTimeout(ring, 0);
    const timer = setInterval(ring, REPEAT_MS[kind]);
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
      setBlocked(false);
      void audio.close();
    };
  }, [ringing, kind]);

  return { blocked };
}

function tone(audio: AudioContext, frequency: number, start: number, length: number, type: OscillatorType = "square", volume = 0.25) {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
  gain.gain.setValueAtTime(volume, start + length - 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + length);
}
