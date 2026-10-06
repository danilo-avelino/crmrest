"use client";

import { useEffect, useState } from "react";

const REPEAT_MS = 1_500;

/**
 * Alarme de "cliente chamando o atendente": dois tons agudos alternados, repetidos sem parar enquanto `ringing`.
 * O navegador só libera o som depois de um clique na página; até lá, `blocked` avisa a tela.
 */
export function useAgentAlarm(ringing: boolean): { blocked: boolean } {
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
      for (let i = 0; i < 6; i++) tone(audio, i % 2 === 0 ? 988 : 740, audio.currentTime + i * 0.17, 0.15);
    };
    const unlock = () => void audio.resume().then(ring);
    const first = setTimeout(ring, 0);
    const timer = setInterval(ring, REPEAT_MS);
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
  }, [ringing]);

  return { blocked };
}

function tone(audio: AudioContext, frequency: number, start: number, length: number) {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "square";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.25, start + 0.01);
  gain.gain.setValueAtTime(0.25, start + length - 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + length);
}
