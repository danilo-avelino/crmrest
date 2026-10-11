"use client";

import { useEffect, useState } from "react";

/** Quem está chamando: o cliente (alarme agudo) ou o entregador (a frase falada, ou dois bipes graves). */
type AlarmKind = "customer" | "courier";

const REPEAT_MS: Record<AlarmKind, number> = { customer: 1_500, courier: 4_000 };

/**
 * Alarme de "chamando o atendente", repetido sem parar enquanto `ringing`. Cliente: dois tons agudos alternados.
 * Entregador: o navegador fala "Entregador chamando"; sem voz em português, dois bipes graves, sempre no mesmo tom.
 * O navegador só libera o som depois de um clique na página; até lá, `blocked` avisa a tela.
 */
export function useAgentAlarm(ringing: boolean, kind: AlarmKind = "customer"): { blocked: boolean } {
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
      if (kind === "courier") courierCall(audio);
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
      if (kind === "courier") speechOf()?.cancel();
      void audio.close();
    };
  }, [ringing, kind]);

  return { blocked };
}

/** Voz do navegador, se ele tiver uma em português (as vozes carregam depois da página: a primeira chamada pode ir de bipe). */
function speechOf(): SpeechSynthesis | null {
  if (!("speechSynthesis" in window)) return null;
  return window.speechSynthesis.getVoices().some((voice) => voice.lang.toLowerCase().startsWith("pt")) ? window.speechSynthesis : null;
}

function courierCall(audio: AudioContext) {
  const speech = speechOf();
  if (!speech) {
    for (const delay of [0, 0.32]) tone(audio, 523, audio.currentTime + delay, 0.2, "sine", 0.18);
    return;
  }
  if (speech.speaking) return;
  const phrase = new SpeechSynthesisUtterance("Entregador chamando");
  phrase.lang = "pt-BR";
  speech.speak(phrase);
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
